import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ELYSIUM_TESTNET, RUNNER_WALLETS, elysiumTestnet, type BotsSchedule } from "@plumbline/shared";
import type { Balances } from "./core/budget.js";
import { errorType } from "./core/errors.js";

/** The two public nodes, each asked once per call: failure is reported, never retried in a loop. */
export const RPC_URLS = [ELYSIUM_TESTNET.rpcUrl, "https://rpc-elysium-testnet.t.conduit.xyz"] as const;

/**
 * The nodes, best first: the private Conduit URL (when its secret is set), then the two public ones.
 * The private URL exists only inside this function and the transport it builds; an error that prints it
 * is scrubbed by `errText` before it is logged, stored or returned.
 */
export function makeClients(privateUrl?: string): PublicClient[] {
  const mk = (url: string): PublicClient =>
    createPublicClient({ chain: elysiumTestnet, transport: http(url, { timeout: 4_000, retryCount: 0 }), batch: { multicall: false } });
  return [...(privateUrl ? [mk(privateUrl)] : []), mk(RPC_URLS[0]), mk(RPC_URLS[1])];
}

/** Ask each node in turn until one answers; throws the last error if none does. */
export async function tryEach<T>(clients: PublicClient[], fn: (c: PublicClient) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const [i, c] of clients.entries()) {
    try {
      const r = await fn(c);
      // With a private node first, an answer from a later node means the private one failed.
      if (i > 0 && clients.length >= 3) fallbacks += 1;
      return r;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

let fallbacks = 0;
/** How many reads fell back from the private node to a public one since this was last asked. */
export function takeFallbacks(): number {
  const n = fallbacks;
  fallbacks = 0;
  return n;
}

const balanceAbi = parseAbi(["function getEthBalance(address) view returns (uint256)"]);

/** All runner wallets' HYPE balances in one call. A wallet with no address yet reads as zero. */
export async function readBalances(client: PublicClient, schedule: BotsSchedule): Promise<Balances> {
  const wallets = RUNNER_WALLETS.filter((w) => schedule.wallets[w] !== null);
  const res = await client.multicall({
    allowFailure: false,
    multicallAddress: ELYSIUM_TESTNET.multicall3,
    contracts: wallets.map((w) => ({ address: ELYSIUM_TESTNET.multicall3, abi: balanceAbi, functionName: "getEthBalance", args: [schedule.wallets[w] as Address] }) as const),
  });
  const out = {} as Balances;
  for (const w of RUNNER_WALLETS) out[w] = 0n;
  wallets.forEach((w, i) => {
    out[w] = res[i] as bigint;
  });
  return out;
}

/** How a failed send is treated. Only what the node did, not what the transaction was, decides a retry or a fall back. */
export type SendFailure = "known" | "nonce-low" | "rejected" | "rate-limit" | "transient";

const KNOWN = /already known|known transaction|already imported|already exists|already in (the )?(mem)?pool|ALREADY_EXISTS/i;
const NONCE_LOW = /nonce (is )?too low|nonce has already been used|NonceTooLow/i;
const REJECTED = /insufficient funds|execution reverted|intrinsic gas|gas (limit )?too low|underpriced|exceeds block gas|invalid sender|max fee per gas less than|exceeds the balance/i;
const RATE_LIMIT = /rate.?limit|\b429\b|too many requests/i;

/** Sorts a send error into one of five kinds, from its message and its node detail. */
export function classifySend(err: unknown): SendFailure {
  const e = err as { shortMessage?: string; details?: string; message?: string } | null;
  const text = `${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? String(err)}`;
  if (KNOWN.test(text)) return "known";
  if (NONCE_LOW.test(text)) return "nonce-low";
  if (REJECTED.test(text)) return "rejected";
  if (RATE_LIMIT.test(text)) return "rate-limit";
  return "transient";
}

/** After a fall back, the preferred node is tried again once this long has passed. */
export const RETURN_TO_PREFERRED_MS = 30_000;

export interface FallbackEvent {
  /** Indexes into the signer's node list, in its own order (0 is the preferred node). */
  from: number;
  to: number;
  failure: SendFailure;
  /** The kind of error (its name, never its text). */
  type: string;
}

export interface SignerOptions {
  /** Names for the nodes, in order, for messages. Never URLs. */
  names?: string[];
  /** Called when a send moves to another node. Must not throw and must not wait on anything slow. */
  onFallback?: (e: FallbackEvent) => void;
}

/**
 * Sends one wallet's transactions in order. The nonce is kept here, so sends need no read in between.
 *
 * A send is signed once. If the node does not answer cleanly the very same signed bytes are sent once more to the same node; they
 * can only ever become one transaction (same nonce, same hash), so a lost response can never turn into a second transaction. A node
 * that says "already known", or "nonce too low" for a transaction it can show under our hash, has our transaction: that is success.
 * If the retry fails too, the nonce is forgotten (it is read again from the next node) and sends move to the next node. After
 * RETURN_TO_PREFERRED_MS they try the preferred node again.
 */
export class Signer {
  private nonce: number | null = null;
  private fee = 0n;
  private feeAt = 0;

  /** The node sends go to: an index into `clients`. */
  private ix = 0;
  /** When to try the preferred node again, ms. */
  private returnAt = 0;
  private readonly clients: PublicClient[];
  private readonly opts: SignerOptions;

  constructor(
    readonly account: PrivateKeyAccount,
    client: PublicClient | PublicClient[],
    opts: SignerOptions = {},
  ) {
    this.clients = Array.isArray(client) ? client : [client];
    this.opts = opts;
  }

  private get client(): PublicClient {
    return this.clients[this.ix] as PublicClient;
  }

  get address(): Address {
    return this.account.address;
  }

  /** True while sends are going to a node other than the preferred one. */
  get fellBack(): boolean {
    return this.ix !== 0;
  }

  /** The preferred node again, once the wait is over. The nonce is ours and stays as it is. */
  private returnToPreferred(): void {
    if (this.ix !== 0 && Date.now() >= this.returnAt) this.ix = 0;
  }

  private fallBack(failure: SendFailure, err: unknown): void {
    if (this.clients.length < 2) return;
    const from = this.ix;
    this.ix = (this.ix + 1) % this.clients.length;
    this.returnAt = Date.now() + RETURN_TO_PREFERRED_MS;
    try {
      this.opts.onFallback?.({ from, to: this.ix, failure, type: errorType(err) });
    } catch {
      // A broken alert hook must never stop a send.
    }
  }

  /** Whether the node can show a transaction under this hash: ours is already in. */
  private async has(hash: Hash): Promise<boolean> {
    return this.client.getTransaction({ hash }).then(
      () => true,
      () => false,
    );
  }

  async send(to: Address, data: Hex, gas: bigint, value = 0n): Promise<Hash> {
    this.returnToPreferred();
    if (this.nonce === null) this.nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
    if (Date.now() - this.feeAt > 30_000 || this.fee === 0n) {
      // Twice the current price: the fee only has to clear the base fee, and Elysium's is flat.
      this.fee = (await this.client.getGasPrice()) * 2n;
      this.feeAt = Date.now();
    }
    const nonce = this.nonce;
    const raw = await this.account.signTransaction({
      chainId: elysiumTestnet.id,
      type: "eip1559",
      to,
      data,
      value,
      nonce,
      gas,
      maxFeePerGas: this.fee,
      maxPriorityFeePerGas: 0n,
    });
    const hash = keccak256(raw);
    let last: unknown;
    let failure: SendFailure = "transient";
    // At most two tries, both with these same signed bytes. Nothing below signs anything again.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const sent = await this.client.sendRawTransaction({ serializedTransaction: raw });
        this.nonce = nonce + 1;
        return sent;
      } catch (err) {
        last = err;
        failure = classifySend(err);
        if (failure === "known") {
          this.nonce = nonce + 1;
          return hash;
        }
        if (failure === "nonce-low" && (await this.has(hash))) {
          this.nonce = nonce + 1;
          return hash;
        }
        // Only a node that did not answer is worth asking again right away.
        if (failure !== "transient") break;
      }
    }
    // Not known to be in. Read the nonce again before the next send; and if the node itself was the trouble, move on from it.
    this.nonce = null;
    if (failure === "transient" || failure === "rate-limit") this.fallBack(failure, last);
    throw last;
  }

  /** Send and wait for the receipt, polling a bounded number of times; throws unless it succeeded. */
  async sendAndConfirm(to: Address, data: Hex, gas: bigint, waitMs = 15_000, value = 0n): Promise<TransactionReceipt> {
    const hash = await this.send(to, data, gas, value);
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 800));
      const r = await this.client.getTransactionReceipt({ hash }).catch(() => null);
      if (r) {
        if (r.status !== "success") throw new Error(`transaction reverted (${hash.slice(0, 10)}…)`);
        return r;
      }
    }
    throw new Error(`no receipt after ${waitMs / 1000}s (${hash.slice(0, 10)}…)`);
  }
}
