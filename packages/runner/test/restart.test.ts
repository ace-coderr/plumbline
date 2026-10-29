import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { schedule } from "../src/config.js";
import worker from "../src/index.js";
import { Signer, makeClients } from "../src/chain.js";
import type { Env } from "../src/env.js";
import { makeLogger, setRedactor } from "../src/core/log.js";
import { makerTick, newMakerState } from "../src/maker.js";
import { Role } from "../src/role.js";
import { Supervisor } from "../src/supervisor.js";
import { MAX_BUCKETS, SLOW_MS, recordAlarm, summarizeAlarms, type AlarmBucket } from "../src/core/alarmlog.js";
import { restartLine } from "../src/core/alerts.js";

const hex = (n: number) => randomBytes(n).toString("hex");
const SET_QUOTE = "0x19e10203";
const CANCEL = "0xea8a1af0";

function fakeState() {
  const m = new Map<string, unknown>();
  let failGet: string | null = null;
  return {
    m,
    failGetOnce: (k: string) => void (failGet = k),
    st: {
      storage: {
        get: async (k: string) => {
          if (failGet === k) {
            failGet = null;
            throw new Error(`storage failed for https://rpc.example/${hex(8)} ${hex(16)}`);
          }
          return m.get(k);
        },
        put: async (k: string, v: unknown) => void m.set(k, v),
        delete: async (k: string) => m.delete(k),
        setAlarm: async () => undefined,
        getAlarm: async () => null,
        deleteAlarm: async () => undefined,
      },
    },
  };
}

describe("a restarted maker starts at its first tick: it polls the price and quotes, it does not cancel", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => (globalThis.fetch = realFetch));

  const aggAbi = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
  const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  function network() {
    const raws: Hex[] = [];
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string; type?: string; params?: unknown[] };
      if (body.type === "allMids") return Response.json({ HYPE: "25.5" });
      const ok = (r: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result: r });
      switch (body.method) {
        case "eth_getTransactionCount": return ok("0x10");
        case "eth_gasPrice": return ok("0x5f5e100");
        case "eth_sendRawTransaction": raws.push(String(body.params![0]) as Hex); return ok(`0x${"ab".repeat(32)}`);
        case "eth_call": {
          const { args } = decodeFunctionData({ abi: aggAbi, data: (body.params![0] as { data: Hex }).data });
          const n = (args[0] as unknown as unknown[]).length;
          return ok(encodeFunctionResult({ abi: aggAbi, functionName: "aggregate3", result: Array.from({ length: n }, () => ({ success: true, returnData: uint(10n ** 21n) })) }));
        }
        default: return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
      }
    }) as typeof fetch;
    return raws;
  }

  it("boot restores the counts but not the tick counter, and the first tick sends a quote", async () => {
    const raws = network();
    const { st, m } = fakeState();
    m.set("cfg", { role: "makerA", runId: 77, windowEnd: Math.floor(Date.now() / 1000) + 3600, running: true, startedAt: 1 });
    // An odd tick count saved before the restart: the case that used to skip the price poll.
    m.set("stats", { runId: 77, role: "makerA", keeper: { probesSent: 0, probesLanded: 0, probesReverted: 0, settles: 0, sendsFailed: 0, failed: 0, pending: [] }, maker: { ticks: 4321, sent: 4000, failed: 3 }, restarts: [] });
    const sup = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
    const role = new Role(st as never, { SUPERVISOR: sup, ROLE: sup } as unknown as Env);
    const priv = role as unknown as { onBoot: (c: unknown) => Promise<void>; maker: ReturnType<typeof newMakerState> };
    await priv.onBoot(m.get("cfg"));
    assert.equal(priv.maker.ticks, 0, "the tick counter starts again");
    assert.equal(priv.maker.sent, 4000, "the counts are back");
    assert.equal(priv.maker.failed, 3);

    const clients = makeClients();
    const ctx = { vault: schedule.vaults.a, settings: schedule.maker.A, referenceCoin: schedule.referenceCoin, signer: new Signer(privateKeyToAccount(generatePrivateKey()), clients), client: clients[0]!, state: priv.maker, log: makeLogger((s) => s, () => undefined) };
    await makerTick(ctx);
    assert.equal(raws.length, 1);
    assert.equal(parseTransaction(raws[0]!).data!.slice(0, 10), SET_QUOTE, "a quote, not a cancel");
    assert.equal(priv.maker.cancelled, false);
  });

  it("with the old behaviour (ticks restored) the first tick would have cancelled: the check can fail", async () => {
    const raws = network();
    const state = newMakerState();
    state.ticks = 4321; // restored from a save
    const clients = makeClients();
    await makerTick({ vault: schedule.vaults.a, settings: schedule.maker.A, referenceCoin: schedule.referenceCoin, signer: new Signer(privateKeyToAccount(generatePrivateKey()), clients), client: clients[0]!, state, log: makeLogger((s) => s, () => undefined) });
    assert.equal(parseTransaction(raws[0]!).data!.slice(0, 10), CANCEL, "this is the bug the fix removes");
  });
});

describe("every restart is recorded and listed", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let telegram: string[] = [];
  beforeEach(() => {
    telegram = [];
    Date.now = () => Date.parse("2026-10-28T14:00:00Z");
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
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
  const env = () => ({ TELEGRAM_BOT_TOKEN: `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`, TELEGRAM_CHAT_ID: String(Math.floor(1e9 + Math.random() * 9e9)) });
  function sup(over: Record<string, unknown> = {}) {
    const { st, m } = fakeState();
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) };
    return { s: new Supervisor(st as never, { ...env(), ...over, SUPERVISOR: ns, ROLE: ns } as unknown as Env), m };
  }
  const event = (s: Supervisor, e: object) => s.fetch(new Request("https://supervisor/event", { method: "POST", body: JSON.stringify(e) }));
  const at = (iso: string) => Date.parse(iso) / 1000;

  it("all restarts go in the log, while the alert stays one an hour per bot", async () => {
    const { s, m } = sup();
    for (const t of ["13:34:08", "14:09:20", "14:30:00"]) await event(s, { kind: "restarted", role: "makerA", at: at(`2026-10-28T${t}Z`) });
    await event(s, { kind: "restarted", role: "keeper", at: at("2026-10-28T14:11:34Z") });
    assert.equal((m.get("restartLog") as unknown[]).length, 4, "every one is recorded");
    assert.equal(telegram.filter((t) => /makerA bot restarted/.test(t)).length, 1, "one alert per hour per bot");
    assert.equal(telegram.filter((t) => /keeper bot restarted/.test(t)).length, 1);
  });

  it("the window's list merges the supervisor's log with what the bots saved, once each, and only this window's", async () => {
    const { s, m } = sup();
    const due = { start: at("2026-10-28T13:00:00Z"), end: at("2026-10-28T17:00:00Z") };
    m.set("restartLog", [
      { role: "makerA", at: at("2026-10-28T13:34:08Z") },
      { role: "makerA", at: at("2026-10-28T14:09:20Z") },
      { role: "makerB", at: at("2026-10-27T15:00:00Z") },
    ]);
    const states = {
      makerA: { saved: { runId: due.start, keeper: { probesSent: 0, probesLanded: 0, probesReverted: 0 }, restarts: [at("2026-10-28T13:34:09Z"), at("2026-10-28T15:02:35Z")] } },
      keeper: { saved: { runId: due.start, keeper: { probesSent: 0, probesLanded: 0, probesReverted: 0 }, restarts: [at("2026-10-28T14:11:34Z")] } },
      makerB: { saved: { runId: due.start - 86_400, keeper: { probesSent: 0, probesLanded: 0, probesReverted: 0 }, restarts: [at("2026-10-27T15:00:00Z")] } },
    };
    const list = await (s as unknown as { windowRestarts: (d: typeof due, st: typeof states) => Promise<{ role: string; at: number }[]> }).windowRestarts(due, states);
    assert.deepEqual(list.map((r) => `${r.role} ${new Date(r.at * 1000).toISOString().slice(11, 19)}`), ["makerA 13:34:08", "makerA 14:09:20", "keeper 14:11:34", "makerA 15:02:35"]);
  });

  it("the summary line lists every restart by bot, or says there were none", () => {
    assert.equal(restartLine([]), "Bot restarts in the window: none.");
    const l = restartLine([
      { role: "makerA", at: at("2026-10-28T13:34:08Z") },
      { role: "keeper", at: at("2026-10-28T14:11:34Z") },
      { role: "makerA", at: at("2026-10-28T15:02:35Z") },
    ]);
    assert.equal(l, "Bot restarts in the window (3): makerA 13:34:08, 15:02:35; keeper 14:11:34 UTC.");
  });
});

describe("the fall back alert", () => {
  const realFetch = globalThis.fetch;
  let telegram: string[] = [];
  beforeEach(() => {
    telegram = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return Response.json({ ok: true });
      }
      throw new Error("an unexpected network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setRedactor((s) => s);
  });

  it("a bot's signer reports a move to another node, by name only, and the supervisor alerts once an hour per bot", async () => {
    const told: Record<string, unknown>[] = [];
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async (_u: string, init?: RequestInit) => { told.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); } }) };
    const { st } = fakeState();
    const priv = `https://rpc.conduit.xyz/v1/${hex(20)}`;
    const role = new Role(st as never, { SUPERVISOR: ns, ROLE: ns, CONDUIT_RPC_URL: priv } as unknown as Env);
    const r = role as unknown as { clients: unknown; roleName: string; tells: Promise<void>[]; signerOptions: (c: unknown[]) => { names: string[]; onFallback: (e: unknown) => void } };
    r.roleName = "makerB";
    const clients = makeClients(priv);
    r.clients = clients; // the bot's own node list, as it builds it
    const opts = r.signerOptions(clients);
    assert.deepEqual(opts.names, ["private node", "public node (Elysium)", "public node (Conduit)"]);
    opts.onFallback({ from: 0, to: 1, failure: "transient", type: "Network" });
    await Promise.all(r.tells);
    assert.deepEqual(told[0], { kind: "send-fallback", role: "makerB", from: "private node", to: "public node (Elysium)", failure: "transient", type: "Network" });
    assert.ok(!JSON.stringify(told).includes(priv.split("/").pop()!));

    const { st: st2 } = fakeState();
    const sup = new Supervisor(st2 as never, { TELEGRAM_BOT_TOKEN: `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`, TELEGRAM_CHAT_ID: "123456789", SUPERVISOR: ns, ROLE: ns } as unknown as Env);
    const send = (e: object) => sup.fetch(new Request("https://supervisor/event", { method: "POST", body: JSON.stringify(e) }));
    await send(told[0]!);
    await send(told[0]!);
    await send({ ...told[0], role: "makerA" });
    assert.equal(telegram.length, 2, "once per bot");
    assert.match(telegram[0]!, /makerB's sends moved from the private node to the public node \(Elysium\) after a Network error/);
  });
});

describe("the rolling alarm record", () => {
  it("counts alarms by minute, notes slow and failed ones, and asks to be saved when it matters", () => {
    const b: AlarmBucket[] = [];
    assert.deepEqual(recordAlarm(b, 6000, 120, 5, "ok"), { rolled: false, urgent: false });
    assert.deepEqual(recordAlarm(b, 6010, 400, 900, "ok"), { rolled: false, urgent: false });
    assert.deepEqual(recordAlarm(b, 6020, SLOW_MS + 1, 0, "ok"), { rolled: false, urgent: true });
    assert.deepEqual(recordAlarm(b, 6030, 80, 0, "Timeout"), { rolled: false, urgent: true });
    assert.deepEqual(recordAlarm(b, 6065, 90, 0, "ok"), { rolled: true, urgent: false });
    assert.equal(b.length, 2);
    assert.deepEqual({ ...b[0], types: b[0]!.types }, { m: 6000, n: 4, err: 1, slow: 1, maxMs: SLOW_MS + 1, sumMs: 120 + 400 + SLOW_MS + 1 + 80, maxLateMs: 900, types: { Timeout: 1 } });
  });

  it("a bot can set its own slow limit, and the record keeps only the last two hours", () => {
    const b: AlarmBucket[] = [];
    assert.equal(recordAlarm(b, 100, 3500, 0, "ok", 6000).urgent, false, "a 3.5 s keeper burst is normal");
    assert.equal(recordAlarm(b, 100, 6500, 0, "ok", 6000).urgent, true);
    for (let i = 0; i < MAX_BUCKETS + 30; i++) recordAlarm(b, 1000 + i * 60, 10, 0, "ok");
    assert.equal(b.length, MAX_BUCKETS);
  });

  it("summarises a recent stretch", () => {
    const b: AlarmBucket[] = [];
    for (let i = 0; i < 10; i++) recordAlarm(b, 6000 + i * 60, 100 + i, 10 * i, i === 3 ? "Revert" : "ok");
    const s = summarizeAlarms(b, 6000 + 9 * 60 + 30, 5);
    assert.equal(s.alarms, 6, "the last five minutes and the part-minute they start in");
    assert.equal(s.errors, 0, "the failure was outside the last five minutes");
    assert.equal(summarizeAlarms(b, 6000 + 9 * 60 + 30, 60).errors, 1);
    assert.deepEqual(summarizeAlarms(b, 6000 + 9 * 60 + 30, 60).types, { Revert: 1 });
  });

  it("a bot's failed alarm is recorded and saved at once, with the kind of error and none of its text", async () => {
    const { st, m, failGetOnce } = fakeState();
    m.set("cfg", { role: "makerA", runId: 5, windowEnd: Math.floor(Date.now() / 1000) + 3600, running: true, startedAt: 1 });
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true, run: true }) }) };
    const role = new Role(st as never, { SUPERVISOR: ns, ROLE: ns } as unknown as Env);
    failGetOnce("stats");
    await role.alarm();
    const saved = m.get("diag") as AlarmBucket[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.n, 1);
    assert.equal(saved[0]!.err, 1);
    assert.deepEqual(Object.keys(saved[0]!.types), ["Error"]);
    const text = JSON.stringify(saved);
    assert.ok(!/rpc\.example|storage failed/.test(text), "no message text, no URL");
  });

  it("the supervisor records its ticks, and the admin route returns the record without secrets", async () => {
    const realNow = Date.now;
    Date.now = () => Date.parse("2026-10-28T03:00:00Z");
    try {
      const { st, m } = fakeState();
      m.set("plumbusdCheckedAt", Math.floor(Date.now() / 1000) + 86_400);
      m.set("windowTracked", Math.floor(Date.now() / 1000));
      const admin = hex(32);
      const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ buckets: [] }) }) };
      const env = { ADMIN_TOKEN: admin, SUPERVISOR: ns, ROLE: ns } as unknown as Env;
      const sup = new Supervisor(st as never, env);
      await sup.tick();
      await sup.tick();
      const body = (await (await sup.fetch(new Request("https://supervisor/diag", { method: "POST" }))).json()) as { supervisor: AlarmBucket[]; roles: Record<string, unknown> };
      assert.equal(body.supervisor[0]!.n, 2);
      assert.deepEqual(Object.keys(body.roles).sort(), ["keeper", "makerA", "makerB"]);
      const state = (await (await sup.fetch(new Request("https://supervisor/state"))).json()) as { alarms: { alarms: number } };
      assert.equal(state.alarms.alarms, 2);
      // From outside, it needs the admin token.
      const bad = await worker.fetch(new Request("https://runner/diag", { method: "POST" }), env);
      assert.equal(bad.status, 401);
      const get = await worker.fetch(new Request("https://runner/diag"), env);
      assert.equal(get.status, 404);
      assert.ok(!JSON.stringify(body).includes(admin));
    } finally {
      Date.now = realNow;
      setRedactor((s) => s);
    }
  });
});

describe("the admin token in the request body", () => {
  it("works from the body or the header, and a wrong one is refused either way", async () => {
    const token = hex(32);
    const calls: string[] = [];
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async (u: string) => { calls.push(u); return Response.json({ ok: true }); } }) };
    const env = { ADMIN_TOKEN: token, SUPERVISOR: ns, ROLE: ns } as unknown as Env;
    const post = (init: RequestInit) => worker.fetch(new Request("https://runner/tick", { method: "POST", ...init }), env);
    assert.equal((await post({ body: JSON.stringify({ token }), headers: { "content-type": "application/json" } })).status, 200);
    assert.equal((await post({ headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await post({ body: JSON.stringify({ token: "nope" }) })).status, 401);
    assert.equal((await post({ headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await post({ body: "not json" })).status, 401);
    assert.equal((await post({})).status, 401);
    assert.equal(calls.length, 2);
  });
});
