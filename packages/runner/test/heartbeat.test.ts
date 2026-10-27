import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Supervisor } from "../src/supervisor.js";
import type { Env } from "../src/env.js";
import { setRedactor } from "../src/core/log.js";

const hex = (n: number) => randomBytes(n).toString("hex");
const T0 = Date.parse("2026-10-27T03:00:00Z");
const nowSec = (ms: number) => Math.floor(ms / 1000);

interface World {
  pings: { url: string; method: string | undefined; signal: boolean; at: number }[];
  telegram: string[];
  logs: string[];
  mode: "ok" | "500" | "throw" | "timeout" | "path";
  telegramCalls: number;
}

describe("the heartbeat", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realLog = console.log;
  let now = T0;
  let world: World;
  let secrets: { HEALTHCHECK_URL: string; TELEGRAM_BOT_TOKEN: string; TELEGRAM_CHAT_ID: string; CONDUIT_RPC_URL: string };

  beforeEach(() => {
    now = T0;
    Date.now = () => now;
    world = { pings: [], telegram: [], logs: [], mode: "ok", telegramCalls: 0 };
    secrets = {
      HEALTHCHECK_URL: `https://hc-ping.example.com/${hex(16)}-${hex(4)}`,
      TELEGRAM_BOT_TOKEN: `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`,
      TELEGRAM_CHAT_ID: String(Math.floor(1e9 + Math.random() * 9e9)),
      CONDUIT_RPC_URL: `https://rpc.conduit.xyz/v1/${hex(20)}`,
    };
    console.log = (...a: unknown[]) => void world.logs.push(a.map(String).join(" "));
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://api.telegram.org/")) {
        world.telegramCalls += 1;
        world.telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return Response.json({ ok: true });
      }
      if (u === secrets.HEALTHCHECK_URL) {
        world.pings.push({ url: u, method: init?.method, signal: init?.signal instanceof AbortSignal, at: now });
        if (world.mode === "throw") throw new Error(`fetch failed: connect ECONNREFUSED ${u}`);
        if (world.mode === "path") throw new Error(`bad gateway for ${new URL(u).host}${new URL(u).pathname}`);
        if (world.mode === "timeout") throw Object.assign(new Error(`The operation was aborted due to timeout while calling ${u}`), { name: "TimeoutError" });
        return new Response(world.mode === "500" ? `error from ${u}` : "OK", { status: world.mode === "500" ? 500 : 200 });
      }
      throw new Error(`an unexpected network call: ${u}`);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    console.log = realLog;
    setRedactor((s) => s);
  });

  function make(opts: { secret?: boolean; failPutOnce?: string } = {}) {
    const env: Record<string, string> = { ...secrets };
    if (opts.secret === false) delete env.HEALTHCHECK_URL;
    const m = new Map<string, unknown>([["plumbusdCheckedAt", nowSec(now) + 86_400], ["windowTracked", nowSec(now)], ["lastTickAt", nowSec(now) - 60]]);
    let failed = false;
    const st = {
      storage: {
        get: async (k: string) => m.get(k),
        put: async (k: string, v: unknown) => {
          if (opts.failPutOnce === k && !failed) {
            failed = true;
            throw new Error("storage broke");
          }
          m.set(k, v);
        },
        delete: async (k: string) => m.delete(k),
        setAlarm: async () => undefined,
        getAlarm: async () => null,
        deleteAlarm: async () => undefined,
      },
    };
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ running: false }) }) };
    return { sup: new Supervisor(st as never, { ...env, SUPERVISOR: ns, ROLE: ns } as unknown as Env), m };
  }
  const everyMinute = async (sup: Supervisor, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      await sup.tick();
      now += 60_000;
    }
  };
  const everything = (extra: unknown[] = []) => [...world.logs, ...world.telegram, ...extra.map((e) => JSON.stringify(e))].join("\n");
  const assertNoUrl = (text: string, where: string) => {
    for (const v of [secrets.HEALTHCHECK_URL, secrets.HEALTHCHECK_URL.split("/").pop()!, secrets.HEALTHCHECK_URL.split("/").pop()!.split("-")[0]!, "hc-ping.example.com/"]) {
      assert.ok(!text.includes(v), `the heartbeat address (${v.slice(0, 8)}…) appeared in ${where}`);
    }
  };

  it("pings every five minutes, in or out of a window, once per five minutes", async () => {
    const { sup } = make();
    await everyMinute(sup, 11);
    assert.equal(world.pings.length, 3, "at minutes 0, 5 and 10");
    assert.deepEqual(world.pings.map((p) => (p.at - T0) / 60_000), [0, 5, 10]);
    assert.ok(world.pings.every((p) => p.method === "GET" && p.signal), "a GET with a timeout signal");
  });

  it("sends nothing and says nothing when the secret is missing", async () => {
    const { sup } = make({ secret: false });
    await everyMinute(sup, 12);
    assert.equal(world.pings.length, 0);
    assert.equal(world.telegramCalls, 0, "no alert either");
    const state = (await (await sup.fetch(new Request("https://supervisor/state"))).json()) as { heartbeat: { configured: boolean; last: unknown } };
    assert.deepEqual(state.heartbeat, { configured: false, last: null, skipped: null });
  });

  it("is skipped while the kill switch is on", async () => {
    const { sup, m } = make();
    m.set("killed", true);
    await everyMinute(sup, 6);
    assert.equal(world.pings.length, 0);
  });

  it("is skipped while a halt is in force, and not for a halt that has ended", async () => {
    const a = make();
    a.m.set("halt", { kind: "cap", reason: "spent", day: "2026-10-27", windowStart: 1, at: 1 });
    await everyMinute(a.sup, 6);
    assert.equal(world.pings.length, 0, "a cap halt for today");
    now = T0;
    world.pings.length = 0;
    const b = make();
    b.m.set("halt", { kind: "cap", reason: "spent", day: "2026-10-26", windowStart: 1, at: 1 });
    await everyMinute(b.sup, 1);
    assert.equal(world.pings.length, 1, "yesterday's cap halt no longer applies");
    now = T0 + 10 * 60_000;
    const c = make();
    c.m.set("halt", { kind: "floor", reason: "low", day: "2026-10-27", windowStart: nowSec(T0) - 3600, at: 1 });
    await everyMinute(c.sup, 1);
    assert.equal(world.pings.length, 2, "a floor halt from a window that is not open");
  });

  it("is skipped when the previous tick was not recent, or this tick failed", async () => {
    const stale = make();
    stale.m.set("lastTickAt", nowSec(now) - 1000);
    await stale.sup.tick();
    assert.equal(world.pings.length, 0, "the cron had been missing");
    const broken = make({ failPutOnce: "lastTickAt" });
    await broken.sup.tick();
    assert.equal(world.pings.length, 0, "the tick threw");
    const skipped = (await (await broken.sup.fetch(new Request("https://supervisor/state"))).json()) as { heartbeat: { skipped: { reason: string } } };
    assert.match(skipped.heartbeat.skipped.reason, /tick failed/);
  });

  it("a failed ping is counted and reported through the error alerts, once an hour, and is not fatal", async () => {
    const { sup, m } = make();
    world.mode = "throw";
    await everyMinute(sup, 6);
    assert.equal(world.pings.length, 2);
    assert.equal(world.telegram.filter((t) => /error in supervisor \(heartbeat ping/.test(t)).length, 1, "deduped by kind");
    const hb = m.get("heartbeat") as { ok: boolean; failures: number; lastError: string };
    assert.equal(hb.ok, false);
    assert.equal(hb.failures, 2);
    assert.ok((m.get("lastTickAt") as number) > nowSec(T0), "the ticks kept running");
    world.mode = "ok";
    await everyMinute(sup, 5);
    assert.equal((m.get("heartbeat") as { ok: boolean }).ok, true, "the next success is recorded");
    assert.equal((m.get("heartbeat") as { failures: number }).failures, 2, "failures stay counted");
  });

  it("a ping is tried once: a refusal or a timeout is not retried", async () => {
    for (const mode of ["500", "timeout"] as const) {
      world.pings.length = 0;
      world.mode = mode;
      now = T0;
      const { sup } = make();
      await sup.tick();
      assert.equal(world.pings.length, 1, `${mode}: one attempt`);
    }
  });

  it("the address is in no log line, alert, /state response or stored failure text, whichever way the ping fails", async () => {
    for (const mode of ["throw", "500", "timeout", "path"] as const) {
      world.mode = mode;
      world.logs.length = 0;
      world.telegram.length = 0;
      now = T0;
      const { sup, m } = make();
      await everyMinute(sup, 2);
      const state = await (await sup.fetch(new Request("https://supervisor/state"))).text();
      assert.ok(world.telegram.length >= 1 || mode === "500", `${mode}: something was reported`);
      assertNoUrl(everything([[...m.entries()]]), `${mode}: logs, alerts and storage`);
      assertNoUrl(state, `${mode}: /state`);
    }
  });

  it("the public /state shows only whether it is set and how the last ping went", async () => {
    const { sup } = make();
    await sup.tick();
    const state = await (await sup.fetch(new Request("https://supervisor/state"))).text();
    assertNoUrl(state, "/state");
    const parsed = JSON.parse(state) as { heartbeat: { configured: boolean; last: { ok: boolean } } };
    assert.equal(parsed.heartbeat.configured, true);
    assert.equal(parsed.heartbeat.last.ok, true);
  });
});

describe("source guard for the heartbeat address", () => {
  it("is read in one place and never logged, returned or put in an error message", () => {
    const dir = decodeURIComponent(new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const t = readFileSync(dir + f, "utf8");
      if (!t.includes("HEALTHCHECK_URL")) continue;
      assert.ok(["env.ts", "supervisor.ts"].includes(f.replace(/\\/g, "/")), `${f} mentions HEALTHCHECK_URL`);
      assert.ok(!/(log|logger)\.\w+\([^)]*HEALTHCHECK_URL/.test(t), `${f} logs it`);
      assert.ok(!/(json|Response|safeJson)\([^)]*HEALTHCHECK_URL/.test(t), `${f} returns it`);
      assert.ok(!/Error\(`[^`]*\$\{[^}]*(HEALTHCHECK_URL|\burl\b)/.test(t.replace(/the heartbeat monitor answered/g, "")), `${f} puts the address in an error`);
    }
  });
});
