/**
 * Check a scorecard snapshot file against the chain: recompute the vault's figures from on-chain
 * ProbeResult and Penalized logs and compare them with the figures computed from the indexer rows.
 *
 *   tsx scripts/check-scorecard.ts <vault> [<vault> ...]     (default: every vault in the snapshot)
 *
 * Exits non-zero if any figure differs. Needs network access to the Elysium RPC.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import {
  ELYSIUM_TESTNET,
  compareFigures,
  computeFigures,
  elysiumTestnet,
  recomputeFromChain,
  type Address,
  type VaultScorecardData,
} from "@plumbline/shared";
import { ROOT } from "./lib/env.js";

const DIR = join(ROOT, "apps", "web", "public", "snapshot", "scorecards");
const args = process.argv.slice(2).map((a) => a.toLowerCase());
const files = readdirSync(DIR).filter((f) => args.length === 0 || args.some((a) => f.startsWith(a)));
if (files.length === 0) throw new Error("no matching scorecard files");

const client = createPublicClient({
  chain: elysiumTestnet,
  transport: http(process.env.INDEXER_RPC_URL ?? ELYSIUM_TESTNET.rpcUrl),
}) as PublicClient;

let bad = 0;
for (const f of files) {
  const data = JSON.parse(readFileSync(join(DIR, f), "utf8")) as VaultScorecardData;
  const claimed = computeFigures(data.results, data.slashes, { base: data.base.decimals, quote: data.quote.decimals });
  const started = Date.now();
  const chain = await recomputeFromChain(client, { vault: data.vault as Address, asOfBlock: BigInt(data.asOfBlock) });
  const checks = compareFigures(claimed, chain.figures);
  const owner = chain.owner.toLowerCase() === data.owner.toLowerCase();
  console.log(
    `${data.vault} ${data.pair}: ${chain.eventCounts.probeResults} ProbeResult, ${chain.eventCounts.penalties} Penalized in blocks ` +
      `${chain.fromBlock}-${chain.toBlock} (${((Date.now() - started) / 1000).toFixed(1)} s); owner ${owner ? "matches" : "DIFFERS"}`,
  );
  for (const c of checks) {
    console.log(`  ${c.match ? "MATCH   " : "MISMATCH"} ${c.key.padEnd(16)} snapshot ${c.claimed}  chain ${c.actual}${c.detail ? `  (${c.detail})` : ""}`);
    if (!c.match) bad++;
  }
  if (!owner) bad++;
}
process.exit(bad === 0 ? 0 : 1);
