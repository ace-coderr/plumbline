import { useSyncExternalStore } from "react";
import {
  SNAPSHOT_DIR,
  TIMED_EVENTS,
  campaignSources,
  chunkRanges,
  logKey,
  readBlockTimes,
  readChainViews,
  scanCampaignEvents,
  scanFills,
  type LiveData,
  type LiveFailedFill,
  type LiveFill,
  type LiveLog,
  type SnapshotMeta,
} from "@plumbline/shared";
import { chainClient } from "./chain";
import { idbGet, idbSet } from "./idb";

/**
 * The browser's own view of the chain since the snapshot. One store for the whole app: it reads
 * current state (campaigns, vaults, live quotes) and the campaigns contract's events after the
 * snapshot block, keeps the events cached in IndexedDB, and polls. Pages never talk to the RPC
 * themselves; they read this through the merge functions in @plumbline/shared.
 *
 * A failed read never becomes data: on failure the store keeps what it last read successfully
 * (marked with when), or nothing, and says so in `status` and `error`.
 */

export type LiveStatus = "idle" | "syncing" | "live" | "error";

export interface LiveState {
  status: LiveStatus;
  data: LiveData;
  /** When (ms since epoch) the chain's current state was last read successfully. */
  readAtMs: number | null;
  error: string | null;
  /** When the next retry is due after a failure, ms since epoch. */
  retryAtMs: number | null;
  /** The cached events were loaded from IndexedDB (not yet refreshed this session). */
  usingCache: boolean;
  /** Snapshot provenance: the block it was taken at and that block's time. */
  snapshot: { block: number; blockTimestamp: number } | null;
  /** The first read has finished, whichever way it went. */
  firstAttemptDone: boolean;
  version: number;
}

const POLL_MS = 15_000;
const REORG_MARGIN = 24;
/** Chunks of a million blocks read at once. */
const GROUP = 5;
const CACHE_KEY = "live-events-v2";

interface Cache {
  snapshotBlock: number;
  historyFrom: number;
  scannedThrough: number;
  events: LiveLog[];
  blockTimes: Record<number, number>;
  fills?: LiveFill[];
  failedFills?: LiveFailedFill[];
}

const emptyData = (): LiveData => ({
  views: null,
  events: [],
  historyFrom: 0,
  blockTimes: {},
  fills: [],
  failedFills: [],
  snapshotBlock: 0,
  scannedThrough: 0,
  scanComplete: false,
});

let state: LiveState = {
  status: "idle",
  data: emptyData(),
  readAtMs: null,
  error: null,
  retryAtMs: null,
  usingCache: false,
  snapshot: null,
  firstAttemptDone: false,
  version: 0,
};

const listeners = new Set<() => void>();
function set(patch: Partial<LiveState>): void {
  state = { ...state, ...patch, version: state.version + 1 };
  listeners.forEach((l) => l());
}
function setData(patch: Partial<LiveData>, rest: Partial<LiveState> = {}): void {
  set({ ...rest, data: { ...state.data, ...patch } });
}

export const getLive = (): LiveState => state;
export const subscribeLive = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useLive = (): LiveState => useSyncExternalStore(subscribeLive, getLive);

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let failures = 0;
let firstAttempt: Promise<void> | null = null;
let resolveFirst: (() => void) | null = null;

/** Resolves once the first read has finished, successfully or not. */
export function waitFirstAttempt(): Promise<void> {
  if (state.firstAttemptDone) return Promise.resolve();
  firstAttempt ??= new Promise<void>((r) => (resolveFirst = r));
  return firstAttempt;
}

async function loadSnapshotMeta(): Promise<{ block: number; blockTimestamp: number }> {
  const res = await fetch(`/${SNAPSHOT_DIR}/meta.json`);
  if (!res.ok) throw new Error(`snapshot meta: ${res.status}`);
  const m = (await res.json()) as SnapshotMeta;
  return { block: m.block, blockTimestamp: m.blockTimestamp };
}

function persist(): void {
  const d = state.data;
  void idbSet(CACHE_KEY, { snapshotBlock: d.snapshotBlock, historyFrom: d.historyFrom, scannedThrough: d.scannedThrough, events: d.events, blockTimes: d.blockTimes, fills: d.fills, failedFills: d.failedFills } satisfies Cache);
}

const message = (err: unknown): string => {
  const e = err as { shortMessage?: string; message?: string };
  return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0]?.slice(0, 200) ?? "failed";
};

async function readOnce(): Promise<void> {
  const snap = state.snapshot;
  if (!snap) throw new Error("snapshot meta not loaded");

  const views = await readChainViews(chainClient);
  setData({ views }, { readAtMs: Date.now(), status: state.data.scanComplete ? "live" : "syncing", error: null, retryAtMs: null });

  // Events: the whole history from the first campaigns contract's deploy block, resuming just after
  // what is already scanned (minus a small reorg margin), up to the head.
  const start = state.data.historyFrom;
  const have = state.data.scannedThrough;
  const from = have >= start ? Math.max(start, have - REORG_MARGIN + 1) : start;
  if (views.head >= from) {
    // Five chunks at a time: first load is dominated by round trips, not by data. A group counts as
    // scanned only when every chunk in it has been, so the scanned-through block is always contiguous.
    const ranges = chunkRanges(BigInt(from), BigInt(views.head), 1_000_000n);
    for (let i = 0; i < ranges.length; i += GROUP) {
      const group = ranges.slice(i, i + GROUP);
      // Fills only matter after the snapshot block; before it the snapshot has them. Read alongside the events.
      const fillFrom = BigInt(Math.max(Number(group[0]!.from), snap.block + 1));
      const fillTo = group[group.length - 1]!.to;
      const [found, swept] = await Promise.all([
        Promise.all(group.map((r) => scanCampaignEvents(chainClient, r.from, r.to))),
        fillTo >= fillFrom
          ? scanFills(chainClient, fillFrom, fillTo, views.vaults.map((v) => v.address), campaignSources.map((s) => s.router))
          : Promise.resolve({ fills: [] as LiveFill[], failed: [] as LiveFailedFill[] }),
      ]);
      const fresh = found.flat();
      const times = await readBlockTimes(
        chainClient,
        [...fresh.filter((e) => TIMED_EVENTS.has(e.name)).map((e) => e.block), ...swept.fills.map((f) => f.block), ...swept.failed.map((f) => f.block)],
        state.data.blockTimes,
      );
      const lo = group[0]!.from;
      const hi = group[group.length - 1]!.to;
      // Replace anything already held in this range (a re-read after the reorg margin), then add.
      const keep = state.data.events.filter((e) => BigInt(e.block) < lo || BigInt(e.block) > hi);
      const merged = new Map<string, LiveLog>();
      for (const e of [...keep, ...fresh]) merged.set(logKey(e), e);
      const keepFills = state.data.fills.filter((f) => BigInt(f.block) < fillFrom || BigInt(f.block) > fillTo);
      const keepFailed = state.data.failedFills.filter((f) => BigInt(f.block) < fillFrom || BigInt(f.block) > fillTo);
      setData({
        events: [...merged.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex),
        blockTimes: times,
        fills: [...keepFills, ...swept.fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex),
        failedFills: [...keepFailed, ...swept.failed].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex),
        scannedThrough: Number(hi),
      });
      persist();
    }
  }
  setData({ scanComplete: state.data.scannedThrough >= views.head }, { status: "live", usingCache: false });
}

async function tick(): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      if (!state.snapshot) {
        const meta = await loadSnapshotMeta();
        set({ snapshot: meta });
        const historyFrom = Math.min(...campaignSources.map((s) => s.deployBlock));
        setData({ snapshotBlock: meta.block, historyFrom, scannedThrough: historyFrom - 1 });
        const cached = await idbGet<Cache>(CACHE_KEY);
        if (cached && cached.snapshotBlock === meta.block && cached.historyFrom === historyFrom && Array.isArray(cached.events)) {
          setData({ events: cached.events, blockTimes: cached.blockTimes ?? {}, fills: cached.fills ?? [], failedFills: cached.failedFills ?? [], scannedThrough: Math.max(cached.scannedThrough, historyFrom - 1) }, { usingCache: true });
        }
      }
      set({ status: state.data.views ? state.status : "syncing" });
      await readOnce();
      failures = 0;
      timer = setTimeout(() => void tick(), POLL_MS);
    } catch (err) {
      failures += 1;
      const delay = Math.min(60_000, 5_000 * 2 ** (failures - 1));
      set({ status: "error", error: message(err), retryAtMs: Date.now() + delay });
      timer = setTimeout(() => void tick(), delay);
    } finally {
      set({ firstAttemptDone: true });
      resolveFirst?.();
      running = null;
    }
  })();
  return running;
}

/** Start reading the chain. Safe to call more than once. */
export function startLive(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  state = { ...state, status: "syncing" };
  void tick();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !running && (state.readAtMs === null || Date.now() - state.readAtMs > POLL_MS)) {
      if (timer) clearTimeout(timer);
      void tick();
    }
  });
}

/** Read now instead of at the next poll, for example right after sending a transaction. */
export async function refreshLive(): Promise<void> {
  if (timer) clearTimeout(timer);
  if (running) await running;
  failures = 0;
  await tick();
}
