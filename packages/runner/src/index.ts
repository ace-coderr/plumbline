import { nextWindow, windowAt } from "@plumbline/shared";
import { schedule } from "./config.js";
import { redactorFor, type Env } from "./env.js";
import { errorType } from "./core/errors.js";
import { errText, makeLogger, safeJson, setRedactor } from "./core/log.js";
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

const json = (body: unknown, status = 200) => safeJson(body, { status, headers: { "cache-control": "no-store" } });

/** Workers' edge cache; the DOM typings do not know about `default`. */
const edgeCache =
  typeof caches === "undefined"
    ? null
    : (caches as unknown as { default: { match(r: Request): Promise<Response | undefined>; put(r: Request, s: Response): Promise<void> } }).default;

const supervisor = (env: Env) => env.SUPERVISOR.get(env.SUPERVISOR.idFromName("main"));

/** Best-effort: tell the supervisor about an uncaught exception. Never throws; the supervisor dedupes and shortens it. */
async function reportToSupervisor(env: Env, context: string, err: unknown): Promise<void> {
  try {
    const text = err instanceof Error ? err.message : String(err);
    await supervisor(env).fetch("https://supervisor/event", { method: "POST", body: JSON.stringify({ kind: "error", role: "worker", context, type: errorType(err), text, count: 1 }) });
  } catch {
    // The supervisor is the thing that failed or cannot be reached: there is nowhere further to report to, and the Worker's own log has the error.
  }
}

/** The admin token from a JSON body {"token": "..."}, or an empty string. */
async function tokenFromBody(req: Request): Promise<string> {
  try {
    const b = (await req.clone().json()) as { token?: unknown };
    return typeof b.token === "string" ? b.token : "";
  } catch {
    return "";
  }
}

async function handle(req: Request, env: Env): Promise<Response> {
    setRedactor(redactorFor(env));
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    // Cached for 15 s at the edge: the free daily request quota is shared with the bots, so a flood of
    // GETs must not reach the Durable Objects.
    const key = new Request(`${url.origin}/health`);
    const hit = edgeCache ? await edgeCache.match(key) : undefined;
    if (hit) return hit;
    const now = Math.floor(Date.now() / 1000);
    const state = (await (await supervisor(env).fetch("https://supervisor/state")).json()) as object;
    const res = safeJson(
      { ...state, scheduleEnabled: schedule.enabled, windows: schedule.windows, inWindow: windowAt(schedule, now) !== null, next: nextWindow(schedule, now) },
      { headers: { "cache-control": "public, max-age=15" } },
    );
    if (edgeCache) await edgeCache.put(key, res.clone());
    return res;
  }
  if (req.method === "POST" && ["/kill", "/resume", "/tick", "/alert-test", "/topup-plan", "/topup-test", "/diag"].includes(url.pathname)) {
    if (!env.ADMIN_TOKEN) return json({ error: "admin actions are disabled: ADMIN_TOKEN is not set" }, 503);
    // The token travels in the request body, which Workers Logs does not record; the Authorization header is still accepted.
    const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || (await tokenFromBody(req));
    if (!sameSecret(given, env.ADMIN_TOKEN)) return json({ error: "unauthorised" }, 401);
    return json(await (await supervisor(env).fetch(`https://supervisor${url.pathname}${url.search}`, { method: "POST" })).json());
  }
  return json({ error: "not found" }, 404);
}

export default {
  /**
   * Public: GET /health, the schedule and the supervisor's state (no secret in it).
   * Admin, with the token in a JSON body `{"token": "<ADMIN_TOKEN>"}` (or an `Authorization: Bearer` header): POST /kill, /resume, /tick, /alert-test, /topup-plan (a dry run), /topup-test?wallet=&hype= (one live transfer of at most 0.001 HYPE).
   * Nothing else is routed: the roles and the supervisor cannot be reached from outside.
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (err) {
      // Never an error page with details: a plain 500, and a best-effort report to the supervisor.
      makeLogger(redactorFor(env)).error("request failed", { err: errText(err) });
      await reportToSupervisor(env, "request", err);
      return json({ error: "internal error" }, 500);
    }
  },

  /** The cron trigger: wakes the supervisor once a minute. Whether anything runs is decided there. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    setRedactor(redactorFor(env));
    ctx.waitUntil(
      supervisor(env)
        .fetch("https://supervisor/tick", { method: "POST" })
        .then(() => undefined)
        .catch(async (err) => {
          makeLogger(redactorFor(env)).error("cron tick failed", { err: errText(err) });
          await reportToSupervisor(env, "cron tick", err);
        }),
    );
  },
};
