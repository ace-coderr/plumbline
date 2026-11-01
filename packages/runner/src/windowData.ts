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

/**
 * Events by block range. The explorer returns at most 1,000 events per request and ignores the page number, so paging would read the
 * same 1,000 again. Instead: ask for the range, and whenever exactly 1,000 come back (so there may be more) split the range in half and
 * ask for each half. A transaction seen twice (an event on the edge of two halves) is counted once, by its hash. At most MAX_LOG_CALLS
 * requests are made in all, to stay inside a Worker's subrequest budget.
 */
export const MAX_LOG_CALLS = 24;

export async function logsByRange(f: Fetch, query: (from: number, to: number) => string, from: number, to: number): Promise<{ rows: ChainLog[]; truncated: boolean }> {
  let calls = 0;
  let truncated = false;
  const byTx = new Map<string, ChainLog>();
  const read = async (a: number, b: number): Promise<void> => {
    if (calls >= MAX_LOG_CALLS) {
      truncated = true;
      return;
    }
    calls += 1;
    const r = await api<ChainLog[] | string>(f, `${query(a, b)}&page=1&offset=${PAGE}`);
    // An empty list comes back as a string ("No logs found").
    const rows = Array.isArray(r) ? r : [];
    if (rows.length >= PAGE) {
      if (a >= b) {
        // One block holding 1,000 events: it cannot be split further.
        truncated = true;
      } else {
        const mid = Math.floor((a + b) / 2);
        await read(a, mid);
        await read(mid + 1, b);
        return;
      }
    }
    for (const l of rows) byTx.set(l.transactionHash.toLowerCase(), l);
  };
  await read(from, to);
  return { rows: [...byTx.values()], truncated };
}

export type WindowResult = { ok: true; figures: WindowFigures } | { ok: false; reason: string };

/** The keeper's window, read from the chain through the explorer's index: its transactions and the Probed events. */
export async function fetchWindowFigures(f: Fetch, keeper: Address, campaigns: Address, start: number, end: number): Promise<WindowResult> {
  try {
    const from = await blockAt(f, start, "after");
    const to = await blockAt(f, end + 60, "before");
    const txs = await pages<ChainTx>(f, `module=account&action=txlist&address=${keeper}&startblock=${from}&endblock=${to}&sort=asc`);
    const logs = await logsByRange(f, (a, b) => `module=logs&action=getLogs&address=${campaigns}&topic0=${PROBED_TOPIC}&fromBlock=${a}&toBlock=${b}`, from, to);
    if (txs.truncated || logs.truncated) return { ok: false, reason: "more transactions than the summary reads" };
    return { ok: true, figures: summarizeWindow({ txs: txs.rows, logs: logs.rows, keeper, campaigns, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start, end }) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "the explorer could not be read" };
  }
}
