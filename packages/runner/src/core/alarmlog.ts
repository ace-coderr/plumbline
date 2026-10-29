/**
 * A small rolling record of how each alarm went, kept in Durable Object storage, so that when something resets we can see what the
 * last minutes looked like: how many alarms ran, how long the slowest took, how late the runtime started them, and how many failed.
 * One bucket per minute, the last two hours. It holds numbers and error kinds (names like "Timeout"), never a message, URL or key.
 */
export interface AlarmBucket {
  /** The minute this bucket covers, Unix seconds, rounded down to a minute. */
  m: number;
  n: number;
  /** Alarms that failed. */
  err: number;
  /** Alarms that took SLOW_MS or longer. */
  slow: number;
  maxMs: number;
  sumMs: number;
  /** The most any alarm started after the time it was set for: a long delay means the runtime was away. */
  maxLateMs: number;
  /** Failures by kind. */
  types: Record<string, number>;
}

export const SLOW_MS = 2_000;
export const MAX_BUCKETS = 120;

export interface RecordResult {
  /** A new minute began: the previous one is complete and worth saving. */
  rolled: boolean;
  /** Something worth saving at once: a failure or a slow alarm. */
  urgent: boolean;
}

/** Adds one alarm to the record. `outcome` is "ok" or the kind of error; `slowMs` is what counts as slow for this bot. Mutates `buckets`. */
export function recordAlarm(buckets: AlarmBucket[], nowSec: number, ms: number, lateMs: number, outcome: string, slowMs = SLOW_MS): RecordResult {
  const minute = Math.floor(nowSec / 60) * 60;
  let b = buckets[buckets.length - 1];
  let rolled = false;
  if (!b || b.m !== minute) {
    b = { m: minute, n: 0, err: 0, slow: 0, maxMs: 0, sumMs: 0, maxLateMs: 0, types: {} };
    buckets.push(b);
    rolled = buckets.length > 1;
    if (buckets.length > MAX_BUCKETS) buckets.splice(0, buckets.length - MAX_BUCKETS);
  }
  b.n += 1;
  b.sumMs += Math.round(ms);
  b.maxMs = Math.max(b.maxMs, Math.round(ms));
  b.maxLateMs = Math.max(b.maxLateMs, Math.round(lateMs));
  const slow = ms >= slowMs;
  if (slow) b.slow += 1;
  if (outcome !== "ok") {
    b.err += 1;
    const kind = outcome.slice(0, 40);
    b.types[kind] = (b.types[kind] ?? 0) + 1;
  }
  return { rolled, urgent: slow || outcome !== "ok" };
}

export interface AlarmSummary {
  minutes: number;
  alarms: number;
  errors: number;
  slow: number;
  avgMs: number;
  maxMs: number;
  maxLateMs: number;
  types: Record<string, number>;
}

/** The record over the last `minutes` minutes. */
export function summarizeAlarms(buckets: AlarmBucket[], nowSec: number, minutes: number): AlarmSummary {
  const since = nowSec - minutes * 60;
  const mine = buckets.filter((b) => b.m + 60 > since);
  const alarms = mine.reduce((a, b) => a + b.n, 0);
  const types: Record<string, number> = {};
  for (const b of mine) for (const [k, v] of Object.entries(b.types)) types[k] = (types[k] ?? 0) + v;
  return {
    minutes,
    alarms,
    errors: mine.reduce((a, b) => a + b.err, 0),
    slow: mine.reduce((a, b) => a + b.slow, 0),
    avgMs: alarms === 0 ? 0 : Math.round(mine.reduce((a, b) => a + b.sumMs, 0) / alarms),
    maxMs: mine.reduce((a, b) => Math.max(a, b.maxMs), 0),
    maxLateMs: mine.reduce((a, b) => Math.max(a, b.maxLateMs), 0),
    types,
  };
}
