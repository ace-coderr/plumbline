import { encodeEventTopics, toFunctionSelector, type Address } from "viem";
import { ELYSIUM_TESTNET, plumbCampaignsAbi } from "@plumbline/shared";
import { summarizeWindow, type ChainLog, type ChainTx, type WindowFigures } from "./core/windowSummary.js";

const PAGE = 1000;
/** At most this many pages of each list: 5,000 keeper transactions in a window is far beyond any real run. */
const MAX_PAGES = 5;

const abiFn = (name: string) => plumbCampaignsAbi.find((f) => f.type === "function" && f.name === name)!;
export const PROBE_SELECTOR = toFunctionSelector(abiFn("probe") as Parameters<typeof toFunctionSelector>[0]);
export const SETTLE_SELECTOR = toFunctionSelector(abiFn("settle") as Parameters<typeof toFunctionSelector>[0]);
const PROBED_TOPIC = encodeEventTopics({ abi: plumbCampaignsAbi, eventName: "Probed" } as never)[0] as string;

type Fetch = typeof fetch;

async function api<T>(f: Fetch, query: string): Promise<T> {
  const res = await f(`${ELYSIUM_TESTNET.explorerApiUrl}?${query}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`the explorer answered ${res.status}`);
  const body = (await res.json()) as { result: T; message?: string };
  return body.result;
}

async function blockAt(f: Fetch, ts: number, closest: "before" | "after"): Promise<number> {
  const r = await api<{ blockNumber: string } | string>(f, `module=block&action=getblocknobytime&timestamp=${ts}&closest=${closest}`);
  const n = Number(typeof r === "object" && r !== null ? r.blockNumber : r);
  if (!Number.isFinite(n) || n <= 0) throw new Error("the explorer could not place the window in blocks");
  return n;
}

async function pages<T>(f: Fetch, query: string): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await api<T[] | string>(f, `${query}&page=${page}&offset=${PAGE}`);
    // An empty list comes back as a string ("No transactions found").
    if (!Array.isArray(r) || r.length === 0) return { rows, truncated: false };
    rows.push(...r);
    if (r.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export type WindowResult = { ok: true; figures: WindowFigures } | { ok: false; reason: string };

/** The keeper's window, read from the chain through the explorer's index: its transactions and the Probed events. */
export async function fetchWindowFigures(f: Fetch, keeper: Address, campaigns: Address, start: number, end: number): Promise<WindowResult> {
  try {
    const from = await blockAt(f, start, "after");
    const to = await blockAt(f, end + 60, "before");
    const txs = await pages<ChainTx>(f, `module=account&action=txlist&address=${keeper}&startblock=${from}&endblock=${to}&sort=asc`);
    const logs = await pages<ChainLog>(f, `module=logs&action=getLogs&address=${campaigns}&topic0=${PROBED_TOPIC}&fromBlock=${from}&toBlock=${to}`);
    if (txs.truncated || logs.truncated) return { ok: false, reason: "more transactions than the summary reads" };
    return { ok: true, figures: summarizeWindow({ txs: txs.rows, logs: logs.rows, keeper, campaigns, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start, end }) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "the explorer could not be read" };
  }
}
