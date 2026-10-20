/**
 * Response types for the indexer REST API, shared by the indexer (producer) and the web app
 * (consumer). Token amounts and prices are decimal strings of raw integers so no precision is lost
 * in JSON; prices use PX_SCALE (1e18) fixed point. Timestamps are unix seconds.
 */
import type { Address, TokenRef } from "./pairs.js";

export type Hash = `0x${string}`;

export interface QuoteView {
  vault: Address;
  owner: Address;
  bidPx: string;
  askPx: string;
  bidSize: string;
  askSize: string;
  updatedAt: number;
  live: boolean;
  freeBase: string;
  freeQuote: string;
  spreadBps: number | null;
  /** Probe pass rate for this vault over the last 24h, 0..1, or null if never probed. */
  uptime24h: number | null;
}

export interface MarketSummary {
  pair: string;
  base: TokenRef;
  quote: TokenRef;
  vaultCount: number;
  liveVaults: number;
  makerCount: number;
  /** Share of probes in the last 24h where at least one vault passed, 0..1. */
  uptime24h: number | null;
  probes24h: number;
  bestBidPx: string | null;
  bestAskPx: string | null;
  spreadBps: number | null;
  /** Sum of live ask sizes, raw base units. */
  askDepth: string;
  /** Sum of live bid notional, raw quote units. */
  bidDepth: string;
  campaignIds: number[];
  lastProbeAt: number | null;
  sampledAt: number | null;
  /** Figures from probe events: what probes verified on-chain, over every probe on this market. */
  verified: VerifiedFigures;
}

/**
 * Market figures derived only from probe events. A passing ProbeResult means the quote was fresh,
 * tight, deep and fully backed at that instant, so these hold for frozen data too.
 */
export interface VerifiedFigures {
  /** Probes that checked at least one vault. */
  probes: number;
  /** Share of those probes in which at least one vault passed, 0..1. */
  uptime: number | null;
  /** First and last probe timestamps: the window the figures cover. */
  from: number | null;
  to: number | null;
  /** Median best-bid to best-ask spread over probes, from passing quotes. */
  medianSpreadBps: number | null;
  /** Best passing bid and ask at the most recent probe that verified any. */
  lastBidPx: string | null;
  lastAskPx: string | null;
  lastVerifiedAt: number | null;
  /** Median depth within ±50 bps of mid over probes: bid notional (raw quote), ask size (raw base). */
  bidDepth50: string;
  askDepth50: string;
}

export interface FillView {
  txHash: Hash;
  block: number;
  ts: number;
  vault: Address;
  taker: Address;
  buyingBase: boolean;
  amountIn: string;
  amountOut: string;
  px: string;
}

export interface FailedFillView {
  txHash: Hash;
  block: number;
  ts: number;
  vault: Address;
  taker: Address;
  amountIn: string;
  status: number;
  penalized: boolean;
}

export interface MarketDetail {
  summary: MarketSummary;
  book: QuoteView[];
  fills: FillView[];
  failedFills: FailedFillView[];
}

export interface ProbeVaultResult {
  vault: Address;
  passed: boolean;
  failMask: number;
  spreadBps: number;
}

export interface ProbeView {
  campaignId: number;
  epoch: number;
  nonce: number;
  txHash: Hash;
  block: number;
  ts: number;
  prober: Address;
  checked: number;
  passed: number;
  fee: string;
  gasUsed: number | null;
  results: ProbeVaultResult[];
}

export interface UptimeBucket {
  /** Bucket start, unix seconds. */
  t: number;
  probes: number;
  /** Probes in which at least one vault passed. */
  covered: number;
  vaultChecks: number;
  vaultPasses: number;
  medianSpreadBps: number | null;
}

export interface UptimeResponse {
  pair: string;
  window: string;
  from: number;
  to: number;
  bucketSeconds: number;
  uptime: number | null;
  buckets: UptimeBucket[];
  probes: ProbeView[];
}

export interface RegistrationView {
  campaignId: number;
  vault: Address;
  maker: Address;
  bond: string;
  status: "active" | "unbonding" | "released";
  registeredAt: number;
}

export interface LeaderboardRow {
  vault: Address;
  maker: Address;
  points: number;
  checks: number;
  uptime: number | null;
  earned: string;
  bond: string;
  status: RegistrationView["status"];
  medianSpreadBps: number | null;
  penalties: number;
}

export interface EpochView {
  epoch: number;
  start: number;
  end: number;
  probes: number;
  totalPoints: number;
  makerPot: string | null;
  refunded: string | null;
  settled: boolean;
  settledTx: Hash | null;
}

export interface CampaignView {
  id: number;
  pair: string;
  base: TokenRef;
  quote: TokenRef;
  creator: Address;
  rewardToken: Address;
  rewardSymbol: string;
  rewardDecimals: number;
  startTime: number;
  numEpochs: number;
  epochLength: number;
  rewardPerEpoch: string;
  maxSpreadBps: number;
  minDepthBase: string;
  minDepthQuote: string;
  minProbeInterval: number;
  probeFeeBps: number;
  makerBond: string;
  referencePrice: Address;
  openedTx: Hash;
  currentEpoch: number;
  settledEpochs: number;
  totalProbes: number;
  lastProbeAt: number | null;
}

export interface CampaignDetail {
  campaign: CampaignView;
  leaderboard: LeaderboardRow[];
  epochs: EpochView[];
  recentProbes: ProbeView[];
  penalties: PenaltyView[];
}

export interface PenaltyView {
  campaignId: number;
  vault: Address;
  reporter: Address;
  slashed: string;
  toReporter: string;
  txHash: Hash;
  ts: number;
}

export interface MakerVaultView {
  vault: Address;
  pair: string;
  quoter: Address;
  createdAt: number;
  quoteUpdates24h: number;
  quote: QuoteView | null;
}

export interface MakerProfile {
  address: Address;
  vaults: MakerVaultView[];
  registrations: RegistrationView[];
  scores: { campaignId: number; epoch: number; vault: Address; points: number; checks: number; reward: string | null }[];
  totalEarned: { token: Address; symbol: string; decimals: number; amount: string }[];
  uptime24h: number | null;
}

export interface DepthBand {
  bps: number;
  /** Median over samples of live ask size within band, raw base units. */
  askBase: string;
  /** Median over samples of live bid notional within band, raw quote units. */
  bidQuote: string;
}

export interface DepthReport {
  token: TokenRef;
  pair: string;
  quote: TokenRef;
  generatedAt: number;
  windowFrom: number;
  windowTo: number;
  verifiedUptime: number | null;
  probes: number;
  vaultChecks: number;
  medianSpreadBps: number | null;
  makers: number;
  depth: DepthBand[];
  campaigns: number[];
  daily: { day: number; uptime: number | null; probes: number; medianSpreadBps: number | null }[];
  probeLog: ProbeView[];
  contracts: { campaigns: Address; factory: Address; router: Address };
}

export interface EconomicsResponse {
  totalProbes: number;
  probeGasTotal: number;
  probeGasAvg: number | null;
  probeCostNativeTotal: string;
  avgGasPriceWei: string | null;
  quoteUpdates: number;
  quoteUpdateGasAvg: number | null;
  quoteUpdateGasSampled: number;
  avgBlockTimeMs: number | null;
  firstProbeAt: number | null;
  lastProbeAt: number | null;
  probesPerHour: number | null;
  quoteUpdatesPerHour: number | null;
  hypeUsd: number | null;
}

export interface IndexerHealth {
  ok: boolean;
  chainId: number;
  head: number;
  cursor: number;
  lagBlocks: number;
  deployed: boolean;
}
