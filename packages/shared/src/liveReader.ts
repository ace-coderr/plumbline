/**
 * Browser-side live reader. The static site ships a snapshot taken at some block; this reads what
 * happened on-chain after it. Two sources, kept apart on purpose:
 *
 *  - contract views (campaign terms and state, every vault and its live quote): the current truth,
 *    one multicall away, never stale;
 *  - events from the campaigns contract since the snapshot block, scanned in chunks: the history
 *    the views do not hold (probes, who was checked, slashes).
 *
 * Everything returned is JSON-safe (bigints as decimal strings), so it can be cached in IndexedDB.
 * No failure becomes data: a call that cannot be read throws, and callers keep what they had.
 */
import { erc20Abi, getAddress, parseEventLogs, zeroAddress, type Hex, type PublicClient } from "viem";
import { plumbCampaignsAbi } from "./abis/PlumbCampaigns.js";
import { plumbQuoteAbi } from "./abis/PlumbQuote.js";
import { plumbQuoteFactoryAbi } from "./abis/PlumbQuoteFactory.js";
import { deployment } from "./addresses.js";
import { scanRange, type ScanOptions } from "./chainScorecard.js";
import { appIdOf, campaignSources } from "./campaignIds.js";
import { knownTokens, type Address } from "./pairs.js";

const FACTORY = deployment.contracts.factory as Address;

// -------------------------------------------------------------------------------------------------
// Views
// -------------------------------------------------------------------------------------------------

export interface ChainTerms {
  base: Address;
  quote: Address;
  epochLength: number;
  rewardPerEpoch: string;
  maxSpreadBps: number;
  minDepthBase: string;
  minDepthQuote: string;
  minProbeInterval: number;
  probeFeeBps: number;
  makerBond: string;
}

export interface ChainCampaignState {
  creator: Address;
  rewardToken: Address;
  referencePrice: Address;
  startTime: number;
  numEpochs: number;
  settledEpochs: number;
  lastProbeAt: number;
  /** Probes run so far: the contract's nonce. */
  probeNonce: number;
}

export interface ChainCampaign {
  id: number;
  terms: ChainTerms;
  state: ChainCampaignState;
}

export interface ChainQuote {
  bidPx: string;
  askPx: string;
  bidSize: string;
  askSize: string;
  updatedAt: number;
  seq: number;
}

export interface ChainVault {
  address: Address;
  owner: Address;
  quoter: Address;
  /** Unix seconds the factory created the vault at. */
  createdAt: number;
  base: Address;
  quote: Address;
  /** Quote fresh at the head block's time. */
  live: boolean;
  quoteData: ChainQuote;
  freeBase: string;
  freeQuote: string;
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

export interface ChainViews {
  head: number;
  headTs: number;
  campaignCount: number;
  campaigns: ChainCampaign[];
  vaultCount: number;
  vaults: ChainVault[];
  tokens: Record<string, TokenMeta>;
  /** Anything beyond these caps was not read, and the counts above say how many there are. */
  capped: { campaigns: boolean; vaults: boolean };
}

const MAX_CAMPAIGNS = 400;
const MAX_VAULTS = 200;

const num = (v: bigint | number): number => Number(v);
const lc = (a: string) => a.toLowerCase();

/** Read a multicall result, or throw: a failed read must never turn into a zero. */
function ok<T>(r: { status: "success"; result: T } | { status: "failure"; error: Error }, what: string): T {
  if (r.status !== "success") throw new Error(`could not read ${what}: ${r.error.message.split("\n")[0] ?? "failed"}`);
  return r.result;
}

export async function readChainViews(client: PublicClient): Promise<ChainViews> {
  // Round trips cost 0.5-1.5 s each on the public nodes, so independent reads go out together.
  const [block, counts, vaultCount] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    Promise.all(campaignSources.map((s) => client.readContract({ address: s.campaigns, abi: plumbCampaignsAbi, functionName: "campaignCount" }))),
    client.readContract({ address: FACTORY, abi: plumbQuoteFactoryAbi, functionName: "vaultCount" }),
  ]);
  const head = num(block.number);
  const headTs = num(block.timestamp);
  const campaignCount = counts.reduce((a, c) => a + num(c), 0);
  const capped = counts.some((c) => num(c) > MAX_CAMPAIGNS);
  const nVaults = Math.min(num(vaultCount), MAX_VAULTS);

  // Each contract numbers its campaigns from 1; `idBase` makes the app id unique across contracts.
  const refs = campaignSources.flatMap((s, si) =>
    Array.from({ length: Math.min(num(counts[si] as bigint), MAX_CAMPAIGNS) }, (_, i) => ({ source: s, local: i + 1, id: s.idBase + i + 1 })),
  );
  const [campaignReads, vaultAddrReads] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: refs.flatMap((r) => [
        { address: r.source.campaigns, abi: plumbCampaignsAbi, functionName: "terms", args: [BigInt(r.local)] } as const,
        { address: r.source.campaigns, abi: plumbCampaignsAbi, functionName: "state", args: [BigInt(r.local)] } as const,
      ]),
    }),
    client.multicall({
      allowFailure: true,
      contracts: Array.from({ length: nVaults }, (_, i) => ({ address: FACTORY, abi: plumbQuoteFactoryAbi, functionName: "vaultAt", args: [BigInt(i)] }) as const),
    }),
  ]);
  const campaigns: ChainCampaign[] = refs.map(({ id }, i) => {
    const t = ok(campaignReads[i * 2] as never, `campaign ${id} terms`) as {
      base: Address; quote: Address; epochLength: bigint; rewardPerEpoch: bigint; maxSpreadBps: number;
      minDepthBase: bigint; minDepthQuote: bigint; minProbeInterval: number; probeFeeBps: number; makerBond: bigint;
    };
    const s = ok(campaignReads[i * 2 + 1] as never, `campaign ${id} state`) as {
      creator: Address; rewardToken: Address; referencePrice: Address; startTime: bigint; numEpochs: number;
      settledEpochs: number; lastProbeAt: bigint; probeNonce: bigint;
    };
    return {
      id,
      terms: {
        base: getAddress(t.base) as Address,
        quote: getAddress(t.quote) as Address,
        epochLength: num(t.epochLength),
        rewardPerEpoch: t.rewardPerEpoch.toString(),
        maxSpreadBps: t.maxSpreadBps,
        minDepthBase: t.minDepthBase.toString(),
        minDepthQuote: t.minDepthQuote.toString(),
        minProbeInterval: t.minProbeInterval,
        probeFeeBps: t.probeFeeBps,
        makerBond: t.makerBond.toString(),
      },
      state: {
        creator: getAddress(s.creator) as Address,
        rewardToken: getAddress(s.rewardToken) as Address,
        referencePrice: getAddress(s.referencePrice) as Address,
        startTime: num(s.startTime),
        numEpochs: s.numEpochs,
        settledEpochs: s.settledEpochs,
        lastProbeAt: num(s.lastProbeAt),
        probeNonce: num(s.probeNonce),
      },
    };
  });

  const vaultAddrs = vaultAddrReads.map((r, i) => ok(r as never, `vault ${i}`) as Address);

  const vaultReads = await client.multicall({
    allowFailure: true,
    contracts: vaultAddrs.flatMap((a) => [
      { address: a, abi: plumbQuoteAbi, functionName: "owner" } as const,
      { address: a, abi: plumbQuoteAbi, functionName: "baseToken" } as const,
      { address: a, abi: plumbQuoteAbi, functionName: "quoteToken" } as const,
      { address: a, abi: plumbQuoteAbi, functionName: "isLive" } as const,
      { address: a, abi: plumbQuoteAbi, functionName: "quoter" } as const,
      { address: FACTORY, abi: plumbQuoteFactoryAbi, functionName: "createdAt", args: [a] } as const,
      // The quote and both free balances, read together by the contract at one instant.
      { address: a, abi: plumbQuoteAbi, functionName: "probeSnapshot" } as const,
    ]),
  });
  const vaults: ChainVault[] = vaultAddrs.map((a, i) => {
    const r = (k: number) => vaultReads[i * 7 + k] as never;
    const [q, , freeBase, freeQuote] = ok(r(6), `vault ${a} snapshot`) as readonly [
      { bidPx: bigint; askPx: bigint; bidSize: bigint; askSize: bigint; updatedAt: bigint; seq: bigint },
      number,
      bigint,
      bigint,
    ];
    return {
      address: getAddress(a) as Address,
      owner: getAddress(ok(r(0), `vault ${a} owner`) as string) as Address,
      quoter: getAddress(ok(r(4), `vault ${a} quoter`) as string) as Address,
      createdAt: num(ok(r(5), `vault ${a} creation time`) as bigint),
      base: getAddress(ok(r(1), `vault ${a} base`) as string) as Address,
      quote: getAddress(ok(r(2), `vault ${a} quote token`) as string) as Address,
      live: ok(r(3), `vault ${a} liveness`) as boolean,
      quoteData: {
        bidPx: q.bidPx.toString(), askPx: q.askPx.toString(), bidSize: q.bidSize.toString(), askSize: q.askSize.toString(),
        updatedAt: num(q.updatedAt), seq: num(q.seq),
      },
      freeBase: freeBase.toString(),
      freeQuote: freeQuote.toString(),
    };
  });

  // Token names: the deployment's known tokens first, the rest from the tokens themselves.
  const tokens: Record<string, TokenMeta> = {};
  for (const t of knownTokens()) tokens[lc(t.address)] = { symbol: t.symbol, decimals: t.decimals };
  const unknown = new Set<string>();
  for (const v of vaults) for (const a of [v.base, v.quote]) if (!tokens[lc(a)]) unknown.add(a);
  for (const c of campaigns) {
    for (const a of [c.terms.base, c.terms.quote, c.state.rewardToken]) if (a !== zeroAddress && !tokens[lc(a)]) unknown.add(a);
  }
  const list = [...unknown] as Address[];
  if (list.length) {
    const reads = await client.multicall({
      allowFailure: true,
      contracts: list.flatMap((a) => [
        { address: a, abi: erc20Abi, functionName: "symbol" } as const,
        { address: a, abi: erc20Abi, functionName: "decimals" } as const,
      ]),
    });
    list.forEach((a, i) => {
      const sym = reads[i * 2] as { status: string; result?: string };
      const dec = reads[i * 2 + 1] as { status: string; result?: number };
      // A token that will not say its symbol is shown by address, never guessed.
      tokens[lc(a)] = {
        symbol: sym.status === "success" && sym.result ? sym.result.slice(0, 16) : `${a.slice(0, 6)}…${a.slice(-4)}`,
        decimals: dec.status === "success" && typeof dec.result === "number" ? dec.result : 18,
      };
    });
  }

  return {
    head,
    headTs,
    campaignCount,
    campaigns,
    vaultCount: num(vaultCount),
    vaults,
    tokens,
    capped: { campaigns: capped, vaults: num(vaultCount) > MAX_VAULTS },
  };
}

// -------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------

export type LiveEventName =
  | "CampaignOpened"
  | "MakerRegistered"
  | "UnbondRequested"
  | "BondReleased"
  | "BondToppedUp"
  | "Probed"
  | "ProbeResult"
  | "Penalized"
  | "RewardCredited"
  | "EpochSettled";

const WANTED = new Set<string>(["CampaignOpened", "MakerRegistered", "UnbondRequested", "BondReleased", "BondToppedUp", "Probed", "ProbeResult", "Penalized", "RewardCredited", "EpochSettled"]);

/** One decoded event, JSON-safe. `args` values are strings (bigints and addresses), booleans or numbers. */
export interface LiveLog {
  name: LiveEventName;
  block: number;
  logIndex: number;
  txHash: Hex;
  args: Record<string, string | number | boolean>;
}

function flatten(args: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof args !== "object" || args === null) return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "object" && v !== null) {
      // the CampaignOpened terms tuple
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        out[`${k}.${k2}`] = typeof v2 === "bigint" ? v2.toString() : (v2 as string | number | boolean);
      }
    }
  }
  return out;
}

export const logKey = (l: Pick<LiveLog, "txHash" | "logIndex">) => `${l.txHash}:${l.logIndex}`;

/**
 * Every event of every campaigns contract (v1 and v2) in [from, to], chunked, with a per-chunk split on
 * failure. A campaign id in an event is rewritten to the app id, so v1 #1 and v2 #1 stay apart.
 */
export async function scanCampaignEvents(client: PublicClient, from: bigint, to: bigint, opts: ScanOptions = {}): Promise<LiveLog[]> {
  const raw = await scanRange(
    from,
    to,
    async (a, b) => {
      const logs = await client.getLogs({ address: campaignSources.map((s) => s.campaigns), fromBlock: a, toBlock: b });
      return parseEventLogs({ abi: plumbCampaignsAbi, logs, strict: false });
    },
    { chunk: 1_000_000n, minChunk: 2_000n, ...opts },
  );
  const out: LiveLog[] = [];
  for (const l of raw) {
    const name = (l as { eventName?: string }).eventName;
    if (!name || !WANTED.has(name)) continue;
    if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null) continue;
    const args = flatten((l as { args?: unknown }).args);
    if (args.id !== undefined) {
      const appId = appIdOf(l.address, Number(args.id));
      if (appId === null) continue;
      args.id = String(appId);
    }
    out.push({ name: name as LiveEventName, block: num(l.blockNumber), logIndex: l.logIndex, txHash: l.transactionHash, args });
  }
  return out;
}

/** Timestamps of `blocks`, reading only those not already in `known`. */
export async function readBlockTimes(
  client: PublicClient,
  blocks: number[],
  known: Record<number, number>,
  concurrency = 4,
): Promise<Record<number, number>> {
  const out: Record<number, number> = { ...known };
  const todo = [...new Set(blocks)].filter((b) => out[b] === undefined);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      for (;;) {
        const b = todo[next++];
        if (b === undefined) return;
        const blk = await client.getBlock({ blockNumber: BigInt(b) });
        out[b] = num(blk.timestamp);
      }
    }),
  );
  return out;
}
