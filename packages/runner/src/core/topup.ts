import { RUNNER_WALLETS, type Address, type BotsSchedule, type RunnerWallet } from "@plumbline/shared";
import { toWei, type Balances } from "./budget.js";

/**
 * Auto top-up planning, pure. A wallet holding less than `belowDays` of its measured daily spend is
 * filled up to `toDays`, from the treasury, within three limits: what one wallet may receive in a UTC
 * day, what the treasury may send in a UTC day, and what the treasury holds. The recipient is always an
 * address read from bots.schedule.json by wallet name; nothing in a plan comes from outside that file.
 */
export interface SentToday {
  /** The UTC day these totals are for; a different day means they start again from zero. */
  day: string;
  perWallet: Partial<Record<RunnerWallet, bigint>>;
  total: bigint;
}

export interface Send {
  wallet: RunnerWallet;
  to: Address;
  amountWei: bigint;
}

export interface TopUpPlan {
  sends: Send[];
  skipped: { wallet: RunnerWallet; reason: string }[];
  /** Under `lowAlertHype`: warn the owner. */
  treasuryLow: boolean;
  /** Under `minHype`: nothing more is sent. */
  treasuryEmpty: boolean;
  /** Why nothing was planned at all, if so. */
  off: string | null;
}

/** The smallest transfer worth sending: below this a top-up is gas for nothing. */
export const MIN_SEND_WEI = toWei(0.00001);

export const emptySentToday = (day: string): SentToday => ({ day, perWallet: {}, total: 0n });

/** The address a wallet name stands for, or null. The one place a recipient is decided. */
export const addressOf = (s: BotsSchedule, w: RunnerWallet): Address | null => s.wallets[w];

/** Whether `to` is one of the wallets bots.schedule.json lists. Every transfer is checked against this. */
export function isListed(s: BotsSchedule, to: string): boolean {
  const t = to.toLowerCase();
  return RUNNER_WALLETS.some((w) => s.wallets[w]?.toLowerCase() === t);
}

/** Days of measured spend a wallet still holds above its floor. */
export function daysLeft(s: BotsSchedule, w: RunnerWallet, balanceWei: bigint): number {
  const spendable = Number(balanceWei - toWei(s.floorHype[w])) / 1e18;
  return Math.max(0, spendable / s.topUp.dailySpendHype[w]);
}

export function planTopUp(i: { schedule: BotsSchedule; balances: Balances; treasuryWei: bigint; sent: SentToday; day: string }): TopUpPlan {
  const { schedule: s, balances, treasuryWei, day } = i;
  const none = (off: string): TopUpPlan => ({ sends: [], skipped: [], treasuryLow: false, treasuryEmpty: false, off });
  if (!s.topUp.enabled) return none("top-ups are switched off");
  if (s.treasury.address === null) return none("there is no treasury address in bots.schedule.json");

  const treasuryLow = treasuryWei < toWei(s.treasury.lowAlertHype);
  const treasuryEmpty = treasuryWei < toWei(s.treasury.minHype);
  const plan: TopUpPlan = { sends: [], skipped: [], treasuryLow, treasuryEmpty, off: null };
  if (treasuryEmpty) return plan;

  // A new UTC day starts the limits again.
  const sent = i.sent.day === day ? i.sent : emptySentToday(day);
  const perWalletCap = toWei(s.topUp.perWalletPerDayHype);
  let totalLeft = toWei(s.topUp.totalPerDayHype) - sent.total;
  let treasuryLeft = treasuryWei - toWei(s.treasury.minHype);

  // Neediest first, so a limit that runs out leaves the healthiest wallets for last.
  const order = RUNNER_WALLETS.filter((w) => addressOf(s, w) !== null).sort(
    (a, b) => daysLeft(s, a, balances[a]) - daysLeft(s, b, balances[b]),
  );
  for (const w of order) {
    const to = addressOf(s, w) as Address;
    const daily = s.topUp.dailySpendHype[w];
    const floor = toWei(s.floorHype[w]);
    if (balances[w] >= toWei(s.topUp.belowDays * daily) + floor) continue;
    const target = toWei(s.topUp.toDays * daily) + floor;
    let amount = target - balances[w];
    const walletLeft = perWalletCap - (sent.perWallet[w] ?? 0n);
    let why: string | null = null;
    if (amount > walletLeft) {
      amount = walletLeft;
      why = "the per-wallet daily limit";
    }
    if (amount > totalLeft) {
      amount = totalLeft;
      why = "the total daily limit";
    }
    if (amount > treasuryLeft) {
      amount = treasuryLeft;
      why = "what the treasury holds";
    }
    if (amount < MIN_SEND_WEI) {
      plan.skipped.push({ wallet: w, reason: `nothing can be sent: ${why ?? "the amount is below the minimum"}` });
      continue;
    }
    plan.sends.push({ wallet: w, to, amountWei: amount });
    totalLeft -= amount;
    treasuryLeft -= amount;
    if (why) plan.skipped.push({ wallet: w, reason: `topped up only partly: ${why}` });
  }
  return plan;
}

/** Add a send to the day's totals (a new day starts from zero). */
export function recordSent(sent: SentToday, day: string, w: RunnerWallet, amountWei: bigint): SentToday {
  const base = sent.day === day ? sent : emptySentToday(day);
  return { day, perWallet: { ...base.perWallet, [w]: (base.perWallet[w] ?? 0n) + amountWei }, total: base.total + amountWei };
}

export const serialiseSent = (s: SentToday): { day: string; perWallet: Record<string, string>; total: string } => ({
  day: s.day,
  perWallet: Object.fromEntries(Object.entries(s.perWallet).map(([k, v]) => [k, (v ?? 0n).toString()])),
  total: s.total.toString(),
});

export function parseSent(raw: { day: string; perWallet: Record<string, string>; total: string } | undefined, day: string): SentToday {
  if (!raw || raw.day !== day) return emptySentToday(day);
  return { day: raw.day, perWallet: Object.fromEntries(Object.entries(raw.perWallet).map(([k, v]) => [k, BigInt(v)])), total: BigInt(raw.total) };
}
