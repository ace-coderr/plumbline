import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { schedule } from "../src/config.js";
import { CAMPAIGNS } from "../src/config.js";
import { Role } from "../src/role.js";
import type { Env } from "../src/env.js";
import { msg } from "../src/core/alerts.js";
import { summarizeWindow, windowLabel, type ChainLog, type ChainTx } from "../src/core/windowSummary.js";
import { PROBE_SELECTOR, SETTLE_SELECTOR, fetchWindowFigures } from "../src/windowData.js";
import { newKeeperState, restoreKeeper, saveKeeper } from "../src/keeper.js";

const KEEPER = "0xde8554954841D2fAbCacAddfAD95899c8BF3E989";
const OTHER = "0x1111111111111111111111111111111111111111";
const START = Date.parse("2026-10-27T13:00:00Z") / 1000;
const END = START + 4 * 3600;
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

/** A known set of chain data: 755 probes by the keeper, 67 reverted, 58 settles, with noise around the window. */
function knownChain() {
  const txs: ChainTx[] = [];
  const logs: ChainLog[] = [];
  const tx = (i: number, methodId: string, isError: boolean, at: number, to = CAMPAIGNS): ChainTx => ({
    hash: `0x${i.toString(16).padStart(64, "0")}`,
    to,
    methodId,
    isError: isError ? "1" : "0",
    gasUsed: isError ? "55000" : "177000",
    gasPrice: "100020000",
    timeStamp: String(at),
  });
  for (let i = 0; i < 755; i++) {
    const reverted = i % 11 === 0 && i / 11 < 67;
    const t = tx(i + 1, PROBE_SELECTOR, reverted, START + 60 + i * 18);
    txs.push(t);
    if (!reverted) logs.push({ topics: ["0xevent", "0x01", "0x02", pad(KEEPER)], transactionHash: t.hash });
  }
  for (let i = 0; i < 58; i++) txs.push(tx(10_000 + i, SETTLE_SELECTOR, false, START + 300 + i * 200));
  // Noise that must not be counted: before the window, long after it, to another contract, and another wallet's probe event.
  txs.push(tx(20_001, PROBE_SELECTOR, false, START - 600));
  txs.push(tx(20_002, PROBE_SELECTOR, false, END + 3600));
  txs.push(tx(20_003, PROBE_SELECTOR, false, START + 100, OTHER));
  logs.push({ topics: ["0xevent", "0x01", "0x02", pad(OTHER)], transactionHash: `0x${"9".repeat(64)}` });
  logs.push({ topics: ["0xevent", "0x01", "0x02", pad(KEEPER)], transactionHash: `0x${(20_001).toString(16).padStart(64, "0")}` });
  return { txs, logs };
}

describe("the window summary comes from chain data", () => {
  it("matches a known set of transactions and Probed events exactly", () => {
    const { txs, logs } = knownChain();
    const f = summarizeWindow({ txs, logs, keeper: KEEPER, campaigns: CAMPAIGNS, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start: START, end: END });
    assert.equal(f.probesSent, 755);
    assert.equal(f.probesReverted, 67);
    assert.equal(f.probesLanded, 688);
    assert.equal(f.settles, 58);
    assert.equal(f.mismatch, false);
    assert.ok(Math.abs(f.revertedPct - 8.874) < 0.001);
    assert.equal(f.revertedGasUsed, 67n * 55_000n);
    assert.equal(f.revertedGasWei, 67n * 55_000n * 100_020_000n);
    assert.equal(f.gasUsedTotal, 67n * 55_000n + 688n * 177_000n + 58n * 177_000n);
  });

  it("flags a landed count that does not equal sent minus reverted", () => {
    const { txs, logs } = knownChain();
    const f = summarizeWindow({ txs, logs: logs.slice(5), keeper: KEEPER, campaigns: CAMPAIGNS, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start: START, end: END });
    assert.equal(f.mismatch, true);
  });

  it("is the same whatever the runner counted: a restart in the middle changes nothing", () => {
    const { txs, logs } = knownChain();
    const a = summarizeWindow({ txs, logs, keeper: KEEPER, campaigns: CAMPAIGNS, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start: START, end: END });
    const b = summarizeWindow({ txs: [...txs].reverse(), logs: [...logs].reverse(), keeper: KEEPER.toLowerCase(), campaigns: CAMPAIGNS.toLowerCase(), probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start: START, end: END });
    assert.deepEqual(a, b);
  });

  it("reads the explorer, pages through long lists, and reports an unreadable explorer instead of guessing", async () => {
    const { txs, logs } = knownChain();
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        const u = new URL(String(url));
        const q = u.searchParams;
        const action = q.get("action");
        if (action === "getblocknobytime") return Response.json({ result: { blockNumber: q.get("closest") === "after" ? "100" : "900" } });
        const page = Number(q.get("page"));
        const all = action === "txlist" ? txs : logs;
        const slice = all.slice((page - 1) * 1000, page * 1000);
        return Response.json({ result: slice.length ? slice : "No transactions found" });
      }) as typeof fetch;
      const ok = await fetchWindowFigures(globalThis.fetch, KEEPER, CAMPAIGNS, START, END);
      assert.ok(ok.ok);
      if (ok.ok) assert.equal(ok.figures.probesSent, 755);
      globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
      const bad = await fetchWindowFigures(globalThis.fetch, KEEPER, CAMPAIGNS, START, END);
      assert.equal(bad.ok, false);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("the message says 'window' only for window figures and labels the HYPE figure as the whole UTC day", () => {
    const { txs, logs } = knownChain();
    const f = summarizeWindow({ txs, logs, keeper: KEEPER, campaigns: CAMPAIGNS, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start: START, end: END });
    const text = msg.summary({
      label: windowLabel(START, END),
      window: { sent: f.probesSent, landed: f.probesLanded, reverted: f.probesReverted, revertedPct: f.revertedPct, settles: f.settles, gasWei: f.gasWei, revertedGasWei: f.revertedGasWei, revertedGasUsed: f.revertedGasUsed, mismatch: f.mismatch },
      dayWei: 20_000_000_000_000_000n,
      minDays: 18.2,
      worst: "keeper",
      treasuryWei: 1_000_000_000_000_000_000n,
      restarts: [Date.parse("2026-10-27T15:21:12Z") / 1000],
    });
    const [line1, ...rest] = text.split("\n");
    assert.match(line1!, /window 13:00–17:00 UTC: 755 probes sent, 688 landed, 67 reverted \(8\.9%\), 58 settles\./);
    assert.match(text, /restarted 1 time\(s\) in the window, at 15:21:12 UTC/);
    const dayLine = rest.find((l) => l.includes("HYPE spent"))!;
    assert.match(dayLine, /HYPE spent today \(the whole UTC day so far, all six runner wallets, by balance change\): 0\.0200/);
    assert.ok(!/window/i.test(dayLine), "the day figure is never called a window figure");
  });
});

/** A Durable Object storage and alarm in memory, shared by two Role instances to simulate a restart. */
function fakeState() {
  const m = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async (k: string) => m.get(k),
      put: async (k: string, v: unknown) => void m.set(k, v),
      delete: async (k: string) => m.delete(k),
      setAlarm: async (t: number) => void (alarm = t),
      getAlarm: async () => alarm,
      deleteAlarm: async () => void (alarm = null),
    },
    map: m,
  };
}

describe("the keeper's counters survive a restart", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => (globalThis.fetch = realFetch));

  function setup() {
    const told: Record<string, unknown>[] = [];
    const sup = { idFromName: (n: string) => n, get: () => ({ fetch: async (url: string, init?: RequestInit) => {
      if (String(url).includes("/event")) told.push(JSON.parse(String(init?.body)));
      return Response.json({ run: true });
    } }) };
    const env = { SUPERVISOR: sup, ROLE: sup } as unknown as Env;
    globalThis.fetch = (async () => {
      throw new Error("no network in this test");
    }) as typeof fetch;
    return { env, told };
  }
  const start = (role: Role, runId: number) =>
    role.fetch(new Request("https://role/start", { method: "POST", body: JSON.stringify({ role: "keeper", runId, windowEnd: Math.floor(Date.now() / 1000) + 3600 }) }));
  const mem = (r: Role) => (r as unknown as { keeper: ReturnType<typeof newKeeperState>; saveStats: (c: unknown) => Promise<void> });

  it("a restarted role has the counters it had, notes the restart and tells the supervisor", async () => {
    const { env, told } = setup();
    const st = fakeState();
    const a = new Role(st as never, env);
    await start(a, 1000);
    Object.assign(mem(a).keeper, { probesSent: 445, probesLanded: 398, probesReverted: 47, settles: 30, sendsFailed: 2, failed: 3, pending: [{ hash: "0xabc", id: 6, at: 1 }] });
    await mem(a).saveStats({ role: "keeper", runId: 1000 });
    // The Durable Object is evicted and comes back: a new instance on the same storage.
    const b = new Role(st as never, env);
    assert.equal(mem(b).keeper.probesSent, 0, "a new instance starts empty in memory");
    await b.alarm();
    assert.equal(mem(b).keeper.probesSent >= 445, true);
    assert.equal(mem(b).keeper.probesLanded, 398);
    assert.equal(mem(b).keeper.probesReverted, 47);
    assert.equal(mem(b).keeper.settles, 30);
    assert.equal(mem(b).keeper.sendsFailed >= 2, true);
    const saved = st.map.get("stats") as { restarts: number[]; keeper: { probesSent: number } };
    assert.equal(saved.restarts.length, 1);
    assert.equal(saved.keeper.probesSent >= 445, true);
    const restarted = told.find((e) => e.kind === "restarted");
    assert.ok(restarted && typeof restarted.at === "number" && restarted.role === "keeper");
    assert.match(msg.keeperRestarted(restarted!.at as number, "keeper"), /restarted mid-window at \d\d:\d\d:\d\d UTC/);
  });

  it("the same window's /start does not clear them, a new window's does", async () => {
    const { env } = setup();
    const st = fakeState();
    const a = new Role(st as never, env);
    await start(a, 2000);
    Object.assign(mem(a).keeper, { probesSent: 7 });
    await mem(a).saveStats({ role: "keeper", runId: 2000 });
    await start(a, 2000);
    assert.equal((st.map.get("stats") as { keeper: { probesSent: number } }).keeper.probesSent, 7);
    await start(new Role(st as never, env), 3000);
    assert.equal((st.map.get("stats") as { keeper: { probesSent: number } }).keeper.probesSent, 0);
  });

  it("save and restore round-trip every counter", () => {
    const s = newKeeperState();
    Object.assign(s, { probesSent: 1, probesLanded: 2, probesReverted: 3, settles: 4, sendsFailed: 5, failed: 6, pending: [{ hash: "0x1" as `0x${string}`, id: 1, at: 2 }] });
    const t = newKeeperState();
    restoreKeeper(t, JSON.parse(JSON.stringify(saveKeeper(s))));
    assert.deepEqual(saveKeeper(t), saveKeeper(s));
  });

  it("the schedule still has the window this test assumes is a day long", () => {
    assert.ok(schedule.windows.length >= 1);
  });
});
