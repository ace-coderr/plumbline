import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { zeroAddress } from "viem";
import {
  TIMED_EVENTS,
  buildLedger,
  deriveCampaignDetail,
  deriveMakerScores,
  deriveMarket,
  deriveProbeTotals,
  deriveRegistrations,
  deriveUptime,
  deriveVaultUptime,
  historyComplete,
} from "../src/derive.js";
import { campaignSources } from "../src/campaignIds.js";
import type { CampaignView } from "../src/api.js";
import type { ChainCampaign, LiveLog } from "../src/liveReader.js";
import type { LiveData } from "../src/liveMerge.js";
import type { Address, TokenRef } from "../src/pairs.js";

const A: Address = "0x00000000000000000000000000000000000000a1";
const B: Address = "0x00000000000000000000000000000000000000b2";
const MAKER_A: Address = "0x00000000000000000000000000000000000000c1";
const MAKER_B: Address = "0x00000000000000000000000000000000000000c2";
const PROBER: Address = "0x00000000000000000000000000000000000000d1";
const PX = 10n ** 18n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

const base: TokenRef = { address: "0x00000000000000000000000000000000000000e1", symbol: "BASE", decimals: 18, demo: false };
const quote: TokenRef = { address: "0x00000000000000000000000000000000000000e2", symbol: "QUOTE", decimals: 6, demo: true };

const START = 1_000_000;
const EPOCH = 300;
const ID = 1_000_001; // a v2 campaign id

const chainCampaign: ChainCampaign = {
  id: ID,
  terms: {
    base: base.address,
    quote: quote.address,
    epochLength: EPOCH,
    rewardPerEpoch: "1000",
    maxSpreadBps: 30,
    minDepthBase: "1",
    minDepthQuote: "1",
    minProbeInterval: 13,
    probeFeeBps: 10,
    makerBond: "100",
  },
  state: { creator: A, rewardToken: zeroAddress, referencePrice: zeroAddress, startTime: START, numEpochs: 2, settledEpochs: 0, lastProbeAt: 0, probeNonce: 0 },
};

const view: CampaignView = {
  id: ID,
  pair: "BASE-QUOTE",
  base,
  quote,
  creator: A,
  rewardToken: zeroAddress,
  rewardSymbol: "HYPE",
  rewardDecimals: 18,
  startTime: START,
  numEpochs: 2,
  epochLength: EPOCH,
  rewardPerEpoch: "1000",
  maxSpreadBps: 30,
  minDepthBase: "1",
  minDepthQuote: "1",
  minProbeInterval: 13,
  probeFeeBps: 10,
  makerBond: "100",
  referencePrice: zeroAddress,
  openedTx: TX(1),
  currentEpoch: 0,
  settledEpochs: 0,
  totalProbes: 0,
  lastProbeAt: null,
};

let idx = 0;
const ev = (name: LiveLog["name"], block: number, args: LiveLog["args"]): LiveLog => ({ name, block, logIndex: idx++, txHash: TX(100 + idx), args });
const times: Record<number, number> = {};
const at = (block: number, ts: number) => {
  times[block] = ts;
  return block;
};

/** quote a vault posts: bid just under 100, ask just over, sizes 5 base. */
const result = (block: number, nonce: number, vault: Address, passed: boolean, bid: bigint, ask: bigint, spread: number, epoch = 0): LiveLog =>
  ev("ProbeResult", block, {
    id: String(ID), epoch, vault, nonce, passed, failMask: passed ? 0 : 1, spreadBps: spread,
    bidPx: String(bid), askPx: String(ask), bidSize: "5000000", askSize: String(5n * PX),
  });
const probed = (block: number, nonce: number, checked: number, passed: number, epoch = 0): LiveLog =>
  ev("Probed", block, { id: String(ID), epoch, prober: PROBER, nonce, checked, passed, fee: "7", referencePx: String(100n * PX) });

const events: LiveLog[] = [
  ev("CampaignOpened", at(10, START - 5), { id: String(ID) }),
  ev("MakerRegistered", at(11, START), { id: String(ID), vault: A, maker: MAKER_A, bond: "100" }),
  ev("MakerRegistered", at(12, START), { id: String(ID), vault: B, maker: MAKER_B, bond: "100" }),
  // probe 0: both pass, A tighter
  result(at(20, START + 20), 0, A, true, 99_950_000n * 10n ** 10n, 100_050_000n * 10n ** 10n, 10),
  result(20, 0, B, true, 99_900_000n * 10n ** 10n, 100_100_000n * 10n ** 10n, 20),
  probed(20, 0, 2, 2),
  // probe 1: only B passes
  result(at(30, START + 60), 1, A, false, 98n * PX, 102n * PX, 400),
  result(30, 1, B, true, 99_900_000n * 10n ** 10n, 100_100_000n * 10n ** 10n, 20),
  probed(30, 1, 2, 1),
  // probe 2: nobody home, nothing checked
  probed(at(40, START + 100), 2, 0, 0),
  // A is slashed in epoch 0 and forfeits its one point
  ev("Penalized", at(50, START + 120), { id: String(ID), vault: A, reporter: PROBER, slashed: "20", toReporter: "10", toMakers: "10", pointsForfeited: 1 }),
  ev("EpochSettled", at(60, START + EPOCH + 5), { id: String(ID), epoch: 0, makerPot: "900", totalPoints: 1, probes: 3, refunded: "0" }),
  ev("RewardCredited", 60, { id: String(ID), epoch: 0, vault: B, maker: MAKER_B, amount: "900", points: 1 }),
];

const L = buildLedger(events, times, [chainCampaign], 5);

describe("derive: the ledger", () => {
  it("knows every block time it needs", () => {
    assert.equal(L.timesKnown, true);
    const missing = buildLedger(events, {}, [chainCampaign], 5);
    assert.equal(missing.timesKnown, false, "a missing block time is flagged, never guessed");
  });

  it("counts probes and results", () => {
    assert.equal(L.probes.length, 3);
    assert.equal(L.results.length, 4);
  });
});

describe("derive: campaign detail", () => {
  const d = deriveCampaignDetail(L, view, null);

  it("scores makers, with the slashed epoch's points forfeited", () => {
    const a = d.leaderboard.find((r) => same(r.vault, A))!;
    const b = d.leaderboard.find((r) => same(r.vault, B))!;
    assert.deepEqual([a.points, a.checks, a.uptime], [0, 2, 0], "A passed once, then forfeited it");
    assert.deepEqual([b.points, b.checks, b.uptime], [2, 2, 1]);
    assert.ok(same(d.leaderboard[0]?.vault ?? "", B), "most points first");
  });

  it("takes the slash off the bond and counts it", () => {
    const a = d.leaderboard.find((r) => same(r.vault, A))!;
    assert.equal(a.bond, "80");
    assert.equal(a.penalties, 1);
    assert.equal(d.penalties.length, 1);
    assert.equal(d.penalties[0]?.slashed, "20");
  });

  it("credits the reward and settles the epoch from its event", () => {
    assert.equal(d.leaderboard.find((r) => same(r.vault, B))?.earned, "900");
    const e0 = d.epochs[0]!;
    assert.deepEqual([e0.settled, e0.makerPot, e0.probes, e0.totalPoints], [true, "900", 3, 1]);
    assert.equal(d.epochs[1]?.settled, false);
    assert.equal(d.epochs[1]?.start, START + EPOCH);
  });

  it("lists probes newest first, with results in vault-address order", () => {
    assert.deepEqual(d.recentProbes.map((p) => p.nonce), [2, 1, 0]);
    const p0 = d.recentProbes[2]!;
    assert.deepEqual(p0.results.map((r) => r.vault.toLowerCase()), [A, B]);
    assert.equal(p0.ts, START + 20);
  });

  it("takes a probe's gas from the snapshot only where it measured it", () => {
    const withGas = deriveCampaignDetail(L, view, new Map([[d.recentProbes[0]!.txHash, 123_456]]));
    assert.equal(withGas.recentProbes[0]?.gasUsed, 123_456);
    assert.equal(withGas.recentProbes[1]?.gasUsed, null);
  });
});

describe("derive: markets", () => {
  const NOW = START + 400;
  const m = deriveMarket(L, [ID], base, quote, NOW);

  it("counts only probes that checked a vault", () => {
    assert.equal(m.verified.probes, 2);
    assert.equal(m.verified.uptime, 1, "both checked probes found a passing quote");
    assert.deepEqual([m.verified.from, m.verified.to], [START + 20, START + 60]);
  });

  it("takes the best passing bid and ask per probe", () => {
    // probe 0: best bid is A's, best ask is A's: spread 10 bps. probe 1: only B passed: 20 bps.
    assert.equal(m.verified.medianSpreadBps, 15);
    assert.equal(m.verified.lastBidPx, String(99_900_000n * 10n ** 10n));
    assert.equal(m.verified.lastAskPx, String(100_100_000n * 10n ** 10n));
    assert.equal(m.verified.lastVerifiedAt, START + 60);
  });

  it("measures 24h from the time it is given, not the visitor's clock", () => {
    assert.equal(m.probes24h, 2);
    const later = deriveMarket(L, [ID], base, quote, START + 3 * 86_400);
    assert.deepEqual([later.probes24h, later.uptime24h], [0, null], "nothing in the last 24h is null, never zero percent");
    assert.equal(later.verified.probes, 2, "the all-time figures do not move");
  });

  it("a vault's pass rate over a window", () => {
    assert.equal(deriveVaultUptime(L, A, 0), 0.5);
    assert.equal(deriveVaultUptime(L, B, 0), 1);
    assert.equal(deriveVaultUptime(L, A, START + 1000), null);
  });
});

describe("derive: timeline, maker and totals", () => {
  it("buckets probes over the campaign window with empty stretches as zeros", () => {
    const u = deriveUptime(L, [view], "BASE-QUOTE", "all", START + 10_000);
    assert.equal(u.from, START);
    assert.equal(u.to, START + 2 * EPOCH, "capped at the last campaign's end");
    assert.ok(u.buckets.length > 1);
    assert.equal(u.buckets.reduce((a, b) => a + b.probes, 0), 2);
    assert.equal(u.uptime, 1);
  });

  it("a maker's scores, earnings and registrations", () => {
    const s = deriveMakerScores(L, MAKER_B, [B], START + 400, () => ({ token: zeroAddress, symbol: "HYPE", decimals: 18 }));
    assert.deepEqual(s.scores.map((x) => [x.epoch, x.points, x.checks, x.reward]), [[0, 2, 2, "900"]]);
    assert.deepEqual(s.totalEarned.map((x) => x.amount), ["900"]);
    assert.equal(s.uptime24h, 1);
    const r = deriveRegistrations(L, MAKER_A);
    assert.deepEqual(r.map((x) => [x.campaignId, x.bond, x.status]), [[ID, "80", "active"]]);
  });

  it("probe totals", () => {
    const t = deriveProbeTotals(L, START + 400);
    assert.deepEqual([t.totalProbes, t.firstProbeAt, t.lastProbeAt], [3, START + 20, START + 100]);
    assert.ok((t.probesPerHour ?? 0) > 0);
  });
});

describe("derive: when the history counts as complete", () => {
  const first = Math.min(...campaignSources.map((s) => s.deployBlock));
  const live = (over: Partial<LiveData>): LiveData => ({
    views: { head: 100, headTs: START + 400, campaignCount: 1, campaigns: [chainCampaign], vaultCount: 0, vaults: [], tokens: {}, avgBlockMs: null, capped: { campaigns: false, vaults: false } },
    events,
    historyFrom: first,
    blockTimes: times,
    fills: [],
    failedFills: [],
    snapshotBlock: 50,
    scannedThrough: 100,
    scanComplete: true,
    ...over,
  });

  it("is complete only when scanned from the first deploy block with every time known", () => {
    assert.equal(historyComplete(live({})), true);
    assert.equal(historyComplete(live({ scanComplete: false })), false, "still scanning");
    assert.equal(historyComplete(live({ historyFrom: first + 1 })), false, "history starts too late");
    assert.equal(historyComplete(live({ blockTimes: {} })), false, "a block time is missing");
    assert.equal(historyComplete(live({ views: null })), false, "nothing read from the chain yet");
  });

  it("names the events whose block time it needs", () => {
    for (const n of ["Probed", "ProbeResult", "Penalized", "MakerRegistered"]) assert.ok(TIMED_EVENTS.has(n));
    assert.ok(!TIMED_EVENTS.has("EpochSettled"));
  });
});
