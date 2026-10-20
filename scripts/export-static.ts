/**
 * Freeze the indexed data into a static snapshot the dashboard can serve with no backend.
 *
 *   pnpm export:static
 *
 * Runs the indexer in-process until it reaches the chain head and has fetched every pending receipt,
 * then writes each API response the dashboard reads to apps/web/public/snapshot/ (layout defined in
 * packages/shared/src/snapshot.ts), stamps it with the block height and time, and pre-renders the
 * report link-preview PNGs into apps/web/public/og/report/. Commit the results; `pnpm --filter
 * @plumbline/web build:static` then produces a site that needs no server, RPC or database.
 *
 * Uses the local indexer database (INDEXER_DB, default data/indexer-99801.sqlite). Set
 * SNAPSHOT_FRESH=1 to rebuild from the deploy block into a throwaway database instead.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createPublicClient, http } from "viem";
import {
  deployment,
  elysiumTestnet,
  ELYSIUM_TESTNET,
  SNAPSHOT_DIR,
  SNAPSHOT_WINDOW,
  snapshotFile,
  type IndexerHealth,
  type SnapshotMeta,
} from "@plumbline/shared";
import { makeLogger } from "@plumbline/shared/node";
import { startIndexer } from "@plumbline/indexer";
import { loadEnv, ROOT } from "./lib/env.js";
import { cardFromReport, renderPng, reportSvg } from "../apps/web/server/og.js";

loadEnv();
const log = makeLogger("export");
const PUBLIC = join(ROOT, "apps", "web", "public");
const OUT = join(PUBLIC, SNAPSHOT_DIR);

if (process.env.SNAPSHOT_FRESH === "1") {
  process.env.INDEXER_DB = join(tmpdir(), `plumbline-snapshot-${Date.now()}.sqlite`);
}
// Take one fresh quote sample quickly so the ladder reflects the vaults at snapshot time.
process.env.INDEXER_SAMPLE_MS ??= "4000";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function write(apiPath: string, body: unknown): void {
  const file = snapshotFile(apiPath);
  if (!file) throw new Error(`no snapshot file for ${apiPath}`);
  const path = join(OUT, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

async function main(): Promise<void> {
  const indexer = await startIndexer(log);
  const started = Date.now();

  // Run to the head: caught up, every receipt fetched, a price read, at least one sample taken.
  for (;;) {
    const s = indexer.status();
    const caughtUp = s.head > 0 && s.head - s.cursor <= 2;
    const settled = s.pendingReceipts === 0 && Date.now() - started > 8_000;
    if (caughtUp && settled && (s.hypeUsd !== null || Date.now() - started > 30_000)) break;
    if (Date.now() - started > 15 * 60_000) throw new Error("indexer did not reach the head in 15 minutes");
    log.info("syncing", { head: s.head, cursor: s.cursor, receipts: s.pendingReceipts });
    await sleep(3_000);
  }
  const { cursor, hypeUsd } = indexer.status();
  const q = indexer.queries;

  const client = createPublicClient({ chain: elysiumTestnet, transport: http(process.env.INDEXER_RPC_URL ?? ELYSIUM_TESTNET.rpcUrl) });
  const block = await client.getBlock({ blockNumber: BigInt(cursor) });

  rmSync(OUT, { recursive: true, force: true });

  const meta: SnapshotMeta = {
    chainId: deployment.chainId,
    block: cursor,
    blockTimestamp: Number(block.timestamp),
    takenAt: new Date().toISOString(),
    contracts: deployment.contracts,
    explorerUrl: ELYSIUM_TESTNET.explorerUrl,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));

  const health: IndexerHealth = { ok: true, chainId: deployment.chainId, head: cursor, cursor, lagBlocks: 0, deployed: true };
  write("/health", health);
  write("/economics", q.economics(hypeUsd));

  const markets = q.listMarkets();
  write("/markets", markets);
  const makers = new Set<string>();
  for (const m of markets) {
    const detail = q.marketDetail(m.pair);
    write(`/markets/${m.pair}`, detail);
    for (const v of detail?.book ?? []) makers.add(v.owner);
    write(`/markets/${m.pair}/uptime?window=${SNAPSHOT_WINDOW}`, q.uptime(m.pair, SNAPSHOT_WINDOW));
  }

  const campaigns = q.listCampaigns();
  write("/campaigns", campaigns);
  for (const c of campaigns) {
    const detail = q.campaignDetail(c.id);
    write(`/campaigns/${c.id}`, detail);
    makers.add(c.creator);
    for (const r of detail?.leaderboard ?? []) makers.add(r.maker);
    for (const p of detail?.penalties ?? []) makers.add(p.reporter);
  }
  for (const a of makers) write(`/makers/${a}`, q.maker(a));

  const tokens = [...new Set(markets.map((m) => m.base.symbol))];
  for (const t of tokens) {
    const report = q.report(t, SNAPSHOT_WINDOW);
    write(`/reports/${t}?window=${SNAPSHOT_WINDOW}`, report);
    write(`/reports/${t}/probes`, q.reportProbes(t, 0, 1_000_000));
    // Link-preview card for the shared report URL, from the same campaign-window figures.
    if (report) {
      const png = join(PUBLIC, "og", "report", `${t.toUpperCase()}.png`);
      mkdirSync(dirname(png), { recursive: true });
      writeFileSync(png, renderPng(reportSvg(cardFromReport(report))));
    }
  }

  log.info("snapshot written", {
    block: meta.block,
    at: new Date(meta.blockTimestamp * 1000).toISOString(),
    markets: markets.length,
    campaigns: campaigns.length,
    makers: makers.size,
    reports: tokens,
  });
  indexer.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  log.error("export failed", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
