/**
 * Figures worked out in the browser from the campaigns contracts' full event history, the same way the
 * indexer works them out from the same events (packages/indexer/src/sync.ts and queries.ts). When the
 * browser holds every event since the first campaigns contract was deployed, nothing here needs the
 * snapshot: a probe, a slash or a settlement shows up in these figures as soon as it is in a block.
 *
 * Everything is a pure function of the events, the block times of the blocks that matter, and the
 * campaigns read from the chain. `scripts/check-derived.ts` runs these against the snapshot files at
 * the snapshot's own block and fails on any difference.
 */
import { getAddress } from "viem";
import type {
  CampaignDetail,
  CampaignView,
  DepthReport,
  EpochUptime,
  EpochView,
  Hash,
  LeaderboardRow,
  MakerProfile,
  PenaltyView,
  ProbeView,
  QuoteView,
  RegistrationView,
  UptimeBucket,
  UptimeResponse,
  VerifiedFigures,
} from "./api.js";
import type { ChainCampaign } from "./liveReader.js";
import type { LiveLog } from "./liveReader.js";
import type { LiveData } from "./liveMerge.js";
import { campaignSources } from "./campaignIds.js";
import type { Address, TokenRef } from "./pairs.js";
import { quoteNotional, spreadBps } from "./score.js";

const CROSSED = 4_294_967_295;
const lc = (a: string) => a.toLowerCase();
const addr = (a: string) => getAddress(a) as Address;
const int = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);

/** Event names whose block time the figures need. */
export const TIMED_EVENTS: ReadonlySet<string> = new Set(["Probed", "ProbeResult", "Penalized", "MakerRegistered"]);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function medianBig(xs: bigint[]): bigint {
  if (xs.length === 0) return 0n;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)] as bigint;
}

// -------------------------------------------------------------------------------------------------
// The ledger: every event applied in order
// -------------------------------------------------------------------------------------------------

export interface DProbe {
  campaignId: number;
  epoch: number;
  nonce: number;
  block: number;
  ts: number;
  txHash: Hash;
  prober: Address;
  checked: number;
  passed: number;
  fee: string;
}

export interface DResult {
  campaignId: number;
  epoch: number;
  nonce: number;
  vault: Address;
  passed: boolean;
  failMask: number;
  spreadBps: number;
  bidPx: string;
  askPx: string;
  bidSize: string;
  askSize: string;
  block: number;
  ts: number;
}

interface Reg {
  vault: Address;
  maker: Address;
  bond: bigint;
  status: RegistrationView["status"];
  registeredAt: number;
}

interface Score {
  campaignId: number;
  epoch: number;
  vault: Address;
  maker: string;
  points: number;
  checks: number;
  reward: bigint | null;
}

interface EpochAgg {
  probes: number;
  totalPoints: number;
  makerPot: string | null;
  refunded: string | null;
  settled: boolean;
  settledTx: Hash | null;
}

interface DPenalty extends PenaltyView {
  pointsForfeited: number;
}

export interface Ledger {
  probes: DProbe[];
  results: DResult[];
  regs: Map<string, Reg>;
  scores: Map<string, Score>;
  epochs: Map<string, EpochAgg>;
  penalties: DPenalty[];
  /** The block the history starts at; the figures are exact only if this is the first deployment's block. */
  historyFrom: number;
  /** Every block time the figures need is known. */
  timesKnown: boolean;
}

const key = (...p: (string | number)[]) => p.join(":");

/**
 * Whether the browser holds the whole history: scanned from the first campaigns contract's deploy block
 * to the head, and the time of every block that matters read.
 */
export function historyComplete(live: LiveData): boolean {
  if (!live.views || !live.scanComplete) return false;
  const first = Math.min(...campaignSources.map((s) => s.deployBlock));
  if (!(live.historyFrom <= first)) return false;
  return live.events.every((e) => !TIMED_EVENTS.has(e.name) || live.blockTimes[e.block] !== undefined);
}

const cache = new WeakMap<LiveLog[], { times: Record<number, number>; campaigns: unknown; ledger: Ledger }>();

/** The ledger for the events held now. Cached until the events, block times or campaigns change. */
export function ledgerOf(live: LiveData): Ledger {
  const hit = cache.get(live.events);
  if (hit && hit.times === live.blockTimes && hit.campaigns === live.views?.campaigns) return hit.ledger;
  const ledger = buildLedger(live.events, live.blockTimes, live.views?.campaigns ?? [], live.historyFrom);
  cache.set(live.events, { times: live.blockTimes, campaigns: live.views?.campaigns, ledger });
  return ledger;
}

export function buildLedger(events: LiveLog[], blockTimes: Record<number, number>, campaigns: ChainCampaign[], historyFrom: number): Ledger {
  const L: Ledger = {
    probes: [],
    results: [],
    regs: new Map(),
    scores: new Map(),
    epochs: new Map(),
    penalties: [],
    historyFrom,
    timesKnown: true,
  };
  const camp = new Map(campaigns.map((c) => [c.id, c]));
  const tsOf = (block: number): number => {
    const t = blockTimes[block];
    if (t === undefined) {
      L.timesKnown = false;
      return 0;
    }
    return t;
  };
  const sorted = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const e of sorted) {
    const a = e.args;
    const id = a.id === undefined ? 0 : int(a.id);
    switch (e.name) {
      case "MakerRegistered": {
        L.regs.set(key(id, lc(str(a.vault))), {
          vault: addr(str(a.vault)),
          maker: addr(str(a.maker)),
          bond: BigInt(str(a.bond)),
          status: "active",
          registeredAt: tsOf(e.block),
        });
        break;
      }
      case "BondToppedUp": {
        const r = L.regs.get(key(id, lc(str(a.vault))));
        if (r) r.bond = BigInt(str(a.bond));
        break;
      }
      case "UnbondRequested": {
        const r = L.regs.get(key(id, lc(str(a.vault))));
        if (r) r.status = "unbonding";
        break;
      }
      case "BondReleased": {
        const r = L.regs.get(key(id, lc(str(a.vault))));
        if (r) {
          r.status = "released";
          r.bond = 0n;
        }
        break;
      }
      case "ProbeResult": {
        const vault = addr(str(a.vault));
        const epoch = int(a.epoch);
        L.results.push({
          campaignId: id,
          epoch,
          nonce: int(a.nonce),
          vault,
          passed: a.passed === true,
          failMask: int(a.failMask),
          spreadBps: int(a.spreadBps),
          bidPx: str(a.bidPx),
          askPx: str(a.askPx),
          bidSize: str(a.bidSize),
          askSize: str(a.askSize),
          block: e.block,
          ts: tsOf(e.block),
        });
        const k = key(id, epoch, lc(vault));
        const s = L.scores.get(k);
        if (s) {
          s.points += a.passed === true ? 1 : 0;
          s.checks += 1;
        } else {
          L.scores.set(k, {
            campaignId: id,
            epoch,
            vault,
            maker: L.regs.get(key(id, lc(vault)))?.maker ?? "",
            points: a.passed === true ? 1 : 0,
            checks: 1,
            reward: null,
          });
        }
        break;
      }
      case "Probed": {
        const epoch = int(a.epoch);
        L.probes.push({
          campaignId: id,
          epoch,
          nonce: int(a.nonce),
          block: e.block,
          ts: tsOf(e.block),
          txHash: e.txHash,
          prober: addr(str(a.prober)),
          checked: int(a.checked),
          passed: int(a.passed),
          fee: str(a.fee),
        });
        const k = key(id, epoch);
        const ep = L.epochs.get(k) ?? { probes: 0, totalPoints: 0, makerPot: null, refunded: null, settled: false, settledTx: null };
        ep.probes += 1;
        ep.totalPoints += int(a.passed);
        L.epochs.set(k, ep);
        break;
      }
      case "Penalized": {
        const vault = addr(str(a.vault));
        const ts = tsOf(e.block);
        L.penalties.push({
          campaignId: id,
          vault,
          reporter: addr(str(a.reporter)),
          slashed: str(a.slashed),
          toReporter: str(a.toReporter),
          txHash: e.txHash,
          ts,
          pointsForfeited: int(a.pointsForfeited),
        });
        const reg = L.regs.get(key(id, lc(vault)));
        if (reg) reg.bond -= BigInt(str(a.slashed));
        const forfeited = int(a.pointsForfeited);
        const c = camp.get(id);
        if (forfeited > 0 && c) {
          const epoch = Math.floor((ts - c.state.startTime) / c.terms.epochLength);
          const s = L.scores.get(key(id, epoch, lc(vault)));
          if (s) s.points = 0;
          const ep = L.epochs.get(key(id, epoch));
          if (ep) ep.totalPoints -= forfeited;
        }
        break;
      }
      case "EpochSettled": {
        const epoch = int(a.epoch);
        const k = key(id, epoch);
        const ep = L.epochs.get(k) ?? { probes: 0, totalPoints: 0, makerPot: null, refunded: null, settled: false, settledTx: null };
        ep.probes = int(a.probes);
        ep.totalPoints = int(a.totalPoints);
        ep.makerPot = str(a.makerPot);
        ep.refunded = str(a.refunded);
        ep.settled = true;
        ep.settledTx = e.txHash;
        L.epochs.set(k, ep);
        break;
      }
      case "RewardCredited": {
        const epoch = int(a.epoch);
        const vault = addr(str(a.vault));
        const k = key(id, epoch, lc(vault));
        const s = L.scores.get(k);
        const amount = BigInt(str(a.amount));
        if (s) {
          s.reward = (s.reward ?? 0n) + amount;
          s.maker = lc(str(a.maker));
        } else {
          L.scores.set(k, { campaignId: id, epoch, vault, maker: lc(str(a.maker)), points: int(a.points), checks: 0, reward: amount });
        }
        break;
      }
      default:
        break;
    }
  }
  return L;
}

// -------------------------------------------------------------------------------------------------
// Probe views
// -------------------------------------------------------------------------------------------------

function probeViews(L: Ledger, rows: DProbe[], gas: Map<string, number | null> | null): ProbeView[] {
  const byProbe = new Map<string, DResult[]>();
  for (const r of L.results) {
    const k = key(r.campaignId, r.nonce);
    const list = byProbe.get(k);
    if (list) list.push(r);
    else byProbe.set(k, [r]);
  }
  return rows.map((p) => ({
    campaignId: p.campaignId,
    epoch: p.epoch,
    nonce: p.nonce,
    txHash: p.txHash,
    block: p.block,
    ts: p.ts,
    prober: p.prober,
    checked: p.checked,
    passed: p.passed,
    fee: p.fee,
    gasUsed: gas?.get(p.txHash) ?? null,
    // The indexer reads these back in key order (by vault address), so the same order here.
    results: [...(byProbe.get(key(p.campaignId, p.nonce)) ?? [])]
      .sort((a, b) => (lc(a.vault) < lc(b.vault) ? -1 : lc(a.vault) > lc(b.vault) ? 1 : 0))
      .map((r) => ({ vault: r.vault, passed: r.passed, failMask: r.failMask, spreadBps: r.spreadBps })),
  }));
}

/** Gas by transaction, from a snapshot's probe rows; whatever the snapshot did not measure stays unknown. */
export function gasIndex(probes: ProbeView[] | undefined): Map<string, number | null> {
  return new Map((probes ?? []).map((p) => [p.txHash, p.gasUsed]));
}

// -------------------------------------------------------------------------------------------------
// Campaign detail
// -------------------------------------------------------------------------------------------------

export function deriveCampaignDetail(L: Ledger, campaign: CampaignView, gas: Map<string, number | null> | null): CampaignDetail {
  const id = campaign.id;
  const regs = [...L.regs.entries()].filter(([k]) => k.startsWith(`${id}:`)).map(([, r]) => r);
  const scores = [...L.scores.values()].filter((s) => s.campaignId === id);
  const penaltiesOf = L.penalties.filter((p) => p.campaignId === id);

  const leaderboard: LeaderboardRow[] = regs.map((r) => {
    const mine = scores.filter((s) => lc(s.vault) === lc(r.vault));
    const points = mine.reduce((a, s) => a + s.points, 0);
    const checks = mine.reduce((a, s) => a + s.checks, 0);
    const earned = mine.reduce((a, s) => a + (s.reward ?? 0n), 0n);
    const spreads = L.results
      .filter((x) => x.campaignId === id && lc(x.vault) === lc(r.vault) && x.spreadBps !== CROSSED)
      .sort((a, b) => b.ts - a.ts || b.nonce - a.nonce)
      .slice(0, 500)
      .map((x) => x.spreadBps);
    return {
      vault: r.vault,
      maker: r.maker,
      points,
      checks,
      uptime: checks ? points / checks : null,
      earned: earned.toString(),
      bond: r.bond.toString(),
      status: r.status,
      medianSpreadBps: median(spreads),
      penalties: penaltiesOf.filter((p) => lc(p.vault) === lc(r.vault)).length,
    };
  });
  leaderboard.sort((a, b) => b.points - a.points || (a.medianSpreadBps ?? 1e9) - (b.medianSpreadBps ?? 1e9));

  const epochs: EpochView[] = [];
  for (let e = 0; e < campaign.numEpochs; e++) {
    const r = L.epochs.get(key(id, e));
    epochs.push({
      epoch: e,
      start: campaign.startTime + e * campaign.epochLength,
      end: campaign.startTime + (e + 1) * campaign.epochLength,
      probes: r?.probes ?? 0,
      totalPoints: r?.totalPoints ?? 0,
      makerPot: r?.makerPot ?? null,
      refunded: r?.refunded ?? null,
      // The contract's own count of settled epochs wins over an event not read yet.
      settled: (r?.settled ?? false) || e < campaign.settledEpochs,
      settledTx: r?.settledTx ?? null,
    });
  }

  const recent = L.probes
    .filter((p) => p.campaignId === id)
    .sort((a, b) => b.nonce - a.nonce)
    .slice(0, 50);
  const penalties: PenaltyView[] = [...penaltiesOf]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 50)
    .map(({ pointsForfeited: _p, ...p }) => p);
  return { campaign, leaderboard, epochs, recentProbes: probeViews(L, recent, gas), penalties };
}

// -------------------------------------------------------------------------------------------------
// Markets
// -------------------------------------------------------------------------------------------------

/** The best passing bid and ask per probe, and depth around the mid, from ProbeResult rows that passed. */
function verifiedBook(L: Ledger, campaignIds: Set<number>, from: number, bands: number[], baseDecimals: number, quoteDecimals: number) {
  const rows = L.results
    .filter((r) => campaignIds.has(r.campaignId) && r.ts >= from && r.passed)
    .sort((a, b) => a.ts - b.ts || a.campaignId - b.campaignId || a.nonce - b.nonce);
  const byProbe = new Map<string, DResult[]>();
  for (const r of rows) {
    const k = key(r.campaignId, r.nonce);
    const list = byProbe.get(k);
    if (list) list.push(r);
    else byProbe.set(k, [r]);
  }
  const askAt: bigint[][] = bands.map(() => []);
  const bidAt: bigint[][] = bands.map(() => []);
  const spreads: number[] = [];
  let last: { bid: bigint; ask: bigint; ts: number } | null = null;
  for (const group of byProbe.values()) {
    let bestBid = 0n;
    let bestAsk = 0n;
    for (const q of group) {
      const bid = BigInt(q.bidPx);
      const ask = BigInt(q.askPx);
      if (BigInt(q.bidSize) > 0n && bid > bestBid) bestBid = bid;
      if (BigInt(q.askSize) > 0n && (bestAsk === 0n || ask < bestAsk)) bestAsk = ask;
    }
    if (bestBid === 0n || bestAsk === 0n || bestAsk <= bestBid) continue;
    last = { bid: bestBid, ask: bestAsk, ts: group[0]?.ts ?? 0 };
    spreads.push(Number(spreadBps(bestBid, bestAsk)));
    const mid = (bestBid + bestAsk) / 2n;
    bands.forEach((bps, bi) => {
      let askBase = 0n;
      let bidQuote = 0n;
      for (const q of group) {
        const ask = BigInt(q.askPx);
        const bid = BigInt(q.bidPx);
        if (ask * 10_000n <= mid * BigInt(10_000 + bps)) askBase += BigInt(q.askSize);
        if (bid * 10_000n >= mid * BigInt(10_000 - bps)) bidQuote += quoteNotional(BigInt(q.bidSize), bid, baseDecimals, quoteDecimals);
      }
      (askAt[bi] as bigint[]).push(askBase);
      (bidAt[bi] as bigint[]).push(bidQuote);
    });
  }
  return { spreads, askAt, bidAt, last };
}

export interface MarketDerived {
  verified: VerifiedFigures;
  uptime24h: number | null;
  probes24h: number;
  lastProbeAt: number | null;
}

/** A market's probe-verified figures, over every probe its campaigns have had. */
export function deriveMarket(L: Ledger, campaignIds: number[], base: TokenRef, quote: TokenRef, now: number): MarketDerived {
  const ids = new Set(campaignIds);
  const probes = L.probes.filter((p) => ids.has(p.campaignId));
  const checked = probes.filter((p) => p.checked > 0);
  const covered = checked.filter((p) => p.passed > 0).length;
  const book = verifiedBook(L, ids, 0, [50], base.decimals, quote.decimals);
  const since = now - 86_400;
  const recent = checked.filter((p) => p.ts >= since);
  return {
    verified: {
      probes: checked.length,
      uptime: checked.length ? covered / checked.length : null,
      from: checked.length ? Math.min(...checked.map((p) => p.ts)) : null,
      to: checked.length ? Math.max(...checked.map((p) => p.ts)) : null,
      medianSpreadBps: median(book.spreads),
      lastBidPx: book.last?.bid.toString() ?? null,
      lastAskPx: book.last?.ask.toString() ?? null,
      lastVerifiedAt: book.last?.ts ?? null,
      bidDepth50: medianBig(book.bidAt[0] ?? []).toString(),
      askDepth50: medianBig(book.askAt[0] ?? []).toString(),
    },
    uptime24h: recent.length ? recent.filter((p) => p.passed > 0).length / recent.length : null,
    probes24h: recent.length,
    lastProbeAt: probes.length ? Math.max(...probes.map((p) => p.ts)) : null,
  };
}

/** A vault's pass rate over its ProbeResult rows since `since`, or null if none. */
export function deriveVaultUptime(L: Ledger, vault: string, since: number): number | null {
  const rows = L.results.filter((r) => lc(r.vault) === lc(vault) && r.ts >= since);
  return rows.length ? rows.filter((r) => r.passed).length / rows.length : null;
}

/** QuoteView.uptime24h for every vault in a book. */
export function withVaultUptime(L: Ledger, book: QuoteView[], now: number): QuoteView[] {
  return book.map((q) => ({ ...q, uptime24h: deriveVaultUptime(L, q.vault, now - 86_400) }));
}

// -------------------------------------------------------------------------------------------------
// Uptime timeline
// -------------------------------------------------------------------------------------------------

const parseWindow = (w: string | undefined, fallback = 86_400): number => {
  if (!w) return fallback;
  const m = /^(\d+)([mhd])$/.exec(w);
  if (!m) return fallback;
  return Math.min(Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86_400), 30 * 86_400);
};

/** A span ("24h") ends now; "all" runs from the first campaign's start to the last one's end, capped at now. */
export function windowRange(campaigns: CampaignView[], window: string | undefined, fallback: number, now: number): { from: number; to: number } {
  if (window !== "all") return { from: now - parseWindow(window, fallback), to: now };
  if (campaigns.length === 0) return { from: now - fallback, to: now };
  const a = Math.min(...campaigns.map((c) => c.startTime));
  const b = Math.max(...campaigns.map((c) => c.startTime + c.numEpochs * c.epochLength));
  return { from: a, to: Math.min(b, now) };
}

export function deriveUptime(L: Ledger, campaigns: CampaignView[], pair: string, window: string | undefined, now: number): UptimeResponse {
  const ids = new Set(campaigns.map((c) => c.id));
  const { from, to } = windowRange(campaigns, window, 86_400, now);
  const span = Math.max(60, to - from);
  const bucketSeconds = Math.max(60, Math.ceil(span / 60 / 60) * 60);
  const probeRows = L.probes.filter((p) => ids.has(p.campaignId) && p.ts >= from && p.ts <= to).sort((a, b) => b.ts - a.ts || b.nonce - a.nonce);
  const resultRows = L.results.filter((r) => ids.has(r.campaignId) && r.ts >= from && r.ts <= to);

  const buckets = new Map<number, UptimeBucket & { spreads: number[] }>();
  const bucketOf = (ts: number) => {
    const t = Math.floor(ts / bucketSeconds) * bucketSeconds;
    let b = buckets.get(t);
    if (!b) {
      b = { t, probes: 0, covered: 0, vaultChecks: 0, vaultPasses: 0, medianSpreadBps: null, spreads: [] };
      buckets.set(t, b);
    }
    return b;
  };
  // Every bucket in the window exists, so a stretch without probes reads as zero, not as a gap.
  for (let t = Math.floor(from / bucketSeconds) * bucketSeconds; t <= to; t += bucketSeconds) bucketOf(t);
  let checkedProbes = 0;
  let covered = 0;
  for (const p of probeRows) {
    if (p.checked === 0) continue;
    const b = bucketOf(p.ts);
    b.probes += 1;
    checkedProbes += 1;
    if (p.passed > 0) {
      b.covered += 1;
      covered += 1;
    }
  }
  for (const r of resultRows) {
    const b = bucketOf(r.ts);
    b.vaultChecks += 1;
    b.vaultPasses += r.passed ? 1 : 0;
    if (r.spreadBps !== CROSSED) b.spreads.push(r.spreadBps);
  }
  const out: UptimeBucket[] = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(({ spreads, ...b }) => ({ ...b, medianSpreadBps: median(spreads) }));
  return {
    pair,
    window: window ?? "24h",
    from,
    to,
    bucketSeconds,
    uptime: checkedProbes ? covered / checkedProbes : null,
    buckets: out,
    probes: probeViews(L, probeRows.slice(0, 200), null),
  };
}

// -------------------------------------------------------------------------------------------------
// Maker
// -------------------------------------------------------------------------------------------------

export function deriveMakerScores(
  L: Ledger,
  address: string,
  ownedVaults: string[],
  now: number,
  rewardMeta: (campaignId: number) => { token: Address; symbol: string; decimals: number } | null,
): Pick<MakerProfile, "scores" | "totalEarned" | "uptime24h"> {
  const owned = new Set(ownedVaults.map(lc));
  const rows = [...L.scores.values()]
    .filter((s) => lc(s.maker) === lc(address) || owned.has(lc(s.vault)))
    .sort((a, b) => a.campaignId - b.campaignId || a.epoch - b.epoch);
  const earned = new Map<string, { token: Address; symbol: string; decimals: number; amount: bigint }>();
  for (const s of rows) {
    if (s.reward === null) continue;
    const meta = rewardMeta(s.campaignId);
    if (!meta) continue;
    const cur = earned.get(lc(meta.token));
    if (cur) cur.amount += s.reward;
    else earned.set(lc(meta.token), { ...meta, amount: s.reward });
  }
  const since = now - 86_400;
  let checks = 0;
  let passes = 0;
  for (const r of L.results) {
    if (!owned.has(lc(r.vault)) || r.ts < since) continue;
    checks += 1;
    if (r.passed) passes += 1;
  }
  return {
    scores: rows.map((s) => ({
      campaignId: s.campaignId,
      epoch: s.epoch,
      vault: s.vault,
      points: s.points,
      checks: s.checks,
      reward: s.reward === null ? null : s.reward.toString(),
    })),
    totalEarned: [...earned.values()].map((e) => ({ token: e.token, symbol: e.symbol, decimals: e.decimals, amount: e.amount.toString() })),
    uptime24h: checks ? passes / checks : null,
  };
}

/** A wallet's registrations, from MakerRegistered, bond and unbond events. */
export function deriveRegistrations(L: Ledger, address: string): RegistrationView[] {
  return [...L.regs.entries()]
    .filter(([, r]) => lc(r.maker) === lc(address))
    .map(([k, r]) => ({
      campaignId: int(k.split(":")[0]),
      vault: r.vault,
      maker: r.maker,
      bond: r.bond.toString(),
      status: r.status,
      registeredAt: r.registeredAt,
    }))
    .sort((a, b) => a.campaignId - b.campaignId);
}

// -------------------------------------------------------------------------------------------------
// Depth report
// -------------------------------------------------------------------------------------------------

export function deriveReport(
  L: Ledger,
  campaigns: CampaignView[],
  vaultOwner: (vault: string) => string | null,
  base: TokenRef,
  quote: TokenRef,
  pair: string,
  window: string | undefined,
  now: number,
  contracts: DepthReport["contracts"],
): DepthReport {
  const ids = new Set(campaigns.map((c) => c.id));
  const { from, to } = windowRange(campaigns, window, 7 * 86_400, now);
  const inWindow = L.probes.filter((p) => ids.has(p.campaignId) && p.ts >= from && p.checked > 0);
  const bands = [25, 50];
  const { spreads, askAt, bidAt } = verifiedBook(L, ids, from, bands, base.decimals, quote.decimals);

  const counted = new Map<string, { n: number; covered: number }>();
  for (const p of inWindow) {
    const k = key(p.campaignId, p.epoch);
    const cur = counted.get(k) ?? { n: 0, covered: 0 };
    cur.n += 1;
    if (p.passed > 0) cur.covered += 1;
    counted.set(k, cur);
  }
  const epochs: EpochUptime[] = [];
  for (const c of [...campaigns].sort((a, b) => a.id - b.id)) {
    for (let e = 0; e < c.numEpochs; e++) {
      const start = c.startTime + e * c.epochLength;
      const end = start + c.epochLength;
      if (start >= to || end <= from) continue;
      const r = counted.get(key(c.id, e));
      epochs.push({ campaignId: c.id, epoch: e, start, end, probes: r?.n ?? 0, covered: r?.covered ?? 0 });
    }
  }
  const owners = new Set<string>();
  for (const r of L.results) {
    if (!ids.has(r.campaignId) || r.ts < from) continue;
    const o = vaultOwner(r.vault);
    if (o) owners.add(lc(o));
  }
  const log = L.probes
    .filter((p) => ids.has(p.campaignId) && p.ts >= from)
    .sort((a, b) => b.ts - a.ts || b.nonce - a.nonce)
    .slice(0, 300);
  return {
    token: base,
    pair,
    quote,
    generatedAt: to,
    windowFrom: from,
    windowTo: to,
    verifiedUptime: inWindow.length ? inWindow.filter((p) => p.passed > 0).length / inWindow.length : null,
    probes: inWindow.length,
    vaultChecks: inWindow.reduce((a, p) => a + p.checked, 0),
    medianSpreadBps: median(spreads),
    makers: owners.size,
    depth: bands.map((bps, i) => ({ bps, askBase: medianBig(askAt[i] as bigint[]).toString(), bidQuote: medianBig(bidAt[i] as bigint[]).toString() })),
    campaigns: [...ids].sort((a, b) => a - b),
    epochs,
    probeLog: probeViews(L, log, null),
    contracts,
  };
}

/** Every probe on a market's campaigns, newest first: the log behind a depth report. */
export function deriveProbeLog(L: Ledger, campaigns: CampaignView[], gas: Map<string, number | null> | null): ProbeView[] {
  const ids = new Set(campaigns.map((c) => c.id));
  const rows = L.probes.filter((p) => ids.has(p.campaignId)).sort((a, b) => b.ts - a.ts || b.nonce - a.nonce);
  return probeViews(L, rows, gas);
}

// -------------------------------------------------------------------------------------------------
// Economics
// -------------------------------------------------------------------------------------------------

export interface ProbeTotals {
  totalProbes: number;
  firstProbeAt: number | null;
  lastProbeAt: number | null;
  /** Probes in the last 24 hours, per hour since the first of them; null if none. */
  probesPerHour: number | null;
}

export function deriveProbeTotals(L: Ledger, now: number): ProbeTotals {
  const ts = L.probes.map((p) => p.ts);
  const since = now - 86_400;
  const recent = ts.filter((t) => t >= since);
  const hours = recent.length ? Math.max(1 / 60, (now - Math.min(...recent)) / 3600) : 0;
  return {
    totalProbes: L.probes.length,
    firstProbeAt: ts.length ? Math.min(...ts) : null,
    lastProbeAt: ts.length ? Math.max(...ts) : null,
    probesPerHour: recent.length ? recent.length / hours : null,
  };
}
