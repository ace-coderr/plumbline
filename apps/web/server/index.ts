/**
 * Production server for the dashboard. Serves the built SPA and the indexer API under /api, and
 * gives /report/:token pages real link previews: OG/Twitter meta tags filled from the live report,
 * plus a rendered PNG card at /og/report/:token.png.
 *
 * EMBED_INDEXER=true runs the indexer inside this process (one deployable service: web + API +
 * sync). Otherwise /api is proxied to INDEXER_URL, which is how local development runs it.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { DepthReport } from "@plumbline/shared";
import { startIndexer } from "@plumbline/indexer";
import { cardFromReport as card, defaultSvg, renderPng, reportSvg } from "./og.js";
import { reportCopy, withMeta } from "./meta.js";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled to dist-server/server/, so the Vite build sits two levels up.
const dist = join(here, "..", "..", "dist");
// Every upstream is configurable; the defaults are for local development.
const INDEXER = process.env.INDEXER_URL ?? "http://127.0.0.1:8788";
// "off" (or empty) disables the keeper proxy: the dashboard then reports the keeper as offline.
const KEEPER = process.env.KEEPER_URL ?? "http://127.0.0.1:8787";
const KEEPER_ON = KEEPER !== "" && KEEPER !== "off";
const EMBED = process.env.EMBED_INDEXER === "true";
// Railway (and most hosts) assign the port through PORT.
const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 8080);
// Public origin for link previews. Falls back to Railway's generated domain, then the request host.
const PUBLIC_URL = (
  process.env.PUBLIC_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/$/, "");

if (!existsSync(join(dist, "index.html"))) {
  throw new Error("apps/web/dist is missing; run pnpm --filter @plumbline/web build first");
}
const template = readFileSync(join(dist, "index.html"), "utf8");

function origin(req: FastifyRequest): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${proto}://${req.headers.host ?? `localhost:${PORT}`}`;
}

/** Report data through this server's own /api route, embedded or proxied alike. */
async function fetchReport(token: string): Promise<DepthReport | null> {
  try {
    const res = await app.inject({ method: "GET", url: `/api/reports/${encodeURIComponent(token)}?window=30d` });
    return res.statusCode === 200 ? (res.json() as DepthReport) : null;
  } catch {
    return null;
  }
}

function page(meta: { title: string; description: string; image: string; url: string }): string {
  return withMeta(template, meta);
}

const app = Fastify({ logger: false });

await app.register(fastifyStatic, { root: dist, wildcard: false, index: false, maxAge: "1h" });

// API passthrough (read-only).
async function proxy(base: string, prefix: string, req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.slice(prefix.length) || "/";
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    reply.code(res.status).header("content-type", res.headers.get("content-type") ?? "application/json");
    return reply.send(Buffer.from(await res.arrayBuffer()));
  } catch {
    return reply.code(502).send({ error: "upstream unavailable" });
  }
}
if (EMBED) {
  const indexer = await startIndexer();
  await app.register(
    async (api) => {
      indexer.register(api);
    },
    { prefix: "/api" },
  );
  const close = () => {
    indexer.close();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
} else {
  app.get("/api/*", (req, reply) => proxy(INDEXER, "/api", req, reply));
}
app.get("/keeper/*", (req, reply) =>
  KEEPER_ON ? proxy(KEEPER, "/keeper", req, reply) : reply.code(503).send({ error: "keeper offline" }),
);

// Link-preview images. /og-default.png ships as a static file; report cards render on demand.
const defaultPng = renderPng(defaultSvg());

const cardCache = new Map<string, { at: number; png: Buffer }>();
app.get<{ Params: { token: string } }>("/og/report/:token.png", async (req, reply) => {
  const token = req.params.token;
  const hit = cardCache.get(token);
  if (hit && Date.now() - hit.at < 60_000) return reply.type("image/png").send(hit.png);
  const r = await fetchReport(token);
  const png = r ? renderPng(reportSvg(card(r))) : defaultPng;
  cardCache.set(token, { at: Date.now(), png });
  return reply.type("image/png").header("cache-control", "public, max-age=60").send(png);
});

// Report pages get report-specific meta; everything else gets the default card.
app.get<{ Params: { token: string } }>("/report/:token", async (req, reply) => {
  const token = req.params.token;
  const r = await fetchReport(token);
  const base = origin(req);
  const html = r
    ? page({
        ...reportCopy(r, token),
        image: `${base}/og/report/${encodeURIComponent(token)}.png`,
        url: `${base}/report/${encodeURIComponent(token)}`,
      })
    : page({
        title: `${token} depth report · Plumbline`,
        description: "Probe-verified liquidity uptime on Elysium.",
        image: `${base}/og-default.png`,
        url: `${base}/report/${encodeURIComponent(token)}`,
      });
  return reply.type("text/html").header("cache-control", "no-cache").send(html);
});

app.setNotFoundHandler((req, reply) => {
  if (req.method !== "GET") return reply.code(404).send();
  const base = origin(req);
  return reply
    .type("text/html")
    .header("cache-control", "no-cache")
    .send(
      page({
        title: "Plumbline · verifiable liquidity uptime",
        description: "Quote vaults, permissionless probes and bonded makers: market-making uptime you can verify on-chain.",
        image: `${base}/og-default.png`,
        url: `${base}${req.url}`,
      }),
    );
});

await app.listen({ port: PORT, host: process.env.WEB_HOST ?? "0.0.0.0" });
console.log(
  `plumbline web on :${PORT} (indexer ${EMBED ? "embedded" : INDEXER}, keeper ${KEEPER_ON ? KEEPER : "off"}, public ${PUBLIC_URL || "request host"})`,
);
