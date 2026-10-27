import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { schedule } from "../src/config.js";
import { Role } from "../src/role.js";
import { Supervisor } from "../src/supervisor.js";
import type { Env } from "../src/env.js";
import { setRedactor } from "../src/core/log.js";
import { MAX_ERRORS_PER_HOUR, emptyErrorGate, errorType, gateError, lastFinishedWindow, shortError } from "../src/core/errors.js";

const hex = (n: number) => randomBytes(n).toString("hex");

describe("error kinds and short text", () => {
  it("names the kind of error", () => {
    assert.equal(errorType(new TypeError("x")), "TypeError");
    assert.equal(errorType(new Error("HTTP request failed: 429 Too Many Requests")), "RateLimit");
    assert.equal(errorType(new Error("the request timed out")), "Timeout");
    assert.equal(errorType(new Error("nonce too low")), "Nonce");
    assert.equal(errorType(new Error("insufficient funds for gas")), "InsufficientFunds");
    assert.equal(errorType(new Error("execution reverted: GateClosed")), "Revert");
    assert.equal(errorType(new Error("something odd")), "Error");
  });

  it("removes URLs, keys and tokens, joins lines and shortens", () => {
    const key = `0x${hex(32)}`;
    const url = `https://rpc.conduit.xyz/v1/${hex(20)}`;
    const token = `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`;
    const scrub = (s: string) => [key, token].reduce((a, v) => a.split(v).join("[redacted]"), s);
    const out = shortError(`failed at ${url} with ${key}\nand ${token} ${"x".repeat(400)}`, scrub);
    assert.ok(!out.includes(url) && !out.includes(key) && !out.includes(token) && !out.includes(url.split("/").pop()!));
    assert.ok(out.includes("[url]") && !out.includes("\n") && out.length <= 140);
  });
});

describe("the error gate", () => {
  it("sends the first, hides repeats inside the hour, and the next alert carries the repeat count", () => {
    const g = emptyErrorGate();
    assert.deepEqual(gateError(g, "keeper|probe send|Revert", 1000), { do: "send", repeats: 0 });
    for (let i = 0; i < 6; i++) assert.deepEqual(gateError(g, "keeper|probe send|Revert", 1100 + i * 60), { do: "suppress" });
    assert.deepEqual(gateError(g, "keeper|probe send|Revert", 1000 + 3601), { do: "send", repeats: 6 });
  });

  it("counts a batch of repeats told together", () => {
    const g = emptyErrorGate();
    gateError(g, "k", 1000);
    gateError(g, "k", 1100, 40);
    assert.deepEqual(gateError(g, "k", 5000), { do: "send", repeats: 40 });
  });

  it("a different kind of error is its own alert", () => {
    const g = emptyErrorGate();
    assert.equal(gateError(g, "keeper|probe send|Revert", 1000).do, "send");
    assert.equal(gateError(g, "keeper|probe send|Nonce", 1001).do, "send");
    assert.equal(gateError(g, "makerA|quote send|Revert", 1002).do, "send");
  });

  it("allows 20 an hour, then one cap notice and silence until the hour is up", () => {
    const g = emptyErrorGate();
    const verdicts = Array.from({ length: 30 }, (_, i) => gateError(g, `r|c${i}|E`, 2000 + i).do);
    assert.equal(verdicts.filter((v) => v === "send").length, MAX_ERRORS_PER_HOUR);
    assert.equal(verdicts.filter((v) => v === "cap-notice").length, 1);
    assert.equal(verdicts.filter((v) => v === "suppress").length, 9);
    assert.equal(gateError(g, "r|new|E", 2000 + 3601).do, "send", "the next hour starts again");
  });
});

describe("the finished-window finder", () => {
  it("returns the latest window that ended at least the grace ago", () => {
    const w = [{ startUtc: "13:00", minutes: 240 }];
    const day = Date.parse("2026-10-27T00:00:00Z") / 1000;
    assert.equal(lastFinishedWindow(w, day + 17 * 3600 + 29 * 60, 1800)!.start, day - 86_400 + 13 * 3600);
    assert.equal(lastFinishedWindow(w, day + 17 * 3600 + 31 * 60, 1800)!.start, day + 13 * 3600);
    assert.equal(lastFinishedWindow([], day, 1800), null);
  });
});

function harness(env: Record<string, string>, over: { failPutOnce?: string } = {}) {
  const m = new Map<string, unknown>();
  let failed = false;
  const st = {
    storage: {
      get: async (k: string) => m.get(k),
      put: async (k: string, v: unknown) => {
        if (over.failPutOnce === k && !failed) {
          failed = true;
          throw new Error(`storage broke for ${env.CONDUIT_RPC_URL}`);
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
  const full = { ...env, SUPERVISOR: ns, ROLE: ns } as unknown as Env;
  return { sup: new Supervisor(st as never, full), m, full };
}
const secrets = () => ({
  TELEGRAM_BOT_TOKEN: `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`,
  TELEGRAM_CHAT_ID: String(Math.floor(1e9 + Math.random() * 9e9)),
  CONDUIT_RPC_URL: `https://rpc.conduit.xyz/v1/${hex(20)}`,
  TREASURY_KEY: `0x${hex(32)}`,
});

describe("error alerts through the supervisor", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let sent: string[] = [];
  let telegramOk = true;
  beforeEach(() => {
    sent = [];
    telegramOk = true;
    Date.now = () => Date.parse("2026-10-27T03:00:00Z");
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        if (!telegramOk) return new Response(`down ${String(url)}`, { status: 502 });
        sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return Response.json({ ok: true });
      }
      throw new Error("an unexpected network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    setRedactor((s) => s);
  });
  const event = (sup: Supervisor, e: object) => sup.fetch(new Request("https://supervisor/event", { method: "POST", body: JSON.stringify(e) }));
  const err = (context: string, type = "Revert", text = "boom", count = 1, role = "keeper") => ({ kind: "error", role, context, type, text, count });

  it("one alert per kind of error per hour, with the repeat count on the next one", async () => {
    const { sup } = harness(secrets());
    for (let i = 0; i < 5; i++) await event(sup, err("probe send"));
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /error in keeper \(probe send, Revert\): boom/);
    assert.ok(!/similar/.test(sent[0]!));
    await event(sup, err("probe send", "Revert", "boom", 30));
    Date.now = () => Date.parse("2026-10-27T04:05:00Z");
    await event(sup, err("probe send"));
    assert.equal(sent.length, 2);
    assert.match(sent[1]!, /\(34 similar error\(s\) since the last alert\)/);
  });

  it("never more than 20 an hour, then one notice", async () => {
    const { sup } = harness(secrets());
    for (let i = 0; i < 40; i++) await event(sup, err(`call ${i}`));
    assert.equal(sent.length, 21);
    assert.equal(sent.filter((t) => /error in keeper/.test(t)).length, 20);
    assert.equal(sent.filter((t) => /20 error alerts have been sent this hour/.test(t)).length, 1);
  });

  it("redacts URLs, keys and tokens, and a role cannot choose its own name or inject text as the role", async () => {
    const s = secrets();
    const { sup } = harness(s);
    await event(sup, err("probe send", "Error", `failed ${s.CONDUIT_RPC_URL} key ${s.TREASURY_KEY} token ${s.TELEGRAM_BOT_TOKEN} chat ${s.TELEGRAM_CHAT_ID} see https://evil.example/x`));
    await event(sup, err("x", "Error", "bad role", 1, "click http://evil.example"));
    for (const t of sent) for (const v of [s.CONDUIT_RPC_URL, s.CONDUIT_RPC_URL.split("/").pop()!, s.TREASURY_KEY, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID, "evil.example"]) assert.ok(!t.includes(v), `leaked ${v.slice(0, 6)}`);
    assert.match(sent[0]!, /\[url\]/);
    assert.match(sent[1]!, /error in a bot/);
  });

  it("an uncaught exception in a tick is reported, and the supervisor carries on", async () => {
    const s = secrets();
    Date.now = () => Date.parse("2026-10-27T03:00:00Z");
    const { sup } = harness(s, { failPutOnce: "lastTickAt" });
    await sup.tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /error in supervisor \(tick, Error\)/);
    assert.ok(!sent[0]!.includes(s.CONDUIT_RPC_URL));
    await sup.tick();
    assert.equal(sent.length, 1, "the next tick ran without a new error");
  });

  it("an uncaught exception in a request returns a plain 500 and reports it", async () => {
    const { sup } = harness(secrets());
    const bad = new Request("https://supervisor/state");
    Object.defineProperty(bad, "url", { get: () => { throw new Error("broken request"); } });
    const res = await sup.fetch(bad);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal error" });
    assert.equal(sent.length, 1);
  });

  it("a failed Telegram send is counted, shown in /health, and the next message that gets through says so", async () => {
    const s = secrets();
    const { sup, m } = harness(s);
    telegramOk = false;
    await event(sup, err("probe send"));
    assert.equal(sent.length, 0);
    const failure = m.get("alertFailures") as { count: number; last: string };
    assert.equal(failure.count, 1);
    assert.ok(!failure.last.includes(s.TELEGRAM_BOT_TOKEN.split(":")[1]!));
    const state = (await (await sup.fetch(new Request("https://supervisor/state"))).json()) as { alertFailures: { count: number } };
    assert.equal(state.alertFailures.count, 1);
    telegramOk = true;
    await event(sup, err("settle send", "Nonce"));
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /1 earlier alert\(s\) could not be sent; the last at \d\d:\d\d:\d\d UTC/);
    assert.equal(m.get("alertFailures"), undefined, "cleared once a message got through");
  });
});

describe("a role reports failed sends and calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => (globalThis.fetch = realFetch));

  it("tells the supervisor of the first at once and batches repeats with a count", async () => {
    const told: Record<string, unknown>[] = [];
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async (_u: string, init?: RequestInit) => { told.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); } }) };
    const st = { storage: { get: async () => undefined, put: async () => undefined, delete: async () => true, setAlarm: async () => undefined, getAlarm: async () => null, deleteAlarm: async () => undefined } };
    const role = new Role(st as never, { SUPERVISOR: ns, ROLE: ns } as unknown as Env);
    const r = role as unknown as { report: (c: string, e: unknown) => void; tells: Promise<void>[]; roleName: string };
    r.roleName = "makerA";
    for (let i = 0; i < 5; i++) r.report("quote send", new Error("nonce too low"));
    await Promise.all(r.tells);
    assert.equal(told.length, 1);
    assert.deepEqual({ ...told[0], text: undefined }, { kind: "error", role: "makerA", context: "quote send", type: "Nonce", text: undefined, count: 1 });
    r.report("quote send", new Error("execution reverted"));
    await Promise.all(r.tells);
    assert.equal(told.length, 2, "a different kind is told at once");
    assert.equal(told[1]!.type, "Revert");
  });
});

describe("the missed-window alert", () => {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let sent: string[] = [];
  const w = Date.parse("2026-10-27T13:00:00Z") / 1000;
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return Response.json({ ok: true });
      }
      throw new Error("an unexpected network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    setRedactor((s) => s);
  });
  const at = (iso: string) => (Date.now = () => Date.parse(iso));

  it("alerts once when the window ended 30 minutes ago and no summary was saved", async () => {
    const { sup, m } = harness(secrets());
    m.set("plumbusdCheckedAt", Math.floor(Date.parse("2026-10-27T17:31:00Z") / 1000));
    m.set("windowTracked", w - 86_400);
    at("2026-10-27T17:29:00Z");
    await sup.tick();
    assert.equal(sent.length, 0, "not yet 30 minutes");
    at("2026-10-27T17:31:00Z");
    await sup.tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /the window 13:00–17:00 UTC ended over 30 minutes ago and no summary was saved/);
    at("2026-10-27T18:40:00Z");
    await sup.tick();
    assert.equal(sent.length, 1, "once per window");
  });

  it("says why when the kill switch is on or the runner is halted", async () => {
    const a = harness(secrets());
    a.m.set("plumbusdCheckedAt", Math.floor(Date.parse("2026-10-27T17:31:00Z") / 1000));
    a.m.set("windowTracked", w - 86_400);
    a.m.set("killed", true);
    at("2026-10-27T17:31:00Z");
    await a.sup.tick();
    assert.match(sent[0]!, /The kill switch is on\./);
    const b = harness(secrets());
    b.m.set("plumbusdCheckedAt", Math.floor(Date.parse("2026-10-27T17:31:00Z") / 1000));
    b.m.set("windowTracked", w - 86_400);
    b.m.set("halt", { kind: "rpc", reason: "balances unreadable", day: "d", windowStart: w, at: w });
    await b.sup.tick();
    assert.match(sent[1]!, /halted \(rpc\): balances unreadable/);
  });

  it("stays quiet when the summary was saved, and on the first run of this version", async () => {
    const saved = harness(secrets());
    saved.m.set("plumbusdCheckedAt", Math.floor(Date.parse("2026-10-27T17:31:00Z") / 1000));
    saved.m.set("windowTracked", w - 86_400);
    saved.m.set("lastSummary", { window: w, at: w + 14_460, figures: null });
    at("2026-10-27T17:31:00Z");
    await saved.sup.tick();
    const first = harness(secrets());
    first.m.set("plumbusdCheckedAt", Math.floor(Date.parse("2026-10-27T17:31:00Z") / 1000));
    await first.sup.tick();
    assert.equal(sent.length, 0);
    assert.equal(first.m.get("windowTracked"), w, "it noted the window without alerting");
  });

  it("a summary that cannot be built is kept, tried again only every five minutes, and reported", async () => {
    const s = secrets();
    const { sup, m } = harness(s);
    m.set("plumbusdCheckedAt", Math.floor(Date.parse("2026-10-27T17:05:00Z") / 1000));
    m.set("windowTracked", w);
    m.set("summaryDue", { start: w, end: w + 4 * 3600 });
    at("2026-10-27T17:02:00Z");
    await sup.tick();
    assert.ok(m.get("summaryDue"), "kept after a failure");
    assert.ok(sent.some((t) => /error in supervisor \(window summary/.test(t)));
    const before = sent.length;
    at("2026-10-27T17:04:00Z");
    await sup.tick();
    assert.equal(sent.length, before, "no retry inside five minutes");
    assert.ok(schedule.windows.length >= 1);
  });
});
