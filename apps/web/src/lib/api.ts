import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  SNAPSHOT_DIR,
  snapshotFile,
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

export const useMarkets = (): UseQueryResult<MarketSummary[]> =>
  useQuery({ queryKey: ["markets"], queryFn: () => apiGet<MarketSummary[]>("/markets"), ...live });

export const useMarket = (pair: string): UseQueryResult<MarketDetail> =>
  useQuery({ queryKey: ["market", pair], queryFn: () => apiGet<MarketDetail>(`/markets/${pair}`), ...live });

export const useUptime = (pair: string, window: string): UseQueryResult<UptimeResponse> =>
  useQuery({
    queryKey: ["uptime", pair, window],
    queryFn: () => apiGet<UptimeResponse>(`/markets/${pair}/uptime?window=${window}`),
    ...slow(5_000),
  });

export const useCampaigns = (): UseQueryResult<CampaignView[]> =>
  useQuery({ queryKey: ["campaigns"], queryFn: () => apiGet<CampaignView[]>("/campaigns"), ...live });

export const useCampaign = (id: number): UseQueryResult<CampaignDetail> =>
  useQuery({ queryKey: ["campaign", id], queryFn: () => apiGet<CampaignDetail>(`/campaigns/${id}`), ...live });

export const useMaker = (address: string | undefined): UseQueryResult<MakerProfile> =>
  useQuery({
    queryKey: ["maker", address],
    queryFn: () => apiGet<MakerProfile>(`/makers/${address ?? ""}`),
    enabled: Boolean(address),
    retry: STATIC ? false : 1,
    ...live,
  });

export const useReport = (token: string, window: string): UseQueryResult<DepthReport> =>
  useQuery({
    queryKey: ["report", token, window],
    queryFn: () => apiGet<DepthReport>(`/reports/${token}?window=${window}`),
    ...slow(15_000),
  });

export const useReportProbes = (
  token: string,
  offset: number,
  limit: number,
): UseQueryResult<{ total: number; probes: ProbeView[] }> =>
  useQuery({
    queryKey: ["report-probes", token, offset, limit],
    queryFn: async () => {
      if (!STATIC) {
        return getJson<{ total: number; probes: ProbeView[] }>(`${API}/reports/${token}/probes?offset=${offset}&limit=${limit}`);
      }
      // The snapshot carries the whole probe log once; page through it locally.
      const all = await apiGet<{ total: number; probes: ProbeView[] }>(`/reports/${token}/probes`);
      return { total: all.total, probes: all.probes.slice(offset, offset + limit) };
    },
    ...slow(15_000),
  });

export const useEconomics = (): UseQueryResult<EconomicsResponse> =>
  useQuery({ queryKey: ["economics"], queryFn: () => apiGet<EconomicsResponse>("/economics"), ...live });

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
