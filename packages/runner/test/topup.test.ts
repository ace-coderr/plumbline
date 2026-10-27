import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RUNNER_WALLETS, type BotsSchedule, type RunnerWallet } from "@plumbline/shared";
import { schedule as shipped } from "../src/config.js";
import { makeClients } from "../src/chain.js";
import type { Env } from "../src/env.js";
import { toWei, type Balances } from "../src/core/budget.js";
import { makeLogger } from "../src/core/log.js";
import { emptySentToday, isListed, planTopUp, recordSent, daysLeft, MIN_SEND_WEI } from "../src/core/topup.js";
import { runTopUp, testSend, type TreasuryCtx } from "../src/treasury.js";

const DAY = "2026-10-27";
const tre = privateKeyToAccount(generatePrivateKey());
const sched = (over: Partial<BotsSchedule["topUp"]> = {}, treasury: Partial<BotsSchedule["treasury"]> = {}): BotsSchedule => ({
  ...shipped,
  treasury: { ...shipped.treasury, address: tre.address, ...treasury },
  topUp: { ...shipped.topUp, enabled: true, ...over },
});
const balancesOf = (s: BotsSchedule, days: number): Balances =>
  Object.fromEntries(RUNNER_WALLETS.map((w) => [w, toWei(s.floorHype[w] + days * s.topUp.dailySpendHype[w])])) as Balances;
const hype = (wei: bigint) => Number(wei) / 1e18;

describe("top-up maths", () => {
  it("fills a wallet under 3 days up to 10 days, and leaves one at 3 days alone", () => {
    const s = sched();
    const b = balancesOf(s, 10);
    b.quoterA = toWei(s.floorHype.quoterA + 2 * s.topUp.dailySpendHype.quoterA);
    b.keeper = toWei(s.floorHype.keeper + 3 * s.topUp.dailySpendHype.keeper + 0.000001);
    const plan = planTopUp({ schedule: s, balances: b, treasuryWei: toWei(1), sent: emptySentToday(DAY), day: DAY });
    assert.equal(plan.sends.length, 1);
    const send = plan.sends[0]!;
    assert.equal(send.wallet, "quoterA");
    assert.ok(Math.abs(hype(send.amountWei) - 8 * s.topUp.dailySpendHype.quoterA) < 1e-9, "tops up by exactly 8 days of spend");
    assert.equal(send.to, s.wallets.quoterA);
  });

  it("every recipient, over many balances, is an address listed in the schedule", () => {
    const s = sched({ perWalletPerDayHype: 5, totalPerDayHype: 50 });
    const listed = new Set(RUNNER_WALLETS.map((w) => s.wallets[w]?.toLowerCase()));
    for (let i = 0; i < 300; i++) {
      const b = Object.fromEntries(RUNNER_WALLETS.map((w) => [w, toWei(Math.random() * 0.5)])) as Balances;
      const plan = planTopUp({ schedule: s, balances: b, treasuryWei: toWei(Math.random() * 3), sent: emptySentToday(DAY), day: DAY });
      for (const x of plan.sends) assert.ok(listed.has(x.to.toLowerCase()) && x.to !== tre.address, `${x.to} is not listed`);
    }
  });

  it("the per-wallet daily cap clips a send, and what was sent counts against it", () => {
    const s = sched({ perWalletPerDayHype: 0.05, totalPerDayHype: 5 });
    const b = balancesOf(s, 0);
    const first = planTopUp({ schedule: s, balances: b, treasuryWei: toWei(5), sent: emptySentToday(DAY), day: DAY });
    const qa = first.sends.find((x) => x.wallet === "quoterA")!;
    assert.equal(qa.amountWei, toWei(0.05), "quoterA wanted more than 0.05");
    assert.ok(first.skipped.some((k) => k.wallet === "quoterA" && /per-wallet/.test(k.reason)));
    let sent = emptySentToday(DAY);
    for (const x of first.sends) sent = recordSent(sent, DAY, x.wallet, x.amountWei);
    const second = planTopUp({ schedule: s, balances: b, treasuryWei: toWei(5), sent, day: DAY });
    assert.equal(second.sends.find((x) => x.wallet === "quoterA"), undefined, "quoterA is at its cap for today");
  });

  it("the total daily cap clips the sum, neediest wallets first", () => {
    const s = sched({ perWalletPerDayHype: 5, totalPerDayHype: 0.1 });
    const plan = planTopUp({ schedule: s, balances: balancesOf(s, 0), treasuryWei: toWei(5), sent: emptySentToday(DAY), day: DAY });
    const total = plan.sends.reduce((a, x) => a + x.amountWei, 0n);
    assert.ok(total <= toWei(0.1));
    assert.ok(plan.skipped.some((k) => /total daily/.test(k.reason)) || plan.sends.length < RUNNER_WALLETS.length);
    const next = planTopUp({ schedule: s, balances: balancesOf(s, 0), treasuryWei: toWei(5), sent: recordSent(emptySentToday(DAY), DAY, "keeper", toWei(0.1)), day: DAY });
    assert.equal(next.sends.length, 0, "nothing is left of today's total");
  });

  it("a new UTC day starts the caps again", () => {
    const s = sched({ perWalletPerDayHype: 0.05, totalPerDayHype: 0.05 });
    const used = recordSent(emptySentToday("2026-10-26"), "2026-10-26", "keeper", toWei(0.05));
    const plan = planTopUp({ schedule: s, balances: balancesOf(s, 0), treasuryWei: toWei(5), sent: used, day: DAY });
    assert.ok(plan.sends.length > 0);
  });

  it("a low treasury still tops up but warns; an empty one sends nothing", () => {
    const s = sched();
    const low = planTopUp({ schedule: s, balances: balancesOf(s, 1), treasuryWei: toWei(0.4), sent: emptySentToday(DAY), day: DAY });
    assert.equal(low.treasuryLow, true);
    assert.equal(low.treasuryEmpty, false);
    assert.ok(low.sends.length > 0);
    const empty = planTopUp({ schedule: s, balances: balancesOf(s, 1), treasuryWei: toWei(s.treasury.minHype / 2), sent: emptySentToday(DAY), day: DAY });
    assert.equal(empty.treasuryEmpty, true);
    assert.equal(empty.sends.length, 0);
  });

  it("never sends more than the treasury holds above its minimum", () => {
    const s = sched({ perWalletPerDayHype: 5, totalPerDayHype: 50 });
    const hold = 0.05;
    const plan = planTopUp({ schedule: s, balances: balancesOf(s, 0), treasuryWei: toWei(hold), sent: emptySentToday(DAY), day: DAY });
    const total = plan.sends.reduce((a, x) => a + x.amountWei, 0n);
    assert.ok(total <= toWei(hold - s.treasury.minHype));
    for (const x of plan.sends) assert.ok(x.amountWei >= MIN_SEND_WEI);
  });

  it("is off when switched off or when there is no treasury address", () => {
    const off = planTopUp({ schedule: sched({ enabled: false }), balances: balancesOf(sched(), 0), treasuryWei: toWei(1), sent: emptySentToday(DAY), day: DAY });
    assert.ok(off.off && off.sends.length === 0);
    const none = planTopUp({ schedule: sched({}, { address: null }), balances: balancesOf(sched(), 0), treasuryWei: toWei(1), sent: emptySentToday(DAY), day: DAY });
    assert.ok(none.off && none.sends.length === 0);
  });

  it("days of funding left counts only what is above the floor", () => {
    const s = sched();
    assert.equal(daysLeft(s, "keeper", toWei(s.floorHype.keeper)), 0);
    assert.ok(Math.abs(daysLeft(s, "quoterA", toWei(s.floorHype.quoterA + 4 * s.topUp.dailySpendHype.quoterA)) - 4) < 1e-6);
  });
});

describe("the allowlist", () => {
  it("refuses any address that is not a listed wallet, including the treasury's own and the deployer's", () => {
    const s = sched();
    for (const a of ["0x0000000000000000000000000000000000000001", tre.address, privateKeyToAccount(generatePrivateKey()).address, "", "0x"]) assert.equal(isListed(s, a), false, a);
    for (const w of RUNNER_WALLETS) {
      assert.equal(isListed(s, s.wallets[w] as string), true);
      assert.equal(isListed(s, (s.wallets[w] as string).toLowerCase()), true);
    }
  });
});

/** A fake chain behind fetch: balances, nonce, gas price, sends (counted, optionally refused) and receipts. */
function fakeChain(balances: Record<string, bigint>, refuseSends = false) {
  const sends: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    switch (body.method) {
      case "eth_getBalance":
        return ok(`0x${(balances[String(body.params[0]).toLowerCase()] ?? 0n).toString(16)}`);
      case "eth_getTransactionCount":
        return ok("0x1");
      case "eth_gasPrice":
        return ok("0x5f5e100");
      case "eth_sendRawTransaction": {
        sends.push(String(body.params[0]));
        if (refuseSends) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "nonce too low" } });
        return ok(`0x${randomBytes(32).toString("hex")}`);
      }
      case "eth_getTransactionReceipt":
        return ok({
          blockHash: `0x${"11".repeat(32)}`, blockNumber: "0x1", contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1",
          from: tre.address, gasUsed: "0x5208", logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", to: tre.address,
          transactionHash: String(body.params[0]), transactionIndex: "0x0", type: "0x2",
        });
      default:
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not mocked" } });
    }
  }) as typeof fetch;
  return { sends, restore: () => void (globalThis.fetch = realFetch) };
}

function ctxFor(s: BotsSchedule, opts: { on?: () => Promise<boolean> } = {}) {
  const store = new Map<string, unknown>();
  const alerts: { key: string; text: string }[] = [];
  const lines: string[] = [];
  const ctx: TreasuryCtx = {
    env: { TREASURY_KEY: "" } as unknown as Env,
    schedule: s,
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v) } as never,
    clients: makeClients(),
    log: makeLogger((x) => x, (l) => lines.push(l)),
    alert: async (key, text) => void alerts.push({ key, text }),
    stillOn: opts.on ?? (async () => true),
  };
  return { ctx, store, alerts, lines };
}

describe("sending", () => {
  let chain: ReturnType<typeof fakeChain> | null = null;
  afterEach(() => chain?.restore());
  const key = generatePrivateKey();
  const s = (): BotsSchedule => ({ ...sched(), treasury: { ...sched().treasury, address: privateKeyToAccount(key).address } });
  const lowBalances = (sc: BotsSchedule, treasuryHype: number) => {
    const m: Record<string, bigint> = { [sc.treasury.address!.toLowerCase()]: toWei(treasuryHype) };
    for (const w of RUNNER_WALLETS) m[(sc.wallets[w] as string).toLowerCase()] = toWei(sc.floorHype[w]);
    return m;
  };
  const balances = (sc: BotsSchedule) => Object.fromEntries(RUNNER_WALLETS.map((w) => [w, toWei(sc.floorHype[w])])) as Balances;

  it("sends once per wallet, records it, and stays inside the caps", async () => {
    const sc = s();
    chain = fakeChain(lowBalances(sc, 1));
    const { ctx, store } = ctxFor(sc);
    (ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = key;
    const r = await runTopUp(ctx, Date.parse(`${DAY}T13:00:00Z`) / 1000, balances(sc));
    assert.ok(r.sent.length > 0 && r.sent.length <= 4);
    assert.equal(chain.sends.length, r.sent.length, "one transaction per planned send, no more");
    const sentToday = store.get("topUpSent") as { total: string };
    assert.equal(BigInt(sentToday.total), r.sent.reduce((a, x) => a + x.amountWei, 0n));
    assert.ok(store.get("lastTopUp"));
  });

  it("a failed transfer is attempted once, alerts, stops the rest of the check and is not retried", async () => {
    const sc = s();
    chain = fakeChain(lowBalances(sc, 1), true);
    const { ctx, alerts, store } = ctxFor(sc);
    (ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = key;
    const r = await runTopUp(ctx, Date.parse(`${DAY}T13:00:00Z`) / 1000, balances(sc));
    assert.equal(chain.sends.length, 1, "exactly one attempt");
    assert.equal(r.sent.length, 0);
    assert.ok(alerts.some((a) => a.key.startsWith("topup-failed")));
    assert.ok(store.get("topUpError"));
  });

  it("does not send once the kill switch is on", async () => {
    const sc = s();
    chain = fakeChain(lowBalances(sc, 1));
    const { ctx } = ctxFor(sc, { on: async () => false });
    (ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = key;
    const r = await runTopUp(ctx, Date.parse(`${DAY}T13:00:00Z`) / 1000, balances(sc));
    assert.equal(chain.sends.length, 0);
    assert.equal(r.sent.length, 0);
  });

  it("a treasury under 0.5 HYPE alerts and one under its minimum alerts and sends nothing", async () => {
    const sc = s();
    chain = fakeChain(lowBalances(sc, 0.3));
    const a = ctxFor(sc);
    (a.ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = key;
    await runTopUp(a.ctx, Date.parse(`${DAY}T13:00:00Z`) / 1000, balances(sc));
    assert.ok(a.alerts.some((x) => x.key === "treasury-low"));
    chain.restore();
    chain = fakeChain(lowBalances(sc, 0.001));
    const b = ctxFor(sc);
    (b.ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = key;
    const r = await runTopUp(b.ctx, Date.parse(`${DAY}T13:00:00Z`) / 1000, balances(sc));
    assert.equal(r.sent.length, 0);
    assert.equal(chain.sends.length, 0);
    assert.ok(b.alerts.some((x) => x.key === "treasury-empty"));
  });

  it("refuses a key that is not the treasury's, with no key in the message", async () => {
    const sc = s();
    chain = fakeChain(lowBalances(sc, 1));
    const other = generatePrivateKey();
    const { ctx, alerts } = ctxFor(sc);
    (ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = other;
    const r = await runTopUp(ctx, Date.parse(`${DAY}T13:00:00Z`) / 1000, balances(sc));
    assert.equal(chain.sends.length, 0);
    assert.equal(r.sent.length, 0);
    for (const t of [r.note, ...alerts.map((a) => a.text)]) assert.ok(!t.includes(other.slice(2)));
  });

  it("the live test transfer takes only a listed wallet name and at most 0.001 HYPE", async () => {
    const sc = s();
    chain = fakeChain(lowBalances(sc, 1));
    const { ctx } = ctxFor(sc);
    (ctx.env as { TREASURY_KEY: string }).TREASURY_KEY = key;
    const now = Date.parse(`${DAY}T13:00:00Z`) / 1000;
    for (const who of ["0x0000000000000000000000000000000000000001", tre.address, "deployer", "treasury", ""]) {
      assert.equal((await testSend(ctx, now, who, 0.0005)).ok, false, who);
    }
    for (const amt of [0, -1, 0.002, 1, NaN]) assert.equal((await testSend(ctx, now, "keeper" as RunnerWallet, amt)).ok, false, String(amt));
    assert.equal(chain.sends.length, 0);
    const ok = await testSend(ctx, now, "makerA", 0.0005);
    assert.equal(ok.ok, true, ok.note);
    assert.equal(chain.sends.length, 1);
  });
});
