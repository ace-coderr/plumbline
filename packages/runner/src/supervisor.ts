import type { PublicClient } from "viem";
import { RUNNER_WALLETS, nextWindow, utcDay, windowAt, type Span } from "@plumbline/shared";
import { schedule } from "./config.js";
import { makeClients, readBalances } from "./chain.js";
import { ensureCampaign } from "./campaign.js";
import { accountFor, secretValues, type Env } from "./env.js";
import { decide, toWei, type Balances, type DayStart, type Halt } from "./core/budget.js";
import { makeRedactor } from "./core/redact.js";
import { errText, makeLogger, type Logger } from "./core/log.js";
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
  private clients: [PublicClient, PublicClient] | null = null;
  /** True while a tick is running: a second tick (cron and alarm can coincide) is skipped, never run alongside. */
  private busy = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.log = makeLogger(makeRedactor(secretValues(env)));
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
        return this.report();
      case "/resume":
        await this.state.storage.put("killed", false);
        await this.state.storage.delete("halt");
        this.log.warn("kill switch off, halts cleared");
        return this.report();
      case "/should-run": {
        const runId = Number(url.searchParams.get("runId"));
        const current = await this.get<number>("runId");
        const killed = (await this.get<boolean>("killed")) ?? false;
        const halt = await this.get<Halt>("halt");
        const nowSec = Math.floor(Date.now() / 1000);
        const w = windowAt(schedule, nowSec);
        // A halt only counts while it applies: a cap halt for its UTC day, any other for its window.
        const halted = halt !== undefined && w !== null && (halt.kind === "cap" ? halt.day === utcDay(nowSec) : halt.windowStart === w.start);
        return Response.json({ run: !killed && !halted && schedule.enabled && w !== null && current === runId });
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
    return Response.json({
      enabled: schedule.enabled,
      killed: (await this.get<boolean>("killed")) ?? false,
      halt: (await this.get<Halt>("halt")) ?? null,
      window: w,
      nextWindow: next,
      lastDecision: (await this.get<unknown>("lastDecision")) ?? null,
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

    this.clients ??= makeClients();
    const [client, sendClient] = this.clients;
    let balances: Balances | null = null;
    try {
      balances = await readBalances(client, schedule);
    } catch (err) {
      this.log.warn("balances not readable", { err: errText(err) });
    }
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
      const out = await ensureCampaign(this.env, schedule, client, sendClient, now, window.end, this.log);
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
