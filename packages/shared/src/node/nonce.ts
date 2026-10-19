/**
 * Transaction sender with local nonce management, tuned for Elysium's 100-200ms blocks.
 *
 * Transactions are signed locally and pushed with eth_sendRawTransaction, so a send costs one
 * gas estimate and one submit round trip. Nonces are allocated in-process; on a nonce error the
 * sender resyncs from the node's pending count and retries.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { Logger } from "./env.js";

export interface TxRequest {
  /** Target; omit to deploy `data` as contract creation code. */
  to?: `0x${string}`;
  data: Hex;
  value?: bigint;
  /** Skip estimation and use this gas limit. */
  gas?: bigint;
  /** Label for logs. */
  label?: string;
  /** ABI used to decode custom revert errors from gas estimation. */
  abi?: Abi;
}

export interface SentTx {
  hash: Hex;
  nonce: number;
  gas: bigint;
  sentAt: number;
}

/** Thrown when gas estimation shows the call would revert. Nothing was broadcast. */
export class WouldRevertError extends Error {
  constructor(
    message: string,
    readonly errorName: string | null,
  ) {
    super(message);
    this.name = "WouldRevertError";
  }
}

export class TxSender {
  private nonce: number | null = null;
  private lock: Promise<void> = Promise.resolve();
  private maxFeePerGas = 0n;
  private feeFetchedAt = 0;

  constructor(
    readonly account: LocalAccount,
    private readonly client: PublicClient,
    private readonly chainId: number,
    private readonly log: Logger,
    private readonly opts: { gasMultiplierPct?: number; feeRefreshMs?: number } = {},
  ) {}

  get address(): `0x${string}` {
    return this.account.address;
  }

  /** Reload the next nonce from the node's pending count. */
  async resync(): Promise<number> {
    this.nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
    return this.nonce;
  }

  private async fee(): Promise<bigint> {
    // Pin the fee cap, e.g. on a local fork whose eth_gasPrice does not match the real chain.
    const pinned = process.env.TX_MAX_FEE_WEI;
    if (pinned) return BigInt(pinned);
    const refresh = this.opts.feeRefreshMs ?? 15_000;
    if (this.maxFeePerGas === 0n || Date.now() - this.feeFetchedAt > refresh) {
      const gasPrice = await this.client.getGasPrice();
      // Arbitrum ignores priority tips. Elysium's base fee sits at its floor, so modest headroom is
      // enough, and a lower cap means less balance has to be held back per transaction.
      this.maxFeePerGas = (gasPrice * 5n) / 4n;
      this.feeFetchedAt = Date.now();
    }
    return this.maxFeePerGas;
  }

  /** Run `fn` exclusively so nonce allocation and submission stay ordered. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Estimate, sign and broadcast. Resolves once the node has accepted the transaction. */
  async send(req: TxRequest): Promise<SentTx> {
    let gas = req.gas;
    if (gas === undefined) {
      try {
        const est = await this.client.estimateGas({
          account: this.account.address,
          to: req.to,
          data: req.data,
          value: req.value ?? 0n,
        });
        gas = (est * BigInt(this.opts.gasMultiplierPct ?? 130)) / 100n;
      } catch (err) {
        throw toWouldRevert(err, req.abi);
      }
    }
    const gasLimit = gas;

    return this.exclusive(async () => {
      if (this.nonce === null) await this.resync();
      for (let attempt = 0; attempt < 4; attempt++) {
        const nonce = this.nonce as number;
        const maxFeePerGas = await this.fee();
        const serialized = await this.account.signTransaction({
          chainId: this.chainId,
          type: "eip1559",
          to: req.to ?? null,
          data: req.data,
          value: req.value ?? 0n,
          nonce,
          gas: gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas: 0n,
        });
        try {
          const hash = await this.client.sendRawTransaction({ serializedTransaction: serialized });
          this.nonce = nonce + 1;
          return { hash, nonce, gas: gasLimit, sentAt: Date.now() };
        } catch (err) {
          const msg = errText(err);
          if (/nonce too low|nonce too high|invalid nonce|replacement transaction/i.test(msg)) {
            const fresh = await this.resync();
            this.log.warn("nonce resync", { label: req.label, had: nonce, now: fresh });
            continue;
          }
          if (/max fee per gas less than block base fee|fee cap/i.test(msg)) {
            this.feeFetchedAt = 0;
            continue;
          }
          if (/already known/i.test(msg)) {
            this.nonce = nonce + 1;
            throw new Error(`tx with nonce ${nonce} already in mempool`);
          }
          throw err;
        }
      }
      throw new Error(`could not submit ${req.label ?? "tx"} after nonce retries`);
    });
  }

  /** Wait for a receipt with tight polling. */
  async wait(hash: Hex, timeoutMs = 30_000): Promise<TransactionReceipt> {
    const pollingInterval = Number(process.env.TX_RECEIPT_POLL_MS ?? 300);
    return this.client.waitForTransactionReceipt({ hash, pollingInterval, timeout: timeoutMs });
  }

  /** Send and wait; throws if the transaction reverted on-chain. */
  async sendAndWait(req: TxRequest): Promise<{ sent: SentTx; receipt: TransactionReceipt }> {
    const sent = await this.send(req);
    const receipt = await this.wait(sent.hash);
    if (receipt.status !== "success") throw new Error(`${req.label ?? "tx"} reverted: ${sent.hash}`);
    return { sent, receipt };
  }
}

function errText(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details ?? ""}`;
  return err instanceof Error ? err.message : String(err);
}

function toWouldRevert(err: unknown, abi?: Abi): WouldRevertError {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return new WouldRevertError(revert.shortMessage, revert.data?.errorName ?? null);
    }
    const data = findRevertData(err);
    if (data && abi) {
      try {
        const decoded = decodeErrorResult({ abi, data });
        return new WouldRevertError(`reverted: ${decoded.errorName}`, decoded.errorName);
      } catch {
        // fall through to the generic message
      }
    }
    return new WouldRevertError(err.shortMessage, null);
  }
  return new WouldRevertError(err instanceof Error ? err.message : String(err), null);
}

/** Dig the raw revert payload out of a viem error chain. */
function findRevertData(err: BaseError): Hex | null {
  let found: Hex | null = null;
  err.walk((e) => {
    if (found) return true;
    if (typeof e === "object" && e !== null && "data" in e) {
      const d = (e as { data: unknown }).data;
      if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) found = d as Hex;
      else if (typeof d === "object" && d !== null && "data" in d) {
        const inner = (d as { data: unknown }).data;
        if (typeof inner === "string" && /^0x[0-9a-fA-F]{8,}$/.test(inner)) found = inner as Hex;
      }
    }
    return false;
  });
  return found;
}
