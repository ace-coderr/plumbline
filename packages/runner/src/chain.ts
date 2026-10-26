import {
  createPublicClient,
  http,
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

/** The two public nodes, each asked once per call: failure is reported, never retried in a loop. */
export const RPC_URLS = [ELYSIUM_TESTNET.rpcUrl, "https://rpc-elysium-testnet.t.conduit.xyz"] as const;

export function makeClients(): [PublicClient, PublicClient] {
  const mk = (url: string): PublicClient =>
    createPublicClient({ chain: elysiumTestnet, transport: http(url, { timeout: 4_000, retryCount: 0 }), batch: { multicall: false } });
  return [mk(RPC_URLS[0]), mk(RPC_URLS[1])];
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

/**
 * Signs and submits from one wallet with a locally tracked nonce. One attempt per call: when a send
 * fails the nonce is dropped and re-read on the next call, which is the only recovery there is.
 */
export class Signer {
  private nonce: number | null = null;
  private fee = 0n;
  private feeAt = 0;

  constructor(
    readonly account: PrivateKeyAccount,
    private readonly client: PublicClient,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  async send(to: Address, data: Hex, gas: bigint): Promise<Hash> {
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
      nonce,
      gas,
      maxFeePerGas: this.fee,
      maxPriorityFeePerGas: 0n,
    });
    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: raw });
      this.nonce = nonce + 1;
      return hash;
    } catch (err) {
      this.nonce = null;
      throw err;
    }
  }

  /** Send and wait for the receipt, polling a bounded number of times; throws unless it succeeded. */
  async sendAndConfirm(to: Address, data: Hex, gas: bigint, waitMs = 15_000): Promise<TransactionReceipt> {
    const hash = await this.send(to, data, gas);
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
