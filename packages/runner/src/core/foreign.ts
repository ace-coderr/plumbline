/**
 * The budget for probing campaigns that the runner's own wallets did not open ("other campaigns"), pure.
 *
 * The keeper probes the six newest campaigns, whoever opened them, and each probe costs gas. Other people's campaigns are probed from
 * a separate daily budget so they cannot use up the daily spend cap that keeps the runner's own campaign running. When the budget is
 * used up the keeper stops probing other campaigns for the rest of the UTC day. It never stops probing the runner's own campaign:
 * a campaign counts as "other" only when its creator is known and is not one of the runner's wallets; anything unknown is treated as own.
 */
export interface OtherLedger {
  /** The UTC day these figures are for; a different day starts again from nothing. */
  day: string;
  /** Gas actually paid for other campaigns' probes whose receipts have come back, wei. */
  spentWei: bigint;
  /** Per campaign id: probes sent and gas paid so far today. */
  campaigns: Record<number, { probes: number; costWei: bigint }>;
  /** The budget is used up: no more probes of other campaigns today. */
  stopped: boolean;
  /** The one alert about it has been sent. */
  alerted: boolean;
}

/** What a probe is assumed to cost until its receipt says otherwise: about 150,000 gas at Elysium's flat 0.1 gwei. */
export const ESTIMATED_PROBE_WEI = 150_000n * 100_020_000n;

export const emptyLedger = (day: string): OtherLedger => ({ day, spentWei: 0n, campaigns: {}, stopped: false, alerted: false });

/** True only for a campaign whose creator is known and is not one of the runner's wallets. */
export function isOther(creator: string | undefined, own: ReadonlySet<string>): boolean {
  return typeof creator === "string" && creator.length > 0 && !own.has(creator.toLowerCase());
}

/** The ledger for `day`: the same one if it is for that day, otherwise a fresh one. */
export const ledgerFor = (ledger: OtherLedger, day: string): OtherLedger => (ledger.day === day ? ledger : emptyLedger(day));

/** What is left of the budget, counting probes already sent whose cost is not yet known at the estimate. */
export function remainingWei(ledger: OtherLedger, budgetWei: bigint, inFlight: number, estimateWei = ESTIMATED_PROBE_WEI): bigint {
  return budgetWei - ledger.spentWei - BigInt(inFlight) * estimateWei;
}

/** Whether one more probe of another campaign may be sent now. Marks the ledger stopped the moment it cannot. */
export function mayProbeOther(ledger: OtherLedger, budgetWei: bigint, inFlight: number): boolean {
  if (ledger.stopped) return false;
  if (remainingWei(ledger, budgetWei, inFlight) <= 0n) {
    ledger.stopped = true;
    return false;
  }
  return true;
}

/** Counts a probe of another campaign as sent. */
export function countOtherProbe(ledger: OtherLedger, id: number): void {
  const c = (ledger.campaigns[id] ??= { probes: 0, costWei: 0n });
  c.probes += 1;
}

/** Charges a probe's real gas cost, from its receipt. */
export function chargeOther(ledger: OtherLedger, id: number, costWei: bigint): void {
  const c = (ledger.campaigns[id] ??= { probes: 0, costWei: 0n });
  c.costWei += costWei;
  ledger.spentWei += costWei;
}

/** The tracks worth polling: everything, minus other people's campaigns once the budget has stopped them. The runner's own are never removed. */
export function allowedTracks<T extends { creator?: string }>(tracks: T[], own: ReadonlySet<string>, ledger: OtherLedger): T[] {
  if (!ledger.stopped) return tracks;
  return tracks.filter((t) => !isOther(t.creator, own));
}

export interface SerialLedger {
  day: string;
  spentWei: string;
  campaigns: Record<string, { probes: number; costWei: string }>;
  stopped: boolean;
  alerted: boolean;
}

export const serialiseLedger = (l: OtherLedger): SerialLedger => ({
  day: l.day,
  spentWei: l.spentWei.toString(),
  campaigns: Object.fromEntries(Object.entries(l.campaigns).map(([k, v]) => [k, { probes: v.probes, costWei: v.costWei.toString() }])),
  stopped: l.stopped,
  alerted: l.alerted,
});

export function parseLedger(raw: SerialLedger | undefined, day: string): OtherLedger {
  if (!raw || raw.day !== day) return emptyLedger(day);
  return {
    day: raw.day,
    spentWei: BigInt(raw.spentWei),
    campaigns: Object.fromEntries(Object.entries(raw.campaigns).map(([k, v]) => [Number(k), { probes: v.probes, costWei: BigInt(v.costWei) }])),
    stopped: raw.stopped,
    alerted: raw.alerted,
  };
}
