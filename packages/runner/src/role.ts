import type { PublicClient } from "viem";
import type { RunnerWallet } from "@plumbline/shared";
import { schedule } from "./config.js";
import { Signer, makeClients, takeFallbacks, type FallbackEvent } from "./chain.js";
import { accountFor, redactorFor, type Env } from "./env.js";
import { errorType } from "./core/errors.js";
import { recordAlarm, summarizeAlarms, type AlarmBucket } from "./core/alarmlog.js";
import { errText, makeLogger, setRedactor, withFields, type Logger, safeJson } from "./core/log.js";
import { cancelQuote, makerTick, newMakerState, type MakerState } from "./maker.js";
import { keeperBurst, newKeeperState, restoreKeeper, saveKeeper, type KeeperSaved, type KeeperState } from "./keeper.js";

export type RoleName = "keeper" | "makerA" | "makerB";

/** Saved in Durable Object storage for the current window, so a restart does not lose the counts. */
interface RoleStats {
  runId: number;
  role: RoleName;
  keeper: KeeperSaved;
  maker: { ticks: number; sent: number; failed: number };
  /** Unix seconds of each restart seen inside this window. */
  restarts: number[];
}

interface RoleConfig {
  role: RoleName;
  runId: number;
  /** Unix seconds. The role ends itself at this time whatever else happens. */
  windowEnd: number;
  running: boolean;
  startedAt: number;
}

/**
 * The node order a maker sends through, preferred first. With a private node both makers use private, then the Elysium public
 * node, then Conduit's public node. Without one, `slot` spreads the two makers over the two public nodes.
 */
export function sendOrder(clients: PublicClient[], slot: 0 | 1): PublicClient[] {
  if (clients.length >= 3) return [clients[0], clients[1], clients[2]] as PublicClient[];
  return slot === 0 ? ([clients[0], clients[1]] as PublicClient[]) : ([clients[1], clients[0]] as PublicClient[]);
}

/** Names for nodes, in makeClients order: private (when there is one), Elysium public, Conduit public. Never URLs. */
export function nodeNames(clients: PublicClient[]): Map<PublicClient, string> {
  const names = clients.length >= 3 ? ["private node", "public node (Elysium)", "public node (Conduit)"] : ["public node (Elysium)", "public node (Conduit)"];
  return new Map(clients.map((c, i) => [c, names[i] ?? `node ${i + 1}`]));
}

const QUOTER: Record<"makerA" | "makerB", RunnerWallet> = { makerA: "quoterA", makerB: "quoterB" };
const MAKER_KEY: Record<"makerA" | "makerB", "A" | "B"> = { makerA: "A", makerB: "B" };
/** How often a role asks the supervisor whether it should still be running. */
const CHECK_EVERY_MS = 30_000;
/** A role stops if the supervisor has not answered for this long: it must not run unsupervised. */
const SUPERVISOR_SILENCE_MS = 150_000;
const MAX_KEEPER_FAILURES = 120;
/** A keeper alarm is a burst of about 3.5 s by design, so only much longer counts as slow. */
const KEEPER_SLOW_MS = 6_000;
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
  private clients: PublicClient[] | null = null;
  private log: Logger;
  private lastCheck = 0;
  private lastOk = 0;
  private backoffs = 0;
  private lastFallbackTold = 0;
  /** False after a restart until the first alarm has restored the saved counters. */
  private booted = false;
  private lastSaved = "";
  private lastMakerSaveAt = 0;
  private restarts: number[] = [];
  /** Errors waiting to be told to the supervisor, and when each kind was last told. */
  private reported = new Map<string, { lastTold: number; pending: number }>();
  private tells: Promise<void>[] = [];
  private roleName: string = "role";
  /** How each alarm went, a bucket a minute, and when the next alarm was set for. */
  private diag: AlarmBucket[] = [];
  private expectedAt = 0;
  private outcome = "ok";

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    const redact = redactorFor(env);
    setRedactor(redact);
    this.log = makeLogger(redact);
  }

  private async savedStats(): Promise<RoleStats | null> {
    return (await this.state.storage.get<RoleStats>("stats")) ?? null;
  }

  /** The first alarm after a restart: put the saved counters back, remember the restart, and say so. */
  private async onBoot(cfg: RoleConfig): Promise<void> {
    this.booted = true;
    this.diag = (await this.state.storage.get<AlarmBucket[]>("diag")) ?? [];
    const saved = await this.savedStats();
    if (!saved || saved.runId !== cfg.runId) return;
    restoreKeeper(this.keeper, saved.keeper);
    // The counts come back, but not the tick counter: a restarted maker must start at its first tick, which polls the price
    // and quotes. (Restoring it once made the first tick skip the price and cancel the quote as stale.)
    this.maker.sent = saved.maker.sent;
    this.maker.failed = saved.maker.failed;
    const at = Math.floor(Date.now() / 1000);
    this.restarts = [...saved.restarts, at];
    await this.state.storage.put("stats", { ...saved, restarts: this.restarts } satisfies RoleStats);
    this.lastSaved = JSON.stringify([saveKeeper(this.keeper), saved.maker]);
    this.log.warn("role restarted mid-window", { role: cfg.role, at });
    await this.tell({ kind: "restarted", role: cfg.role, at });
  }

  /** Writes the counters when they changed (a maker's only every 30 s: it sends once a second). */
  private async saveStats(cfg: RoleConfig, force = false): Promise<void> {
    const isKeeper = cfg.role === "keeper";
    if (!isKeeper && !force && Date.now() - this.lastMakerSaveAt < 30_000) return;
    const keeper = saveKeeper(this.keeper);
    const maker = { ticks: this.maker.ticks, sent: this.maker.sent, failed: this.maker.failed };
    const sig = JSON.stringify([keeper, maker]);
    if (sig === this.lastSaved) return;
    this.lastSaved = sig;
    if (!isKeeper) this.lastMakerSaveAt = Date.now();
    await this.state.storage.put("stats", { runId: cfg.runId, role: cfg.role, keeper, maker, restarts: this.restarts } satisfies RoleStats);
  }

  private async cfg(): Promise<RoleConfig | null> {
    return (await this.state.storage.get<RoleConfig>("cfg")) ?? null;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/start") {
      const body = (await req.json()) as { role: RoleName; runId: number; windowEnd: number };
      const cur = await this.cfg();
      if (cur?.running && cur.runId === body.runId) return safeJson({ ok: true, already: true });
      if (cur?.running && cur.runId > body.runId) return safeJson({ ok: false, reason: "a newer run is active" }, { status: 409 });
      this.maker = newMakerState();
      this.keeper = newKeeperState();
      this.signer = null;
      this.lastCheck = Date.now();
      this.lastOk = Date.now();
      this.backoffs = 0;
      this.booted = true;
      // A new window starts the counters again; the same window's counters are never cleared.
      this.lastSaved = "";
      this.restarts = [];
      await this.state.storage.put("stats", { runId: body.runId, role: body.role, keeper: saveKeeper(this.keeper), maker: { ticks: 0, sent: 0, failed: 0 }, restarts: [] } satisfies RoleStats);
      await this.state.storage.put("cfg", { role: body.role, runId: body.runId, windowEnd: body.windowEnd, running: true, startedAt: Date.now() } satisfies RoleConfig);
      this.expectedAt = Date.now() + 50;
      await this.state.storage.setAlarm(this.expectedAt);
      this.log.info("role started", { role: body.role, runId: body.runId });
      return safeJson({ ok: true });
    }
    if (path === "/diag") {
      this.diag = this.diag.length ? this.diag : ((await this.state.storage.get<AlarmBucket[]>("diag")) ?? []);
      return safeJson({ role: this.roleName, buckets: this.diag });
    }
    if (path === "/stop") {
      await this.finish("stopped by the supervisor");
      return safeJson({ ok: true });
    }
    const cfg = await this.cfg();
    const alarm = await this.state.storage.getAlarm();
    return safeJson({
      role: cfg?.role ?? null,
      running: cfg?.running ?? false,
      runId: cfg?.runId ?? null,
      windowEnd: cfg?.windowEnd ?? null,
      alarmSet: alarm !== null,
      saved: await this.savedStats(),
      alarms: summarizeAlarms(this.diag.length ? this.diag : ((await this.state.storage.get<AlarmBucket[]>("diag")) ?? []), Math.floor(Date.now() / 1000), 60),
      maker: cfg?.role === "keeper" ? undefined : { ticks: this.maker.ticks, sent: this.maker.sent, failed: this.maker.failed, lastSendAt: this.maker.lastSendAt, lastError: this.maker.lastError },
      keeper: cfg?.role === "keeper" ? { bursts: this.keeper.bursts, pollsOk: this.keeper.pollsOk, pollsFailed: this.keeper.pollsFailed, probesSent: this.keeper.probesSent, probesLanded: this.keeper.probesLanded, probesReverted: this.keeper.probesReverted, settles: this.keeper.settles, failed: this.keeper.failed, lastProbeAt: this.keeper.lastProbeAt, lastError: this.keeper.lastError } : undefined,
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
    if (cfg?.running) await this.saveStats(cfg, true);
    // A stop the supervisor asked for needs no message back: it knows.
    if (cfg?.running && reason !== "stopped by the supervisor") await this.tell({ kind: "ended", role: cfg.role, reason, ...this.stats(cfg.role) });
  }

  /** The counters a window summary is made of. Numbers only. */
  private stats(role: RoleName) {
    return role === "keeper"
      ? { probesSent: this.keeper.probesSent, probesLanded: this.keeper.probesLanded, probesReverted: this.keeper.probesReverted }
      : { quotesSent: this.maker.sent, quotesFailed: this.maker.failed };
  }

  /** Tells the supervisor something worth an alert. It decides whether to send one; a miss is not retried. */
  private async tell(event: Record<string, unknown>): Promise<void> {
    try {
      const stub = this.env.SUPERVISOR.get(this.env.SUPERVISOR.idFromName("main"));
      await stub.fetch("https://supervisor/event", { method: "POST", body: JSON.stringify(event) });
    } catch (err) {
      this.log.warn("could not tell the supervisor", { err: errText(err) });
    }
  }

  private makerCtx(role: "makerA" | "makerB") {
    const clients = (this.clients ??= makeClients(this.env.CONDUIT_RPC_URL));
    const account = accountFor(this.env, QUOTER[role], schedule);
    if (!account) return null;
    // Sends go to the private node first, then the public ones. Without a private node, maker A sends
    // through the primary public node and maker B through Conduit, so neither carries both. Either way a
    // refused send moves that maker on to the next node and it stays there.
    const ordered = sendOrder(clients, role === "makerA" ? 0 : 1);
    this.signer ??= new Signer(account, ordered, this.signerOptions(ordered));
    return {
      vault: role === "makerA" ? schedule.vaults.a : schedule.vaults.b,
      settings: schedule.maker[MAKER_KEY[role]],
      referenceCoin: schedule.referenceCoin,
      signer: this.signer,
      client: clients[0] as PublicClient,
      state: this.maker,
      log: withFields(this.log, { bot: role }),
      report: this.report,
    };
  }

  /** Names for the nodes and the hook that tells the supervisor when a send moves to another node. */
  private signerOptions(ordered: PublicClient[]): { names: string[]; onFallback: (e: FallbackEvent) => void } {
    const all = nodeNames((this.clients ??= makeClients(this.env.CONDUIT_RPC_URL)));
    const names = ordered.map((c) => all.get(c) ?? "a node");
    return {
      names,
      onFallback: (e) => {
        this.log.warn("sends moved to another node", { from: names[e.from], to: names[e.to], failure: e.failure, type: e.type });
        this.tells.push(this.tell({ kind: "send-fallback", role: this.roleName, from: names[e.from] ?? "a node", to: names[e.to] ?? "a node", failure: e.failure, type: e.type }));
      },
    };
  }

  /**
   * A failed call or send. The first of each kind is told at once; repeats are counted and told at most once a minute with
   * their count. The supervisor turns that into one Telegram line an hour. Never throws and never waits.
   */
  private report = (context: string, err: unknown): void => {
    const type = errorType(err);
    const key = `${context}|${type}`;
    const e = this.reported.get(key) ?? { lastTold: 0, pending: 0 };
    e.pending += 1;
    this.reported.set(key, e);
    if (Date.now() - e.lastTold < 60_000) return;
    const count = e.pending;
    e.pending = 0;
    e.lastTold = Date.now();
    this.tells.push(this.tell({ kind: "error", role: this.roleName, context, type, text: errText(err), count }));
  };

  /** Asks the supervisor whether this run should go on. True while it says yes. */
  private async supervisorSays(runId: number): Promise<boolean> {
    try {
      const stub = this.env.SUPERVISOR.get(this.env.SUPERVISOR.idFromName("main"));
      const res = await stub.fetch("https://supervisor/should-run?runId=" + runId);
      const body = (await res.json()) as { run: boolean };
      this.lastOk = Date.now();
      return body.run;
    } catch (err) {
      const stillTrusted = Date.now() - this.lastOk < SUPERVISOR_SILENCE_MS;
      this.log.warn("the supervisor did not answer", { err: errText(err), stillTrusted });
      return stillTrusted;
    }
  }

  async alarm(): Promise<void> {
    const t0 = Date.now();
    const lateMs = this.expectedAt > 0 ? Math.max(0, t0 - this.expectedAt) : 0;
    this.outcome = "ok";
    try {
      await this.alarmInner();
    } catch (err) {
      // Anything not already handled: say so, and end the run cleanly rather than leave it half alive.
      this.outcome = errorType(err);
      this.log.error("role alarm failed", { err: errText(err) });
      this.report("alarm", err);
      await Promise.allSettled(this.tells.splice(0));
      await this.finish(`error: ${errText(err)}`).catch(() => undefined);
    }
    await this.recordDiag(t0, lateMs);
  }

  /** Adds this alarm to the rolling record. Saved when a minute completes, or at once for a failure or a slow alarm. */
  private async recordDiag(t0: number, lateMs: number): Promise<void> {
    try {
      const r = recordAlarm(this.diag, Math.floor(Date.now() / 1000), Date.now() - t0, lateMs, this.outcome, this.roleName === "keeper" ? KEEPER_SLOW_MS : undefined);
      if (r.rolled || r.urgent) await this.state.storage.put("diag", this.diag);
    } catch (err) {
      this.log.warn("could not save the alarm record", { err: errText(err) });
    }
  }

  private async alarmInner(): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg?.running) return;
    const t0 = Date.now();
    this.roleName = cfg.role;
    if (!this.booted) await this.onBoot(cfg);
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
        const clients = (this.clients ??= makeClients(this.env.CONDUIT_RPC_URL));
        this.signer ??= new Signer(account, clients, this.signerOptions(clients));
        await keeperBurst({ signer: this.signer, clients, state: this.keeper, log: withFields(this.log, { bot: "keeper" }), report: this.report });
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
      this.outcome = errorType(err);
      return this.finish(`error: ${errText(err)}`);
    }
    await this.saveStats(cfg);
    await Promise.allSettled(this.tells.splice(0));
    // A read or send that had to leave the private node: say so, at most every five minutes.
    if (takeFallbacks() > 0 && Date.now() - this.lastFallbackTold > 300_000) {
      this.lastFallbackTold = Date.now();
      await this.tell({ kind: "fallback", role: cfg.role });
    }
    this.expectedAt = Math.max(Date.now() + 50, next);
    await this.state.storage.setAlarm(this.expectedAt);
  }
}
