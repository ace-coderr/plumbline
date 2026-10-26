import { parseUnits } from "viem";
import type { Address, BotsSchedule } from "@plumbline/shared";

/**
 * Campaign manager planning, pure. The runner needs one running v2 campaign on WHYPE/PLUMBUSD that
 * both runner vaults are bonded into; this decides what is missing. It never decides to retry: the
 * caller makes each attempt once and halts on failure.
 */
export interface CampaignLite {
  /** The id on the v2 contract. */
  id: number;
  base: Address;
  quote: Address;
  rewardToken: Address;
  startTime: number;
  numEpochs: number;
  epochLength: number;
  /** Vaults bonded into it. */
  vaults: Address[];
}

export interface Tokens {
  base: Address;
  quote: Address;
  reward: Address;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const endOf = (c: CampaignLite): number => c.startTime + c.numEpochs * c.epochLength;

/** Running now, on the right pair and reward token, with at least `minRemainingMinutes` left. */
export function isUsable(c: CampaignLite, nowSec: number, minRemainingMinutes: number, t: Tokens): boolean {
  return (
    same(c.base, t.base) &&
    same(c.quote, t.quote) &&
    same(c.rewardToken, t.reward) &&
    c.startTime <= nowSec &&
    endOf(c) - nowSec >= minRemainingMinutes * 60
  );
}

/** Epochs to open a campaign with: the rest of the window plus a margin, so it does not end mid-window. */
export function epochsFor(windowEndSec: number, nowSec: number, epochLengthSeconds: number): number {
  const margin = 30 * 60;
  const n = Math.ceil((windowEndSec - nowSec + margin) / epochLengthSeconds);
  return Math.min(120, Math.max(6, n));
}

export type Plan =
  | { kind: "ok"; id: number }
  | { kind: "register"; id: number; vaults: ("a" | "b")[] }
  | { kind: "open"; epochs: number };

export function plan(campaigns: CampaignLite[], schedule: BotsSchedule, nowSec: number, windowEndSec: number, t: Tokens): Plan {
  const usable = campaigns.filter((c) => isUsable(c, nowSec, schedule.campaign.minRemainingMinutes, t)).sort((a, b) => endOf(b) - endOf(a));
  const c = usable[0];
  if (!c) return { kind: "open", epochs: epochsFor(windowEndSec, nowSec, schedule.campaign.epochLengthSeconds) };
  const missing = (["a", "b"] as const).filter((k) => !c.vaults.some((v) => same(v, schedule.vaults[k])));
  return missing.length ? { kind: "register", id: c.id, vaults: missing } : { kind: "ok", id: c.id };
}

/** What a plan costs in PLUMBUSD (raw, 6 decimals): the pot to fund and the bonds to post. */
export function funding(schedule: BotsSchedule, p: Plan): { pot: bigint; bonds: bigint } {
  const dec = 6;
  const bond = parseUnits(String(schedule.campaign.bondPlumbusd), dec);
  const reward = parseUnits(String(schedule.campaign.rewardPerEpochPlumbusd), dec);
  if (p.kind === "open") return { pot: reward * BigInt(p.epochs), bonds: bond * 2n };
  if (p.kind === "register") return { pot: 0n, bonds: bond * BigInt(p.vaults.length) };
  return { pot: 0n, bonds: 0n };
}
