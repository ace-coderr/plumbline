import Fastify, { type FastifyInstance } from "fastify";
import { deployment, type IndexerHealth } from "@plumbline/shared";
import type { Queries } from "./queries.js";
import type { Syncer } from "./sync.js";

interface PairParams {
  pair: string;
}
interface WindowQuery {
  window?: string;
}

/** Small TTL cache for the heavier aggregate endpoints. */
function cached<T>(ttlMs: number) {
  const store = new Map<string, { at: number; value: T }>();
  return (key: string, compute: () => T): T => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = compute();
    store.set(key, { at: Date.now(), value });
    return value;
  };
}

/** Standalone API server (local development: indexer on its own port). */
export function buildApi(q: Queries, sync: Syncer, hypeUsd: () => number | null): FastifyInstance {
  const app = Fastify({ logger: false });
  registerApi(app, q, sync, hypeUsd);
  return app;
}

/**
 * Register the API routes on any Fastify instance. The production web server mounts these under
 * /api so web and API run as one process.
 */
export function registerApi(app: FastifyInstance, q: Queries, sync: Syncer, hypeUsd: () => number | null): void {
  const reportCache = cached<ReturnType<Queries["report"]>>(20_000);
  const econCache = cached<ReturnType<Queries["economics"]>>(5_000);

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get("/health", async (): Promise<IndexerHealth> => ({
    ok: sync.head - sync.cursor < 500,
    chainId: deployment.chainId,
    head: sync.head,
    cursor: sync.cursor,
    lagBlocks: Math.max(0, sync.head - sync.cursor),
    deployed: deployment.deployed,
  }));

  app.get("/markets", async () => q.listMarkets());

  app.get<{ Params: PairParams }>("/markets/:pair", async (req, reply) => {
    const d = q.marketDetail(req.params.pair);
    return d ?? reply.code(404).send({ error: "unknown market" });
  });

  app.get<{ Params: PairParams; Querystring: WindowQuery }>("/markets/:pair/uptime", async (req, reply) => {
    const d = q.uptime(req.params.pair, req.query.window);
    return d ?? reply.code(404).send({ error: "unknown market" });
  });

  app.get<{ Params: { address: string } }>("/makers/:address", async (req, reply) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) return reply.code(400).send({ error: "bad address" });
    return q.maker(req.params.address);
  });

  app.get<{ Params: { address: string } }>("/vaults/:address/scorecard", async (req, reply) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) return reply.code(400).send({ error: "bad address" });
    const d = q.vaultScorecard(req.params.address, sync.cursor, Math.floor(Date.now() / 1000));
    return d ?? reply.code(404).send({ error: "unknown vault" });
  });

  app.get("/campaigns", async () => q.listCampaigns());

  app.get<{ Params: { id: string } }>("/campaigns/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "bad id" });
    return q.campaignDetail(id) ?? reply.code(404).send({ error: "unknown campaign" });
  });

  app.get<{ Params: { token: string }; Querystring: WindowQuery }>("/reports/:token", async (req, reply) => {
    const key = `${req.params.token.toLowerCase()}:${req.query.window ?? ""}`;
    const r = reportCache(key, () => q.report(req.params.token, req.query.window));
    return r ?? reply.code(404).send({ error: "no market for token" });
  });

  app.get<{ Params: { token: string }; Querystring: { offset?: string; limit?: string } }>(
    "/reports/:token/probes",
    async (req, reply) => {
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
      return q.reportProbes(req.params.token, offset, limit) ?? reply.code(404).send({ error: "no market for token" });
    },
  );

  app.get("/economics", async () => econCache("all", () => q.economics(hypeUsd())));
}
