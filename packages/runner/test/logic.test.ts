import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseSchedule, type BotsSchedule, RUNNER_WALLETS, type RunnerWallet } from "@plumbline/shared";
import { decide, spentToday, toWei, type Balances, type DayStart, type Halt } from "../src/core/budget.js";
import { epochsFor, funding, isUsable, plan, type CampaignLite } from "../src/core/campaign.js";
import { pollable, settleDue, type Track } from "../src/core/keeper.js";

const raw = JSON.parse(readFileSync(new URL("../../../bots.schedule.json", import.meta.url), "utf8")) as Record<string, unknown>;
const base = parseSchedule(raw);
const on: BotsSchedule = { ...base, enabled: true, wallets: { ...base.wallets, sponsor: "0x00000000000000000000000000000000000000f1" } };
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const IN = T("2026-10-27T10:00:00Z"); // inside 09:00-13:00 UTC

const bal = (hype: number, over: Partial<Record<RunnerWallet, number>> = {}): Balances => {
  const o = {} as Balances;
  for (const w of RUNNER_WALLETS) o[w] = toWei(over[w] ?? hype);
  return o;
};
const day = (b: Balances, d = "2026-10-27"): DayStart => ({ day: d, balances: b });

describe("budget decisions", () => {
  const ok = bal(0.05);
  const input = { schedule: on, nowSec: IN, killed: false, halt: null, balances: ok, dayStart: day(ok) };

  it("runs inside a window with money and no halt", () => {
    const d = decide(input);
    assert.equal(d.action, "run");
  });

  it("does nothing when the schedule is off, even inside a window", () => {
    const d = decide({ ...input, schedule: { ...on, enabled: false } });
    assert.deepEqual(d, { action: "idle", reason: "the schedule is switched off" });
  });

  it("does nothing outside the windows", () => {
    assert.equal(decide({ ...input, nowSec: T("2026-10-27T13:00:00Z") }).action, "idle");
    assert.equal(decide({ ...input, nowSec: T("2026-10-27T08:59:00Z") }).action, "idle");
  });

  it("the kill switch beats everything", () => {
    assert.equal(decide({ ...input, killed: true }).action, "idle");
  });

  it("stops at the daily cap", () => {
    const start = day(bal(0.2));
    const now = bal(0.2, { keeper: 0.1, quoterA: 0.1 }); // 0.2 HYPE spent, cap is 0.13
    const d = decide({ ...input, balances: now, dayStart: start });
    assert.equal(d.action, "stop");
    if (d.action === "stop") assert.equal(d.halt.kind, "cap");
  });

  it("does not stop just under the cap", () => {
    const start = day(bal(0.2));
    const now = bal(0.2, { keeper: 0.2 - 0.12 });
    assert.equal(decide({ ...input, balances: now, dayStart: start }).action, "run");
  });

  it("counts spending even if another wallet was topped up", () => {
    const start = day(bal(0.1));
    const topped = bal(0.1, { keeper: 0.0, quoterA: 0.9 }); // keeper spent 0.1, quoterA gained 0.8
    assert.equal(spentToday(start, topped), toWei(0.1));
  });

  it("stops under a floor, naming the wallet", () => {
    const d = decide({ ...input, balances: bal(0.05, { quoterB: 0.0001 }), dayStart: day(bal(0.05)) });
    assert.equal(d.action, "stop");
    if (d.action === "stop") {
      assert.equal(d.halt.kind, "floor");
      assert.match(d.halt.reason, /quoterB/);
    }
  });

  it("ignores the floor of a wallet that does not exist yet", () => {
    const noSponsor: BotsSchedule = { ...on, wallets: { ...on.wallets, sponsor: null } };
    const b = bal(0.05, { sponsor: 0 });
    assert.equal(decide({ ...input, schedule: noSponsor, balances: b, dayStart: day(b) }).action, "run");
  });

  it("holds, and does not start, when the balances cannot be read", () => {
    assert.equal(decide({ ...input, balances: null }).action, "hold");
  });

  const halt = (kind: Halt["kind"], d = "2026-10-27", windowStart = T("2026-10-27T09:00:00Z")): Halt => ({ kind, reason: "x", day: d, windowStart, at: IN });
  it("a cap halt lasts the whole UTC day, across windows", () => {
    const h = halt("cap");
    assert.equal(decide({ ...input, halt: h }).action, "idle");
    const two: BotsSchedule = { ...on, windows: [{ startUtc: "09:00", minutes: 60 }, { startUtc: "20:00", minutes: 60 }] };
    assert.equal(decide({ ...input, schedule: two, nowSec: T("2026-10-27T20:30:00Z"), halt: h }).action, "idle");
    assert.equal(decide({ ...input, nowSec: T("2026-10-28T10:00:00Z"), halt: h, dayStart: day(ok, "2026-10-28") }).action, "run", "a new UTC day clears it");
  });

  it("any other halt lasts its window, and the next window gets one clean try", () => {
    const h = halt("floor");
    assert.equal(decide({ ...input, halt: h }).action, "idle");
    assert.equal(decide({ ...input, nowSec: T("2026-10-28T10:00:00Z"), halt: h, dayStart: day(ok, "2026-10-28") }).action, "run");
  });

  it("a day with no starting point yet starts from the balances as they are", () => {
    assert.equal(decide({ ...input, dayStart: null }).action, "run");
    assert.equal(decide({ ...input, dayStart: day(bal(5), "2026-10-26") }).action, "run", "yesterday's snapshot is not used today");
  });
});

describe("campaign manager planning", () => {
  const t = { base: "0x00000000000000000000000000000000000000a1", quote: "0x00000000000000000000000000000000000000a2", reward: "0x00000000000000000000000000000000000000a2" } as const;
  const camp = (over: Partial<CampaignLite> = {}): CampaignLite => ({
    id: 1,
    base: t.base,
    quote: t.quote,
    rewardToken: t.reward,
    startTime: IN - 600,
    numEpochs: 60,
    epochLength: 300,
    vaults: [on.vaults.a, on.vaults.b],
    ...over,
  });
  const WEND = T("2026-10-27T13:00:00Z");

  it("is fine when a running campaign has both vaults and time left", () => {
    assert.deepEqual(plan([camp()], on, IN, WEND, t), { kind: "ok", id: 1 });
  });

  it("opens one when there is none", () => {
    const p = plan([], on, IN, WEND, t);
    assert.equal(p.kind, "open");
    if (p.kind === "open") assert.equal(p.epochs, epochsFor(WEND, IN, 300));
  });

  it("opens one when the only campaign is about to end or has ended", () => {
    assert.equal(plan([camp({ numEpochs: 3 })], on, IN, WEND, t).kind, "open", "ends in under 20 minutes");
    assert.equal(plan([camp({ startTime: IN - 100_000 })], on, IN, WEND, t).kind, "open");
    assert.equal(plan([camp({ startTime: IN + 600 })], on, IN, WEND, t).kind, "open", "not started yet");
  });

  it("ignores a campaign on another pair or reward token", () => {
    assert.equal(plan([camp({ base: "0x00000000000000000000000000000000000000b9" })], on, IN, WEND, t).kind, "open");
    assert.equal(plan([camp({ rewardToken: "0x00000000000000000000000000000000000000b8" })], on, IN, WEND, t).kind, "open");
  });

  it("bonds only the vault that is missing", () => {
    assert.deepEqual(plan([camp({ vaults: [on.vaults.a] })], on, IN, WEND, t), { kind: "register", id: 1, vaults: ["b"] });
    assert.deepEqual(plan([camp({ vaults: [] })], on, IN, WEND, t), { kind: "register", id: 1, vaults: ["a", "b"] });
  });

  it("opens with enough epochs to outlast the window, within bounds", () => {
    const n = epochsFor(WEND, IN, 300); // 3h left + 30 min margin
    assert.equal(n, 42);
    assert.equal(epochsFor(IN + 1, IN, 600), 6, "never fewer than six");
    assert.equal(epochsFor(IN + 10 * 86_400, IN, 60), 120, "never more than 120");
    assert.ok(isUsable(camp({ numEpochs: n }), IN, 20, t) && camp({ numEpochs: n }).startTime + n * 300 > WEND);
  });

  it("prices a campaign in PLUMBUSD", () => {
    const p = plan([], on, IN, WEND, t);
    const f = funding(on, p);
    assert.equal(f.pot, 42_000_000n, "42 epochs at 1 PLUMBUSD");
    assert.equal(f.bonds, 2_000_000n, "two bonds of 1 PLUMBUSD");
    assert.deepEqual(funding(on, { kind: "ok", id: 1 }), { pot: 0n, bonds: 0n });
  });
});

describe("keeper decisions", () => {
  const tr = (over: Partial<Track> = {}): Track => ({ id: 1, startTime: IN - 60, numEpochs: 10, epochLength: 300, minProbeInterval: 13, settledEpochs: 0, lastProbeAt: 0, ...over });

  it("polls only running campaigns past their minimum interval", () => {
    assert.equal(pollable([tr()], IN, {}, 0).length, 1);
    assert.equal(pollable([tr({ startTime: IN + 10 })], IN, {}, 0).length, 0, "not started");
    assert.equal(pollable([tr({ startTime: IN - 5000 })], IN, {}, 0).length, 0, "over");
    assert.equal(pollable([tr({ lastProbeAt: IN - 5 })], IN, {}, 0).length, 0, "probed 5 s ago");
    assert.equal(pollable([tr()], IN, { 1: 5_000 }, 4_000).length, 0, "quiet after an attempt");
    assert.equal(pollable([tr()], IN, { 1: 5_000 }, 5_000).length, 1);
  });

  it("settles the first finished, unsettled epoch only once it is over", () => {
    assert.equal(settleDue([tr({ startTime: IN - 200 })], IN), null);
    assert.equal(settleDue([tr({ startTime: IN - 400 })], IN)?.id, 1);
    assert.equal(settleDue([tr({ startTime: IN - 400, settledEpochs: 1 })], IN), null);
    assert.equal(settleDue([tr({ startTime: IN - 100_000, numEpochs: 3, settledEpochs: 3 })], IN), null, "all settled");
  });
});
