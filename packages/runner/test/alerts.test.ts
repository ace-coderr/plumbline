import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { Supervisor } from "../src/supervisor.js";
import { redactorFor, secretValues, SECRET_NAMES, type Env } from "../src/env.js";
import { gate, msg, prune, sendTelegram } from "../src/core/alerts.js";
import { errText, makeLogger, safeJson, setRedactor } from "../src/core/log.js";
import worker from "../src/index.js";
import { schedule } from "../src/config.js";

const hex = (n: number) => randomBytes(n).toString("hex");
const secrets = () => ({
  TREASURY_KEY: generatePrivateKey(),
  TELEGRAM_BOT_TOKEN: `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`,
  TELEGRAM_CHAT_ID: String(Math.floor(1e9 + Math.random() * 9e9)),
  CONDUIT_RPC_URL: `https://rpc.conduit.xyz/v1/${hex(20)}`,
  ADMIN_TOKEN: hex(32),
});

describe("alert rate limiting", () => {
  it("the same alert is sent once in the repeat window, again after it, and other alerts are independent", () => {
    const g: Record<string, number> = {};
    assert.equal(gate(g, "kill", 1000, 60), true);
    assert.equal(gate(g, "kill", 1000 + 59 * 60, 60), false);
    assert.equal(gate(g, "treasury-low", 1000 + 60, 60), true);
    assert.equal(gate(g, "kill", 1000 + 60 * 60, 60), true);
  });

  it("a hammered alert is sent once however often it fires", () => {
    const g: Record<string, number> = {};
    let sent = 0;
    for (let i = 0; i < 500; i++) if (gate(g, "halt:rpc", 5000 + i * 5, 60)) sent += 1;
    assert.equal(sent, 1);
  });

  it("forgets entries older than a day", () => {
    assert.deepEqual(Object.keys(prune({ a: 0, b: 90_000 }, 100_000)), ["b"]);
  });
});

describe("Telegram", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setRedactor((s) => s);
  });

  it("sends only to the configured chat id, with the text redacted", async () => {
    const s = secrets();
    const seen: { url: string; body: { chat_id: string; text: string } }[] = [];
    const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const redact = redactorFor(s as unknown as Env);
    const r = await sendTelegram({ token: s.TELEGRAM_BOT_TOKEN, chatId: s.TELEGRAM_CHAT_ID }, `halted: could not read ${s.CONDUIT_RPC_URL} with ${s.TREASURY_KEY} for ${s.TELEGRAM_CHAT_ID}`, redact, fake);
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.body.chat_id, s.TELEGRAM_CHAT_ID);
    for (const v of [s.CONDUIT_RPC_URL, s.TREASURY_KEY, s.TREASURY_KEY.slice(2), s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID, hex(20)]) assert.ok(!seen[0]!.body.text.includes(v));
    assert.ok(seen[0]!.url.startsWith("https://api.telegram.org/bot"), "only Telegram is called");
  });

  it("a failing or unreachable Telegram returns an error with no token or chat id in it, and does not throw", async () => {
    const s = secrets();
    const redact = redactorFor(s as unknown as Env);
    for (const fake of [
      (async (url: RequestInfo | URL) => {
        throw new Error(`getaddrinfo failed for ${String(url)} chat ${s.TELEGRAM_CHAT_ID}`);
      }) as typeof fetch,
      (async (url: RequestInfo | URL) => new Response(`bad ${String(url)}`, { status: 401 })) as typeof fetch,
    ]) {
      const r = await sendTelegram({ token: s.TELEGRAM_BOT_TOKEN, chatId: s.TELEGRAM_CHAT_ID }, "x", redact, fake);
      assert.equal(r.ok, false);
      const text = JSON.stringify(r);
      assert.ok(!text.includes(s.TELEGRAM_BOT_TOKEN) && !text.includes(s.TELEGRAM_CHAT_ID) && !text.includes(s.TELEGRAM_BOT_TOKEN.split(":")[1]!));
    }
  });

  it("sends nothing when the token or the chat id is missing", async () => {
    let calls = 0;
    const fake = (async () => void (calls += 1)) as unknown as typeof fetch;
    assert.equal((await sendTelegram({ token: undefined, chatId: "1" }, "x", (t) => t, fake)).ok, false);
    assert.equal((await sendTelegram({ token: "t", chatId: undefined }, "x", (t) => t, fake)).ok, false);
    assert.equal(calls, 0);
  });
});

/** An in-memory Durable Object storage, and a role namespace that always answers. */
function harness(env: Record<string, string>) {
  const m = new Map<string, unknown>();
  const st = {
    storage: {
      get: async (k: string) => m.get(k),
      put: async (k: string, v: unknown) => void m.set(k, v),
      delete: async (k: string) => m.delete(k),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
      deleteAlarm: async () => undefined,
    },
  };
  const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ running: false }) }) };
  const full = { ...env, SUPERVISOR: ns, ROLE: ns } as unknown as Env;
  return { sup: new Supervisor(st as never, full), full, m };
}

describe("alerts through the supervisor", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let telegram: { chat_id: string; text: string }[] = [];
  beforeEach(() => {
    telegram = [];
    Date.now = () => Date.parse("2026-10-27T03:00:00Z");
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        telegram.push(JSON.parse(String(init?.body)));
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

  it("the kill switch alerts once however many times it is used inside the hour, and /resume alerts too", async () => {
    const s = secrets();
    const { sup } = harness(s);
    for (let i = 0; i < 4; i++) await sup.fetch(new Request("https://supervisor/kill", { method: "POST" }));
    assert.equal(telegram.filter((t) => /kill switch was used/.test(t.text)).length, 1);
    await sup.fetch(new Request("https://supervisor/resume", { method: "POST" }));
    assert.equal(telegram.filter((t) => /resume was used/.test(t.text)).length, 1);
    assert.ok(telegram.every((t) => t.chat_id === s.TELEGRAM_CHAT_ID));
  });

  it("parallel events do not slip two copies of one alert through", async () => {
    const s = secrets();
    const { sup } = harness(s);
    await Promise.all(Array.from({ length: 12 }, () => sup.fetch(new Request("https://supervisor/event", { method: "POST", body: JSON.stringify({ kind: "fallback", role: "keeper" }) }))));
    assert.equal(telegram.length, 1);
  });

  it("a bot that ended badly alerts, with the secret in its reason redacted; a normal end does not", async () => {
    const s = secrets();
    const { sup } = harness(s);
    const ev = (e: object) => sup.fetch(new Request("https://supervisor/event", { method: "POST", body: JSON.stringify(e) }));
    await ev({ kind: "ended", role: "makerA", reason: "the supervisor said stop" });
    assert.equal(telegram.length, 0);
    await ev({ kind: "ended", role: "makerA", reason: `error: failed at ${s.CONDUIT_RPC_URL} using ${s.TREASURY_KEY}` });
    assert.equal(telegram.length, 1);
    assert.ok(/ended early/.test(telegram[0]!.text));
    for (const v of [s.CONDUIT_RPC_URL, s.TREASURY_KEY, s.TELEGRAM_BOT_TOKEN]) assert.ok(!telegram[0]!.text.includes(v));
  });

  it("an event with a role name that is not one of ours cannot put its own text into an alert", async () => {
    const s = secrets();
    const { sup } = harness(s);
    await sup.fetch(new Request("https://supervisor/event", { method: "POST", body: JSON.stringify({ kind: "ended", role: "click http://evil.example", reason: "boom" }) }));
    assert.ok(!telegram[0]!.text.includes("evil.example"));
  });

  it("the alert test endpoint reports success or a scrubbed failure", async () => {
    const s = secrets();
    const { sup } = harness(s);
    const ok = (await (await sup.fetch(new Request("https://supervisor/alert-test", { method: "POST" }))).json()) as { ok: boolean };
    assert.equal(ok.ok, true);
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      throw new Error(`down: ${String(url)}`);
    }) as typeof fetch;
    const bad = await (await sup.fetch(new Request("https://supervisor/alert-test", { method: "POST" }))).text();
    assert.ok(!bad.includes(s.TELEGRAM_BOT_TOKEN) && !bad.includes(s.TELEGRAM_BOT_TOKEN.split(":")[1]!));
  });

  it("low PLUMBUSD at the faucet or the sponsor alerts once an hour; healthy balances do not", async () => {
    Date.now = () => Date.parse("2026-10-27T03:00:00Z");
    const s = secrets();
    const balances = { faucet: 19_999_000_000n, sponsor: 1_999_000_000n };
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        telegram.push(JSON.parse(String(init?.body)));
        return Response.json({ jsonrpc: "2.0", ok: true });
      }
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: { data?: string }[] };
      if (body.method !== "eth_call") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
      const arg = String(body.params[0]?.data ?? "").toLowerCase();
      const v = arg.includes(schedule.wallets.sponsor!.slice(2).toLowerCase()) ? balances.sponsor : balances.faucet;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: `0x${v.toString(16).padStart(64, "0")}` });
    }) as typeof fetch;
    const { sup, m } = harness(s);
    await sup.tick();
    assert.equal(telegram.filter((t) => /faucet pool holds 19,999/.test(t.text)).length, 1);
    assert.equal(telegram.filter((t) => /sponsor wallet holds 1,999/.test(t.text)).length, 1);
    m.set("plumbusdCheckedAt", 0);
    await sup.tick();
    assert.equal(telegram.length, 2, "the same alerts are not repeated inside the hour");
    telegram = [];
    balances.faucet = 500_000_000_000n;
    balances.sponsor = 501_000_000_000n;
    const fresh = harness(secrets());
    await fresh.sup.tick();
    assert.equal(telegram.length, 0);
  });

  it("two ticks at once run one: the second never touches the chain", async () => {
    Date.now = () => Date.parse("2026-10-27T13:30:00Z");
    const s = secrets();
    const { sup } = harness(s);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await hold;
      throw new Error("down");
    }) as typeof fetch;
    const first = sup.tick();
    await new Promise((r) => setTimeout(r, 20));
    const before = calls;
    assert.ok(before > 0, "the first tick is reading the chain");
    await sup.tick();
    assert.equal(calls, before, "the second tick did nothing");
    release();
    await first;
  });
});

describe("secrets never leave in any response", () => {
  it("every secret is in the redactor's list, in its raw form", () => {
    const s = secrets();
    const needles = secretValues(s as unknown as Env);
    for (const v of [s.TREASURY_KEY, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID, s.CONDUIT_RPC_URL]) assert.ok(needles.includes(v), "the value is a needle");
    for (const n of ["TREASURY_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "CONDUIT_RPC_URL"]) assert.ok((SECRET_NAMES as readonly string[]).includes(n));
  });

  it("logs, JSON responses, /health, errors and the supervisor report carry none of them", async () => {
    const s = secrets();
    const env = s as unknown as Env;
    setRedactor(redactorFor(env));
    const all = [s.TREASURY_KEY, s.TREASURY_KEY.slice(2), s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_BOT_TOKEN.split(":")[1]!, s.TELEGRAM_CHAT_ID, s.CONDUIT_RPC_URL, s.CONDUIT_RPC_URL.split("/").pop()!];
    const dirty = `err ${all.join(" | ")} ${all.map(encodeURIComponent).join(" ")}`;
    const lines: string[] = [];
    makeLogger(redactorFor(env), (l) => lines.push(l)).warn("x", { err: new Error(dirty), dirty });
    const out = [lines.join("\n"), errText(new Error(dirty)), await safeJson({ reason: dirty }).text()];
    const { sup, m } = harness(s);
    m.set("halt", { kind: "rpc", reason: dirty, day: "d", windowStart: 1, at: 1 });
    m.set("topUpError", { at: 1, wallet: "keeper", reason: dirty });
    m.set("topUpNote", { at: 1, note: dirty, sent: 0 });
    m.set("campaignNote", dirty);
    out.push(await (await sup.fetch(new Request("https://supervisor/state"))).text());
    const { full } = harness(s);
    out.push(await (await worker.fetch(new Request("https://runner/health"), full)).text());
    out.push(await (await worker.fetch(new Request("https://runner/topup-test?wallet=keeper&hype=0.0001", { method: "POST", headers: { authorization: `Bearer ${dirty}` } }), full)).text());
    for (const text of out) for (const v of all) assert.ok(!text.includes(v), `a secret appeared: ${v.slice(0, 4)}…`);
  });

  it("the admin-only routes refuse a missing or wrong token", async () => {
    const s = secrets();
    const { full } = harness(s);
    for (const path of ["/kill", "/resume", "/tick", "/alert-test", "/topup-plan", "/topup-test?wallet=keeper&hype=0.0001"]) {
      for (const headers of [{} as Record<string, string>, { authorization: "Bearer nope" }]) {
        const res = await worker.fetch(new Request(`https://runner${path}`, { method: "POST", headers }), full);
        assert.equal(res.status, 401, path);
      }
      assert.equal((await worker.fetch(new Request(`https://runner${path}`), full)).status, 404, `${path} by GET`);
    }
  });

  it("source: the new secrets are read in one place each and never put in a log, a response or an error", () => {
    const dir = decodeURIComponent(new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const t = readFileSync(dir + f, "utf8");
      for (const name of ["TREASURY_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DEPLOYER"]) {
        if (!t.includes(name)) continue;
        assert.ok(!/(log|logger)\.\w+\([^)]*\b(TREASURY_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\b/.test(t), `${f} logs ${name}`);
        assert.ok(!/(json|Response|safeJson)\([^)]*\b(TREASURY_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\b/.test(t), `${f} returns ${name}`);
        assert.ok(!/Error\(`[^`]*\$\{[^}]*(TREASURY_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)/.test(t), `${f} puts ${name} in an error`);
        assert.ok(name !== "DEPLOYER" || f === "env.ts", `${f} mentions the deployer key`);
      }
    }
  });
});

void msg;
