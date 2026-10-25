import { blockUrl } from "@plumbline/shared";
import { STATIC, useSnapshot } from "../lib/api";
import { dateTime, fmtInt } from "../lib/format";

/** Chain time of the snapshot in static mode, the wall clock in live mode. */
export function useNow(): number {
  const meta = useSnapshot();
  return STATIC && meta.data ? meta.data.blockTimestamp : Math.floor(Date.now() / 1000);
}

/**
 * Provenance line for frozen data: block height (linked to the explorer) and UTC time. Rendered
 * only in static mode, so a snapshot is never mistaken for live data.
 */
export function SnapshotStamp() {
  const meta = useSnapshot();
  if (!STATIC || !meta.data) return null;
  const m = meta.data;
  return (
    <div className="num flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[8px] border-2 border-ink bg-highlight px-3 py-1.5 text-xs text-ink">
      <span className="font-bold uppercase tracking-label">Snapshot</span>
      <span>
        block{" "}
        <a href={blockUrl(m.block)} target="_blank" rel="noreferrer" className="font-semibold underline decoration-2 underline-offset-2 hover:text-violet-text">
          #{fmtInt(m.block)}
        </a>
      </span>
      <span>{dateTime(m.blockTimestamp).replace("Z", " UTC")}</span>
      <span className="text-muted">frozen data, not live</span>
    </div>
  );
}
