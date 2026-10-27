import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Supervisor } from "../src/supervisor.js";
import { accountFor, type Env } from "../src/env.js";
import { schedule } from "../src/config.js";

/** An in-memory Durable Object storage and role namespace, so the supervisor can run without a network. */
function fakeState() {
  const m = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void m.set(k, v),
      delete: async (k: string) => m.delete(k),
      setAlarm: async (t: number | Date) => void (alarm = Number(t)),
      getAlarm: async () => alarm,
      deleteAlarm: async () => void (alarm = null),
    },
    map: m,
  };
}

function fakeEnv() {
  const calls: string[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: (id: unknown) => ({
      fetch: async (url: string | Request) => {
        calls.push(`${String(id)} ${typeof url === "string" ? url : url.url}`);
        return Response.json({ running: false });
      },
    }),
  };
  const env = { SUPERVISOR: ns, ROLE: ns, ADMIN_TOKEN: "t" } as unknown as Env;
  return { env, calls };
}

const realFetch = globalThis.fetch;
const realNow = Date.now;
let networkCalls = 0;
beforeEach(() => {
  networkCalls = 0;
  // 03:00 UTC: outside the shipped 13:00 window, whatever time the tests really run.
  Date.now = () => Date.parse("2026-10-27T03:00:00Z");
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("the supervisor touched the network");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

describe("supervisor as shipped, outside its window", () => {
  it("has one window and it is not 03:00 UTC", () => {
    assert.equal(schedule.windows.length, 1);
  });

  it("a tick makes no network call and starts nothing", async () => {
    const st = fakeState();
    // The twice-an-hour PLUMBUSD check is covered in alerts.test.ts; here it is marked as just done.
    st.map.set("plumbusdCheckedAt", Math.floor(Date.now() / 1000));
    const { env, calls } = fakeEnv();
    const s = new Supervisor(st as never, env);
    await s.tick();
    assert.equal(networkCalls, 0);
    assert.equal(calls.filter((c) => c.includes("/start")).length, 0);
    assert.equal(st.map.get("rolesRunning"), undefined);
    assert.equal(await st.storage.getAlarm(), null, "no alarm is kept when there is nothing to do");
    assert.deepEqual(st.map.get("lastDecision"), { action: "idle", reason: "outside the scheduled windows" });
  });

  it("the kill switch stops every role, persists, and answers should-run with no", async () => {
    const st = fakeState();
    // The twice-an-hour PLUMBUSD check is covered in alerts.test.ts; here it is marked as just done.
    st.map.set("plumbusdCheckedAt", Math.floor(Date.now() / 1000));
    const { env, calls } = fakeEnv();
    const s = new Supervisor(st as never, env);
    const r = await s.fetch(new Request("https://supervisor/kill", { method: "POST" }));
    assert.equal(((await r.json()) as { killed: boolean }).killed, true);
    assert.equal(st.map.get("killed"), true);
    assert.deepEqual(calls.filter((c) => c.includes("/stop")).map((c) => c.split(" ")[0]).sort(), ["keeper", "makerA", "makerB"]);
    const q = await s.fetch(new Request("https://supervisor/should-run?runId=1"));
    assert.equal(((await q.json()) as { run: boolean }).run, false);
    await s.tick();
    assert.equal(networkCalls, 0);
    const back = await s.fetch(new Request("https://supervisor/resume", { method: "POST" }));
    assert.equal(((await back.json()) as { killed: boolean }).killed, false);
  });

  it("reports its state without any secret", async () => {
    const st = fakeState();
    // The twice-an-hour PLUMBUSD check is covered in alerts.test.ts; here it is marked as just done.
    st.map.set("plumbusdCheckedAt", Math.floor(Date.now() / 1000));
    const { env } = fakeEnv();
    const body = JSON.stringify(await (await new Supervisor(st as never, env).fetch(new Request("https://supervisor/state"))).json());
    assert.ok(!body.includes("\"t\""), "no admin token in the report");
    assert.match(body, /"enabled":true/);
  });
});

describe("keys are checked against the schedule", () => {
  const key = "0x" + "11".repeat(32);
  it("refuses a malformed key without echoing it", () => {
    assert.throws(() => accountFor({ KEEPER_KEY: "not-a-key" } as unknown as Env, "keeper", schedule), (e: Error) => /not a 32-byte hex/.test(e.message) && !e.message.includes("not-a-key"));
  });
  it("refuses a key that is not the wallet's, naming neither key", () => {
    assert.throws(() => accountFor({ KEEPER_KEY: key } as unknown as Env, "keeper", schedule), (e: Error) => /does not belong to wallets\.keeper/.test(e.message) && !e.message.includes(key.slice(2)));
  });
  it("asks for the address when the wallet is not listed yet", () => {
    assert.throws(() => accountFor({ SPONSOR_KEY: key } as unknown as Env, "sponsor", { ...schedule, wallets: { ...schedule.wallets, sponsor: null } }), /wallets\.sponsor is null/);
  });
  it("returns null when no secret is set", () => {
    assert.equal(accountFor({} as unknown as Env, "keeper", schedule), null);
  });
});
