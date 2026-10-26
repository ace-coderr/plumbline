import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { lagosLabel, nextWindow, parseSchedule, runnerHeartbeat, utcDay, utcLabel, windowAt, type BotsSchedule } from "../src/schedule.js";

const shipped = JSON.parse(readFileSync(new URL("../../../bots.schedule.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(shipped)) as Record<string, unknown>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("bots.schedule.json", () => {
  const s = parseSchedule(shipped);

  it("ships switched off, with one four-hour daily window", () => {
    assert.equal(s.enabled, false);
    assert.deepEqual(s.windows, [{ startUtc: "09:00", minutes: 240 }]);
  });

  it("keeps the deployer out of it: no wallet role for it", () => {
    assert.ok(!Object.keys(s.wallets).some((k) => /deployer/i.test(k)));
  });

  it("rejects an unknown field, a missing field and a bad value", () => {
    const a = clone();
    a.surprise = 1;
    assert.throws(() => parseSchedule(a), /unknown field "surprise"/);
    const b = clone();
    delete b.dailyHypeCap;
    assert.throws(() => parseSchedule(b), /missing field "dailyHypeCap"/);
    const c = clone();
    c.windows = [{ startUtc: "9:00", minutes: 240 }];
    assert.throws(() => parseSchedule(c), /HH:MM/);
    const d = clone();
    (d.maker as Record<string, Record<string, unknown>>).A!.refreshMs = 5000;
    assert.throws(() => parseSchedule(d), /refreshMs/);
    const e = clone();
    (e.wallets as Record<string, unknown>).keeper = "0x123";
    assert.throws(() => parseSchedule(e), /not an address/);
    assert.throws(() => parseSchedule("nope"), /must be an object/);
  });

  it("rejects overlapping windows, including across midnight", () => {
    const a = clone();
    a.windows = [{ startUtc: "09:00", minutes: 240 }, { startUtc: "12:00", minutes: 60 }];
    assert.throws(() => parseSchedule(a), /overlap/);
    const b = clone();
    b.windows = [{ startUtc: "22:00", minutes: 240 }, { startUtc: "01:00", minutes: 60 }];
    assert.throws(() => parseSchedule(b), /overlap/);
    const ok = clone();
    ok.windows = [{ startUtc: "22:00", minutes: 120 }, { startUtc: "01:00", minutes: 60 }];
    assert.equal(parseSchedule(ok).windows.length, 2);
  });
});

describe("windows", () => {
  const on: BotsSchedule = { ...parseSchedule(shipped), enabled: true };

  it("is inside the window only between its start and end", () => {
    assert.equal(windowAt(on, T("2026-10-27T08:59:59Z")), null);
    assert.deepEqual(windowAt(on, T("2026-10-27T09:00:00Z")), { start: T("2026-10-27T09:00:00Z"), end: T("2026-10-27T13:00:00Z") });
    assert.notEqual(windowAt(on, T("2026-10-27T12:59:59Z")), null);
    assert.equal(windowAt(on, T("2026-10-27T13:00:00Z")), null, "the end is exclusive");
  });

  it("names the next window, today or tomorrow", () => {
    assert.equal(nextWindow(on, T("2026-10-27T07:00:00Z"))?.start, T("2026-10-27T09:00:00Z"));
    assert.equal(nextWindow(on, T("2026-10-27T10:00:00Z"))?.start, T("2026-10-28T09:00:00Z"), "inside a window, the next one is tomorrow's");
    assert.equal(nextWindow(on, T("2026-10-27T20:00:00Z"))?.start, T("2026-10-28T09:00:00Z"));
  });

  it("handles a window that crosses midnight", () => {
    const s: BotsSchedule = { ...on, windows: [{ startUtc: "23:00", minutes: 180 }] };
    assert.notEqual(windowAt(s, T("2026-10-28T01:30:00Z")), null);
    assert.equal(windowAt(s, T("2026-10-28T02:00:00Z")), null);
    assert.equal(windowAt(s, T("2026-10-27T22:59:59Z")), null);
  });

  it("is never inside a window, and has no next one, when switched off or empty", () => {
    const off: BotsSchedule = { ...on, enabled: false };
    assert.equal(windowAt(off, T("2026-10-27T10:00:00Z")), null);
    assert.equal(nextWindow(off, T("2026-10-27T10:00:00Z")), null);
    const empty: BotsSchedule = { ...on, windows: [] };
    assert.equal(windowAt(empty, T("2026-10-27T10:00:00Z")), null);
    assert.equal(nextWindow(empty, T("2026-10-27T10:00:00Z")), null);
  });

  it("formats the same moment in UTC and Lagos", () => {
    const t = T("2026-10-27T09:00:00Z");
    assert.equal(utcLabel(t), "Tue 27 Oct 09:00 UTC");
    assert.equal(lagosLabel(t), "Tue 27 Oct 10:00 WAT");
    assert.equal(lagosLabel(T("2026-10-27T23:30:00Z")), "Wed 28 Oct 00:30 WAT", "Lagos can be on the next date");
    assert.equal(utcDay(T("2026-10-27T23:59:59Z")), "2026-10-27");
  });
});

describe("runner heartbeat", () => {
  const s = parseSchedule(shipped);
  const vault = (address: string, quoter: string, updatedAt: number) => ({ address, quoter, quoteData: { updatedAt } });
  it("is the newest quote by the listed quoter or probe by the keeper", () => {
    const hb = runnerHeartbeat(
      s,
      [vault(s.vaults.a, s.wallets.quoterA as string, 100), vault(s.vaults.b, s.wallets.quoterB as string, 300)],
      [{ prober: s.wallets.keeper as string, ts: 200 }],
    );
    assert.deepEqual(hb, { at: 300, what: "a quote from maker B" });
    const hb2 = runnerHeartbeat(s, [vault(s.vaults.a, s.wallets.quoterA as string, 100)], [{ prober: (s.wallets.keeper as string).toLowerCase(), ts: 200 }]);
    assert.deepEqual(hb2, { at: 200, what: "a probe from the keeper" });
  });
  it("ignores a quote written by someone else, a vault never quoted and probes by other wallets", () => {
    assert.equal(runnerHeartbeat(s, [vault(s.vaults.a, "0x00000000000000000000000000000000000000aa", 999)], [{ prober: "0x00000000000000000000000000000000000000bb", ts: 999 }]), null);
    assert.equal(runnerHeartbeat(s, [vault(s.vaults.a, s.wallets.quoterA as string, 0)], []), null);
  });
});
