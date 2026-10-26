import type { PublicClient } from "viem";
import type { RunnerWallet } from "@plumbline/shared";
import { schedule } from "./config.js";
import { Signer, makeClients } from "./chain.js";
import { accountFor, secretValues, type Env } from "./env.js";
import { makeRedactor } from "./core/redact.js";
import { errText, makeLogger, type Logger } from "./core/log.js";
import { cancelQuote, makerTick, newMakerState, type MakerState } from "./maker.js";
import { keeperBurst, newKeeperState, type KeeperState } from "./keeper.js";

export type RoleName = "keeper" | "makerA" | "makerB";

interface RoleConfig {
  role: RoleName;
  runId: number;
  /** Unix seconds. The role ends itself at this time whatever else happens. */
  windowEnd: number;
  running: boolean;
  startedAt: number;
}

const QUOTER: Record<"makerA" | "makerB", RunnerWallet> = { makerA: "quoterA", makerB: "quoterB" };
const MAKER_KEY: Record<"makerA" | "makerB", "A" | "B"> = { makerA: "A", makerB: "B" };
/** How often a role asks the supervisor whether it should still be running. */
const CHECK_EVERY_MS = 30_000;
/** A role stops if the supervisor has not answered for this long: it must not run unsupervised. */
const SUPERVISOR_SILENCE_MS = 150_000;
const MAX_KEEPER_FAILURES = 120;
/** After ten failed sends in a row a maker waits this long, and the run ends after this many such waits. */
const BACKOFF_MS = 15_000;
const MAX_BACKOFFS = 6;

/**
 * One bot as a Durable Object: an alarm loop. There are three, named keeper, makerA and makerB, so a
 * second copy of a bot cannot exist. It runs only between /start and its window's end, and ends itself
 * at the window's end, when the supervisor says stop, when the supervisor goes quiet, or when sends keep
 * failing. It never retries a failed send within a tick.
 */
export class Role {
  private maker: MakerState = newMakerState();
  private keeper: KeeperState = newKeeperState();
  private signer: Signer | null = null;
  private clients: [PublicClient, PublicClient] | null = null;
  private log: Logger;
  private lastCheck = 0;
  private lastOk = 0;
  private backoffs = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.log = makeLogger(makeRedactor(secretValues(env)));
  }

  private async cfg(): Promise<RoleConfig | null> {
    return (await this.state.storage.get<RoleConfig>("cfg")) ?? null;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/start") {
      const body = (await req.json()) as { role: RoleName; runId: number; windowEnd: number };
      const cur = await this.cfg();
      if (cur?.running && cur.runId === body.runId) return Response.json({ ok: true, already: true });
      if (cur?.running && cur.runId > body.runId) return Response.json({ ok: false, reason: "a newer run is active" }, { status: 409 });
      this.maker = newMakerState();
      this.keeper = newKeeperState();
      this.signer = null;
      this.lastCheck = Date.now();
      this.lastOk = Date.now();
      this.backoffs = 0;
      await this.state.storage.put("cfg", { role: body.role, runId: body.runId, windowEnd: body.windowEnd, running: true, startedAt: Date.now() } satisfies RoleConfig);
      await this.state.storage.setAlarm(Date.now() + 50);
      this.log.info("role started", { role: body.role, runId: body.runId });
      return Response.json({ ok: true });
    }
    if (path === "/stop") {
      await this.finish("stopped by the supervisor");
      return Response.json({ ok: true });
    }
    const cfg = await this.cfg();
    const alarm = await this.state.storage.getAlarm();
    return Response.json({
      role: cfg?.role ?? null,
      running: cfg?.running ?? false,
      runId: cfg?.runId ?? null,
      windowEnd: cfg?.windowEnd ?? null,
      alarmSet: alarm !== null,
      maker: cfg?.role === "keeper" ? undefined : { ticks: this.maker.ticks, sent: this.maker.sent, failed: this.maker.failed, lastSendAt: this.maker.lastSendAt, lastError: this.maker.lastError },
      keeper: cfg?.role === "keeper" ? { bursts: this.keeper.bursts, probesSent: this.keeper.probesSent, probesLanded: this.keeper.probesLanded, probesReverted: this.keeper.probesReverted, settles: this.keeper.settles, failed: this.keeper.failed, lastProbeAt: this.keeper.lastProbeAt, lastError: this.keeper.lastError } : undefined,
    });
  }

  /** Ends the run: cancels a maker's quote once, clears the alarm, and records why. */
  private async finish(reason: string): Promise<void> {
    const cfg = await this.cfg();
    if (cfg?.running && cfg.role !== "keeper") {
      try {
        const c = this.makerCtx(cfg.role);
        if (c) await cancelQuote(c, reason);
      } catch (err) {
        this.log.error("cancel on finish failed", { err: errText(err) });
      }
    }
    if (cfg) await this.state.storage.put("cfg", { ...cfg, running: false } satisfies RoleConfig);
    await this.state.storage.deleteAlarm();
    this.log.warn("role ended", { role: cfg?.role ?? null, reason });
  }

  private makerCtx(role: "makerA" | "makerB") {
    const clients = (this.clients ??= makeClients());
    const account = accountFor(this.env, QUOTER[role], schedule);
    if (!account) return null;
    this.signer ??= new Signer(account, [clients[0], clients[1]]);
    return {
      vault: role === "makerA" ? schedule.vaults.a : schedule.vaults.b,
      settings: schedule.maker[MAKER_KEY[role]],
      referenceCoin: schedule.referenceCoin,
      signer: this.signer,
      client: clients[0],
      state: this.maker,
      log: this.log,
    };
  }

  /** Asks the supervisor whether this run should go on. True while it says yes. */
  private async supervisorSays(runId: number): Promise<boolean> {
    try {
      const stub = this.env.SUPERVISOR.get(this.env.SUPERVISOR.idFromName("main"));
      const res = await stub.fetch("https://supervisor/should-run?runId=" + runId);
      const body = (await res.json()) as { run: boolean };
      this.lastOk = Date.now();
      return body.run;
    } catch {
      return Date.now() - this.lastOk < SUPERVISOR_SILENCE_MS;
    }
  }

  async alarm(): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg?.running) return;
    const t0 = Date.now();
    if (t0 / 1000 >= cfg.windowEnd) return this.finish("the window ended");
    if (t0 - this.lastCheck > CHECK_EVERY_MS) {
      this.lastCheck = t0;
      if (!(await this.supervisorSays(cfg.runId))) return this.finish("the supervisor said stop");
    }
    let next: number;
    try {
      if (cfg.role === "keeper") {
        const account = accountFor(this.env, "keeper", schedule);
        if (!account) return this.finish("KEEPER_KEY is not set");
        const clients = (this.clients ??= makeClients());
        this.signer ??= new Signer(account, [clients[0], clients[1]]);
        await keeperBurst({ signer: this.signer, clients, state: this.keeper, log: this.log });
        if (this.keeper.failed >= MAX_KEEPER_FAILURES) return this.finish("too many failures");
        next = Date.now() + 100;
      } else {
        const ctx = this.makerCtx(cfg.role);
        if (!ctx) return this.finish("the quoter key is not set");
        const r = await makerTick(ctx);
        if (r === "backoff") {
          this.backoffs += 1;
          this.log.warn("sends failing, waiting", { role: cfg.role, waits: this.backoffs });
          if (this.backoffs >= MAX_BACKOFFS) return this.finish("sends keep failing");
          next = Date.now() + BACKOFF_MS;
        } else {
          next = t0 + schedule.maker[MAKER_KEY[cfg.role]].refreshMs;
        }
      }
    } catch (err) {
      // A thrown error (a bad key, say) ends the run; it is never retried.
      return this.finish(`error: ${errText(err)}`);
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + 50, next));
  }
}
