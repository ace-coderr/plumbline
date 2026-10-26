/**
 * Vault scorecards: the figures a vault's probe results add up to, a signed report that carries
 * them, and the checks /verify runs. One implementation computes the figures whether the rows come
 * from the indexer (the scorecard page) or straight from on-chain logs (/verify), so the two can
 * only disagree if the data does.
 *
 * Everything here is pure except the signature helpers, which use viem's message recovery.
 */
import { isAddress, keccak256, recoverMessageAddress, toBytes, type Hex } from "viem";
import { quoteNotional } from "./score.js";
import type { Address, TokenRef } from "./pairs.js";

/** `spread_bps` saturates to uint32 max for a crossed or empty quote; it is not a measurement. */
export const CROSSED_SPREAD = 4_294_967_295;

/** One vault's result in one probe: the `ProbeResult` event, as the indexer stores it. */
export interface VaultProbeRow {
  campaignId: number;
  epoch: number;
  nonce: number;
  passed: boolean;
  failMask: number;
  spreadBps: number;
  /** Raw uint128 values as decimal strings: prices at PX_SCALE, sizes in raw base units. */
  bidPx: string;
  askPx: string;
  bidSize: string;
  askSize: string;
}

/** One `Penalized` event against the vault. `slashed` is in the campaign's reward token. */
export interface VaultSlash {
  campaignId: number;
  txHash: Hex;
  slashed: string;
}

/** What the indexer (or a snapshot file) returns for a vault. */
export interface VaultScorecardData {
  vault: Address;
  owner: Address;
  pair: string;
  base: TokenRef;
  quote: TokenRef;
  /** Campaigns the vault has bonded into. */
  campaigns: number[];
  /** Every figure covers probes and slashes up to and including this block. */
  asOfBlock: number;
  results: VaultProbeRow[];
  slashes: VaultSlash[];
}

export interface EpochFigure {
  campaignId: number;
  epoch: number;
  /** Probes that checked this vault in the epoch. */
  probes: number;
  /** Of those, the ones the vault passed. */
  passes: number;
}

export interface ScorecardFigures {
  /** Probes that checked the vault. */
  probes: number;
  passes: number;
  /** passes / probes, or null when no probe has checked the vault. */
  uptime: number | null;
  /** Median measured spread over passing results, or null with none. */
  medianSpreadBps: number | null;
  /** Median bid notional (raw quote units) over passing results, or null with none. */
  bidDepthQuote: string | null;
  /** Median ask size (raw base units) over passing results, or null with none. */
  askDepthBase: string | null;
  slashes: VaultSlash[];
  epochs: EpochFigure[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Upper median, matching the indexer's report figures. */
function medianBig(xs: bigint[]): bigint | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)] as bigint;
}

const byKey = (a: { campaignId: number }, b: { campaignId: number }, ak: number, bk: number) =>
  a.campaignId - b.campaignId || ak - bk;

/**
 * The figures for a vault. A probe checks a vault once, so rows repeated for the same (campaign,
 * nonce), as chunked log reads can produce, count once. "Verified" depth and spread come only from
 * results the probe passed: those quotes were fresh, tight, deep and backed at that block.
 */
export function computeFigures(
  rows: VaultProbeRow[],
  slashes: VaultSlash[],
  decimals: { base: number; quote: number },
): ScorecardFigures {
  const unique = new Map<string, VaultProbeRow>();
  for (const r of rows) unique.set(`${r.campaignId}:${r.nonce}`, r);
  const results = [...unique.values()].sort((a, b) => byKey(a, b, a.nonce, b.nonce));

  const passing = results.filter((r) => r.passed);
  const spreads = passing.filter((r) => r.spreadBps !== CROSSED_SPREAD).map((r) => r.spreadBps);
  const bids = passing.map((r) => quoteNotional(BigInt(r.bidSize), BigInt(r.bidPx), decimals.base, decimals.quote));
  const asks = passing.map((r) => BigInt(r.askSize));

  const epochs = new Map<string, EpochFigure>();
  for (const r of results) {
    const k = `${r.campaignId}:${r.epoch}`;
    const e = epochs.get(k) ?? { campaignId: r.campaignId, epoch: r.epoch, probes: 0, passes: 0 };
    e.probes += 1;
    if (r.passed) e.passes += 1;
    epochs.set(k, e);
  }

  const seen = new Set<string>();
  const slashList = slashes
    .map((s) => ({ campaignId: s.campaignId, txHash: s.txHash.toLowerCase() as Hex, slashed: s.slashed }))
    .filter((s) => {
      const k = `${s.txHash}:${s.campaignId}:${s.slashed}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => byKey(a, b, 0, 0) || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0));

  return {
    probes: results.length,
    passes: passing.length,
    uptime: results.length ? passing.length / results.length : null,
    medianSpreadBps: median(spreads),
    bidDepthQuote: medianBig(bids)?.toString() ?? null,
    askDepthBase: medianBig(asks)?.toString() ?? null,
    slashes: slashList,
    epochs: [...epochs.values()].sort((a, b) => byKey(a, b, a.epoch, b.epoch)),
  };
}

// -------------------------------------------------------------------------------------------------
// Report
// -------------------------------------------------------------------------------------------------

export const REPORT_FORMAT = "plumbline-scorecard";
export const REPORT_VERSION = 1;

/** What the hash and the signature cover. */
export interface ReportBody {
  chainId: number;
  /** The campaigns contract the probe results were emitted by. */
  campaignsContract: Address;
  vault: Address;
  owner: Address;
  pair: string;
  base: { symbol: string; address: Address; decimals: number };
  quote: { symbol: string; address: Address; decimals: number };
  /** Figures cover everything up to and including this block. */
  asOfBlock: number;
  /** Where the figures were read from when the report was made. */
  source: "snapshot" | "indexer";
  figures: ScorecardFigures;
}

export interface ScorecardReport {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  body: ReportBody;
  /** keccak256 of the canonical JSON of `body`. */
  hash: Hex;
  /** The vault owner's personal_sign signature over `signingMessage(hash)`. */
  signer?: Address;
  signature?: Hex;
  /** The sender's own name for the vault. Not part of the hash; included only if they choose. */
  label?: string;
}

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace. The same body always yields the
 * same string, whatever order its keys were built in.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new Error("bigint in a report body: use a decimal string");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number in a report body");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
}

export function reportHash(body: ReportBody): Hex {
  return keccak256(toBytes(canonicalize(body)));
}

/** The exact text the vault owner signs with personal_sign. */
export function signingMessage(hash: Hex): string {
  return `Plumbline scorecard v${REPORT_VERSION}\nreport hash: ${hash}`;
}

export function buildReport(body: ReportBody, label?: string): ScorecardReport {
  const report: ScorecardReport = { format: REPORT_FORMAT, version: REPORT_VERSION, body, hash: reportHash(body) };
  const l = label?.trim();
  if (l) report.label = l;
  return report;
}

export function withSignature(report: ScorecardReport, signer: Address, signature: Hex): ScorecardReport {
  return { ...report, signer, signature };
}

export interface ReportChecks {
  /** The hash field equals the hash recomputed from the body. */
  hashOk: boolean;
  recomputedHash: Hex;
  /** null when the report is unsigned. */
  signature: null | { recovered: Address; matchesClaimedSigner: boolean };
}

/** Check a report's own consistency: its hash, and who its signature recovers to. */
export async function checkReport(report: ScorecardReport): Promise<ReportChecks> {
  const recomputedHash = reportHash(report.body);
  const hashOk = recomputedHash.toLowerCase() === report.hash.toLowerCase();
  if (!report.signature) return { hashOk, recomputedHash, signature: null };
  const recovered = await recoverMessageAddress({
    message: signingMessage(report.hash),
    signature: report.signature,
  });
  return {
    hashOk,
    recomputedHash,
    signature: { recovered, matchesClaimedSigner: report.signer?.toLowerCase() === recovered.toLowerCase() },
  };
}

// -------------------------------------------------------------------------------------------------
// Parsing and comparing
// -------------------------------------------------------------------------------------------------

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isDec = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const isHex = (v: unknown, bytes?: number): v is Hex =>
  typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && (bytes === undefined || v.length === 2 + bytes * 2);
const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function tokenOk(t: unknown): boolean {
  return rec(t) && typeof t.symbol === "string" && isAddress(String(t.address)) && isInt(t.decimals);
}

/** Parse report text. Returns what is wrong in plain words when it is not a usable report. */
export function parseReport(text: string): { ok: true; report: ScorecardReport } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: "This is not valid JSON." };
  }
  if (!rec(v) || v.format !== REPORT_FORMAT) return { ok: false, error: "This is not a Plumbline scorecard report." };
  if (v.version !== REPORT_VERSION) return { ok: false, error: `Unsupported report version ${String(v.version)}.` };
  const b = v.body;
  if (!rec(b)) return { ok: false, error: "The report has no body." };
  if (!isHex(v.hash, 32)) return { ok: false, error: "The report hash is missing or malformed." };
  if (!isAddress(String(b.vault)) || !isAddress(String(b.owner)) || !isAddress(String(b.campaignsContract))) {
    return { ok: false, error: "The report's vault, owner or contract address is malformed." };
  }
  if (!isInt(b.chainId) || !isInt(b.asOfBlock) || typeof b.pair !== "string") {
    return { ok: false, error: "The report's chain, block or pair is malformed." };
  }
  if (b.source !== "snapshot" && b.source !== "indexer") return { ok: false, error: "The report's source is malformed." };
  if (!tokenOk(b.base) || !tokenOk(b.quote)) return { ok: false, error: "The report's token details are malformed." };
  const f = b.figures;
  if (!rec(f) || !isInt(f.probes) || !isInt(f.passes) || !Array.isArray(f.epochs) || !Array.isArray(f.slashes)) {
    return { ok: false, error: "The report's figures are malformed." };
  }
  const nullableDec = (x: unknown) => x === null || isDec(x);
  if (
    !(f.uptime === null || typeof f.uptime === "number") ||
    !(f.medianSpreadBps === null || typeof f.medianSpreadBps === "number") ||
    !nullableDec(f.bidDepthQuote) ||
    !nullableDec(f.askDepthBase)
  ) {
    return { ok: false, error: "The report's figures are malformed." };
  }
  const epochsOk = f.epochs.every((e) => rec(e) && isInt(e.campaignId) && isInt(e.epoch) && isInt(e.probes) && isInt(e.passes));
  const slashesOk = f.slashes.every((s) => rec(s) && isInt(s.campaignId) && isHex(s.txHash, 32) && isDec(s.slashed));
  if (!epochsOk || !slashesOk) return { ok: false, error: "The report's epoch or slash entries are malformed." };
  if (v.signature !== undefined && (!isHex(v.signature) || !isAddress(String(v.signer)))) {
    return { ok: false, error: "The report's signature or signer is malformed." };
  }
  return { ok: true, report: v as unknown as ScorecardReport };
}

export type FigureKey =
  | "probes"
  | "passes"
  | "uptime"
  | "medianSpreadBps"
  | "bidDepthQuote"
  | "askDepthBase"
  | "slashes"
  | "epochs";

export interface FigureCheck {
  key: FigureKey;
  /** The figure as a string, "none" when there is no value, so a check is always comparable. */
  claimed: string;
  actual: string;
  match: boolean;
  /** For lists: what differs, in words. */
  detail?: string;
}

const str = (v: number | string | null): string => (v === null ? "none" : String(v));

function diffList<T>(claimed: T[], actual: T[], key: (t: T) => string): string | undefined {
  const c = new Map(claimed.map((x) => [key(x), JSON.stringify(x)]));
  const a = new Map(actual.map((x) => [key(x), JSON.stringify(x)]));
  const notes: string[] = [];
  for (const [k, v] of c) {
    if (!a.has(k)) notes.push(`${k} is in the report but not on-chain`);
    else if (a.get(k) !== v) notes.push(`${k} differs`);
  }
  for (const k of a.keys()) if (!c.has(k)) notes.push(`${k} is on-chain but not in the report`);
  return notes.length ? notes.slice(0, 5).join("; ") + (notes.length > 5 ? `; and ${notes.length - 5} more` : "") : undefined;
}

/** Compare the figures a report claims with figures recomputed from chain data. */
export function compareFigures(claimed: ScorecardFigures, actual: ScorecardFigures): FigureCheck[] {
  const scalar = (key: FigureKey, c: number | string | null, a: number | string | null): FigureCheck => ({
    key,
    claimed: str(c),
    actual: str(a),
    match: c === a,
  });
  const epochKey = (e: EpochFigure) => `campaign ${e.campaignId} epoch ${e.epoch}`;
  const slashKey = (s: VaultSlash) => `slash ${s.txHash.slice(0, 10)}`;
  const epochDetail = diffList(claimed.epochs, actual.epochs, epochKey);
  const slashDetail = diffList(claimed.slashes, actual.slashes, slashKey);
  return [
    scalar("probes", claimed.probes, actual.probes),
    scalar("passes", claimed.passes, actual.passes),
    scalar("uptime", claimed.uptime, actual.uptime),
    scalar("medianSpreadBps", claimed.medianSpreadBps, actual.medianSpreadBps),
    scalar("bidDepthQuote", claimed.bidDepthQuote, actual.bidDepthQuote),
    scalar("askDepthBase", claimed.askDepthBase, actual.askDepthBase),
    {
      key: "slashes",
      claimed: String(claimed.slashes.length),
      actual: String(actual.slashes.length),
      match: slashDetail === undefined,
      detail: slashDetail,
    },
    {
      key: "epochs",
      claimed: String(claimed.epochs.length),
      actual: String(actual.epochs.length),
      match: epochDetail === undefined,
      detail: epochDetail,
    },
  ];
}
