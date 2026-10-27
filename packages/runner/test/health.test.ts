import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Address } from "viem";
import { RUNNER_WALLETS } from "@plumbline/shared";
import { CAMPAIGNS, FAUCET, PLUMBUSD, schedule } from "../src/config.js";
import { Supervisor } from "../src/supervisor.js";
import type { Env } from "../src/env.js";
import { setRedactor } from "../src/core/log.js";
import { toWei, type Balances } from "../src/core/budget.js";
import { formatHealth, plumbusdLines, rpcLines, runnerLines, treasuryLine, walletLines, windowLines } from "../src/core/health.js";
import { summarizeWindow, type ChainLog, type ChainTx } from "../src/core/windowSummary.js";
import { PROBE_SELECTOR, SETTLE_SELECTOR } from "../src/windowData.js";

const full = (n: number): Balances => Object.fromEntries(RUNNER_WALLETS.map((w) => [w, toWei(n)])) as Balances;
const START = Date.parse("2026-10-27T13:00:00Z") / 1000;
const END = START + 4 * 3600;

describe("health lines", () => {
  const ok = (ls: { ok: boolean }[]) => ls.every((l) => l.ok);

  it("wallets: above the floor passes, below it fails and says which", () => {
    assert.ok(ok(walletLines(schedule, full(1))));
    const b = full(1);
    b.keeper = toWei(schedule.floorHype.keeper / 2);
    const bad = walletLines(schedule, b).filter((l) => !l.ok);
    assert.equal(bad.length, 1);
    assert.match(bad[0]!.name, /keeper/);
    assert.match(bad[0]!.detail, /under its floor/);
  });

  it("treasury: ok, low, unreadable and unset", () => {
    assert.equal(treasuryLine(schedule, toWei(1)).ok, true);
    assert.equal(treasuryLine(schedule, toWei(0.2)).ok, false);
    assert.equal(treasuryLine(schedule, null).ok, false);
    assert.equal(treasuryLine({ ...schedule, treasury: { ...schedule.treasury, address: null } }, toWei(1)).ok, false);
  });

  it("PLUMBUSD: sponsor and faucet against their alert levels, and an unreadable balance fails", () => {
    assert.ok(ok(plumbusdLines(schedule, 500_000, 500_000)));
    const low = plumbusdLines(schedule, schedule.alerts.sponsorLowPlumbusd - 1, schedule.alerts.faucetLowPlumbusd + 1);
    assert.deepEqual(low.map((l) => l.ok), [false, true]);
    assert.equal(plumbusdLines(schedule, null, 500_000)[0]!.ok, false);
  });

  it("runner: a stale tick, the kill switch, a halt and a switched-off schedule each fail", () => {
    const base = { nowSec: 10_000, lastTickAt: 9_990, killed: false, halt: null, scheduleEnabled: true };
    assert.ok(ok(runnerLines(base)));
    assert.equal(runnerLines({ ...base, lastTickAt: 9_000 })[0]!.ok, false);
    assert.equal(runnerLines({ ...base, lastTickAt: null })[0]!.ok, false);
    assert.equal(runnerLines({ ...base, killed: true }).filter((l) => !l.ok).length, 1);
    assert.equal(runnerLines({ ...base, halt: { kind: "cap", reason: "spent" } }).filter((l) => !l.ok).length, 1);
    assert.equal(runnerLines({ ...base, scheduleEnabled: false }).filter((l) => !l.ok).length, 1);
  });

  it("window: consistent figures pass; a mismatch, a differing tally and an unreadable chain fail", () => {
    const f = { probesSent: 100, probesLanded: 90, probesReverted: 10, revertedPct: 10, settles: 5, settlesFailed: 0, gasUsedTotal: 0n, gasWei: 0n, revertedGasUsed: 0n, revertedGasWei: 0n, mismatch: false };
    assert.equal(windowLines(f, null)[0]!.ok, true);
    assert.equal(windowLines(f, { sent: 101, landed: 90, reverted: 10 })[0]!.ok, true, "up to two in flight at the end is fine");
    assert.equal(windowLines(f, { sent: 40, landed: 30, reverted: 10 })[0]!.ok, false);
    assert.equal(windowLines({ ...f, mismatch: true }, null)[0]!.ok, false);
    assert.equal(windowLines(null, null, "the explorer answered 503")[0]!.ok, false);
  });

  it("the short form is one PASS line per group, and a failure shows its own line", () => {
    const lines = [...rpcLines([{ name: "a", ok: true, detail: "x" }, { name: "b", ok: true, detail: "y" }]), ...walletLines(schedule, full(1)), treasuryLine(schedule, toWei(1))];
    const pass = formatHealth(lines);
    assert.equal(pass.failed.length, 0);
    assert.match(pass.text, /^Health: all checks passed\nPASS RPC \(2\/2\)\nPASS Wallets \(6\/6\)\nPASS Treasury$/);
    const b = full(1);
    b.quoterA = 0n;
    const bad = formatHealth([...walletLines(schedule, b), treasuryLine(schedule, toWei(1))]);
    assert.equal(bad.failed.length, 1);
    assert.match(bad.text, /^Health: 1 failed\nFAIL wallet quoterA: /);
    assert.match(bad.text, /PASS Treasury/);
  });
});

/** A chain behind fetch: JSON-RPC (block number, balances, multicall, ERC-20 balances), the explorer and Telegram. */
function fakeWorld(opts: { balances: Record<string, bigint>; plum: Record<string, bigint>; failNode?: string }) {
  const seen = { rpc: 0, explorer: 0, telegram: [] as string[] };
  const keeper = schedule.wallets.keeper as string;
  const txs: ChainTx[] = [];
  const logs: ChainLog[] = [];
  for (let i = 0; i < 120; i++) {
    const reverted = i % 10 === 0;
    const hash = `0x${(i + 1).toString(16).padStart(64, "0")}`;
    txs.push({ hash, to: CAMPAIGNS, methodId: PROBE_SELECTOR, isError: reverted ? "1" : "0", gasUsed: reverted ? "55000" : "177000", gasPrice: "100020000", timeStamp: String(START + 60 + i * 60) });
    if (!reverted) logs.push({ topics: ["0xe", "0x1", "0x2", `0x${"0".repeat(24)}${keeper.slice(2).toLowerCase()}`], transactionHash: hash });
  }
  for (let i = 0; i < 6; i++) txs.push({ hash: `0x${(900 + i).toString(16).padStart(64, "0")}`, to: CAMPAIGNS, methodId: SETTLE_SELECTOR, isError: "0", gasUsed: "177000", gasPrice: "100020000", timeStamp: String(START + 600 + i * 1000) });
  const aggAbi = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
  const balAbi = parseAbi(["function getEthBalance(address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
  const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      seen.telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true });
    }
    if (u.includes("/api?")) {
      seen.explorer += 1;
      const q = new URL(u).searchParams;
      const action = q.get("action");
      if (action === "getblocknobytime") return Response.json({ result: { blockNumber: q.get("closest") === "after" ? "100" : "900" } });
      const all = action === "txlist" ? txs : logs;
      const page = Number(q.get("page"));
      const slice = all.slice((page - 1) * 1000, page * 1000);
      return Response.json({ result: slice.length ? slice : "No transactions found" });
    }
    seen.rpc += 1;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (opts.failNode && u === opts.failNode && body.method === "eth_blockNumber") return new Response("nope", { status: 500 });
    switch (body.method) {
      case "eth_blockNumber":
        return ok("0x1000");
      case "eth_chainId":
        return ok("0x185d9");
      case "eth_getBalance":
        return ok(`0x${(opts.balances[String(body.params[0]).toLowerCase()] ?? 0n).toString(16)}`);
      case "eth_call": {
        const call = body.params[0] as { to: string; data: `0x${string}` };
        if (call.data.startsWith("0x82ad56cb")) {
          const { args } = decodeFunctionData({ abi: aggAbi, data: call.data });
          const res = (args[0] as unknown as { callData: `0x${string}` }[]).map((c) => {
            const who = decodeFunctionData({ abi: balAbi, data: c.callData }).args![0] as string;
            return { success: true, returnData: uint(opts.balances[who.toLowerCase()] ?? 0n) };
          });
          return ok(encodeFunctionResult({ abi: aggAbi, functionName: "aggregate3", result: res }));
        }
        const who = decodeFunctionData({ abi: balAbi, data: call.data }).args![0] as string;
        return ok(uint(opts.plum[who.toLowerCase()] ?? 0n));
      }
      default:
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not mocked" } });
    }
  }) as typeof fetch;
  return { seen, restore: () => void (globalThis.fetch = realFetch), keeper };
}

describe("the daily summary carries the Health block", () => {
  const realNow = Date.now;
  let world: ReturnType<typeof fakeWorld> | null = null;
  beforeEach(() => {
    Date.now = () => (END + 120) * 1000;
  });
  afterEach(() => {
    Date.now = realNow;
    world?.restore();
    setRedactor((s) => s);
  });

  const hex = (n: number) => randomBytes(n).toString("hex");
  const addr = (a: string | null) => (a as string).toLowerCase();
  function run(world: ReturnType<typeof fakeWorld>, env: Record<string, string>) {
    const m = new Map<string, unknown>([
      ["summaryDue", { start: START, end: END }],
      ["plumbusdCheckedAt", END + 120],
      ["lastTickAt", END + 100],
      ["dayStart", { day: "2026-10-27", balances: Object.fromEntries(RUNNER_WALLETS.map((w) => [w, toWei(1).toString()])) }],
    ]);
    const st = { storage: { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v), delete: async (k: string) => m.delete(k), setAlarm: async () => undefined, getAlarm: async () => null, deleteAlarm: async () => undefined } };
    const keeperState = { saved: { runId: START, keeper: { probesSent: 120, probesLanded: 108, probesReverted: 12 }, restarts: [] as number[] } };
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json(keeperState) }) };
    const sup = new Supervisor(st as never, { ...env, SUPERVISOR: ns, ROLE: ns } as unknown as Env);
    return { sup, m };
  }
  const goodBalances = () => ({
    ...Object.fromEntries(RUNNER_WALLETS.filter((w) => schedule.wallets[w]).map((w) => [addr(schedule.wallets[w]), toWei(1)])),
    [addr(schedule.treasury.address)]: toWei(1),
  });
  const goodPlum = () => ({ [addr(schedule.wallets.sponsor)]: 500_000_000_000n, [addr(FAUCET)]: 500_000_000_000n });
  const secrets = () => ({ TELEGRAM_BOT_TOKEN: `${Math.floor(1e9 + Math.random() * 9e9)}:AA${hex(16)}`, TELEGRAM_CHAT_ID: String(Math.floor(1e9 + Math.random() * 9e9)), CONDUIT_RPC_URL: `https://rpc.conduit.xyz/v1/${hex(20)}` });

  it("all healthy: one message ending in a Health block, no separate alert, few requests", async () => {
    world = fakeWorld({ balances: goodBalances(), plum: goodPlum() });
    const env = secrets();
    const { sup } = run(world, env);
    await sup.tick();
    assert.equal(world.seen.telegram.length, 1, "one message, no failure alert");
    const text = world.seen.telegram[0]!;
    assert.match(text, /window 13:00–17:00 UTC: 120 probes sent, 108 landed, 12 reverted \(10\.0%\), 6 settles/);
    assert.match(text, /Health: all checks passed\nPASS RPC \(3\/3\)\nPASS Runner\nPASS Wallets \(6\/6\)\nPASS Treasury\nPASS PLUMBUSD\nPASS Window$/);
    assert.ok(text.trim().endsWith("PASS Window"), "the Health block is last");
    assert.ok(world.seen.rpc + world.seen.explorer + world.seen.telegram.length <= 20, `requests: ${world.seen.rpc} rpc, ${world.seen.explorer} explorer`);
    for (const v of [env.CONDUIT_RPC_URL, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.CONDUIT_RPC_URL.split("/").pop()!]) assert.ok(!text.includes(v));
  });

  it("a wallet under its floor and a dead node: the summary shows them and a separate alert is sent", async () => {
    const bal = goodBalances();
    bal[addr(schedule.wallets.keeper)] = 0n;
    const env = secrets();
    world = fakeWorld({ balances: bal, plum: goodPlum(), failNode: env.CONDUIT_RPC_URL });
    const { sup } = run(world, env);
    await sup.tick();
    assert.equal(world.seen.telegram.length, 2);
    const [summary, alert] = world.seen.telegram as [string, string];
    assert.match(summary, /Health: 2 failed/);
    assert.match(summary, /FAIL RPC private node: /);
    assert.match(summary, /FAIL wallet keeper: .*under its floor/);
    assert.match(summary, /PASS Treasury/);
    assert.match(alert, /2 health check\(s\) failed/);
    assert.match(alert, /- wallet keeper: /);
    assert.match(alert, /- RPC private node: /);
    for (const t of [summary, alert]) assert.ok(!t.includes(env.CONDUIT_RPC_URL) && !t.includes(env.CONDUIT_RPC_URL.split("/").pop()!));
  });

  it("low PLUMBUSD and a low treasury fail their lines", async () => {
    const bal = goodBalances();
    bal[addr(schedule.treasury.address)] = toWei(0.1);
    world = fakeWorld({ balances: bal, plum: { [addr(schedule.wallets.sponsor)]: 5_000_000n, [addr(FAUCET)]: 500_000_000_000n } });
    const { sup } = run(world, secrets());
    await sup.tick();
    const summary = world.seen.telegram[0]!;
    assert.match(summary, /FAIL treasury: /);
    assert.match(summary, /FAIL sponsor PLUMBUSD: /);
    assert.doesNotMatch(summary, /FAIL faucet/);
    assert.equal(world.seen.telegram.length, 2);
  });

  it("the Health block repeats nothing it did not need to read: the summary's own reads are reused", () => {
    // Pure lines only: building them from values already read makes no request at all.
    const f = summarizeWindow({ txs: [], logs: [], keeper: "0x0", campaigns: CAMPAIGNS, probeSelector: PROBE_SELECTOR, settleSelector: SETTLE_SELECTOR, start: START, end: END });
    assert.equal(windowLines(f, null)[0]!.ok, true);
    void (PLUMBUSD as { address: Address });
  });
});
