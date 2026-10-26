import { ELYSIUM_GAS_PRICE_GWEI, blockUrl, gasCostNative } from "@plumbline/shared";
import { STATIC, useSnapshot } from "../lib/api";
import { useLive } from "../lib/liveStore";
import { fmtDec, fmtInt } from "../lib/format";

/**
 * Above every write action on the static site. Transactions are real either way. What differs is
 * whether the page can show their effect: it can when the browser is reading the chain, and cannot
 * when the RPC is unreachable and the page is only the snapshot.
 */
export function WriteNotice({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const meta = useSnapshot();
  const live = useLive();
  if (!STATIC) return null;
  const reading = live.status !== "error" && live.data.views !== null;
  const head = live.data.views?.head;
  const block = meta.data?.block;

  if (compact) {
    return (
      <p className={`rounded-[8px] border-2 border-ink bg-paper px-3 py-2 text-xs leading-5 ${className}`}>
        {reading ? (
          <>
            <span className="font-bold">Real transaction.</span> It lands on Elysium, and this page reads the chain live, so its effect should show within seconds.
          </>
        ) : (
          <>
            <span className="font-bold">Real transaction, offline page.</span> It lands on Elysium, but the chain cannot be read right now, so this
            snapshot (block <span className="num">#{block ? fmtInt(block) : "…"}</span>) will not show it.
          </>
        )}
      </p>
    );
  }
  return (
    <div className={`rounded-[8px] border-2 border-ink bg-paper px-4 py-3 text-sm leading-6 shadow-brut ${className}`}>
      <div className="label text-ink">{reading ? "Live transactions, live data" : "Live transactions, offline data"}</div>
      <p className="mt-1">
        {reading ? (
          <>
            Transactions sent from here are real and land on Elysium. This page reads the chain directly (latest block{" "}
            <a href={blockUrl(head ?? 0)} target="_blank" rel="noreferrer" className="num font-semibold underline decoration-2 underline-offset-2 hover:text-violet-text">
              #{fmtInt(head ?? 0)}
            </a>
            ), so what they change should show up within seconds.
          </>
        ) : (
          <>
            The chain cannot be read right now, so the data shown is the snapshot at block{" "}
            {block ? (
              <a href={blockUrl(block)} target="_blank" rel="noreferrer" className="num font-semibold underline decoration-2 underline-offset-2 hover:text-violet-text">
                #{fmtInt(block)}
              </a>
            ) : (
              "…"
            )}
            . Transactions sent from here are still real and land on Elysium, but they will not appear here until the chain can be read again. Check
            them on the explorer instead.
          </>
        )}
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
