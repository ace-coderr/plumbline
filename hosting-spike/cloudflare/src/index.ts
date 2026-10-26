/**
 * Keyless feasibility probe for running a 2-second quote cadence on Cloudflare Workers Free.
 * It holds no secret, sends no transaction and uses a random throwaway key only to time signing.
 *
 *   /start   begins a run: a Durable Object alarm every CADENCE_MS, for at most MAX_TICKS ticks
 *   /report  JSON: how late each alarm fired, RPC and price-feed latency seen from Cloudflare's edge,
 *            signing time, subrequests per tick, and whether any limit error was hit
 *   /stop    ends the run
 *
 * It stops itself after MAX_TICKS (about 10 minutes), so it cannot spend the daily free quota.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

interface Env {
  PROBE: DurableObjectNamespace;
}

const CADENCE_MS = 1_500;
const MAX_TICKS = 400;
const RPCS = ["https://testnet-rpc.elysium.kinetiq.xyz", "https://rpc-elysium-testnet.t.conduit.xyz"];
const FEED = "https://api.hyperliquid-testnet.xyz/info";

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor(p * s.length))] as number) * 10) / 10;
};
const summary = (xs: number[]) => ({ n: xs.length, median: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) });

export class Probe {
  private state: DurableObjectState;
  private running = false;
  private ticks = 0;
  private scheduledFor = 0;
  private late: number[] = [];
  private tickMs: number[] = [];
  private rpc: Record<string, number[]> = { a: [], b: [] };
  private feed: number[] = [];
  private sign: number[] = [];
  private errors: string[] = [];
  private startedAt = 0;
  private colo = "";
  private account = privateKeyToAccount(generatePrivateKey());

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    this.colo = (req as Request & { cf?: { colo?: string } }).cf?.colo ?? this.colo;
    if (path === "/start" && !this.running) {
      this.running = true;
      this.ticks = 0;
      this.late = [];
      this.tickMs = [];
      this.rpc = { a: [], b: [] };
      this.feed = [];
      this.sign = [];
      this.errors = [];
      this.startedAt = Date.now();
      this.scheduledFor = Date.now() + CADENCE_MS;
      await this.state.storage.setAlarm(this.scheduledFor);
    }
    if (path === "/stop") this.running = false;
    return Response.json({
      running: this.running,
      colo: this.colo,
      cadenceMs: CADENCE_MS,
      ticks: this.ticks,
      seconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      alarmLateMs: summary(this.late),
      alarmsLateOver500ms: this.late.filter((x) => x > 500).length,
      alarmsLateOver1000ms: this.late.filter((x) => x > 1000).length,
      tickWallMs: summary(this.tickMs),
      rpcPrimaryMs: summary(this.rpc.a ?? []),
      rpcConduitMs: summary(this.rpc.b ?? []),
      priceFeedMs: summary(this.feed),
      signMs: summary(this.sign),
      subrequestsPerTick: 3,
      errors: this.errors.slice(-10),
    });
  }

  async alarm(): Promise<void> {
    if (!this.running) return;
    const t0 = Date.now();
    this.late.push(Math.max(0, t0 - this.scheduledFor));
    const timed = async (url: string, init: RequestInit, into: number[]) => {
      const t = Date.now();
      try {
        const r = await fetch(url, init);
        await r.text();
        if (!r.ok) this.errors.push(`${url.slice(8, 30)} ${r.status}`);
        into.push(Date.now() - t);
      } catch (e) {
        this.errors.push(String((e as Error).message).slice(0, 80));
      }
    };
    const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await Promise.all([
      timed(RPCS[0] as string, post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), this.rpc.a as number[]),
      timed(RPCS[1] as string, post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), this.rpc.b as number[]),
      timed(FEED, post({ type: "allMids" }), this.feed),
    ]);
    const s = Date.now();
    try {
      await this.account.signTransaction({
        chainId: 99801,
        type: "eip1559",
        to: "0x1111111111111111111111111111111111111111",
        data: `0x${"ab".repeat(164)}`,
        nonce: this.ticks,
        gas: 120_000n,
        maxFeePerGas: 200_000_000n,
        maxPriorityFeePerGas: 0n,
      });
    } catch (e) {
      this.errors.push(`sign: ${String((e as Error).message).slice(0, 60)}`);
    }
    this.sign.push(Date.now() - s);
    this.tickMs.push(Date.now() - t0);
    this.ticks += 1;
    if (this.ticks >= MAX_TICKS) {
      this.running = false;
      return;
    }
    this.scheduledFor = Math.max(Date.now() + 50, t0 + CADENCE_MS);
    await this.state.storage.setAlarm(this.scheduledFor);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!["/start", "/report", "/stop"].includes(path)) return new Response("/start, /report or /stop", { status: 404 });
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(req);
  },
};
