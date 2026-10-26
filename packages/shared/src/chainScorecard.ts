/**
 * Recompute a vault's scorecard figures straight from the chain: every `ProbeResult` and `Penalized`
 * event the campaigns contract emitted for the vault, read with chunked `getLogs`. Nothing here
 * touches the indexer, so /verify can check a report against the chain alone.
 */
import { erc20Abi, type Hex, type PublicClient } from "viem";
import { plumbCampaignsAbi } from "./abis/PlumbCampaigns.js";
import { plumbQuoteAbi } from "./abis/PlumbQuote.js";
import { deployment } from "./addresses.js";
import { computeFigures, type ScorecardFigures, type VaultProbeRow, type VaultSlash } from "./scorecard.js";
import type { Address } from "./pairs.js";

/** Inclusive block ranges of at most `size` blocks covering [from, to]. */
export function chunkRanges(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  if (size < 1n) throw new Error("chunk size must be at least 1");
  const out: { from: bigint; to: bigint }[] = [];
  for (let a = from; a <= to; a += size) {
    const b = a + size - 1n;
    out.push({ from: a, to: b < to ? b : to });
  }
  return out;
}

export interface ScanOptions {
  /** Blocks per request to start with. */
  chunk?: bigint;
  /** A range is never split below this many blocks; a failure there is thrown. */
  minChunk?: bigint;
  /** Extra attempts for a failing range before it is split or given up on. */
  retries?: number;
  retryDelayMs?: number;
  /**
   * Failed requests in a row (reset by any success) before the scan gives up. Without it, a node that
   * keeps failing makes the scan split ever smaller ranges and retry each one, which looks like hanging.
   */
  maxFailures?: number;
  onProgress?: (doneThrough: bigint) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A node refusing the range itself (too wide, too many results): retrying the same range cannot help. */
const refusesRange = (err: unknown): boolean =>
  /more than|too many|limit|exceed|too large|range|result set|response size/i.test(err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err));

/**
 * Read [from, to] in chunks. A range the node refuses (too many results, too wide) is retried, then
 * split in half and read as two; only a range already at `minChunk` blocks fails the scan.
 */
export async function scanRange<T>(
  from: bigint,
  to: bigint,
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  opts: ScanOptions = {},
): Promise<T[]> {
  const { chunk = 50_000n, minChunk = 500n, retries = 2, retryDelayMs = 700, maxFailures = 5, onProgress } = opts;
  if (to < from) return [];
  const out: T[] = [];
  let failures = 0;

  const read = async (a: bigint, b: bigint): Promise<T[]> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const got = await fetchRange(a, b);
        failures = 0;
        return got;
      } catch (err) {
        lastError = err;
        if (++failures > maxFailures) throw err;
        if (refusesRange(err)) break; // split now instead of asking the same question again
        if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    const width = b - a + 1n;
    if (width <= minChunk) throw lastError;
    const mid = a + width / 2n - 1n;
    return [...(await read(a, mid)), ...(await read(mid + 1n, b))];
  };

  for (const r of chunkRanges(from, to, chunk)) {
    out.push(...(await read(r.from, r.to)));
    onProgress?.(r.to);
  }
  return out;
}

export interface ChainScorecard {
  vault: Address;
  /** The vault's owner now, read on-chain. */
  owner: Address;
  base: { address: Address; decimals: number; symbol: string };
  quote: { address: Address; decimals: number; symbol: string };
  figures: ScorecardFigures;
  /** Blocks read, inclusive. */
  fromBlock: number;
  toBlock: number;
  eventCounts: { probeResults: number; penalties: number };
}

export interface RecomputeOptions extends ScanOptions {
  vault: Address;
  /** Last block to read; figures cover the chain up to and including it. */
  asOfBlock: bigint;
  /** First block to read; defaults to the block the contracts were deployed at. */
  fromBlock?: bigint;
}

/**
 * Figures for `vault` from chain data. `onProgress` is called with the last block read so far.
 * Token decimals and the owner are read from the vault and its tokens; nothing is taken on trust.
 */
export async function recomputeFromChain(client: PublicClient, opts: RecomputeOptions): Promise<ChainScorecard> {
  const { vault, asOfBlock } = opts;
  const from = opts.fromBlock ?? BigInt(deployment.deployBlock);
  const campaigns = deployment.contracts.campaigns as Address;

  const [owner, baseToken, quoteToken] = await Promise.all([
    client.readContract({ address: vault, abi: plumbQuoteAbi, functionName: "owner" }),
    client.readContract({ address: vault, abi: plumbQuoteAbi, functionName: "baseToken" }),
    client.readContract({ address: vault, abi: plumbQuoteAbi, functionName: "quoteToken" }),
  ]);
  const [baseDecimals, quoteDecimals, baseSymbol, quoteSymbol] = await Promise.all([
    client.readContract({ address: baseToken, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: quoteToken, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: baseToken, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: quoteToken, abi: erc20Abi, functionName: "symbol" }),
  ]);

  const results = await scanRange(
    from,
    asOfBlock,
    async (a, b) =>
      client.getContractEvents({
        abi: plumbCampaignsAbi,
        address: campaigns,
        eventName: "ProbeResult",
        args: { vault },
        fromBlock: a,
        toBlock: b,
        strict: true,
      }),
    opts,
  );
  const penalties = await scanRange(
    from,
    asOfBlock,
    async (a, b) =>
      client.getContractEvents({
        abi: plumbCampaignsAbi,
        address: campaigns,
        eventName: "Penalized",
        args: { vault },
        fromBlock: a,
        toBlock: b,
        strict: true,
      }),
    { ...opts, onProgress: undefined },
  );

  const rows: VaultProbeRow[] = results.map((l) => ({
    campaignId: Number(l.args.id),
    epoch: Number(l.args.epoch),
    nonce: Number(l.args.nonce),
    passed: l.args.passed,
    failMask: l.args.failMask,
    spreadBps: l.args.spreadBps,
    bidPx: l.args.bidPx.toString(),
    askPx: l.args.askPx.toString(),
    bidSize: l.args.bidSize.toString(),
    askSize: l.args.askSize.toString(),
  }));
  const slashes: VaultSlash[] = penalties.map((l) => ({
    campaignId: Number(l.args.id),
    txHash: l.transactionHash as Hex,
    slashed: l.args.slashed.toString(),
  }));

  return {
    vault,
    owner,
    base: { address: baseToken, decimals: baseDecimals, symbol: baseSymbol },
    quote: { address: quoteToken, decimals: quoteDecimals, symbol: quoteSymbol },
    figures: computeFigures(rows, slashes, { base: baseDecimals, quote: quoteDecimals }),
    fromBlock: Number(from),
    toBlock: Number(asOfBlock),
    eventCounts: { probeResults: results.length, penalties: penalties.length },
  };
}
