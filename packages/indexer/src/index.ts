import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { deployment, elysiumTestnet, ELYSIUM_TESTNET } from "@plumbline/shared";
import { dataDir, envNumber, envString, loadRootEnv, makeLogger, throttleRpc } from "@plumbline/shared/node";
import { openDb } from "./db.js";
import { Syncer } from "./sync.js";
import { Sampler, fetchHypeUsd } from "./sampler.js";
import { Queries } from "./queries.js";
import { buildApi } from "./api.js";

loadRootEnv();
const log = makeLogger("indexer");

function every(name: string, ms: number, fn: () => Promise<unknown>): void {
  const run = async () => {
    const t0 = Date.now();
    try {
      await fn();
    } catch (err) {
      log.warn(`${name} error`, { err: err instanceof Error ? err.message : String(err) });
    }
    setTimeout(() => void run(), Math.max(0, ms - (Date.now() - t0)));
  };
  void run();
}

async function main(): Promise<void> {
  if (!deployment.deployed) throw new Error("Plumbline is not deployed; run pnpm contracts:deploy first");
  const rpcUrl = envString("INDEXER_RPC_URL", envString("ELYSIUM_RPC_URL", ELYSIUM_TESTNET.rpcUrl));
  throttleRpc([rpcUrl], envNumber("INDEXER_RPC_PER_SECOND", 2), (m) => log.warn(m));
  const db = openDb(envString("INDEXER_DB", join(dataDir(), `indexer-${deployment.chainId}.sqlite`)));
  const client = createPublicClient({
    chain: elysiumTestnet,
    transport: http(rpcUrl, { retryCount: 3, timeout: 20_000 }),
  });

  const sync = new Syncer(db, client, log);
  const sampler = new Sampler(db, client, log);
  const queries = new Queries(db);
  let hypeUsd: number | null = null;

  sync.requeueMissingGas();
  log.info("starting", { cursor: sync.cursor, deployBlock: deployment.deployBlock });

  // Catch up as fast as the RPC allows, then follow the head.
  every("sync", envNumber("INDEXER_POLL_MS", 1_000), async () => {
    let n = 0;
    do {
      n = await sync.step();
    } while (sync.head - sync.cursor > 0 && n >= 0 && sync.head - sync.cursor > 10);
  });
  every("receipts", 1_000, () => sync.drainReceipts());
  every("sample", envNumber("INDEXER_SAMPLE_MS", 5_000), () => sampler.sample());
  every("blocktime", 60_000, () => sampler.blockTime());
  every("prune", 3_600_000, async () => sampler.prune());
  every("price", 60_000, async () => {
    hypeUsd = (await fetchHypeUsd()) ?? hypeUsd;
  });

  const app = buildApi(queries, sync, () => hypeUsd);
  const port = envNumber("INDEXER_PORT", 8788);
  await app.listen({ port, host: envString("INDEXER_HOST", "0.0.0.0") });
  log.info("api up", { port });

  const shutdown = () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
