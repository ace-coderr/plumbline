import Fastify, { type FastifyInstance } from "fastify";
import { formatEther } from "viem";
import { deployment } from "@plumbline/shared";
import type { Keeper } from "./keeper.js";
import type { Stats } from "./stats.js";

/** /health and /stats. Read-only; safe to expose. */
export function buildServer(keeper: Keeper, stats: Stats, address: `0x${string}`): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    return payload;
  });

  app.get("/health", async (_req, reply) => {
    const sincePoll = Date.now() - keeper.lastPollAt;
    const healthy = keeper.lastPollAt > 0 && sincePoll < 10_000;
    return reply.code(healthy ? 200 : 503).send({
      ok: healthy,
      address,
      msSinceLastPoll: keeper.lastPollAt ? sincePoll : null,
      tracking: keeper.activeTracks().map((t) => t.id),
      balanceHype: formatEther(keeper.balanceWei),
    });
  });

  app.get("/stats", async () => {
    const campaigns = [...stats.campaigns.values()].map((c) => {
      const attempts = c.probesOk + c.probesReverted;
      return {
        id: c.id,
        probesOk: c.probesOk,
        probesReverted: c.probesReverted,
        raceLost: c.raceLost,
        errors: c.errors,
        gasUsed: c.gasUsed,
        avgGasPerProbe: attempts ? Math.round(c.gasUsed / attempts) : null,
        costHype: formatEther(BigInt(c.costWei)),
        avgCostPerProbeHype: attempts ? formatEther(BigInt(c.costWei) / BigInt(attempts)) : null,
        feesEarnedHype: formatEther(BigInt(c.feesEarnedWei)),
        avgLatencyMs: c.probesOk ? Math.round(c.latencyMsTotal / c.probesOk) : null,
        vaultPassRate: c.vaultsChecked ? c.vaultsPassed / c.vaultsChecked : null,
        lastProbeAt: c.lastProbeAt,
        recent: c.recent.slice(0, 20),
      };
    });
    const probesOk = campaigns.reduce((a, c) => a + c.probesOk, 0);
    return {
      keeper: address,
      chainId: deployment.chainId,
      campaignsContract: deployment.contracts.campaigns,
      startedAt: stats.totals.startedAt,
      uptimeSec: Math.floor(Date.now() / 1000) - stats.totals.startedAt,
      balanceHype: formatEther(keeper.balanceWei),
      totals: {
        probes: probesOk,
        probesPerMinute: Number(stats.probesPerMinute().toFixed(2)),
        settles: stats.totals.settles,
        claims: stats.totals.claims,
        claimedHype: formatEther(BigInt(stats.totals.claimedWei)),
        gasUsed: stats.totals.gasUsed,
        gasCostHype: formatEther(BigInt(stats.totals.costWei)),
      },
      campaigns,
    };
  });

  return app;
}
