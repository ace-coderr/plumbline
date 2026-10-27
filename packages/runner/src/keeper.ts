import { encodeFunctionData, type Hash, type PublicClient } from "viem";
import { plumbCampaignsAbi } from "@plumbline/shared";
import { CAMPAIGNS } from "./config.js";
import { tryEach, type Signer } from "./chain.js";
import { shortHash } from "./core/redact.js";
import { errText, type Logger } from "./core/log.js";
import { pollable, settleDue, type Track } from "./core/keeper.js";

/**
 * One keeper burst, run from a Durable Object alarm. A burst polls the probe gate for a few seconds
 * from both nodes at once (the gate is open for about a second, and a poll takes about a quarter of
 * one on this host), sends a probe the moment it opens, and settles finished epochs. Each burst stays
 * under 40 subrequests, inside the 50 a Workers Free invocation is allowed.
 */
export interface KeeperState {
  bursts: number;
  tracks: Track[];
  refreshedAt: number;
  settleCheckedAt: number;
  quietUntil: Record<number, number>;
  /** A node that just refused us (rate limit) is left alone until this time, ms. */
  coolUntil: number[];
  pending: { hash: Hash; id: number; at: number }[];
  pollsOk: number;
  pollsFailed: number;
  probesSent: number;
  probesLanded: number;
  probesReverted: number;
  settles: number;
  /** Probe or settle transactions the node refused to take. */
  sendsFailed: number;
  failed: number;
  lastProbeAt: number;
  lastError: string | null;
}

export const newKeeperState = (): KeeperState => ({
  bursts: 0,
  tracks: [],
  refreshedAt: 0,
  settleCheckedAt: 0,
  quietUntil: {},
  coolUntil: [0, 0, 0],
  pending: [],
  pollsOk: 0,
  pollsFailed: 0,
  probesSent: 0,
  probesLanded: 0,
  probesReverted: 0,
  settles: 0,
  sendsFailed: 0,
  failed: 0,
  lastProbeAt: 0,
  lastError: null,
});

/** The counters and unresolved probes that must outlive a restart of the Durable Object. */
export interface KeeperSaved {
  probesSent: number;
  probesLanded: number;
  probesReverted: number;
  settles: number;
  sendsFailed: number;
  failed: number;
  pending: KeeperState["pending"];
}

export const saveKeeper = (s: KeeperState): KeeperSaved => ({
  probesSent: s.probesSent,
  probesLanded: s.probesLanded,
  probesReverted: s.probesReverted,
  settles: s.settles,
  sendsFailed: s.sendsFailed,
  failed: s.failed,
  pending: s.pending,
});

export function restoreKeeper(s: KeeperState, saved: Partial<KeeperSaved>): void {
  s.probesSent = saved.probesSent ?? 0;
  s.probesLanded = saved.probesLanded ?? 0;
  s.probesReverted = saved.probesReverted ?? 0;
  s.settles = saved.settles ?? 0;
  s.sendsFailed = saved.sendsFailed ?? 0;
  s.failed = saved.failed ?? 0;
  s.pending = saved.pending ?? [];
}

export interface KeeperCtx {
  signer: Signer;
  clients: PublicClient[];
  state: KeeperState;
  log: Logger;
}

const BURST_MS = 3_500;
/** Between gate polls on each node: about 3 a second each, 6 in all. */
const POLL_EVERY_MS = 300;
const SUBREQUEST_BUDGET = 30;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function refresh(c: KeeperCtx, nowMs: number): Promise<number> {
  const count = Number(await tryEach(c.clients, (cl) => cl.readContract({ address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "campaignCount" })));
  // The most recent campaigns only: older ones are over.
  const ids = Array.from({ length: Math.min(count, 6) }, (_, i) => count - i);
  if (ids.length === 0) {
    c.state.tracks = [];
    c.state.refreshedAt = nowMs;
    return 1;
  }
  const reads = await tryEach(c.clients, (cl) =>
    cl.multicall({
    allowFailure: false,
    contracts: ids.flatMap((id) => [
      { address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "terms", args: [BigInt(id)] } as const,
      { address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "state", args: [BigInt(id)] } as const,
    ]),
    }),
  );

  c.state.tracks = ids.map((id, i) => {
    const t = reads[2 * i] as { epochLength: bigint; minProbeInterval: number };
    const s = reads[2 * i + 1] as { startTime: bigint; numEpochs: number; settledEpochs: number; lastProbeAt: bigint };
    return {
      id,
      startTime: Number(s.startTime),
      numEpochs: s.numEpochs,
      epochLength: Number(t.epochLength),
      minProbeInterval: t.minProbeInterval,
      settledEpochs: s.settledEpochs,
      lastProbeAt: Number(s.lastProbeAt),
    };
  });
  c.state.refreshedAt = nowMs;
  return 2;
}

/** Look at the receipts of probes sent in earlier bursts, to count landed and reverted. */
async function settlePending(c: KeeperCtx): Promise<number> {
  let used = 0;
  const keep: KeeperState["pending"] = [];
  for (const p of c.state.pending) {
    if (used >= 3) {
      keep.push(p);
      continue;
    }
    used += 1;
    const r = await tryEach(c.clients, (cl) => cl.getTransactionReceipt({ hash: p.hash })).catch(() => null);
    if (!r) {
      if (Date.now() - p.at < 20_000) keep.push(p);
      continue;
    }
    if (r.status === "success") c.state.probesLanded += 1;
    else c.state.probesReverted += 1;
  }
  c.state.pending = keep;
  return used;
}

export async function keeperBurst(c: KeeperCtx): Promise<void> {
  const st = c.state;
  const t0 = Date.now();
  st.bursts += 1;
  let used = 0;
  try {
    if (t0 - st.refreshedAt > 5_000) used += await refresh(c, t0);
    if (st.pending.length) used += await settlePending(c);

    const nowSec = () => Math.floor(Date.now() / 1000);
    if (t0 - st.settleCheckedAt > 15_000) {
      st.settleCheckedAt = t0;
      const due = settleDue(st.tracks, nowSec());
      if (due) {
        try {
          await c.signer.send(CAMPAIGNS, encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "settle", args: [BigInt(due.id)] }), 400_000n);
          st.settles += 1;
          // Count it settled until the next refresh says otherwise, so it is not sent twice.
          due.settledEpochs += 1;
          used += 1;
        } catch (err) {
          st.failed += 1;
          st.sendsFailed += 1;
          st.lastError = errText(err);
          c.log.warn("settle failed", { id: due.id, err: st.lastError });
        }
      }
    }

    // Poll the gate until the burst ends: one poll per node every POLL_EVERY_MS, both at once. A node that
    // refused us is left alone for three seconds. (Three polls per 110 ms, as the local keeper does,
    // is far over what a shared Cloudflare address is allowed.)
    let rounds = 0;
    while (Date.now() - t0 < BURST_MS && used < SUBREQUEST_BUDGET) {
      const targets = pollable(st.tracks, nowSec(), st.quietUntil, Date.now());
      if (targets.length === 0) {
        await sleep(400);
        continue;
      }
      const round = Date.now();
      // With a private node (three clients) it is polled every round and the first public node every
      // second round; otherwise both public nodes are polled every round.
      rounds += 1;
      const nodes = c.clients.length >= 3 ? (rounds % 2 === 0 ? [0, 1] : [0]) : [0, 1];
      const polls = nodes.map(async (idx) => {
        if (Date.now() < (st.coolUntil[idx] ?? 0)) return [] as Track[];
        const open = await (c.clients[idx] as PublicClient)
          .multicall({
            allowFailure: true,
            contracts: targets.map((t) => ({ address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "probeGateOpen", args: [BigInt(t.id)] }) as const),
          })
          .catch(() => {
            st.coolUntil[idx] = Date.now() + 3_000;
            return null;
          });
        used += 1;
        if (open) st.pollsOk += 1;
        else st.pollsFailed += 1;
        return open ? targets.filter((_, i) => open[i]?.status === "success" && open[i]?.result === true) : [];
      });
      const results = await Promise.all(polls);
      const wait = POLL_EVERY_MS - (Date.now() - round);
      const opened0 = results.flat();
      if (opened0.length === 0 && wait > 0) await sleep(wait);
      const opened = new Set(opened0.map((t) => t.id));
      for (const id of opened) {
        // Re-checked after the polls came back: another poll in this round may already have sent.
        if (Date.now() < (st.quietUntil[id] ?? 0)) continue;
        st.quietUntil[id] = Date.now() + 2_000;
        try {
          const hash = await c.signer.send(CAMPAIGNS, encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "probe", args: [BigInt(id)] }), 450_000n);
          st.probesSent += 1;
          st.lastProbeAt = Date.now();
          st.pending.push({ hash, id, at: Date.now() });
          c.log.info("probe sent", { id, tx: shortHash(hash) });
          used += 1;
        } catch (err) {
          st.failed += 1;
          st.sendsFailed += 1;
          st.lastError = errText(err);
          c.log.warn("probe send failed", { id, err: st.lastError });
        }
      }
    }
  } catch (err) {
    st.failed += 1;
    st.lastError = errText(err);
    c.log.warn("keeper burst failed", { err: st.lastError });
  }
}
