/**
 * The window summary, worked out from chain data and nothing the runner counted itself: the keeper's
 * transactions to the campaigns contract (each has a receipt status, gas used and gas price) and the
 * `Probed` events the contract emitted for the keeper in the window. A probe is "sent" when the keeper's
 * transaction is on-chain, "landed" when it emitted a Probed event, "reverted" when its receipt failed.
 */
export interface ChainTx {
  hash: string;
  to: string;
  methodId: string;
  isError: string;
  gasUsed: string;
  gasPrice: string;
  timeStamp: string;
}

export interface ChainLog {
  topics: string[];
  transactionHash: string;
}

export interface WindowInput {
  txs: ChainTx[];
  logs: ChainLog[];
  keeper: string;
  campaigns: string;
  probeSelector: string;
  settleSelector: string;
  /** Unix seconds. Transactions are counted from `start` up to `end` plus a short grace for the last receipts. */
  start: number;
  end: number;
}

export interface WindowFigures {
  probesSent: number;
  probesLanded: number;
  probesReverted: number;
  /** Reverted share of probes sent, in percent. 0 when none were sent. */
  revertedPct: number;
  settles: number;
  settlesFailed: number;
  gasUsedTotal: bigint;
  /** HYPE paid in gas by every keeper transaction in the window, wei. */
  gasWei: bigint;
  revertedGasUsed: bigint;
  revertedGasWei: bigint;
  /** Landed does not equal sent minus reverted: some probe is unaccounted for. */
  mismatch: boolean;
}

const GRACE_SECONDS = 60;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function summarizeWindow(i: WindowInput): WindowFigures {
  const mine = i.txs.filter((t) => {
    const at = Number(t.timeStamp);
    return same(t.to, i.campaigns) && at >= i.start && at < i.end + GRACE_SECONDS;
  });
  const probes = mine.filter((t) => t.methodId === i.probeSelector);
  const settles = mine.filter((t) => t.methodId === i.settleSelector);
  const probeHashes = new Set(probes.map((t) => t.hash.toLowerCase()));
  // A Probed event counts once per transaction, only if the keeper sent that transaction in this window.
  const landed = new Set(
    i.logs
      .filter((l) => l.topics[3] !== undefined && same(`0x${l.topics[3].slice(-40)}`, i.keeper) && probeHashes.has(l.transactionHash.toLowerCase()))
      .map((l) => l.transactionHash.toLowerCase()),
  );
  const reverted = probes.filter((t) => t.isError === "1");
  const wei = (t: ChainTx) => BigInt(t.gasUsed) * BigInt(t.gasPrice);
  const sum = (ts: ChainTx[], f: (t: ChainTx) => bigint) => ts.reduce((a, t) => a + f(t), 0n);
  const sent = probes.length;
  return {
    probesSent: sent,
    probesLanded: landed.size,
    probesReverted: reverted.length,
    revertedPct: sent === 0 ? 0 : (reverted.length / sent) * 100,
    settles: settles.length,
    settlesFailed: settles.filter((t) => t.isError === "1").length,
    gasUsedTotal: sum(mine, (t) => BigInt(t.gasUsed)),
    gasWei: sum(mine, wei),
    revertedGasUsed: sum(reverted, (t) => BigInt(t.gasUsed)),
    revertedGasWei: sum(reverted, wei),
    mismatch: landed.size !== sent - reverted.length,
  };
}

/** "13:00–17:00 UTC" for a window. */
export function windowLabel(start: number, end: number): string {
  const hm = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);
  return `${hm(start)}–${hm(end)} UTC`;
}
