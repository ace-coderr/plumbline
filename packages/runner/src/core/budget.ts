import { RUNNER_WALLETS, utcDay, windowAt, type BotsSchedule, type RunnerWallet, type Span } from "@plumbline/shared";

/**
 * What the supervisor does next, as a pure function of the schedule, the clock and the balances, so
 * every rule that stops the bots can be tested without a chain.
 */
export type Balances = Record<RunnerWallet, bigint>;

export interface Halt {
  kind: "cap" | "floor" | "sponsor" | "campaign" | "config" | "rpc";
  reason: string;
  /** The UTC day it happened on: a cap halt ends with the day. */
  day: string;
  /** The window it happened in: every other halt ends with the window. */
  windowStart: number;
  at: number;
}

export interface DayStart {
  day: string;
  balances: Balances;
}

export interface DecideInput {
  schedule: BotsSchedule;
  nowSec: number;
  killed: boolean;
  halt: Halt | null;
  /** Null when the balances could not be read. */
  balances: Balances | null;
  dayStart: DayStart | null;
}

export type Decision =
  | { action: "idle"; reason: string }
  | { action: "hold"; reason: string; window: Span }
  | { action: "stop"; halt: Halt }
  | { action: "run"; window: Span; spentWei: bigint };

export const toWei = (hype: number): bigint => BigInt(Math.round(hype * 1e9)) * 1_000_000_000n;

/** HYPE spent since the day began: only decreases count, so topping a wallet up never hides spending. */
export function spentToday(dayStart: DayStart, now: Balances): bigint {
  let spent = 0n;
  for (const w of RUNNER_WALLETS) {
    const before = dayStart.balances[w];
    const after = now[w];
    if (before > after) spent += before - after;
  }
  return spent;
}

export function decide(i: DecideInput): Decision {
  const { schedule, nowSec } = i;
  if (i.killed) return { action: "idle", reason: "kill switch is on" };
  if (!schedule.enabled) return { action: "idle", reason: "the schedule is switched off" };
  const window = windowAt(schedule, nowSec);
  if (!window) return { action: "idle", reason: "outside the scheduled windows" };

  const day = utcDay(nowSec);
  const h = i.halt;
  if (h && (h.kind === "cap" ? h.day === day : h.windowStart === window.start)) {
    return { action: "idle", reason: `halted: ${h.reason}` };
  }
  if (!i.balances) return { action: "hold", reason: "balances could not be read", window };

  const halt = (kind: Halt["kind"], reason: string): Decision => ({ action: "stop", halt: { kind, reason, day, windowStart: window.start, at: nowSec } });
  // A day that has no snapshot yet starts from the balances as they are now.
  const start = i.dayStart && i.dayStart.day === day ? i.dayStart : { day, balances: i.balances };
  const spent = spentToday(start, i.balances);
  const cap = toWei(schedule.dailyHypeCap);
  if (spent >= cap) return halt("cap", `spent ${fmt(spent)} HYPE today, the daily cap is ${schedule.dailyHypeCap}`);
  for (const w of RUNNER_WALLETS) {
    if (schedule.wallets[w] === null) continue;
    if (i.balances[w] < toWei(schedule.floorHype[w])) {
      return halt("floor", `${w} holds ${fmt(i.balances[w])} HYPE, below its floor of ${schedule.floorHype[w]}`);
    }
  }
  return { action: "run", window, spentWei: spent };
}

const fmt = (wei: bigint): string => (Number(wei) / 1e18).toFixed(6);
