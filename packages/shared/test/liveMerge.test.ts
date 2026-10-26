import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { zeroAddress } from "viem";
import type { CampaignDetail, CampaignView, MarketDetail, MarketSummary } from "../src/api.js";
import type { ChainCampaign, ChainVault, ChainViews, LiveLog } from "../src/liveReader.js";
import {
  chainNow,
  liveCounts,
  mergeCampaignDetail,
  mergeCampaigns,
  mergeEconomics,
  mergeMarket,
  mergeMarkets,
  mergeScorecard,
  type LiveData,
} from "../src/liveMerge.js";
import type { VaultScorecardData } from "../src/scorecard.js";

const SNAP = new URL("../../../apps/web/public/snapshot/", import.meta.url);
const read = <T>(f: string): T => JSON.parse(readFileSync(new URL(f, SNAP), "utf8")) as T;

const snapCampaigns = read<CampaignView[]>("campaigns.json");
const snapMarkets = read<MarketSummary[]>("markets.json");
const snapMarket = read<MarketDetail>("markets/WHYPE-PLUMBUSD.json");
const snapDetail1 = read<CampaignDetail>("campaigns/1.json");
const snapCard = read<VaultScorecardData>("scorecards/0x714daee721b93b3cc6b81eb9a2290a92e331c0e0.json");

const SNAPSHOT_BLOCK = 12_049_937;
const WHYPE = snapCampaigns[0]!.base;
const PLUMBUSD = snapCampaigns[0]!.quote;
const NEW_OWNER = "0x8557FABdC62f59A1bA7D6a74aaf0942CDcb68F69";
const NEW_VAULT = "0x355839a757B312403D4E90A3d4b506F4954d5bF4";
const NEW_TX = `0x${"ee".repeat(32)}` as const;
const T0 = 1_792_900_000; // chain time at the head block

const chainCampaign = (c: CampaignView): ChainCampaign => ({
  id: c.id,
  terms: {
    base: c.base.address, quote: c.quote.address, epochLength: c.epochLength, rewardPerEpoch: c.rewardPerEpoch, maxSpreadBps: c.maxSpreadBps,
    minDepthBase: c.minDepthBase, minDepthQuote: c.minDepthQuote, minProbeInterval: c.minProbeInterval, probeFeeBps: c.probeFeeBps, makerBond: c.makerBond,
  },
  state: {
    creator: c.creator, rewardToken: c.rewardToken, referencePrice: c.referencePrice, startTime: c.startTime, numEpochs: c.numEpochs,
    settledEpochs: c.settledEpochs, lastProbeAt: c.lastProbeAt ?? 0, probeNonce: c.totalProbes,
  },
});

const newCampaign: ChainCampaign = {
  id: 3,
  terms: { ...chainCampaign(snapCampaigns[0]!).terms, epochLength: 300, rewardPerEpoch: "1000000000000000", makerBond: "1000000000000000" },
  state: { creator: NEW_OWNER as `0x${string}`, rewardToken: zeroAddress, referencePrice: zeroAddress, startTime: T0 - 700, numEpochs: 12, settledEpochs: 1, lastProbeAt: T0 - 100, probeNonce: 2 },
};

const vault = (address: string, owner: string, live: boolean, over: Partial<ChainVault> = {}): ChainVault => ({
  address: address as `0x${string}`, owner: owner as `0x${string}`, quoter: zeroAddress, createdAt: 1, base: WHYPE.address, quote: PLUMBUSD.address, live,
  quoteData: { bidPx: "0", askPx: "0", bidSize: "0", askSize: "0", updatedAt: 0, seq: 0 }, freeBase: "0", freeQuote: "0", ...over,
});

const baseVaults = (): ChainVault[] =>
  snapMarket.book.map((q) => vault(q.vault, q.owner, false)).concat(
    // the USDC vault from the other market
    [vault("0x7D59e73a049680F9476c704e7142f9B7EA83F6Dd", "0x2465E835FAB3B9F07d6478177416611D11F46E03", false, { quote: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2" })],
  );

function views(over: Partial<ChainViews> = {}): ChainViews {
  const campaigns = [...snapCampaigns.map(chainCampaign).sort((a, b) => a.id - b.id), newCampaign];
  const vaults = [...baseVaults(), vault(NEW_VAULT, NEW_OWNER, false)];
  return {
    head: 16_200_000, headTs: T0, campaignCount: 3, campaigns, vaultCount: vaults.length, vaults,
    tokens: { [WHYPE.address.toLowerCase()]: { symbol: "WHYPE", decimals: 18 }, [PLUMBUSD.address.toLowerCase()]: { symbol: "PLUMBUSD", decimals: 6 } },
    capped: { campaigns: false, vaults: false }, ...over,
  };
}

const log = (name: LiveLog["name"], block: number, logIndex: number, args: LiveLog["args"], txHash: `0x${string}` = NEW_TX): LiveLog => ({ name, block, logIndex, txHash, args });

const opened = log("CampaignOpened", 16_134_623, 0, { id: "3" });
const registered = log("MakerRegistered", 16_134_700, 0, { id: "3", vault: NEW_VAULT, maker: NEW_OWNER, bond: "1000000000000000" });
const probed = log("Probed", 16_135_000, 0, { id: "3", epoch: "0", prober: NEW_OWNER, nonce: "0", checked: "1", passed: "1", fee: "5", referencePx: "0" });
const result = log("ProbeResult", 16_135_000, 1, { id: "3", epoch: "0", vault: NEW_VAULT, nonce: "0", passed: true, failMask: 0, spreadBps: 11, bidPx: "1", askPx: "2", bidSize: "3", askSize: "4" });
const settled = log("EpochSettled", 16_136_000, 0, { id: "3", epoch: "0", makerPot: "900", totalPoints: "1", probes: "1", refunded: "0" });
const times = { 16_134_623: T0 - 650, 16_134_700: T0 - 640, 16_135_000: T0 - 600, 16_136_000: T0 - 300 };

const liveData = (over: Partial<LiveData> = {}): LiveData => ({
  views: views(), events: [], blockTimes: times, snapshotBlock: SNAPSHOT_BLOCK, scannedThrough: 16_200_000, scanComplete: true, ...over,
});

describe("mergeCampaigns", () => {
  it("shows a campaign created after the snapshot, with its opening transaction", () => {
    const merged = mergeCampaigns(snapCampaigns, liveData({ events: [opened] }), T0);
    assert.equal(merged.length, 3);
    const c = merged.find((x) => x.id === 3)!;
    assert.equal(c.creator, NEW_OWNER);
    assert.equal(c.rewardSymbol, "HYPE");
    assert.equal(c.pair, "WHYPE-PLUMBUSD");
    assert.equal(c.openedTx, NEW_TX);
    assert.equal(c.totalProbes, 2);
    assert.equal(c.settledEpochs, 1);
    assert.equal(c.currentEpoch, 2); // 700 s into 300 s epochs
  });

  it("says the opening transaction is unknown rather than inventing one while events are unread", () => {
    assert.equal(mergeCampaigns(snapCampaigns, liveData({ events: [], scanComplete: false }), T0).find((x) => x.id === 3)?.openedTx, null);
  });

  it("keeps the snapshot's own details for an old campaign and takes state from the chain", () => {
    const old = mergeCampaigns(snapCampaigns, liveData(), T0).find((x) => x.id === 1)!;
    assert.equal(old.openedTx, snapCampaigns.find((x) => x.id === 1)!.openedTx);
    assert.equal(old.totalProbes, 17);
    assert.equal(old.settledEpochs, 24);
  });

  it("orders newest first, and returns the snapshot untouched before anything is read", () => {
    assert.deepEqual(mergeCampaigns(snapCampaigns, liveData(), T0).map((c) => c.id), [3, 2, 1]);
    assert.deepEqual(mergeCampaigns(snapCampaigns, liveData({ views: null }), T0), snapCampaigns);
  });
});

describe("mergeCampaignDetail", () => {
  it("builds a new campaign from the chain: registration, probe, settlement", () => {
    const d = mergeCampaignDetail(null, 3, liveData({ events: [opened, registered, probed, result, settled] }), T0)!;
    assert.equal(d.epochs.length, 12);
    assert.equal(d.epochs[0]!.probes, 1);
    assert.equal(d.epochs[0]!.settled, true);
    assert.equal(d.epochs[0]!.settledTx, NEW_TX);
    assert.equal(d.epochs[0]!.makerPot, "900");
    assert.equal(d.leaderboard.length, 1);
    assert.deepEqual([d.leaderboard[0]!.points, d.leaderboard[0]!.checks, d.leaderboard[0]!.uptime, d.leaderboard[0]!.medianSpreadBps], [1, 1, 1, 11]);
    assert.equal(d.recentProbes.length, 1);
    assert.equal(d.recentProbes[0]!.results[0]!.spreadBps, 11);
    assert.equal(d.recentProbes[0]!.ts, T0 - 600);
  });

  it("is readable before any event is: epochs and state from the chain, empty history, no invented rows", () => {
    const d = mergeCampaignDetail(null, 3, liveData({ events: [], scanComplete: false }), T0)!;
    assert.equal(d.epochs.length, 12);
    assert.equal(d.epochs[0]!.settled, true); // the contract's own settled count
    assert.equal(d.leaderboard.length, 0);
    assert.equal(d.recentProbes.length, 0);
  });

  it("adds new events to an old campaign without touching what the snapshot recorded", () => {
    const e = log("Penalized", 16_137_000, 0, { id: "1", vault: snapDetail1.leaderboard[0]!.vault, reporter: NEW_OWNER, slashed: "5", toReporter: "2", toMakers: "3", pointsForfeited: "0" });
    const d = mergeCampaignDetail(snapDetail1, 1, liveData({ events: [e], blockTimes: { ...times, 16_137_000: T0 - 10 } }), T0)!;
    assert.equal(d.penalties.length, snapDetail1.penalties.length + 1);
    assert.equal(d.leaderboard[0]!.points, snapDetail1.leaderboard[0]!.points);
    assert.equal(d.epochs.length, snapDetail1.epochs.length);
  });

  it("returns null for a campaign that exists nowhere", () => {
    assert.equal(mergeCampaignDetail(null, 99, liveData(), T0), null);
  });
});

describe("mergeMarkets and mergeMarket", () => {
  it("counts the vault created after the snapshot, and says none are quoting", () => {
    const m = mergeMarkets(snapMarkets, liveData(), T0).find((x) => x.pair === "WHYPE-PLUMBUSD")!;
    assert.equal(m.vaultCount, 4);
    assert.equal(m.liveVaults, 0);
    assert.equal(m.makerCount, 4); // four vaults, four distinct owners
    assert.equal(m.bestBidPx, null);
    assert.equal(m.bestAskPx, null);
    assert.deepEqual(m.campaignIds, [1, 2, 3]);
  });

  it("reports only vaults whose quote is live as quoting, with the best live prices", () => {
    const q = { bidPx: "52000000000000000000", askPx: "52100000000000000000", bidSize: "1000000000000000", askSize: "1000000000000000", updatedAt: T0, seq: 5 };
    const v = views();
    v.vaults[0] = { ...v.vaults[0]!, live: true, quoteData: q };
    const m = mergeMarkets(snapMarkets, liveData({ views: v }), T0).find((x) => x.pair === "WHYPE-PLUMBUSD")!;
    assert.equal(m.liveVaults, 1);
    assert.equal(m.bestBidPx, q.bidPx);
    assert.equal(m.spreadBps! > 0, true);
  });

  it("adds new probes to the verified counts and leaves the medians the snapshot's", () => {
    const m = mergeMarkets(snapMarkets, liveData({ events: [probed, result] }), T0).find((x) => x.pair === "WHYPE-PLUMBUSD")!;
    const s = snapMarkets.find((x) => x.pair === "WHYPE-PLUMBUSD")!;
    assert.equal(m.verified.probes, s.verified.probes + 1);
    assert.equal(m.verified.medianSpreadBps, s.verified.medianSpreadBps);
  });

  it("builds the book from the chain's own vaults, including the new one", () => {
    const d = mergeMarket(snapMarket, "WHYPE-PLUMBUSD", liveData(), T0)!;
    assert.equal(d.book.length, 4);
    assert.ok(d.book.every((q) => q.live === false));
    assert.equal(d.fills.length, snapMarket.fills.length);
  });

  it("creates a market the snapshot never had, with no invented activity", () => {
    const v = views();
    v.vaults.push(vault("0x00000000000000000000000000000000000000aa", NEW_OWNER, false, { quote: "0x00000000000000000000000000000000000000bb" }));
    const m = mergeMarkets(snapMarkets, liveData({ views: v }), T0);
    const fresh = m.find((x) => x.vaultCount === 1 && x.quote.address.toLowerCase().endsWith("bb"))!;
    assert.equal(fresh.verified.probes, 0);
    assert.equal(fresh.verified.uptime, null);
  });
});

describe("mergeScorecard", () => {
  it("is unavailable, not empty, for a new vault until the events are scanned", () => {
    assert.equal(mergeScorecard(null, NEW_VAULT, liveData({ scanComplete: false })), null);
  });

  it("builds a new vault's scorecard from the chain once scanned, with its probes and no more", () => {
    const d = mergeScorecard(null, NEW_VAULT, liveData({ events: [registered, result] }))!;
    assert.equal(d.owner, NEW_OWNER);
    assert.equal(d.results.length, 1);
    assert.deepEqual(d.campaigns, [3]);
    assert.equal(d.asOfBlock, 16_200_000);
  });

  it("adds new rows to a snapshot vault and moves its as-of block", () => {
    const row = log("ProbeResult", 16_135_000, 2, { id: "3", epoch: "0", vault: snapCard.vault, nonce: "0", passed: false, failMask: 1, spreadBps: 4294967295, bidPx: "0", askPx: "0", bidSize: "0", askSize: "0" });
    const d = mergeScorecard(snapCard, snapCard.vault, liveData({ events: [row] }))!;
    assert.equal(d.results.length, snapCard.results.length + 1);
    assert.equal(d.asOfBlock, 16_200_000);
  });

  it("keeps the snapshot's rows and block while the scan is incomplete", () => {
    const d = mergeScorecard(snapCard, snapCard.vault, liveData({ scanComplete: false }))!;
    assert.deepEqual(d.results, snapCard.results);
    assert.equal(d.asOfBlock, snapCard.asOfBlock);
  });
});

describe("liveCounts, chainNow, mergeEconomics", () => {
  it("counts vaults and campaigns from the chain and 0 quoting when nobody is", () => {
    const c = liveCounts(liveData(), T0)!;
    assert.deepEqual([c.vaults, c.quoting, c.campaigns], [5, 0, 3]);
    assert.equal(c.running, 1); // only campaign 3 is inside its window
  });

  it("is null before anything is read, so no zero is shown for a count that is unknown", () => {
    assert.equal(liveCounts(liveData({ views: null }), T0), null);
  });

  it("advances chain time from the head block by the seconds since it was read", () => {
    assert.equal(chainNow(liveData(), 10_000, 4_000), T0 + 6);
  });

  it("adds probes since the snapshot to the economics probe count only", () => {
    const e = read<import("../src/api.js").EconomicsResponse>("economics.json");
    const m = mergeEconomics(e, liveData({ events: [probed] }))!;
    assert.equal(m.totalProbes, e.totalProbes + 1);
    assert.equal(m.probeGasAvg, e.probeGasAvg);
  });
});
