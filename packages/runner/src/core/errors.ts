/**
 * Error reporting, pure. Every uncaught exception and every failed send or call becomes at most one Telegram line per
 * kind of error per hour, with a count of the repeats it hid, and never more than 20 such lines an hour in all.
 */
export const MAX_ERRORS_PER_HOUR = 20;
const HOUR = 3600;

/** A short name for the kind of error, so the same failure repeating is one alert and a different one is another. */
export function errorType(err: unknown): string {
  if (err instanceof Error && err.name && err.name !== "Error") return err.name;
  const text = err instanceof Error ? err.message : String(err);
  if (/rate.?limit|429|too many requests/i.test(text)) return "RateLimit";
  if (/timed? ?out|timeout|aborted/i.test(text)) return "Timeout";
  if (/nonce/i.test(text)) return "Nonce";
  if (/insufficient funds|exceeds the balance/i.test(text)) return "InsufficientFunds";
  if (/revert/i.test(text)) return "Revert";
  if (/fetch failed|network|econn|enotfound|socket/i.test(text)) return "Network";
  return "Error";
}

/** One line of at most `max` characters: no URL, nothing the redactor knows, no line break. */
export function shortError(text: string, scrub: (s: string) => string, max = 140): string {
  const one = scrub(text).replace(/https?:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export interface ErrorGateState {
  /** Per kind of error: when its last alert went out and how many repeats it has hidden since. */
  keys: Record<string, { sentAt: number; suppressed: number }>;
  /** The current hour's tally. It starts at the first alert after the previous hour ended. */
  hour: { start: number; sent: number; capNotified: boolean };
}

export const emptyErrorGate = (): ErrorGateState => ({ keys: {}, hour: { start: 0, sent: 0, capNotified: false } });

export type ErrorVerdict = { do: "send"; repeats: number } | { do: "cap-notice" } | { do: "suppress" };

/** Decides what to do with one error report. Mutates the state; the caller stores it. */
export function gateError(state: ErrorGateState, key: string, nowSec: number, count = 1): ErrorVerdict {
  if (nowSec - state.hour.start >= HOUR) state.hour = { start: nowSec, sent: 0, capNotified: false };
  for (const [k, v] of Object.entries(state.keys)) if (nowSec - v.sentAt >= 2 * HOUR) delete state.keys[k];
  const entry = state.keys[key];
  if (entry && nowSec - entry.sentAt < HOUR) {
    entry.suppressed += count;
    return { do: "suppress" };
  }
  if (state.hour.sent >= MAX_ERRORS_PER_HOUR) {
    // The cap: say so once, count the rest, send nothing more this hour.
    const prior = entry?.suppressed ?? 0;
    state.keys[key] = { sentAt: entry?.sentAt ?? 0, suppressed: prior + count };
    if (state.hour.capNotified) return { do: "suppress" };
    state.hour.capNotified = true;
    return { do: "cap-notice" };
  }
  state.hour.sent += 1;
  const repeats = entry?.suppressed ?? 0;
  state.keys[key] = { sentAt: nowSec, suppressed: 0 };
  return { do: "send", repeats };
}

/** The most recent window that ended at least `graceSec` ago, from the schedule's daily windows (today's and yesterday's). */
export function lastFinishedWindow(windows: { startUtc: string; minutes: number }[], nowSec: number, graceSec: number): { start: number; end: number } | null {
  const day0 = Math.floor(nowSec / 86_400) * 86_400;
  const spans = [0, -86_400].flatMap((off) =>
    windows.map((w) => {
      const [h, m] = w.startUtc.split(":").map(Number) as [number, number];
      const start = day0 + off + h * 3600 + m * 60;
      return { start, end: start + w.minutes * 60 };
    }),
  );
  return spans.filter((s) => s.end + graceSec <= nowSec).sort((a, b) => b.start - a.start)[0] ?? null;
}
