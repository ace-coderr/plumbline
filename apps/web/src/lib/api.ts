import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { isAddress } from "viem";
import { getLive, waitFirstAttempt } from "./liveStore";
import {
  SNAPSHOT_DIR,
  SNAPSHOT_WINDOW,
  chainNow,
  mergeCampaignDetail,
  mergeCampaigns,
  mergeEconomics,
  mergeMaker,
  mergeMarket,
  mergeMarkets,
  mergeReport,
  mergeScorecard,
  snapshotFile,
  type LiveData,
  type CampaignDetail,
  type CampaignView,
  type DepthReport,
  type EconomicsResponse,
  type IndexerHealth,
  type MakerProfile,
  type MarketDetail,
  type MarketSummary,
  type ProbeView,
  type SnapshotMeta,
  type UptimeResponse,
  type VaultScorecardData,
} from "@plumbline/shared";

/**
 * Two data modes.
 *  live:   the indexer REST API (proxied under /api by the Vite dev server and the web server).
 *  static: a frozen snapshot of the same responses, exported as JSON (pnpm export:static) and
 *          served as plain files. Built with `vite build --mode static`.
 */
export const STATIC = import.meta.env.VITE_DATA_MODE === "static";
export const API = import.meta.env.VITE_API_BASE ?? "/api";
export const KEEPER = import.meta.env.VITE_KEEPER_BASE ?? "/keeper";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = String(res.status);
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // keep the status code
    }
    throw new ApiError(res.status, msg);
  }
  // A static host answers a missing file with the app's index.html; that is a 404, not a parse error.
  if (!(res.headers.get("content-type") ?? "").includes("json")) throw new ApiError(404, "not found");
  return (await res.json()) as T;
}

/** Fetch an indexer API path, from the live API or from the snapshot file that mirrors it. */
async function apiGet<T>(path: string): Promise<T> {
  if (!STATIC) return getJson<T>(`${API}${path}`);
  const file = snapshotFile(path);
  if (!file) throw new ApiError(404, "not in this snapshot");
  try {
    const body = await getJson<T | null>(`/${SNAPSHOT_DIR}/${file}`);
    if (body === null) throw new ApiError(404, "not in this snapshot");
    return body;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw new ApiError(404, "not in this snapshot");
    throw err;
  }
}

// Live data polls; a snapshot never changes, so it is fetched once.
const live = STATIC ? ({ staleTime: Infinity } as const) : ({ refetchInterval: 3_000, staleTime: 1_000 } as const);
const slow = (ms: number) => (STATIC ? ({ staleTime: Infinity } as const) : ({ refetchInterval: ms } as const));

/** Snapshot provenance: block height and time. Null in live mode. */
export const useSnapshot = (): UseQueryResult<SnapshotMeta | null> =>
  useQuery({
    queryKey: ["snapshot-meta"],
    queryFn: () => (STATIC ? getJson<SnapshotMeta>(`/${SNAPSHOT_DIR}/meta.json`) : Promise.resolve(null)),
    staleTime: Infinity,
  });

export const useHealth = (): UseQueryResult<IndexerHealth> =>
  useQuery({ queryKey: ["health"], queryFn: () => apiGet<IndexerHealth>("/health"), ...live });

/**
 * Static mode serves a snapshot; the live reader (liveStore) adds what happened on-chain since. A hook
 * here fetches its snapshot file (immutable, memoised), waits for the first chain read if the snapshot
 * has nothing, and merges. The live store invalidates these queries whenever it learns something, so a
 * campaign created seconds ago appears without a reload. In live (indexer) mode they are plain polls.
 */
const snapshotMemo = new Map<string, Promise<unknown>>();
function snapshotOrNull<T>(path: string): Promise<T | null> {
  let p = snapshotMemo.get(path);
  if (!p) {
    p = apiGet<T>(path).catch((err: unknown) => {
      snapshotMemo.delete(path); // only a 404 is a fact worth keeping
      if (err instanceof ApiError && err.status === 404) {
        snapshotMemo.set(path, Promise.resolve(null));
        return null;
      }
      throw err;
    });
    snapshotMemo.set(path, p);
  }
  return p as Promise<T | null>;
}

const liveNow = (): number => {
  const s = getLive();
  return chainNow(s.data, Date.now(), s.readAtMs);
};

interface MergedQuery<T> {
  key: unknown[];
  /** Indexer path in live mode, snapshot file path in static mode. */
  path: string | null;
  merge: (snap: T | null, live: LiveData, now: number) => T | null;
  enabled?: boolean;
  poll?: "fast" | number;
  /** In static mode, not finding it: whether the chain not being readable is the reason. */
  retry?: boolean;
}

function useMerged<T>(q: MergedQuery<T>): UseQueryResult<T> {
  const polling = q.poll === "fast" ? live : slow(typeof q.poll === "number" ? q.poll : 15_000);
  return useQuery<T>({
    queryKey: q.key,
    enabled: q.enabled ?? true,
    retry: STATIC ? false : (q.retry ?? true) ? 1 : false,
    meta: { live: STATIC },
    queryFn: async () => {
      if (!STATIC) return apiGet<T>(q.path ?? "");
      const snap = q.path ? await snapshotOrNull<T>(q.path) : null;
      // Never call something missing before the chain has been asked.
      if (snap === null) await waitFirstAttempt();
      const s = getLive();
      const out = q.merge(snap, s.data, liveNow());
      if (out === null) {
        if (s.data.views === null) throw new ApiError(503, "The chain could not be read, and this is not in the snapshot.");
        throw new ApiError(404, "not found");
      }
      return out;
    },
    ...(STATIC ? { staleTime: Infinity } : polling),
  });
}

export const useMarkets = (): UseQueryResult<MarketSummary[]> =>
  useMerged<MarketSummary[]>({ key: ["markets"], path: "/markets", merge: (s, l, n) => mergeMarkets(s, l, n), poll: "fast" });

export const useMarket = (pair: string): UseQueryResult<MarketDetail> =>
  useMerged<MarketDetail>({ key: ["market", pair], path: `/markets/${pair}`, merge: (s, l, n) => mergeMarket(s, pair, l, n), poll: "fast" });

export const useUptime = (pair: string, window: string): UseQueryResult<UptimeResponse> =>
  useQuery({
    queryKey: ["uptime", pair, window],
    queryFn: () => apiGet<UptimeResponse>(`/markets/${pair}/uptime?window=${window}`),
    ...slow(5_000),
  });

/**
 * A vault's probe results and slashes: the snapshot's rows plus every ProbeResult and Penalized event
 * since (static mode), or the indexer's (live mode). A vault created after the snapshot is built from
 * the chain once its events have been read; until then this says it is still reading.
 */
export const useScorecard = (address: string | undefined): UseQueryResult<VaultScorecardData> =>
  useQuery<VaultScorecardData>({
    queryKey: ["scorecard", address?.toLowerCase()],
    enabled: Boolean(address) && isAddress(address ?? ""),
    retry: STATIC ? false : 1,
    meta: { live: STATIC },
    queryFn: async () => {
      if (!STATIC) return apiGet<VaultScorecardData>(`/vaults/${address ?? ""}/scorecard`);
      const snap = await snapshotOrNull<VaultScorecardData>(`/vaults/${address ?? ""}/scorecard`);
      if (snap === null) await waitFirstAttempt();
      const s = getLive();
      const out = mergeScorecard(snap, address ?? "", s.data);
      if (out) return out;
      if (s.data.views === null) throw new ApiError(503, "The chain could not be read, and this vault is not in the snapshot.");
      if (s.data.views.vaults.some((v) => v.address.toLowerCase() === (address ?? "").toLowerCase())) {
        throw new ApiError(425, "Reading this vault's history from the chain.");
      }
      throw new ApiError(404, "unknown vault");
    },
    ...(STATIC ? { staleTime: Infinity } : { refetchInterval: 15_000 }),
  });

export const useCampaigns = (): UseQueryResult<CampaignView[]> =>
  useMerged<CampaignView[]>({ key: ["campaigns"], path: "/campaigns", merge: (s, l, n) => mergeCampaigns(s, l, n), poll: "fast" });

export const useCampaign = (id: number): UseQueryResult<CampaignDetail> =>
  useMerged<CampaignDetail>({ key: ["campaign", id], path: `/campaigns/${id}`, merge: (s, l, n) => mergeCampaignDetail(s, id, l, n), poll: "fast" });

export const useMaker = (address: string | undefined): UseQueryResult<MakerProfile> =>
  useMerged<MakerProfile>({
    key: ["maker", address],
    path: address ? `/makers/${address}` : null,
    merge: (s, l) => mergeMaker(s, address ?? "", l),
    enabled: Boolean(address),
    poll: "fast",
    retry: false,
  });

export const useReport = (token: string, window: string): UseQueryResult<DepthReport> =>
  useMerged<DepthReport>({ key: ["report", token, window], path: `/reports/${token}?window=${window}`, merge: (s, l, n) => mergeReport(s, token, l, n) });

export const useReportProbes = (
  token: string,
  offset: number,
  limit: number,
): UseQueryResult<{ total: number; probes: ProbeView[] }> =>
  useQuery({
    queryKey: ["report-probes", token, offset, limit],
    meta: { live: STATIC },
    queryFn: async () => {
      if (!STATIC) {
        return getJson<{ total: number; probes: ProbeView[] }>(`${API}/reports/${token}/probes?offset=${offset}&limit=${limit}`);
      }
      // The snapshot carries the whole probe log once; probes since come from the chain. Page locally.
      const all = await snapshotOrNull<{ total: number; probes: ProbeView[] }>(`/reports/${token}/probes`);
      if (all === null) throw new ApiError(404, "not in this snapshot");
      const report = await snapshotOrNull<DepthReport>(`/reports/${token}?window=${SNAPSHOT_WINDOW}`);
      const s = getLive();
      const merged = report && s.data.views ? mergeReport(report, token, s.data, liveNow()) : null;
      const fresh = (merged?.probeLog ?? []).filter((p) => p.block > s.data.snapshotBlock);
      const probes = [...fresh, ...all.probes];
      return { total: probes.length, probes: probes.slice(offset, offset + limit) };
    },
    ...(STATIC ? { staleTime: Infinity } : { refetchInterval: 15_000 }),
  });

export const useEconomics = (): UseQueryResult<EconomicsResponse> =>
  useMerged<EconomicsResponse>({ key: ["economics"], path: "/economics", merge: (s, l) => mergeEconomics(s, l), poll: "fast" });

export interface KeeperStats {
  keeper: string;
  uptimeSec: number;
  balanceHype: string;
  totals: {
    probes: number;
    probesPerMinute: number;
    settles: number;
    claims: number;
    gasUsed: number;
    gasCostHype: string;
  };
  campaigns: {
    id: number;
    probesOk: number;
    probesReverted: number;
    raceLost: number;
    avgGasPerProbe: number | null;
    avgLatencyMs: number | null;
    costHype: string;
    feesEarnedHype: string;
    vaultPassRate: number | null;
  }[];
}

/** Keeper stats exist only while a keeper runs; a snapshot has none. */
export const useKeeper = (): UseQueryResult<KeeperStats> =>
  useQuery({
    queryKey: ["keeper"],
    queryFn: () => (STATIC ? Promise.reject(new ApiError(404, "not running")) : getJson<KeeperStats>(`${KEEPER}/stats`)),
    ...live,
    retry: false,
  });
