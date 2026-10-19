/**
 * TypeScript mirror of the on-chain PlumbScore constants and helpers. Keep in lockstep with
 * contracts/src/libraries/PlumbScore.sol.
 */

export const BPS = 10_000n;
export const PX_SCALE = 10n ** 18n;

export const FailFlag = {
  Stale: 1 << 0,
  Crossed: 1 << 1,
  Spread: 1 << 2,
  DepthBase: 1 << 3,
  DepthQuote: 1 << 4,
  InventoryBase: 1 << 5,
  InventoryQuote: 1 << 6,
  Bond: 1 << 7,
} as const;

export type FailFlagName = keyof typeof FailFlag;

const FLAG_LABELS: Record<FailFlagName, string> = {
  Stale: "stale",
  Crossed: "crossed",
  Spread: "wide",
  DepthBase: "thin ask",
  DepthQuote: "thin bid",
  InventoryBase: "unbacked ask",
  InventoryQuote: "unbacked bid",
  Bond: "bond",
};

/** Decode a probe fail mask into flag names. */
export function decodeFailMask(mask: number): FailFlagName[] {
  return (Object.keys(FailFlag) as FailFlagName[]).filter((k) => (mask & FailFlag[k]) !== 0);
}

/** Short human labels for a fail mask, e.g. ["wide", "unbacked ask"]. */
export function failLabels(mask: number): string[] {
  return decodeFailMask(mask).map((k) => FLAG_LABELS[k]);
}

/** Router FillStatus enum from PlumbQuote. */
export const FillStatus = ["ok", "stale", "no size", "size exceeded", "insufficient inventory", "zero out"] as const;
export type FillStatusName = (typeof FillStatus)[number];

/** Spread in bps, rounded up, around `ref` or the quote's own mid when `ref` is 0. */
export function spreadBps(bid: bigint, ask: bigint, ref = 0n): bigint {
  if (bid <= 0n || ask <= bid) return -1n;
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  if (ref === 0n) return ceilDiv((ask - bid) * 2n * BPS, ask + bid);
  const down = ref > bid ? ref - bid : bid - ref;
  const up = ask > ref ? ask - ref : ref - ask;
  return ceilDiv((down > up ? down : up) * 2n * BPS, ref);
}

/** Convert a decimal price to PX_SCALE fixed point. */
export function toPx(price: number | string): bigint {
  const s = typeof price === "number" ? price.toFixed(18) : price;
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  const sign = whole.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(whole.replace("-", "") || "0") * PX_SCALE + BigInt(fracPadded));
}

/** Convert a PX_SCALE fixed-point price to a JS number (display only). */
export function fromPx(px: bigint): number {
  return Number(px) / 1e18;
}

/** Raw quote units for `baseAmount` raw base units at `px`, rounded down. */
export function quoteNotional(baseAmount: bigint, px: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  return (baseAmount * px * 10n ** BigInt(quoteDecimals)) / (10n ** BigInt(baseDecimals) * PX_SCALE);
}

/** Raw base units purchasable for `quoteAmount` raw quote units at `px`, rounded down. */
export function baseForQuote(quoteAmount: bigint, px: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  return (quoteAmount * 10n ** BigInt(baseDecimals) * PX_SCALE) / (px * 10n ** BigInt(quoteDecimals));
}
