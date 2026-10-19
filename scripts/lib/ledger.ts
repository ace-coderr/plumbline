/**
 * Gas ledger: every transaction a script sends is recorded with its real receipt gas and price,
 * so budgets are sized from measurements rather than guesses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TransactionReceipt } from "viem";
import type { SentTx, TxRequest, TxSender } from "@plumbline/shared/node";
import { ROOT } from "./env.js";

export interface LedgerEntry {
  action: string;
  hash: string;
  gasUsed: number;
  gasPriceWei: string;
  costWei: string;
  from: string;
}

export class Ledger {
  readonly entries: LedgerEntry[] = [];

  constructor(readonly path: string) {
    if (existsSync(path)) this.entries.push(...(JSON.parse(readFileSync(path, "utf8")) as LedgerEntry[]));
  }

  static forRun(chainId: number, tag: string): Ledger {
    return new Ledger(join(ROOT, "data", `gas-${chainId}-${tag}.json`));
  }

  record(action: string, from: string, receipt: TransactionReceipt): void {
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;
    this.entries.push({
      action,
      hash: receipt.transactionHash,
      gasUsed: Number(receipt.gasUsed),
      gasPriceWei: receipt.effectiveGasPrice.toString(),
      costWei: cost.toString(),
      from,
    });
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  /** Send, wait, and record under `action`. */
  async send(sender: TxSender, action: string, req: TxRequest): Promise<{ sent: SentTx; receipt: TransactionReceipt }> {
    const r = await sender.sendAndWait({ ...req, label: req.label ?? action });
    this.record(action, sender.address, r.receipt);
    return r;
  }

  /** Per-action summary: count, mean gas, total cost in wei. */
  summary(): { action: string; count: number; meanGas: number; totalWei: bigint }[] {
    const by = new Map<string, { count: number; gas: number; wei: bigint }>();
    for (const e of this.entries) {
      const s = by.get(e.action) ?? { count: 0, gas: 0, wei: 0n };
      s.count += 1;
      s.gas += e.gasUsed;
      s.wei += BigInt(e.costWei);
      by.set(e.action, s);
    }
    return [...by.entries()].map(([action, s]) => ({
      action,
      count: s.count,
      meanGas: Math.round(s.gas / s.count),
      totalWei: s.wei,
    }));
  }
}
