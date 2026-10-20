import { ELYSIUM_GAS_PRICE_GWEI, blockUrl, gasCostNative } from "@plumbline/shared";
import { STATIC, useSnapshot } from "../lib/api";
import { fmtDec, fmtInt } from "../lib/format";

/**
 * Above every write action in static mode. The contracts are live and so is the wallet, but the data
 * on the page is frozen, so a transaction that succeeds never shows up here.
 */
export function WriteNotice({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const meta = useSnapshot();
  if (!STATIC) return null;
  const block = meta.data?.block;
  if (compact) {
    return (
      <p className={`rounded-[8px] border-2 border-ink bg-paper px-3 py-2 text-xs leading-5 ${className}`}>
        <span className="font-bold">Real transaction, frozen page.</span> It lands on Elysium, but this snapshot (block{" "}
        <span className="num">#{block ? fmtInt(block) : "…"}</span>) will not show it.
      </p>
    );
  }
  return (
    <div className={`rounded-[8px] border-2 border-ink bg-paper px-4 py-3 text-sm leading-6 shadow-brut ${className}`}>
      <div className="label text-ink">Live transactions, frozen data</div>
      <p className="mt-1">
        Data shown is a snapshot at block{" "}
        {block ? (
          <a href={blockUrl(block)} target="_blank" rel="noreferrer" className="num font-semibold underline decoration-2 underline-offset-2 hover:text-violet">
            #{fmtInt(block)}
          </a>
        ) : (
          "…"
        )}
        . Transactions sent from here are real and land on Elysium, but they will not appear on this site until the snapshot
        is refreshed. Check them on the explorer instead.
      </p>
    </div>
  );
}

/** Estimated network fee for `gas` at Elysium's gas price, in plain HYPE. */
export function gasHype(gas: number): number {
  return gasCostNative(gas, ELYSIUM_GAS_PRICE_GWEI);
}

/** "≈ 0.00017 HYPE gas (1,697,212 gas)" next to a button. */
export function GasCost({ gas, label = "network fee" }: { gas: number; label?: string }) {
  return (
    <span className="num text-xs text-muted">
      {label} ≈ {fmtDec(gasHype(gas), 2)} HYPE <span className="hidden sm:inline">({fmtInt(gas)} gas)</span>
    </span>
  );
}
