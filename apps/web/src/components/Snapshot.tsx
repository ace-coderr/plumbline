import { useEffect, useState } from "react";
import { blockUrl, chainNow } from "@plumbline/shared";
import { STATIC, useSnapshot } from "../lib/api";
import { useLive } from "../lib/liveStore";
import { dateTime, fmtInt } from "../lib/format";

/** Re-render every `ms`, so "updated 4s ago" stays true. */
function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

/**
 * Chain time now. Static mode with a live read: the head block's time advanced by the seconds since it
 * was read. Without one: the snapshot's block time (never the visitor's clock, so frozen pages stay
 * consistent). Live (indexer) mode: the wall clock.
 */
export function useNow(): number {
  const live = useLive();
  const meta = useSnapshot();
  useTick(5_000);
  if (!STATIC) return Math.floor(Date.now() / 1000);
  if (live.data.views) return chainNow(live.data, Date.now(), live.readAtMs);
  return meta.data ? meta.data.blockTimestamp : Math.floor(Date.now() / 1000);
}

const age = (sec: number): string => (sec < 60 ? `${Math.max(0, sec)}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`);
const utc = (ts: number): string => dateTime(ts).replace("Z", " UTC");

function BlockLink({ block }: { block: number }) {
  return (
    <a href={blockUrl(block)} target="_blank" rel="noreferrer" className="font-semibold underline decoration-2 underline-offset-2 hover:text-violet-text">
      #{fmtInt(block)}
    </a>
  );
}

/**
 * What the data on the page really is, in words. Shown only on the static site, where the data is a
 * snapshot plus whatever the browser has read from the chain since:
 *  - read OK: "Live from chain, latest block N, updated Xs ago";
 *  - still reading: the same, with how far the history scan has got;
 *  - RPC unreachable: that, and what is shown instead (the snapshot, or the last successful read).
 */
export function SnapshotStamp() {
  const live = useLive();
  const meta = useSnapshot();
  useTick(1_000);
  if (!STATIC) return null;
  const snap = live.snapshot ?? (meta.data ? { block: meta.data.block, blockTimestamp: meta.data.blockTimestamp } : null);
  const v = live.data.views;
  const nowMs = Date.now();
  const readAgo = live.readAtMs === null ? null : Math.floor((nowMs - live.readAtMs) / 1000);
  const retryIn = live.retryAtMs === null ? null : Math.max(0, Math.ceil((live.retryAtMs - nowMs) / 1000));
  const sinceDate = snap ? utc(snap.blockTimestamp) : "an unknown date";

  let head: React.ReactNode;
  let detail: React.ReactNode;
  if (live.status === "error") {
    if (v) {
      head = (
        <>
          RPC unreachable. Showing chain data read {readAgo === null ? "earlier" : `${age(readAgo)} ago`} (block <BlockLink block={v.head} />)
        </>
      );
      detail = <>retrying{retryIn !== null ? ` in ${retryIn}s` : ""} · older history from the snapshot of {sinceDate}</>;
    } else {
      head = <>RPC unreachable, showing snapshot from {sinceDate}</>;
      detail = <>retrying{retryIn !== null ? ` in ${retryIn}s` : ""} · {live.error ?? "no answer"}</>;
    }
  } else if (!v) {
    head = <>Reading the chain…</>;
    detail = <>showing the snapshot from {sinceDate} until it answers</>;
  } else {
    head = (
      <>
        Live from chain, latest block <BlockLink block={v.head} />, updated {readAgo === null ? "just now" : `${age(readAgo)} ago`}
      </>
    );
    detail = live.data.scanComplete ? (
      <>history before block {snap ? fmtInt(snap.block) : "?"} from the snapshot of {sinceDate}</>
    ) : (
      <>
        reading history: events scanned through block {fmtInt(live.data.scannedThrough)} of {fmtInt(v.head)} · older history from the snapshot of {sinceDate}
      </>
    );
  }
  return (
    <div role="status" className="num flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[8px] border-2 border-ink bg-highlight px-3 py-1.5 text-xs text-ink">
      <span className="font-bold uppercase tracking-label">{live.status === "error" ? "Offline" : v ? "Live" : "Loading"}</span>
      <span>{head}</span>
      <span className="text-muted">{detail}</span>
    </div>
  );
}
