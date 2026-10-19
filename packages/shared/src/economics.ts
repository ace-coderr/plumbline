/**
 * Cost model for the /economics comparison. Elysium figures are measured from receipts; the
 * comparison chain is a set of explicit, user-adjustable assumptions, never presented as measured.
 */

export interface ChainAssumption {
  label: string;
  blockTimeMs: number;
  gasPriceGwei: number;
  nativeUsd: number;
}

/** Default comparison: a generic chain with one-second blocks. Every field is editable in the UI. */
export const ONE_SECOND_CHAIN: ChainAssumption = {
  label: "1-second chain",
  blockTimeMs: 1_000,
  gasPriceGwei: 0.05,
  nativeUsd: 3_000,
};

/** Native-token cost of `gas` units at `gasPriceGwei`. */
export function gasCostNative(gas: number, gasPriceGwei: number): number {
  return (gas * gasPriceGwei) / 1e9;
}

/**
 * Quote refreshes a maker needs per day to keep a quote with `maxAgeSec` freshness permanently live,
 * given the chain's block time. A refresh can land at most once per block, and the quote must be
 * re-stamped before it ages out, so the cadence is the faster of the block time and the target.
 */
export function refreshesPerDay(targetIntervalMs: number, blockTimeMs: number): number {
  const interval = Math.max(targetIntervalMs, blockTimeMs);
  return Math.floor(86_400_000 / interval);
}

/**
 * Blocks available inside one freshness window. With one-second timestamps and a 2s window, a
 * 1-second chain gives a maker one or two chances to refresh; Elysium gives over a dozen.
 */
export function blocksPerWindow(maxAgeSec: number, blockTimeMs: number): number {
  return Math.floor((maxAgeSec * 1000) / blockTimeMs);
}
