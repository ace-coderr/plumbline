import { isAddress } from "viem";
import type { Address } from "./pairs.js";

/**
 * The runner's schedule (bots.schedule.json at the repository root): when the automated bots may run,
 * how much HYPE they may spend, and what they need to run. Pure functions only, so the runner, the
 * status page and the tests all read it the same way. Nothing here holds a secret: wallets are public
 * addresses, and the runner checks that each key it is given belongs to the address listed here.
 */
export const RUNNER_WALLETS = ["keeper", "quoterA", "quoterB", "sponsor", "makerA", "makerB"] as const;
export type RunnerWallet = (typeof RUNNER_WALLETS)[number];

export interface ScheduleWindow {
  /** "HH:MM", UTC, every day. */
  startUtc: string;
  minutes: number;
}

export interface MakerSettings {
  spreadBps: number;
  /** Target size per side, whole base units. */
  size: string;
  skewBps: number;
  /** Between quote refreshes. A quote is stale after 2 s on-chain, so this stays under 1,500. */
  refreshMs: number;
}

/** Where top-ups come from and when to warn that it is running dry. */
export interface TreasurySettings {
  /** Public address of the treasury wallet; null until it has been created. */
  address: Address | null;
  /** Warn (status page, Telegram) when it holds less than this, in HYPE. */
  lowAlertHype: number;
  /** Stop topping up when it holds less than this, in HYPE: what is left pays for the transfers themselves. */
  minHype: number;
}

export interface TopUpSettings {
  enabled: boolean;
  /** How often during a window the wallets are checked, besides at the window's start. */
  checkEveryMinutes: number;
  /** A wallet holding less than this many days of spend gets a top-up. */
  belowDays: number;
  /** ...up to this many days of spend. */
  toDays: number;
  /** Measured daily spend of each wallet over a full window, in HYPE: what "days" means. */
  dailySpendHype: Record<RunnerWallet, number>;
  /** Most HYPE one wallet may receive in a UTC day. */
  perWalletPerDayHype: number;
  /** Most HYPE the treasury may send in a UTC day, in all. */
  totalPerDayHype: number;
}

export interface BotsSchedule {
  /** The master switch. False: nothing runs, whatever the windows say. */
  enabled: boolean;
  windows: ScheduleWindow[];
  /** Most HYPE the runner wallets may spend in one UTC day, in HYPE. */
  dailyHypeCap: number;
  /** Stop everything when a wallet holds less than this, in HYPE. */
  floorHype: Record<RunnerWallet, number>;
  /** Public addresses of the runner wallets; null where the wallet has not been created yet. */
  wallets: Record<RunnerWallet, Address | null>;
  vaults: { a: Address; b: Address };
  campaign: {
    epochLengthSeconds: number;
    rewardPerEpochPlumbusd: number;
    bondPlumbusd: number;
    /** A campaign with less than this left is not counted as running. */
    minRemainingMinutes: number;
    maxSpreadBps: number;
    minDepthBase: string;
    minDepthQuote: string;
    minProbeIntervalSeconds: number;
    probeFeeBps: number;
  };
  maker: { A: MakerSettings; B: MakerSettings };
  referenceCoin: string;
  treasury: TreasurySettings;
  topUp: TopUpSettings;
  alerts: {
    /** The same alert is not sent again within this many minutes. */
    repeatMinutes: number;
    /** Alert when the faucet pool holds less PLUMBUSD than this. */
    faucetLowPlumbusd: number;
    /** Alert when the sponsor wallet holds less PLUMBUSD than this. */
    sponsorLowPlumbusd: number;
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function only(o: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${where}: unknown field "${k}"`);
  for (const k of keys) if (!(k in o)) throw new Error(`${where}: missing field "${k}"`);
}

function num(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`${where}: must be a number from ${min} to ${max}`);
  return v;
}

const addr = (v: unknown, where: string): Address => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${where}: not an address`);
  return v as Address;
};

const decimal = (v: unknown, where: string): string => {
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) throw new Error(`${where}: must be a positive decimal string`);
  return v;
};

function parseMaker(v: unknown, where: string): MakerSettings {
  if (!isObj(v)) throw new Error(`${where}: must be an object`);
  only(v, ["spreadBps", "size", "skewBps", "refreshMs"], where);
  return {
    spreadBps: num(v.spreadBps, `${where}.spreadBps`, 1, 1000),
    size: decimal(v.size, `${where}.size`),
    skewBps: num(v.skewBps, `${where}.skewBps`, 0, 500),
    refreshMs: num(v.refreshMs, `${where}.refreshMs`, 500, 1500),
  };
}

/** Validate a parsed bots.schedule.json. Strict: an unknown or missing field is an error, never ignored. */
export function parseSchedule(raw: unknown): BotsSchedule {
  if (!isObj(raw)) throw new Error("schedule: must be an object");
  only(raw, ["enabled", "windows", "dailyHypeCap", "floorHype", "wallets", "vaults", "campaign", "maker", "referenceCoin", "treasury", "topUp", "alerts"], "schedule");
  if (typeof raw.enabled !== "boolean") throw new Error("schedule.enabled: must be true or false");
  if (!Array.isArray(raw.windows) || raw.windows.length > 6) throw new Error("schedule.windows: must be a list of at most 6");
  const windows = raw.windows.map((w, i): ScheduleWindow => {
    if (!isObj(w)) throw new Error(`schedule.windows[${i}]: must be an object`);
    only(w, ["startUtc", "minutes"], `schedule.windows[${i}]`);
    if (typeof w.startUtc !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.startUtc)) throw new Error(`schedule.windows[${i}].startUtc: must be "HH:MM"`);
    return { startUtc: w.startUtc, minutes: num(w.minutes, `schedule.windows[${i}].minutes`, 5, 720) };
  });
  // Windows may not overlap: two overlapping windows would double the spend the cap is meant to bound.
  const spans = windows.map((w) => {
    const s = Number(w.startUtc.slice(0, 2)) * 60 + Number(w.startUtc.slice(3));
    return [s, s + w.minutes] as const;
  });
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const [a0, a1] = spans[i] as readonly [number, number];
      const [b0, b1] = spans[j] as readonly [number, number];
      const overlap = (x0: number, x1: number, y0: number, y1: number) => x0 < y1 && y0 < x1;
      if (overlap(a0, a1, b0, b1) || overlap(a0, a1, b0 + 1440, b1 + 1440) || overlap(a0 + 1440, a1 + 1440, b0, b1)) {
        throw new Error("schedule.windows: windows overlap");
      }
    }
  }
  if (!isObj(raw.floorHype)) throw new Error("schedule.floorHype: must be an object");
  only(raw.floorHype, RUNNER_WALLETS, "schedule.floorHype");
  if (!isObj(raw.wallets)) throw new Error("schedule.wallets: must be an object");
  only(raw.wallets, RUNNER_WALLETS, "schedule.wallets");
  const floorHype = {} as Record<RunnerWallet, number>;
  const wallets = {} as Record<RunnerWallet, Address | null>;
  for (const w of RUNNER_WALLETS) {
    floorHype[w] = num((raw.floorHype as Record<string, unknown>)[w], `schedule.floorHype.${w}`, 0, 10);
    const a = (raw.wallets as Record<string, unknown>)[w];
    wallets[w] = a === null ? null : addr(a, `schedule.wallets.${w}`);
  }
  if (!isObj(raw.vaults)) throw new Error("schedule.vaults: must be an object");
  only(raw.vaults, ["a", "b"], "schedule.vaults");
  if (!isObj(raw.campaign)) throw new Error("schedule.campaign: must be an object");
  const c = raw.campaign;
  only(c, ["epochLengthSeconds", "rewardPerEpochPlumbusd", "bondPlumbusd", "minRemainingMinutes", "maxSpreadBps", "minDepthBase", "minDepthQuote", "minProbeIntervalSeconds", "probeFeeBps"], "schedule.campaign");
  if (!isObj(raw.maker)) throw new Error("schedule.maker: must be an object");
  only(raw.maker, ["A", "B"], "schedule.maker");
  if (typeof raw.referenceCoin !== "string" || !/^[A-Z0-9]{2,10}$/.test(raw.referenceCoin)) throw new Error("schedule.referenceCoin: must be a coin symbol");
  if (!isObj(raw.treasury)) throw new Error("schedule.treasury: must be an object");
  only(raw.treasury, ["address", "lowAlertHype", "minHype"], "schedule.treasury");
  if (!isObj(raw.topUp)) throw new Error("schedule.topUp: must be an object");
  const tu = raw.topUp;
  only(tu, ["enabled", "checkEveryMinutes", "belowDays", "toDays", "dailySpendHype", "perWalletPerDayHype", "totalPerDayHype"], "schedule.topUp");
  if (typeof tu.enabled !== "boolean") throw new Error("schedule.topUp.enabled: must be true or false");
  if (!isObj(tu.dailySpendHype)) throw new Error("schedule.topUp.dailySpendHype: must be an object");
  only(tu.dailySpendHype, RUNNER_WALLETS, "schedule.topUp.dailySpendHype");
  const dailySpendHype = {} as Record<RunnerWallet, number>;
  for (const w of RUNNER_WALLETS) dailySpendHype[w] = num((tu.dailySpendHype as Record<string, unknown>)[w], `schedule.topUp.dailySpendHype.${w}`, 0.000001, 5);
  const belowDays = num(tu.belowDays, "schedule.topUp.belowDays", 0.5, 60);
  const toDays = num(tu.toDays, "schedule.topUp.toDays", 1, 120);
  if (toDays <= belowDays) throw new Error("schedule.topUp.toDays: must be more than belowDays");
  if (!isObj(raw.alerts)) throw new Error("schedule.alerts: must be an object");
  only(raw.alerts, ["repeatMinutes", "faucetLowPlumbusd", "sponsorLowPlumbusd"], "schedule.alerts");
  return {
    enabled: raw.enabled,
    windows,
    dailyHypeCap: num(raw.dailyHypeCap, "schedule.dailyHypeCap", 0, 5),
    floorHype,
    wallets,
    vaults: { a: addr(raw.vaults.a, "schedule.vaults.a"), b: addr(raw.vaults.b, "schedule.vaults.b") },
    campaign: {
      epochLengthSeconds: num(c.epochLengthSeconds, "schedule.campaign.epochLengthSeconds", 60, 3600),
      rewardPerEpochPlumbusd: num(c.rewardPerEpochPlumbusd, "schedule.campaign.rewardPerEpochPlumbusd", 0.000001, 1000),
      bondPlumbusd: num(c.bondPlumbusd, "schedule.campaign.bondPlumbusd", 0.000001, 1000),
      minRemainingMinutes: num(c.minRemainingMinutes, "schedule.campaign.minRemainingMinutes", 1, 120),
      maxSpreadBps: num(c.maxSpreadBps, "schedule.campaign.maxSpreadBps", 1, 10_000),
      minDepthBase: decimal(c.minDepthBase, "schedule.campaign.minDepthBase"),
      minDepthQuote: decimal(c.minDepthQuote, "schedule.campaign.minDepthQuote"),
      minProbeIntervalSeconds: num(c.minProbeIntervalSeconds, "schedule.campaign.minProbeIntervalSeconds", 1, 600),
      probeFeeBps: num(c.probeFeeBps, "schedule.campaign.probeFeeBps", 0, 1000),
    },
    maker: { A: parseMaker(raw.maker.A, "schedule.maker.A"), B: parseMaker(raw.maker.B, "schedule.maker.B") },
    referenceCoin: raw.referenceCoin,
    treasury: {
      address: raw.treasury.address === null ? null : addr(raw.treasury.address, "schedule.treasury.address"),
      lowAlertHype: num(raw.treasury.lowAlertHype, "schedule.treasury.lowAlertHype", 0, 1000),
      minHype: num(raw.treasury.minHype, "schedule.treasury.minHype", 0, 1000),
    },
    topUp: {
      enabled: tu.enabled,
      checkEveryMinutes: num(tu.checkEveryMinutes, "schedule.topUp.checkEveryMinutes", 5, 240),
      belowDays,
      toDays,
      dailySpendHype,
      perWalletPerDayHype: num(tu.perWalletPerDayHype, "schedule.topUp.perWalletPerDayHype", 0, 100),
      totalPerDayHype: num(tu.totalPerDayHype, "schedule.topUp.totalPerDayHype", 0, 1000),
    },
    alerts: {
      repeatMinutes: num(raw.alerts.repeatMinutes, "schedule.alerts.repeatMinutes", 1, 1440),
      faucetLowPlumbusd: num(raw.alerts.faucetLowPlumbusd, "schedule.alerts.faucetLowPlumbusd", 0, 1e9),
      sponsorLowPlumbusd: num(raw.alerts.sponsorLowPlumbusd, "schedule.alerts.sponsorLowPlumbusd", 0, 1e9),
    },
  };
}

export interface Span {
  /** Unix seconds. */
  start: number;
  end: number;
}

const DAY = 86_400;
const dayStart = (sec: number) => Math.floor(sec / DAY) * DAY;

/** Every window instance that could touch [now - 1 day, now + 2 days], oldest first. */
function instances(s: BotsSchedule, nowSec: number): Span[] {
  const out: Span[] = [];
  for (let d = -1; d <= 2; d++) {
    for (const w of s.windows) {
      const start = dayStart(nowSec) + d * DAY + (Number(w.startUtc.slice(0, 2)) * 60 + Number(w.startUtc.slice(3))) * 60;
      out.push({ start, end: start + w.minutes * 60 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The window running at `nowSec`, or null. Null whenever the schedule is switched off. */
export function windowAt(s: BotsSchedule, nowSec: number): Span | null {
  if (!s.enabled) return null;
  return instances(s, nowSec).find((w) => w.start <= nowSec && nowSec < w.end) ?? null;
}

/** The next window that has not started yet, or null if the schedule is off or has no windows. */
export function nextWindow(s: BotsSchedule, nowSec: number): Span | null {
  if (!s.enabled) return null;
  return instances(s, nowSec).find((w) => w.start > nowSec) ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 27 Oct 09:00 UTC". */
export function utcLabel(sec: number): string {
  const d = new Date(sec * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** The same moment in Lagos (Africa/Lagos, UTC+1 all year): "Tue 27 Oct 10:00 WAT". */
export function lagosLabel(sec: number): string {
  const d = new Date((sec + 3600) * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} WAT`;
}

/** The UTC date a moment falls on, "2026-10-27": the budget day. */
export const utcDay = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

export interface Heartbeat {
  /** Unix seconds of the newest on-chain sign of life. */
  at: number;
  what: string;
}

/**
 * The newest thing a runner wallet did on-chain, as far as a browser can read it: a quote written to one
 * of the runner vaults by its listed quoter, or a probe sent by the keeper. Null when there is none.
 * This is the wallets' heartbeat, not the Worker's: a Worker that is up but cannot send shows none.
 */
export function runnerHeartbeat(
  s: BotsSchedule,
  vaults: { address: string; quoter: string; quoteData: { updatedAt: number } }[],
  probes: { prober: string; ts: number }[],
): Heartbeat | null {
  const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
  let best: Heartbeat | null = null;
  const take = (at: number, what: string) => {
    if (at > 0 && (best === null || at > best.at)) best = { at, what };
  };
  for (const [k, label] of [["a", "maker A"], ["b", "maker B"]] as const) {
    const v = vaults.find((x) => same(s.vaults[k], x.address));
    const quoter = s.wallets[k === "a" ? "quoterA" : "quoterB"];
    if (v && same(quoter, v.quoter)) take(v.quoteData.updatedAt, `a quote from ${label}`);
  }
  for (const p of probes) if (same(s.wallets.keeper, p.prober)) take(p.ts, "a probe from the keeper");
  return best;
}
