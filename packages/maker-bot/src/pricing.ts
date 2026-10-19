import { PX_SCALE, quoteNotional, toPx } from "@plumbline/shared";

/** Parts-per-million scale for fractional bps math. */
const PPM = 1_000_000n;

export interface QuoteInputs {
  /** Reference mid as a decimal string. */
  mid: string;
  spreadBps: number;
  skewBps: number;
  /** Target size per side, raw base units. */
  targetSize: bigint;
  freeBase: bigint;
  freeQuote: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface QuoteOutputs {
  bidPx: bigint;
  askPx: bigint;
  bidSize: bigint;
  askSize: bigint;
  /** -1 (all quote) .. 1 (all base). */
  imbalance: number;
}

/** Keep a sliver back so rounding in the vault never leaves a quote one wei short of backed. */
const HAIRCUT_PPM = 999_000n;

/**
 * Build a two-sided quote around `mid`. Inventory skew shifts both prices against the heavy side:
 * long base means a lower mid, so the ask is likelier to fill and the bid less so.
 */
export function buildQuote(i: QuoteInputs): QuoteOutputs {
  const midPx = toPx(i.mid);
  const baseValue = quoteNotional(i.freeBase, midPx, i.baseDecimals, i.quoteDecimals);
  const total = baseValue + i.freeQuote;
  const imbalance = total === 0n ? 0 : Number(((baseValue - i.freeQuote) * 10_000n) / total) / 10_000;

  const halfPpm = BigInt(Math.round((i.spreadBps / 2) * 100));
  const skewPpm = BigInt(Math.round(-imbalance * i.skewBps * 100));
  const center = (midPx * (PPM + skewPpm)) / PPM;
  const bidPx = (center * (PPM - halfPpm)) / PPM;
  const askPx = (center * (PPM + halfPpm) + PPM - 1n) / PPM;

  const usableBase = (i.freeBase * HAIRCUT_PPM) / PPM;
  const usableQuote = (i.freeQuote * HAIRCUT_PPM) / PPM;
  const askSize = i.targetSize < usableBase ? i.targetSize : usableBase;
  // Largest bid size whose notional the vault can cover.
  const maxBidSize =
    bidPx === 0n ? 0n : (usableQuote * 10n ** BigInt(i.baseDecimals) * PX_SCALE) / (bidPx * 10n ** BigInt(i.quoteDecimals));
  const bidSize = i.targetSize < maxBidSize ? i.targetSize : maxBidSize;

  return { bidPx, askPx, bidSize, askSize, imbalance };
}
