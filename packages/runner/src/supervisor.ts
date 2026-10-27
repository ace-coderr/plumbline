import type { PublicClient } from "viem";
import { RUNNER_WALLETS, nextWindow, utcDay, windowAt, type Span } from "@plumbline/shared";
import { schedule } from "./config.js";
import { makeClients, readBalances, takeFallbacks, tryEach } from "./chain.js";
import { ensureCampaign } from "./campaign.js";
import { redactorFor, type Env } from "./env.js";
import { decide, spentToday, toWei, type Balances, type DayStart, type Halt } from "./core/budget.js";
import { gate, msg, prune, sendTelegram, type AlertGate } from "./core/alerts.js";
import { daysLeft, parseSent } from "./core/topup.js";
import { planNow, runTopUp, testSend, treasuryBalance, withSent, type LastTopUp, type TreasuryCtx } from "./treasury.js";
import { errText, makeLogger, setRedactor, type Logger, safeJson } from "./core/log.js";
import { accountFor } from "./env.js";
import type { RoleName } from "./role.js";

const ROLES: RoleName[] = ["keeper", "makerA", "makerB"];
const TICK_MS = 20_000;
/** The campaign check runs this often, not on every tick. */
const CAMPAIGN_CHECK_MS = 60_000;

const stringify = (b: Balances | null): Record<string, string> | null => (b ? Object.fromEntries(RUNNER_WALLETS.map((w) => [w, b[w].toString()])) : null);
const parse = (s: Record<string, string>): Balances => Object.fromEntries(RUNNER_WALLETS.map((w) => [w, BigInt(s[w] ?? "0")])) as Balances;

/**
 * The one supervisor (a single Durable Object). A cron trigger wakes it every minute and it keeps its
 * own 20-second alarm while a window is open. On each tick it reads the balances and applies the
 * rules in core/budget.ts: stop at the daily cap, stop under a floor, do nothing outside a window or
 * when the schedule is off or the kill switch is on. When all is well it makes sure a campaign exists
 * and that the three bots are running; roles end themselves at the window's end regardless.
 */
export class Supervisor {
  private log: Logger;
  private clients: PublicClient[] | null = null;
  /** True while a tick is running: a second tick (cron and alarm can coincide) is skipped, never run alongside. */
  private busy = false;
  private readonly redact: (s: string) => string;
  /** Alerts go one at a time, so two at once cannot both pass the once-an-hour gate. */
  private alerts: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    const redact = redactorFor(env);
    setRedactor(redact);
    this.redact = redact;
    this.log = makeLogger(redact);
  }

  /** Sends a Telegram alert unless the same `key` was sent within the repeat window. Never throws. */
  private alert(key: string, text: string, force = false): Promise<void> {
    this.alerts = this.alerts.then(async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const state = (await this.get<AlertGate>("alertGate")) ?? {};
        if (!force && !gate(state, key, now, schedule.alerts.repeatMinutes)) return;
        await this.state.storage.put("alertGate", prune(force ? { ...state, [key]: now } : state, now));
        const r = await sendTelegram({ token: this.env.TELEGRAM_BOT_TOKEN, chatId: this.env.TELEGRAM_CHAT_ID }, text, this.redact);
        if (!r.ok) this.log.warn("alert not sent", { key, err: r.error });
      } catch (err) {
        this.log.warn("alert failed", { key, err: errText(err) });
      }
    });
    return this.alerts;
  }

  private treasuryCtx(): TreasuryCtx {
    return {
      env: this.env,
      schedule,
      storage: this.state.storage,
      clients: (this.clients ??= makeClients(this.env.CONDUIT_RPC_URL)),
      log: this.log,
      alert: (k, t) => this.alert(k, t),
      stillOn: async () => !((await this.get<boolean>("killed")) ?? false),
    };
  }

  private get<T>(k: string): Promise<T | undefined> {
    return this.state.storage.get<T>(k);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/tick":
        await this.tick();
        return this.report();
      case "/kill":
        await this.state.storage.put("killed", true);
        await this.stopRoles("kill switch");
        await this.state.storage.deleteAlarm();
        this.log.warn("kill switch on");
        await this.alert("kill", msg.kill());
        return this.report();
      case "/resume":
        await this.state.storage.put("killed", false);
        await this.state.storage.delete("halt");
        this.log.warn("kill switch off, halts cleared");
        await this.alert("resume", msg.resumed());
        return this.report();
      case "/event":
        return this.onEvent((await req.json().catch(() => null)) as Record<string, unknown> | null);
      case "/alert-test": {
        const r = await sendTelegram({ token: this.env.TELEGRAM_BOT_TOKEN, chatId: this.env.TELEGRAM_CHAT_ID }, msg.test(), this.redact);
        return safeJson(r.ok ? { ok: true } : { ok: false, error: r.error });
      }
      case "/topup-plan":
      case "/topup-test":
        return this.topUpAdmin(url);
      case "/should-run": {
        const runId = Number(url.searchParams.get("runId"));
        const current = await this.get<number>("runId");
        const killed = (await this.get<boolean>("killed")) ?? false;
        const halt = await this.get<Halt>("halt");
        const nowSec = Math.floor(Date.now() / 1000);
        const w = windowAt(schedule, nowSec);
        // A halt only counts while it applies: a cap halt for its UTC day, any other for its window.
        const halted = halt !== undefined && w !== null && (halt.kind === "cap" ? halt.day === utcDay(nowSec) : halt.windowStart === w.start);
        return safeJson({ run: !killed && !halted && schedule.enabled && w !== null && current === runId });
      }
      default:
        return this.report();
    }
  }

  async alarm(): Promise<void> {
    await this.tick();
  }

  private async report(): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const w = windowAt(schedule, now);
    const next = nextWindow(schedule, now);
    const dayStart = await this.get<{ day: string; balances: Record<string, string> }>("dayStart");
    const roles = await Promise.all(
      ROLES.map(async (r) => {
        try {
          const res = await this.env.ROLE.get(this.env.ROLE.idFromName(r)).fetch("https://role/state");
          return { name: r, ...((await res.json()) as object) };
        } catch {
          return { name: r, error: "unreachable" };
        }
      }),
    );
    return safeJson({
      enabled: schedule.enabled,
      killed: (await this.get<boolean>("killed")) ?? false,
      halt: (await this.get<Halt>("halt")) ?? null,
      window: w,
      nextWindow: next,
      lastDecision: (await this.get<unknown>("lastDecision")) ?? null,
      treasury: {
        address: schedule.treasury.address,
        topUpsOn: schedule.topUp.enabled,
        lastTopUp: (await this.get<LastTopUp>("lastTopUp")) ?? null,
        lastCheckAt: (await this.get<number>("topUpCheckAt")) ?? null,
        lastNote: (await this.get<unknown>("topUpNote")) ?? null,
        lastError: (await this.get<unknown>("topUpError")) ?? null,
        sentToday: await this.sentTodayHype(),
        alertsConfigured: Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID),
      },
      lastTickAt: (await this.get<number>("lastTickAt")) ?? null,
      campaignNote: (await this.get<string>("campaignNote")) ?? null,
      dayStart: dayStart?.day ?? null,
      roles,
    });
  }

  private async stopRoles(reason: string): Promise<void> {
    await this.state.storage.delete("runId");
    await Promise.all(
      ROLES.map((r) => this.env.ROLE.get(this.env.ROLE.idFromName(r)).fetch("https://role/stop", { method: "POST" }).catch(() => undefined)),
    );
    await this.state.storage.put("rolesRunning", false);
    this.log.info("roles stopped", { reason });
  }

  private async halt(h: Halt): Promise<void> {
    await this.state.storage.put("halt", h);
    this.log.warn("halted", { kind: h.kind, reason: h.reason });
    await this.stopRoles(h.reason);
    await this.alert(`halt:${h.kind}`, h.kind === "cap" ? msg.capHit(h.reason) : h.kind === "floor" ? msg.walletUnderFloor(h.reason) : msg.halted(h.kind, h.reason));
  }

  private async sentTodayHype(): Promise<{ day: string; totalHype: number } | null> {
    const day = utcDay(Math.floor(Date.now() / 1000));
    const s = parseSent(await this.get<{ day: string; perWallet: Record<string, string>; total: string }>("topUpSent"), day);
    return { day, totalHype: Number(s.total) / 1e18 };
  }

  /** What the roles report: a window that ended early or badly, a node that failed, the end of a window. */
  private async onEvent(e: Record<string, unknown> | null): Promise<Response> {
    if (!e || typeof e.kind !== "string") return safeJson({ ok: false });
    const role = typeof e.role === "string" && (ROLES as string[]).includes(e.role) ? e.role : "a bot";
    if (e.kind === "fallback") await this.alert("fallback", msg.rpcFallback());
    if (e.kind === "ended" && typeof e.reason === "string") {
      if (e.reason === "the window ended") {
        if (role === "keeper") await this.summary(Number(e.probesSent) || 0, Number(e.probesLanded) || 0, Number(e.probesReverted) || 0);
      } else if (e.reason !== "the supervisor said stop") {
        await this.alert(`failed:${role}`, msg.windowFailed(role, e.reason));
      }
    }
    return safeJson({ ok: true });
  }

  /** The short message after each window: probes, HYPE spent today, and the least funding left. */
  private async summary(probesSent: number, probesLanded: number, probesReverted: number): Promise<void> {
    try {
      const clients = (this.clients ??= makeClients(this.env.CONDUIT_RPC_URL));
      const balances = await tryEach(clients, (c) => readBalances(c, schedule));
      const stored = await this.get<{ day: string; balances: Record<string, string> }>("dayStart");
      const spentWei = stored ? spentToday({ day: stored.day, balances: parse(stored.balances) }, balances) : 0n;
      let worst = "";
      let minDays = Infinity;
      for (const w of RUNNER_WALLETS) {
        if (schedule.wallets[w] === null) continue;
        const d = daysLeft(schedule, w, balances[w]);
        if (d < minDays) [minDays, worst] = [d, w];
      }
      const treasuryWei = (await treasuryBalance({ clients, schedule })) ?? 0n;
      const start = windowAt(schedule, Math.floor(Date.now() / 1000) - 1)?.start ?? 0;
      await this.alert(`summary:${start}`, msg.summary({ probesLanded, probesSent, probesReverted, spentWei, minDays: Number.isFinite(minDays) ? minDays : 0, worst, treasuryWei }));
    } catch (err) {
      this.log.warn("summary not sent", { err: errText(err) });
    }
  }

  /** Admin: what a top-up would do right now (a dry run), or one live transfer of at most 0.001 HYPE. */
  private async topUpAdmin(url: URL): Promise<Response> {
    if (this.busy) return safeJson({ ok: false, note: "a tick is running; try again in a moment" });
    this.busy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const c = this.treasuryCtx();
      if (url.pathname === "/topup-test") {
        return safeJson(await testSend(c, now, url.searchParams.get("wallet") ?? "", Number(url.searchParams.get("hype"))));
      }
      const balances = await tryEach(c.clients, (cl) => readBalances(cl, schedule));
      const { plan, treasuryWei } = await planNow(c, now, balances);
      return safeJson({
        treasuryHype: treasuryWei === null ? null : Number(treasuryWei) / 1e18,
        off: plan.off,
        treasuryLow: plan.treasuryLow,
        treasuryEmpty: plan.treasuryEmpty,
        sends: plan.sends.map((s) => ({ wallet: s.wallet, hype: Number(s.amountWei) / 1e18 })),
        skipped: plan.skipped,
      });
    } catch (err) {
      return safeJson({ ok: false, note: errText(err) });
    } finally {
      this.busy = false;
    }
  }

  /**
   * The top-up check, when one is due: at the first tick of a window and then every checkEveryMinutes.
   * The check is marked done before it starts, so a failure waits for the next scheduled check.
   * What was sent moves the day's starting balances up by the same amount, so the cap still sees spending.
   */
  private async topUp(now: number, w: Span, balances: Balances): Promise<Balances> {
    if (!schedule.topUp.enabled) return balances;
    const lastAt = (await this.get<number>("topUpCheckAt")) ?? 0;
    const lastWindow = await this.get<number>("topUpWindow");
    if (lastWindow === w.start && now - lastAt < schedule.topUp.checkEveryMinutes * 60) return balances;
    await this.state.storage.put("topUpCheckAt", now);
    await this.state.storage.put("topUpWindow", w.start);
    let result;
    try {
      result = await runTopUp(this.treasuryCtx(), now, balances);
    } catch (err) {
      this.log.warn("top-up check failed", { err: errText(err) });
      await this.state.storage.put("topUpNote", { at: now, note: "the check failed", sent: 0 });
      return balances;
    }
    await this.state.storage.put("topUpNote", { at: now, note: result.note, sent: result.sent.length });
    if (result.sent.length === 0) return balances;
    const stored = await this.get<{ day: string; balances: Record<string, string> }>("dayStart");
    if (stored) await this.state.storage.put("dayStart", { day: stored.day, balances: stringify(withSent(parse(stored.balances), result.sent)) });
    // A wallet that was under its floor is no longer: the floor halt can end.
    const halt = await this.get<Halt>("halt");
    if (halt?.kind === "floor") await this.state.storage.delete("halt");
    return withSent(balances, result.sent);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tickOnce();
    } finally {
      this.busy = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.state.storage.put("lastTickAt", now);
    const killed = (await this.get<boolean>("killed")) ?? false;
    // Nothing to do (switched off, killed, or outside a window): answer without a single network call.
    const quick = decide({ schedule, nowSec: now, killed, halt: null, balances: null, dayStart: null });
    if (quick.action === "idle") {
      await this.state.storage.put("lastDecision", quick);
      if ((await this.get<boolean>("rolesRunning")) ?? false) await this.stopRoles(quick.reason);
      await this.state.storage.deleteAlarm();
      return;
    }

    const clients = (this.clients ??= makeClients(this.env.CONDUIT_RPC_URL));
    let balances: Balances | null = null;
    try {
      balances = await tryEach(clients, (c) => readBalances(c, schedule));
    } catch (err) {
      this.log.warn("balances not readable", { err: errText(err) });
    }
    if (takeFallbacks() > 0) await this.alert("fallback", msg.rpcFallback());
    const nowWindow = windowAt(schedule, now);
    if (balances && nowWindow && !killed) balances = await this.topUp(now, nowWindow, balances);
    const storedDay = await this.get<{ day: string; balances: Record<string, string> }>("dayStart");
    const dayStart: DayStart | null = storedDay ? { day: storedDay.day, balances: parse(storedDay.balances) } : null;
    const d = decide({
      schedule,
      nowSec: now,
      killed,
      halt: (await this.get<Halt>("halt")) ?? null,
      balances,
      dayStart,
    });
    // The first balances of a UTC day are the day's starting point for the cap.
    if (balances && (!dayStart || dayStart.day !== utcDay(now))) {
      await this.state.storage.put("dayStart", { day: utcDay(now), balances: stringify(balances) });
    }
    await this.state.storage.put("lastDecision", d.action === "stop" ? { action: "stop", reason: d.halt.reason } : d.action === "run" ? { action: "run", spentWei: d.spentWei.toString() } : d);

    if (d.action === "idle") {
      if ((await this.get<boolean>("rolesRunning")) ?? false) await this.stopRoles(d.reason);
      await this.state.storage.deleteAlarm();
      return;
    }
    if (d.action === "stop") {
      await this.halt(d.halt);
      await this.state.storage.deleteAlarm();
      return;
    }
    // Spending cannot be watched without balances: after six blind ticks (two minutes) everything stops.
    if (d.action === "hold") {
      const blind = ((await this.get<number>("blindTicks")) ?? 0) + 1;
      await this.state.storage.put("blindTicks", blind);
      if (blind >= 6) {
        await this.state.storage.put("blindTicks", 0);
        await this.halt({ kind: "rpc", reason: "the balances could not be read for two minutes, so spending cannot be watched", day: utcDay(now), windowStart: d.window.start, at: now });
        await this.state.storage.deleteAlarm();
        return;
      }
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
      return;
    }
    await this.state.storage.put("blindTicks", 0);
    await this.state.storage.setAlarm(Date.now() + TICK_MS);
    // Reaching here means any earlier halt no longer applies.
    await this.state.storage.delete("halt");

    // Run: validate the keys once per window, make sure a campaign is there, then start the bots.
    const window: Span = d.window;
    const runId = await this.get<number>("runId");
    if (runId !== window.start) {
      for (const w of ["keeper", "quoterA", "quoterB"] as const) {
        try {
          if (!accountFor(this.env, w, schedule)) return this.halt({ kind: "config", reason: `the secret for ${w} is not set`, day: utcDay(now), windowStart: window.start, at: now });
        } catch (err) {
          return this.halt({ kind: "config", reason: errText(err), day: utcDay(now), windowStart: window.start, at: now });
        }
      }
    }
    const lastCheck = (await this.get<number>("campaignCheckedAt")) ?? 0;
    if (runId !== window.start || Date.now() - lastCheck > CAMPAIGN_CHECK_MS) {
      await this.state.storage.put("campaignCheckedAt", Date.now());
      const out = await ensureCampaign(this.env, schedule, clients, now, window.end, this.log);
      if (!out.ok && out.transient) {
        // A node that would not answer is not a reason to stop: look again next time, and stop after three in a row.
        const misses = ((await this.get<number>("campaignReadMisses")) ?? 0) + 1;
        await this.state.storage.put("campaignReadMisses", misses);
        await this.state.storage.put("campaignCheckedAt", 0);
        if (misses < 3) {
          this.log.warn("campaign check skipped", { reason: out.reason, misses });
          if (runId !== window.start) return;
        } else {
          await this.state.storage.put("campaignReadMisses", 0);
          return this.halt({ kind: "rpc", reason: out.reason, day: utcDay(now), windowStart: window.start, at: now });
        }
      } else if (out.ok) {
        await this.state.storage.put("campaignReadMisses", 0);
      }
      if (!out.ok && !out.transient) return this.halt({ kind: out.reason.includes("PLUMBUSD") && out.reason.includes("sponsor") ? "sponsor" : "campaign", reason: out.reason, day: utcDay(now), windowStart: window.start, at: now });
      if (out.ok && out.did) await this.state.storage.put("campaignNote", `${out.did} at ${new Date().toISOString()}`);
    }
    if (runId !== window.start) {
      await this.state.storage.put("runId", window.start);
      await Promise.all(
        ROLES.map((r) =>
          this.env.ROLE.get(this.env.ROLE.idFromName(r)).fetch("https://role/start", {
            method: "POST",
            body: JSON.stringify({ role: r, runId: window.start, windowEnd: window.end }),
          }),
        ),
      );
      await this.state.storage.put("rolesRunning", true);
      this.log.info("window started", { start: window.start, end: window.end, capWei: toWei(schedule.dailyHypeCap).toString(), spentWei: d.spentWei.toString() });
    }
  }
}
