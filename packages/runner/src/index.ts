import { nextWindow, windowAt } from "@plumbline/shared";
import { schedule } from "./config.js";
import type { Env } from "./env.js";
import { Role } from "./role.js";
import { Supervisor } from "./supervisor.js";

export { Role, Supervisor };

/** Constant-time string comparison, so a wrong admin token takes as long to reject as a near-miss. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const supervisor = (env: Env) => env.SUPERVISOR.get(env.SUPERVISOR.idFromName("main"));

export default {
  /**
   * Public: GET /health, the schedule and the supervisor's state (no secret in it).
   * Admin, with `Authorization: Bearer <ADMIN_TOKEN>`: POST /kill, POST /resume, POST /tick.
   * Nothing else is routed: the roles and the supervisor cannot be reached from outside.
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      const now = Math.floor(Date.now() / 1000);
      const state = (await (await supervisor(env).fetch("https://supervisor/state")).json()) as object;
      return json({ ...state, scheduleEnabled: schedule.enabled, windows: schedule.windows, inWindow: windowAt(schedule, now) !== null, next: nextWindow(schedule, now) });
    }
    if (req.method === "POST" && ["/kill", "/resume", "/tick"].includes(url.pathname)) {
      if (!env.ADMIN_TOKEN) return json({ error: "admin actions are disabled: ADMIN_TOKEN is not set" }, 503);
      const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!sameSecret(given, env.ADMIN_TOKEN)) return json({ error: "unauthorised" }, 401);
      return json(await (await supervisor(env).fetch(`https://supervisor${url.pathname}`, { method: "POST" })).json());
    }
    return json({ error: "not found" }, 404);
  },

  /** The cron trigger: wakes the supervisor once a minute. Whether anything runs is decided there. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(supervisor(env).fetch("https://supervisor/tick", { method: "POST" }).then(() => undefined));
  },
};
