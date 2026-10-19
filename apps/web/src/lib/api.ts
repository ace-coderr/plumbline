import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  CampaignDetail,
  CampaignView,
  DepthReport,
  EconomicsResponse,
  IndexerHealth,
  MakerProfile,
  MarketDetail,
  MarketSummary,
  ProbeView,
  UptimeResponse,
} from "@plumbline/shared";

/** Indexer API, proxied under /api by both the Vite dev server and the production web server. */
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

const live = { refetchInterval: 3_000, staleTime: 1_000 } as const;

export const useHealth = (): UseQueryResult<IndexerHealth> =>
  useQuery({ queryKey: ["health"], queryFn: () => getJson<IndexerHealth>(`${API}/health`), ...live });

export const useMarkets = (): UseQueryResult<MarketSummary[]> =>
  useQuery({ queryKey: ["markets"], queryFn: () => getJson<MarketSummary[]>(`${API}/markets`), ...live });

export const useMarket = (pair: string): UseQueryResult<MarketDetail> =>
  useQuery({ queryKey: ["market", pair], queryFn: () => getJson<MarketDetail>(`${API}/markets/${pair}`), ...live });

export const useUptime = (pair: string, window: string): UseQueryResult<UptimeResponse> =>
  useQuery({
    queryKey: ["uptime", pair, window],
    queryFn: () => getJson<UptimeResponse>(`${API}/markets/${pair}/uptime?window=${window}`),
    refetchInterval: 5_000,
  });

export const useCampaigns = (): UseQueryResult<CampaignView[]> =>
  useQuery({ queryKey: ["campaigns"], queryFn: () => getJson<CampaignView[]>(`${API}/campaigns`), ...live });

export const useCampaign = (id: number): UseQueryResult<CampaignDetail> =>
  useQuery({ queryKey: ["campaign", id], queryFn: () => getJson<CampaignDetail>(`${API}/campaigns/${id}`), ...live });

export const useMaker = (address: string | undefined): UseQueryResult<MakerProfile> =>
  useQuery({
    queryKey: ["maker", address],
    queryFn: () => getJson<MakerProfile>(`${API}/makers/${address ?? ""}`),
    enabled: Boolean(address),
    ...live,
  });

export const useReport = (token: string, window: string): UseQueryResult<DepthReport> =>
  useQuery({
    queryKey: ["report", token, window],
    queryFn: () => getJson<DepthReport>(`${API}/reports/${token}?window=${window}`),
    refetchInterval: 15_000,
  });

export const useReportProbes = (
  token: string,
  offset: number,
  limit: number,
): UseQueryResult<{ total: number; probes: ProbeView[] }> =>
  useQuery({
    queryKey: ["report-probes", token, offset, limit],
    queryFn: () =>
      getJson<{ total: number; probes: ProbeView[] }>(`${API}/reports/${token}/probes?offset=${offset}&limit=${limit}`),
    refetchInterval: 15_000,
  });

export const useEconomics = (): UseQueryResult<EconomicsResponse> =>
  useQuery({ queryKey: ["economics"], queryFn: () => getJson<EconomicsResponse>(`${API}/economics`), ...live });

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

export const useKeeper = (): UseQueryResult<KeeperStats> =>
  useQuery({ queryKey: ["keeper"], queryFn: () => getJson<KeeperStats>(`${KEEPER}/stats`), ...live, retry: false });
