/**
 * The indexer as a library: sync loops, quote sampler and API routes, startable inside another
 * process. The production web server embeds it so web and API deploy as one service; the
 * standalone entry (index.ts) wraps it with its own port for local development.
 */
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import type { FastifyInstance } from "fastify";
import { deployment, elysiumTestnet, ELYSIUM_TESTNET } from "@plumbline/shared";
import { dataDir, envNumber, envString, makeLogger, throttleRpc, type Logger } from "@plumbline/shared/node";
import { openDb } from "./db.js";
import { Syncer } from "./sync.js";
import { Sampler, fetchHypeUsd } from "./sampler.js";
import { Queries } from "./queries.js";
import { registerApi } from "./api.js";

export interface IndexerService {
  /** Mount the REST routes on a Fastify instance (use a prefix such as /api when embedding). */
  register(app: FastifyInstance): void;
  /** Read model behind the API, for exporters that write the same responses to files. */
  queries: Queries;
  /** Sync progress: chain head, indexed cursor, receipts still to fetch, last HYPE/USD read. */
  status(): { head: number; cursor: number; pendingReceipts: number; hypeUsd: number | null };
  /** Stop loops and close the database. */
  close(): void;
  dbPath: string;
}

export { Queries } from "./queries.js";
export { fetchHypeUsd } from "./sampler.js";

export async function startIndexer(log: Logger = makeLogger("indexer")): Promise<IndexerService> {
  if (!deployment.deployed) throw new Error("Plumbline is not deployed; run pnpm contracts:deploy first");
  const rpcUrl = envString("INDEXER_RPC_URL", envString("ELYSIUM_RPC_URL", ELYSIUM_TESTNET.rpcUrl));
  throttleRpc([rpcUrl], envNumber("INDEXER_RPC_PER_SECOND", 2), (m) => log.warn(m));
  const dbPath = envString("INDEXER_DB", join(dataDir(), `indexer-${deployment.chainId}.sqlite`));
  const db = openDb(dbPath);
  const client = createPublicClient({
    chain: elysiumTestnet,
    transport: http(rpcUrl, { retryCount: 3, timeout: 20_000 }),
  });

  // A fresh database backfills from the block the Plumbline contracts were deployed in (override
  // with INDEXER_START_BLOCK), so a new volume rebuilds the full probe history.
  const startBlock = envNumber("INDEXER_START_BLOCK", deployment.deployBlock);
  const sync = new Syncer(db, client, log, startBlock);
  const sampler = new Sampler(db, client, log);
  const queries = new Queries(db);
  let hypeUsd: number | null = null;
  let stopped = false;

  const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
    const run = async () => {
      if (stopped) return;
      const t0 = Date.now();
      try {
        await fn();
      } catch (err) {
        log.warn(`${name} error`, { err: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
      setTimeout(() => void run(), Math.max(0, ms - (Date.now() - t0)));
    };
    void run();
  };

  sync.requeueMissingGas();
  log.info("starting", { db: dbPath, cursor: sync.cursor, startBlock });

  // Catch up as fast as the RPC allows, then follow the head.
  every("sync", envNumber("INDEXER_POLL_MS", 1_000), async () => {
    let n = 0;
    do {
      n = await sync.step();
    } while (!stopped && n >= 0 && sync.head - sync.cursor > 10);
  });
  every("receipts", 1_000, () => sync.drainReceipts());
  every("sample", envNumber("INDEXER_SAMPLE_MS", 5_000), () => sampler.sample());
  every("blocktime", 60_000, () => sampler.blockTime());
  every("prune", 3_600_000, async () => sampler.prune());
  every("price", 60_000, async () => {
    hypeUsd = (await fetchHypeUsd()) ?? hypeUsd;
  });

  return {
    dbPath,
    register: (app) => registerApi(app, queries, sync, () => hypeUsd),
    queries,
    status: () => ({ head: sync.head, cursor: sync.cursor, pendingReceipts: sync.pendingReceipts(), hypeUsd }),
    close: () => {
      stopped = true;
      db.close();
    },
  };
}
