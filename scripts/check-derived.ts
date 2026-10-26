/**
 * Check that the figures the browser works out from chain events (packages/shared/src/derive.ts) are
 * the figures the indexer put in the snapshot.
 *
 *   pnpm check:derived
 *
 * Reads every campaigns-contract event from the first deploy block up to the snapshot's own block,
 * works the figures out with the browser's code, and compares them with the snapshot files field by
 * field. Anything that differs is printed and the exit code is 1. Gas per probe is the one thing events
 * do not carry, so it is taken from the snapshot, as the app does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import {
  campaignSources,
  buildLedger,
  deriveCampaignDetail,
  deriveMakerScores,
  deriveMarket,
  deriveProbeLog,
  deriveProbeTotals,
  deriveRegistrations,
  deriveReport,
  deriveUptime,
  elysiumTestnet,
  gasIndex,
  readBlockTimes,
  readChainViews,
  scanCampaignEvents,
  SNAPSHOT_DIR,
  TIMED_EVENTS,
  type CampaignDetail,
  type CampaignView,
  type DepthReport,
  type EconomicsResponse,
  type MakerProfile,
  type MarketDetail,
  type MarketSummary,
  type ProbeView,
  type SnapshotMeta,
  type UptimeResponse,
} from "@plumbline/shared";
import { loadEnv, ROOT } from "./lib/env.js";

loadEnv();
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];
const DIR = join(ROOT, "apps", "web", "public", SNAPSHOT_DIR);
const read = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), "utf8")) as T;

let failures = 0;
let checks = 0;

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    out.push(`${path}: derived ${JSON.stringify(a)} != snapshot ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array vs object`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: derived length ${a.length} != snapshot length ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  for (const k of new Set([...ka, ...kb])) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
}

function check(name: string, derived: unknown, snapshot: unknown, ignore: string[] = []): void {
  checks += 1;
  const strip = (v: unknown): unknown => {
    const j = JSON.parse(JSON.stringify(v)) as unknown;
    return j;
  };
  const out: string[] = [];
  diff(strip(derived), strip(snapshot), name, out);
  const shown = out.filter((l) => !ignore.some((i) => l.startsWith(i)));
  if (shown.length === 0) {
    console.log(`  ok    ${name}${out.length ? `  (ignored ${out.length} difference${out.length === 1 ? "" : "s"} in: ${ignore.join(", ")})` : ""}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  for (const l of shown.slice(0, 12)) console.log(`        ${l}`);
  if (shown.length > 12) console.log(`        … and ${shown.length - 12} more`);
}

async function main(): Promise<void> {
  const meta = read<SnapshotMeta>("meta.json");
  const client = createPublicClient({ chain: elysiumTestnet, transport: http(rpcUrl) });
  const from = BigInt(Math.min(...campaignSources.map((s) => s.deployBlock)));
  console.log(`snapshot block ${meta.block}; reading events ${from}..${meta.block}`);
  const views = await readChainViews(client);
  const events = await scanCampaignEvents(client, from, BigInt(meta.block));
  const blockTimes = await readBlockTimes(client, events.filter((e) => TIMED_EVENTS.has(e.name)).map((e) => e.block), {});
  console.log(`${events.length} events, ${Object.keys(blockTimes).length} block times`);
  // The snapshot was taken at a wall-clock moment a few seconds after its block; "24h" figures use it.
  const takenAt = Math.floor(Date.parse(meta.takenAt) / 1000);
  const L = buildLedger(events, blockTimes, views.campaigns, Number(from));
  if (!L.timesKnown) throw new Error("some block times were not read");

  const snapCampaigns = read<CampaignView[]>("campaigns.json");
  const byId = new Map(snapCampaigns.map((c) => [c.id, c]));
  const markets = read<MarketSummary[]>("markets.json");

  console.log("\ncampaigns");
  for (const c of snapCampaigns) {
    const snap = read<CampaignDetail>(`campaigns/${c.id}.json`);
    const d = deriveCampaignDetail(L, c, gasIndex(snap.recentProbes));
    check(`campaign ${c.id} leaderboard`, d.leaderboard, snap.leaderboard);
    check(`campaign ${c.id} epochs`, d.epochs, snap.epochs);
    check(`campaign ${c.id} recent probes`, d.recentProbes, snap.recentProbes);
    check(`campaign ${c.id} penalties`, d.penalties, snap.penalties);
  }

  console.log("\nmarkets");
  for (const m of markets) {
    const ids = snapCampaigns.filter((c) => c.pair === m.pair).map((c) => c.id);
    const d = deriveMarket(L, ids, m.base, m.quote, takenAt);
    check(`market ${m.pair} verified`, d.verified, m.verified);
    check(`market ${m.pair} 24h`, { uptime24h: d.uptime24h, probes24h: d.probes24h, lastProbeAt: d.lastProbeAt }, {
      uptime24h: m.uptime24h,
      probes24h: m.probes24h,
      lastProbeAt: m.lastProbeAt,
    });
    const detail = read<MarketDetail>(`markets/${m.pair}.json`);
    void detail;
    for (const window of ["all"]) {
      let snapUp: UptimeResponse | null = null;
      try {
        snapUp = read<UptimeResponse>(`markets/${m.pair}/uptime-${window}.json`);
      } catch {
        snapUp = null;
      }
      if (!snapUp) continue;
      const cs = snapCampaigns.filter((c) => c.pair === m.pair);
      check(`uptime ${m.pair} ${window}`, deriveUptime(L, cs, m.pair, window, takenAt), snapUp, ["uptime ".concat(m.pair, " ", window, ".probes")]);
      // The probes list carries gas, which events do not; compare it with the gas filled in.
      const gas = gasIndex(snapUp.probes);
      const withGas = deriveUptime(L, cs, m.pair, window, takenAt).probes.map((p) => ({ ...p, gasUsed: gas.get(p.txHash) ?? null }));
      check(`uptime ${m.pair} ${window} probes`, withGas, snapUp.probes);
    }
  }

  console.log("\nmakers");
  for (const f of ["0x2465e835fab3b9f07d6478177416611d11f46e03", "0xa12c18af4faa2aa266ac705ad1d6e1a644ff32c3", "0xe071a74989784bce375af084069c3ab9b8d872ef"]) {
    const snap = read<MakerProfile>(`makers/${f}.json`);
    const owned = snap.vaults.map((v) => v.vault);
    const camps = new Map(snapCampaigns.map((c) => [c.id, c]));
    const d = deriveMakerScores(L, f, owned, takenAt, (cid) => {
      const c = camps.get(cid);
      return c ? { token: c.rewardToken, symbol: c.rewardSymbol, decimals: c.rewardDecimals } : null;
    });
    check(`maker ${f.slice(0, 8)} scores`, d.scores, snap.scores);
    check(`maker ${f.slice(0, 8)} earned`, d.totalEarned, snap.totalEarned);
    check(`maker ${f.slice(0, 8)} uptime24h`, d.uptime24h, snap.uptime24h);
    check(`maker ${f.slice(0, 8)} registrations`, deriveRegistrations(L, f), snap.registrations);
  }

  console.log("\nreport");
  const report = read<DepthReport>("reports/WHYPE-all.json");
  const cs = snapCampaigns.filter((c) => c.pair === report.pair);
  const owner = (vault: string) => views.vaults.find((v) => v.address.toLowerCase() === vault.toLowerCase())?.owner ?? null;
  const d = deriveReport(L, cs, owner, report.token, report.quote, report.pair, "all", takenAt, report.contracts);
  const gas = gasIndex(read<{ total: number; probes: ProbeView[] }>("reports/WHYPE-probes.json").probes);
  check("report figures", { ...d, probeLog: [], epochs: [] }, { ...report, probeLog: [], epochs: [] });
  check("report epochs", d.epochs, report.epochs);
  check("report probe log", d.probeLog.map((p) => ({ ...p, gasUsed: gas.get(p.txHash) ?? null })), report.probeLog);
  const probes = read<{ total: number; probes: ProbeView[] }>("reports/WHYPE-probes.json");
  const log = deriveProbeLog(L, cs, gas);
  check("report probe pages", { total: log.length, probes: log }, probes);

  console.log("\neconomics");
  const econ = read<EconomicsResponse>("economics.json");
  const t = deriveProbeTotals(L, takenAt);
  check("economics probe totals", t, {
    totalProbes: econ.totalProbes,
    firstProbeAt: econ.firstProbeAt,
    lastProbeAt: econ.lastProbeAt,
    probesPerHour: econ.probesPerHour,
  });
  void byId;

  console.log(`\n${checks - failures}/${checks} checks match the snapshot`);
  if (failures) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
