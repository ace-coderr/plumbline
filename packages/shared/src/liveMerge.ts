/**
 * Merge what the browser read from the chain (liveReader) into the shapes the pages already use
 * (api.ts), on top of the static snapshot. Pure functions: a snapshot and a `LiveData` in, the same
 * shape out. The rules:
 *
 *  - Current state (campaign state, every vault and its quote) is replaced by the chain's view.
 *  - History after the snapshot block (probes, registrations, slashes, settlements) is applied from
 *    events; history before it stays the snapshot's.
 *  - Nothing is guessed. A figure that needs data not read is left as the snapshot had it, and the
 *    callers say so.
 */
import { getAddress, zeroAddress } from "viem";
import type {
  CampaignDetail,
  CampaignView,
  DepthReport,
  EconomicsResponse,
  EpochView,
  Hash,
  LeaderboardRow,
  MakerProfile,
  MakerVaultView,
  MarketDetail,
  MarketSummary,
  PenaltyView,
  ProbeView,
  QuoteView,
  RegistrationView,
} from "./api.js";
import type { VaultProbeRow, VaultScorecardData, VaultSlash } from "./scorecard.js";
import type { ChainCampaign, ChainVault, ChainViews, LiveLog, TokenMeta } from "./liveReader.js";
import { isDemoToken, type Address, type TokenRef } from "./pairs.js";
import { quoteNotional, spreadBps } from "./score.js";

/** What the browser knows from the chain. `views` null means nothing has been read yet. */
export interface LiveData {
  views: ChainViews | null;
  /** Campaigns-contract events in (snapshotBlock, scannedThrough]. */
  events: LiveLog[];
  blockTimes: Record<number, number>;
  snapshotBlock: number;
  /** Events are complete through this block (the snapshot block until the first scan chunk lands). */
  scannedThrough: number;
  /** True once the scan has reached the head the views were read at. */
  scanComplete: boolean;
}

export const CROSSED = 4_294_967_295;
const lc = (a: string) => a.toLowerCase();
const sameAddr = (a: string, b: string) => lc(a) === lc(b);
const addr = (a: string) => getAddress(a) as Address;
const asInt = (v: unknown): number => Number(v);
const asStr = (v: unknown): string => String(v);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// -------------------------------------------------------------------------------------------------
// Tokens and markets
// -------------------------------------------------------------------------------------------------

function tokenRef(live: LiveData, address: string, fallback?: TokenRef): TokenRef {
  const meta: TokenMeta | undefined = live.views?.tokens[lc(address)];
  if (fallback) return fallback;
  return { address: addr(address), symbol: meta?.symbol ?? `${address.slice(0, 6)}…`, decimals: meta?.decimals ?? 18, demo: isDemoToken(address) };
}

const slug = (base: TokenRef, quote: TokenRef) => `${base.symbol}-${quote.symbol}`;

/** Reward token metadata: native HYPE for the zero address. */
function rewardMeta(live: LiveData, token: string): { symbol: string; decimals: number } {
  if (token === zeroAddress) return { symbol: "HYPE", decimals: 18 };
  const m = live.views?.tokens[lc(token)];
  return { symbol: m?.symbol ?? `${token.slice(0, 6)}…`, decimals: m?.decimals ?? 18 };
}

/** The event time: the block's timestamp. Null if that block's time was not read. */
const tsOf = (live: LiveData, block: number): number | null => live.blockTimes[block] ?? null;

/** Chain time now, from the head block's timestamp advanced by the seconds since it was read. */
export function chainNow(live: LiveData, nowMs: number, readAtMs: number | null): number {
  const h = live.views;
  if (!h) return Math.floor(nowMs / 1000);
  return h.headTs + (readAtMs === null ? 0 : Math.max(0, Math.floor((nowMs - readAtMs) / 1000)));
}

// -------------------------------------------------------------------------------------------------
// Campaigns
// -------------------------------------------------------------------------------------------------

function openedTx(live: LiveData, id: number): Hash | null {
  const e = live.events.find((x) => x.name === "CampaignOpened" && asInt(x.args.id) === id);
  return e ? e.txHash : null;
}

function currentEpoch(start: number, epochLength: number, now: number): number {
  const elapsed = now - start;
  return elapsed < 0 ? 0 : Math.floor(elapsed / epochLength);
}

function campaignFromChain(live: LiveData, c: ChainCampaign, now: number, snap?: CampaignView): CampaignView {
  const base = snap?.base ?? tokenRef(live, c.terms.base);
  const quote = snap?.quote ?? tokenRef(live, c.terms.quote);
  const reward = rewardMeta(live, c.state.rewardToken);
  return {
    id: c.id,
    pair: snap?.pair ?? slug(base, quote),
    base,
    quote,
    creator: c.state.creator,
    rewardToken: c.state.rewardToken,
    rewardSymbol: snap?.rewardSymbol ?? reward.symbol,
    rewardDecimals: snap?.rewardDecimals ?? reward.decimals,
    startTime: c.state.startTime,
    numEpochs: c.state.numEpochs,
    epochLength: c.terms.epochLength,
    rewardPerEpoch: c.terms.rewardPerEpoch,
    maxSpreadBps: c.terms.maxSpreadBps,
    minDepthBase: c.terms.minDepthBase,
    minDepthQuote: c.terms.minDepthQuote,
    minProbeInterval: c.terms.minProbeInterval,
    probeFeeBps: c.terms.probeFeeBps,
    makerBond: c.terms.makerBond,
    referencePrice: c.state.referencePrice,
    openedTx: snap?.openedTx ?? openedTx(live, c.id),
    currentEpoch: currentEpoch(c.state.startTime, c.terms.epochLength, now),
    settledEpochs: c.state.settledEpochs,
    totalProbes: c.state.probeNonce,
    lastProbeAt: c.state.lastProbeAt || snap?.lastProbeAt || null,
  };
}

/** Every campaign: the snapshot's, refreshed from the chain's state, plus the ones created since. */
export function mergeCampaigns(snap: CampaignView[] | null, live: LiveData, now: number): CampaignView[] {
  const views = live.views;
  if (!views) return snap ?? [];
  const byId = new Map((snap ?? []).map((c) => [c.id, c]));
  const out: CampaignView[] = views.campaigns.map((c) => campaignFromChain(live, c, now, byId.get(c.id)));
  // Campaigns beyond the read cap stay as the snapshot had them.
  for (const c of snap ?? []) if (!out.some((x) => x.id === c.id)) out.push(c);
  return out.sort((a, b) => b.id - a.id);
}

const eventsFor = (live: LiveData, id: number) => live.events.filter((e) => e.args.id !== undefined && asInt(e.args.id) === id);

function emptyDetail(c: CampaignView): CampaignDetail {
  const epochs: EpochView[] = Array.from({ length: c.numEpochs }, (_, e) => ({
    epoch: e,
    start: c.startTime + e * c.epochLength,
    end: c.startTime + (e + 1) * c.epochLength,
    probes: 0,
    totalPoints: 0,
    makerPot: null,
    refunded: null,
    settled: false,
    settledTx: null,
  }));
  return { campaign: c, leaderboard: [], epochs, recentProbes: [], penalties: [] };
}

/**
 * Apply campaign events to a detail. For a campaign created after the snapshot this is its whole
 * history; for an older one it adds what happened since. Events already applied by the snapshot are
 * excluded by the caller (only events after the snapshot block are passed in).
 */
export function applyCampaignEvents(detail: CampaignDetail, events: LiveLog[], live: LiveData): CampaignDetail {
  const d: CampaignDetail = {
    campaign: detail.campaign,
    leaderboard: detail.leaderboard.map((r) => ({ ...r })),
    epochs: detail.epochs.map((e) => ({ ...e })),
    recentProbes: [...detail.recentProbes],
    penalties: [...detail.penalties],
  };
  const row = (vault: string) => d.leaderboard.find((r) => sameAddr(r.vault, vault));
  const spreads = new Map<string, number[]>();
  const probeResults = new Map<number, LiveLog[]>();
  for (const e of events) if (e.name === "ProbeResult") probeResults.set(asInt(e.args.nonce), [...(probeResults.get(asInt(e.args.nonce)) ?? []), e]);

  const sorted = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const e of sorted) {
    const a = e.args;
    switch (e.name) {
      case "MakerRegistered": {
        const existing = row(asStr(a.vault));
        if (existing) {
          existing.bond = asStr(a.bond);
          existing.status = "active";
        } else {
          d.leaderboard.push({
            vault: addr(asStr(a.vault)),
            maker: addr(asStr(a.maker)),
            points: 0,
            checks: 0,
            uptime: null,
            earned: "0",
            bond: asStr(a.bond),
            status: "active",
            medianSpreadBps: null,
            penalties: 0,
          });
        }
        break;
      }
      case "BondToppedUp": {
        const r = row(asStr(a.vault));
        if (r) r.bond = asStr(a.bond);
        break;
      }
      case "UnbondRequested": {
        const r = row(asStr(a.vault));
        if (r) r.status = "unbonding";
        break;
      }
      case "BondReleased": {
        const r = row(asStr(a.vault));
        if (r) r.status = "released";
        break;
      }
      case "ProbeResult": {
        const r = row(asStr(a.vault));
        const ep = d.epochs[asInt(a.epoch)];
        if (r) {
          r.checks += 1;
          if (a.passed === true) r.points += 1;
          const list = spreads.get(lc(r.vault)) ?? [];
          if (asInt(a.spreadBps) !== CROSSED) list.push(asInt(a.spreadBps));
          spreads.set(lc(r.vault), list);
        }
        void ep;
        break;
      }
      case "Probed": {
        const ep = d.epochs[asInt(a.epoch)];
        if (ep) {
          ep.probes += 1;
          ep.totalPoints += asInt(a.passed);
        }
        const ts = tsOf(live, e.block);
        if (ts !== null) {
          const results = (probeResults.get(asInt(a.nonce)) ?? []).map((x) => ({
            vault: addr(asStr(x.args.vault)),
            passed: x.args.passed === true,
            failMask: asInt(x.args.failMask),
            spreadBps: asInt(x.args.spreadBps),
          }));
          d.recentProbes.unshift({
            campaignId: detail.campaign.id,
            epoch: asInt(a.epoch),
            nonce: asInt(a.nonce),
            txHash: e.txHash,
            block: e.block,
            ts,
            prober: addr(asStr(a.prober)),
            checked: asInt(a.checked),
            passed: asInt(a.passed),
            fee: asStr(a.fee),
            gasUsed: null,
            results,
          });
        }
        break;
      }
      case "Penalized": {
        const r = row(asStr(a.vault));
        if (r) {
          r.penalties += 1;
          r.points = Math.max(0, r.points - asInt(a.pointsForfeited));
        }
        const ts = tsOf(live, e.block);
        if (ts !== null) {
          const p: PenaltyView = {
            campaignId: detail.campaign.id,
            vault: addr(asStr(a.vault)),
            reporter: addr(asStr(a.reporter)),
            slashed: asStr(a.slashed),
            toReporter: asStr(a.toReporter),
            txHash: e.txHash,
            ts,
          };
          d.penalties.unshift(p);
        }
        break;
      }
      case "RewardCredited": {
        const r = row(asStr(a.vault));
        if (r) r.earned = (BigInt(r.earned) + BigInt(asStr(a.amount))).toString();
        break;
      }
      case "EpochSettled": {
        const ep = d.epochs[asInt(a.epoch)];
        if (ep) {
          ep.settled = true;
          ep.settledTx = e.txHash;
          ep.makerPot = asStr(a.makerPot);
          ep.refunded = asStr(a.refunded);
          ep.totalPoints = asInt(a.totalPoints);
          ep.probes = asInt(a.probes);
        }
        break;
      }
      default:
        break;
    }
  }
  for (const r of d.leaderboard) {
    r.uptime = r.checks ? r.points / r.checks : null;
    const fresh = spreads.get(lc(r.vault));
    // Only recomputed where every result is in hand; an older row keeps the snapshot's median.
    if (fresh && (detail.campaign.openedTx === null || r.medianSpreadBps === null)) r.medianSpreadBps = median(fresh);
  }
  d.leaderboard.sort((a, b) => b.points - a.points || (a.medianSpreadBps ?? 1e9) - (b.medianSpreadBps ?? 1e9));
  d.recentProbes = d.recentProbes.sort((a, b) => b.nonce - a.nonce).slice(0, 50);
  return d;
}

/**
 * One campaign's detail. Null if the campaign is in neither the snapshot nor on-chain. A campaign
 * created after the snapshot is built from the chain alone.
 */
export function mergeCampaignDetail(snap: CampaignDetail | null, id: number, live: LiveData, now: number): CampaignDetail | null {
  const c = live.views?.campaigns.find((x) => x.id === id);
  if (!c) return snap;
  const campaign = campaignFromChain(live, c, now, snap?.campaign);
  const base = snap ? { ...snap, campaign } : emptyDetail(campaign);
  const events = eventsFor(live, id).filter((e) => e.name !== "CampaignOpened");
  const merged = events.length ? applyCampaignEvents(base, events, live) : base;
  // The contract's own count of settled epochs wins over any event not read yet.
  merged.epochs = merged.epochs.map((e) => (e.epoch < campaign.settledEpochs && !e.settled ? { ...e, settled: true } : e));
  return merged;
}

// -------------------------------------------------------------------------------------------------
// Vaults and markets
// -------------------------------------------------------------------------------------------------

function quoteView(v: ChainVault, snap: QuoteView | undefined, base: TokenRef, quote: TokenRef): QuoteView {
  const bid = BigInt(v.quoteData.bidPx);
  const ask = BigInt(v.quoteData.askPx);
  const sp = bid > 0n && ask > bid ? Number(spreadBps(bid, ask)) : null;
  void base;
  void quote;
  return {
    vault: v.address,
    owner: v.owner,
    bidPx: v.quoteData.bidPx,
    askPx: v.quoteData.askPx,
    bidSize: v.quoteData.bidSize,
    askSize: v.quoteData.askSize,
    updatedAt: v.quoteData.updatedAt,
    live: v.live,
    freeBase: v.freeBase,
    freeQuote: v.freeQuote,
    spreadBps: sp,
    uptime24h: snap?.uptime24h ?? null,
  };
}

const vaultsOfPair = (live: LiveData, base: string, quote: string): ChainVault[] =>
  (live.views?.vaults ?? []).filter((v) => sameAddr(v.base, base) && sameAddr(v.quote, quote));

/** New probes (checked at least one vault) per campaign since the snapshot. */
function newProbesByCampaign(live: LiveData): Map<number, { n: number; covered: number; lastBlock: number }> {
  const out = new Map<number, { n: number; covered: number; lastBlock: number }>();
  for (const e of live.events) {
    if (e.name !== "Probed" || asInt(e.args.checked) === 0) continue;
    const id = asInt(e.args.id);
    const cur = out.get(id) ?? { n: 0, covered: 0, lastBlock: 0 };
    cur.n += 1;
    if (asInt(e.args.passed) > 0) cur.covered += 1;
    cur.lastBlock = Math.max(cur.lastBlock, e.block);
    out.set(id, cur);
  }
  return out;
}

function summaryFor(live: LiveData, snap: MarketSummary | null, base: TokenRef, quote: TokenRef, campaigns: CampaignView[], now: number): MarketSummary {
  const vaults = vaultsOfPair(live, base.address, quote.address);
  const liveV = vaults.filter((v) => v.live);
  const pairCampaigns = campaigns.filter((c) => sameAddr(c.base.address, base.address) && sameAddr(c.quote.address, quote.address));
  const probes = newProbesByCampaign(live);
  let newN = 0;
  let newCovered = 0;
  let lastBlock = 0;
  for (const c of pairCampaigns) {
    const p = probes.get(c.id);
    if (p) {
      newN += p.n;
      newCovered += p.covered;
      lastBlock = Math.max(lastBlock, p.lastBlock);
    }
  }
  const sv = snap?.verified;
  const total = (sv?.probes ?? 0) + newN;
  const covered = (sv?.uptime ?? 0) * (sv?.probes ?? 0) + newCovered;
  const lastTs = lastBlock ? tsOf(live, lastBlock) : null;

  // Best live bid and ask across vaults that are quoting right now.
  let bestBid: bigint | null = null;
  let bestAsk: bigint | null = null;
  let askDepth = 0n;
  let bidDepth = 0n;
  for (const v of liveV) {
    const bid = BigInt(v.quoteData.bidPx);
    const ask = BigInt(v.quoteData.askPx);
    if (BigInt(v.quoteData.bidSize) > 0n && (bestBid === null || bid > bestBid)) bestBid = bid;
    if (BigInt(v.quoteData.askSize) > 0n && (bestAsk === null || ask < bestAsk)) bestAsk = ask;
    askDepth += BigInt(v.quoteData.askSize);
    bidDepth += quoteNotional(BigInt(v.quoteData.bidSize), bid, base.decimals, quote.decimals);
  }
  const sp = bestBid !== null && bestAsk !== null && bestAsk > bestBid ? Number(spreadBps(bestBid, bestAsk)) : null;

  return {
    pair: snap?.pair ?? slug(base, quote),
    base,
    quote,
    vaultCount: vaults.length,
    liveVaults: liveV.length,
    makerCount: new Set(vaults.map((v) => lc(v.owner))).size,
    uptime24h: snap?.uptime24h ?? null,
    probes24h: snap?.probes24h ?? 0,
    bestBidPx: bestBid?.toString() ?? null,
    bestAskPx: bestAsk?.toString() ?? null,
    spreadBps: sp,
    askDepth: askDepth.toString(),
    bidDepth: bidDepth.toString(),
    campaignIds: pairCampaigns.map((c) => c.id).sort((a, b) => a - b),
    lastProbeAt: lastTs ?? snap?.lastProbeAt ?? null,
    sampledAt: live.views?.headTs ?? snap?.sampledAt ?? null,
    verified: {
      probes: total,
      uptime: total ? covered / total : null,
      from: sv?.from ?? null,
      to: lastTs ?? sv?.to ?? null,
      // Spread and depth over probes need every probe's quotes; they stay the snapshot's.
      medianSpreadBps: sv?.medianSpreadBps ?? null,
      lastBidPx: sv?.lastBidPx ?? null,
      lastAskPx: sv?.lastAskPx ?? null,
      lastVerifiedAt: sv?.lastVerifiedAt ?? null,
      bidDepth50: sv?.bidDepth50 ?? "0",
      askDepth50: sv?.askDepth50 ?? "0",
    },
  };
}

/** Pairs on-chain: every vault's pair, plus any the snapshot knew. */
function pairKeys(live: LiveData, snap: MarketSummary[] | null): { base: string; quote: string }[] {
  const keys = new Map<string, { base: string; quote: string }>();
  for (const m of snap ?? []) keys.set(`${lc(m.base.address)}:${lc(m.quote.address)}`, { base: m.base.address, quote: m.quote.address });
  for (const v of live.views?.vaults ?? []) keys.set(`${lc(v.base)}:${lc(v.quote)}`, { base: v.base, quote: v.quote });
  return [...keys.values()];
}

export function mergeMarkets(snap: MarketSummary[] | null, live: LiveData, now: number): MarketSummary[] {
  if (!live.views) return snap ?? [];
  const campaigns = mergeCampaigns(null, live, now);
  return pairKeys(live, snap).map((k) => {
    const s = (snap ?? []).find((m) => sameAddr(m.base.address, k.base) && sameAddr(m.quote.address, k.quote)) ?? null;
    return summaryFor(live, s, s?.base ?? tokenRef(live, k.base), s?.quote ?? tokenRef(live, k.quote), campaigns, now);
  });
}

export function mergeMarket(snap: MarketDetail | null, pair: string, live: LiveData, now: number): MarketDetail | null {
  if (!live.views) return snap;
  const all = mergeMarkets(snap ? [snap.summary] : null, live, now);
  const summary = all.find((m) => lc(m.pair) === lc(pair));
  if (!summary) return snap;
  const book = vaultsOfPair(live, summary.base.address, summary.quote.address).map((v) =>
    quoteView(v, snap?.book.find((q) => sameAddr(q.vault, v.address)), summary.base, summary.quote),
  );
  return { summary, book, fills: snap?.fills ?? [], failedFills: snap?.failedFills ?? [] };
}

/** Footer counts straight from the chain: vaults, vaults quoting right now, campaigns running now. */
export function liveCounts(live: LiveData, now: number): { vaults: number; quoting: number; running: number; campaigns: number } | null {
  const v = live.views;
  if (!v) return null;
  const running = v.campaigns.filter((c) => now >= c.state.startTime && now < c.state.startTime + c.state.numEpochs * c.terms.epochLength).length;
  return { vaults: v.vaultCount, quoting: v.vaults.filter((x) => x.live).length, running, campaigns: v.campaignCount };
}

// -------------------------------------------------------------------------------------------------
// Scorecard, maker, report, economics
// -------------------------------------------------------------------------------------------------

/**
 * A vault's scorecard data: the snapshot's rows plus every ProbeResult and Penalized event since.
 * Null when the vault is neither in the snapshot nor yet readable; a vault created after the
 * snapshot is built from the chain, but only once its events have been scanned.
 */
export function mergeScorecard(snap: VaultScorecardData | null, vault: string, live: LiveData): VaultScorecardData | null {
  const v = live.views?.vaults.find((x) => sameAddr(x.address, vault));
  if (!snap && !(v && live.scanComplete)) return null;
  const base = snap ?? {
    vault: v!.address,
    owner: v!.owner,
    pair: "",
    base: tokenRef(live, v!.base),
    quote: tokenRef(live, v!.quote),
    campaigns: [] as number[],
    asOfBlock: live.snapshotBlock,
    results: [] as VaultProbeRow[],
    slashes: [] as VaultSlash[],
  };
  const fresh = live.events.filter((e) => e.args.vault !== undefined && sameAddr(asStr(e.args.vault), vault));
  const results: VaultProbeRow[] = [...base.results];
  const slashes: VaultSlash[] = [...base.slashes];
  const campaigns = new Set(base.campaigns);
  for (const e of fresh) {
    const a = e.args;
    if (e.name === "ProbeResult") {
      results.push({
        campaignId: asInt(a.id), epoch: asInt(a.epoch), nonce: asInt(a.nonce), passed: a.passed === true, failMask: asInt(a.failMask),
        spreadBps: asInt(a.spreadBps), bidPx: asStr(a.bidPx), askPx: asStr(a.askPx), bidSize: asStr(a.bidSize), askSize: asStr(a.askSize),
      });
    } else if (e.name === "Penalized") slashes.push({ campaignId: asInt(a.id), txHash: e.txHash, slashed: asStr(a.slashed) });
    else if (e.name === "MakerRegistered") campaigns.add(asInt(a.id));
  }
  const bTok = base.base;
  const qTok = base.quote;
  return {
    ...base,
    pair: base.pair || slug(bTok, qTok),
    owner: v?.owner ?? base.owner,
    campaigns: [...campaigns].sort((a, b) => a - b),
    // Figures are as of the block the events are complete through; until then, the snapshot's.
    asOfBlock: live.scanComplete ? live.scannedThrough : base.asOfBlock,
    results: live.scanComplete ? results : base.results,
    slashes: live.scanComplete ? slashes : base.slashes,
  };
}

/** A wallet's maker profile: vaults it owns straight from the chain, registrations since the snapshot added. */
export function mergeMaker(snap: MakerProfile | null, address: string, live: LiveData): MakerProfile | null {
  const views = live.views;
  if (!views) return snap;
  const owned = views.vaults.filter((v) => sameAddr(v.owner, address));
  const vaults: MakerVaultView[] = owned.map((v) => {
    const s = snap?.vaults.find((x) => sameAddr(x.vault, v.address));
    const b = tokenRef(live, v.base);
    const q = tokenRef(live, v.quote);
    return {
      vault: v.address,
      pair: s?.pair ?? slug(b, q),
      quoter: v.quoter,
      createdAt: v.createdAt,
      quoteUpdates24h: s?.quoteUpdates24h ?? 0,
      quote: quoteView(v, undefined, b, q),
    };
  });
  const registrations: RegistrationView[] = [...(snap?.registrations ?? [])].map((r) => ({ ...r }));
  for (const e of [...live.events].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)) {
    const a = e.args;
    if (e.name === "MakerRegistered" && sameAddr(asStr(a.maker), address)) {
      const ts = tsOf(live, e.block);
      const existing = registrations.find((r) => r.campaignId === asInt(a.id) && sameAddr(r.vault, asStr(a.vault)));
      if (existing) {
        existing.bond = asStr(a.bond);
        existing.status = "active";
      } else if (ts !== null) {
        registrations.push({ campaignId: asInt(a.id), vault: addr(asStr(a.vault)), maker: addr(address), bond: asStr(a.bond), status: "active", registeredAt: ts });
      }
    } else if (e.name === "UnbondRequested" || e.name === "BondReleased") {
      const r = registrations.find((x) => x.campaignId === asInt(a.id) && sameAddr(x.vault, asStr(a.vault)));
      if (r) r.status = e.name === "UnbondRequested" ? "unbonding" : "released";
    }
  }
  if (!snap && vaults.length === 0 && registrations.length === 0) return null;
  return {
    address: addr(address),
    vaults,
    registrations,
    scores: snap?.scores ?? [],
    totalEarned: snap?.totalEarned ?? [],
    uptime24h: snap?.uptime24h ?? null,
  };
}

/** The depth report with campaigns, epochs and probe counts added for what happened since the snapshot. */
export function mergeReport(snap: DepthReport | null, token: string, live: LiveData, now: number): DepthReport | null {
  if (!snap || !live.views) return snap;
  const campaigns = mergeCampaigns(null, live, now).filter((c) => lc(c.base.symbol) === lc(token));
  const probes = newProbesByCampaign(live);
  let n = 0;
  let covered = 0;
  const epochs = [...snap.epochs.map((e) => ({ ...e }))];
  for (const c of campaigns) {
    const p = probes.get(c.id);
    if (p) {
      n += p.n;
      covered += p.covered;
    }
    for (let e = 0; e < c.numEpochs; e++) {
      const start = c.startTime + e * c.epochLength;
      if (start >= now) break;
      const existing = epochs.find((x) => x.campaignId === c.id && x.epoch === e);
      let cnt = 0;
      let cov = 0;
      for (const ev of live.events) {
        if (ev.name === "Probed" && asInt(ev.args.id) === c.id && asInt(ev.args.epoch) === e && asInt(ev.args.checked) > 0) {
          cnt += 1;
          if (asInt(ev.args.passed) > 0) cov += 1;
        }
      }
      if (existing) {
        existing.probes += cnt;
        existing.covered += cov;
      } else {
        epochs.push({ campaignId: c.id, epoch: e, start, end: start + c.epochLength, probes: cnt, covered: cov });
      }
    }
  }
  epochs.sort((a, b) => a.campaignId - b.campaignId || a.epoch - b.epoch);
  const total = snap.probes + n;
  const probeLog: ProbeView[] = [...snap.probeLog];
  for (const c of campaigns) {
    const d = mergeCampaignDetail(null, c.id, live, now);
    if (d) for (const p of d.recentProbes) if (p.block > live.snapshotBlock && p.checked > 0) probeLog.unshift(p);
  }
  return {
    ...snap,
    campaigns: [...new Set([...snap.campaigns, ...campaigns.map((c) => c.id)])].sort((a, b) => a - b),
    probes: total,
    verifiedUptime: total ? ((snap.verifiedUptime ?? 0) * snap.probes + covered) / total : null,
    epochs,
    probeLog: probeLog.sort((a, b) => b.ts - a.ts).slice(0, 300),
    generatedAt: live.views.headTs,
  };
}

/** Economics: the probe count includes probes since the snapshot; gas and quote figures stay the snapshot's. */
export function mergeEconomics(snap: EconomicsResponse | null, live: LiveData): EconomicsResponse | null {
  if (!snap || !live.views) return snap;
  const fresh = [...newProbesByCampaign(live).values()].reduce((a, p) => a + p.n, 0);
  return { ...snap, totalProbes: snap.totalProbes + fresh };
}

export type { LeaderboardRow };
