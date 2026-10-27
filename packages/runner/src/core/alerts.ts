import { errText } from "./log.js";

/**
 * Telegram alerts. Every message is built from numbers and names (never a URL or a secret) and goes through
 * the redactor before it leaves; the bot token and chat id are Worker secrets. The same alert is never sent
 * twice within `repeatMinutes`, whatever calls it.
 */
export type AlertGate = Record<string, number>;

/** True, and the time recorded, when `key` has not been sent within `repeatMinutes`. */
export function gate(state: AlertGate, key: string, nowSec: number, repeatMinutes: number): boolean {
  const last = state[key];
  if (last !== undefined && nowSec - last < repeatMinutes * 60) return false;
  state[key] = nowSec;
  return true;
}

/** Forget entries older than a day so the stored gate stays small. */
export function prune(state: AlertGate, nowSec: number): AlertGate {
  return Object.fromEntries(Object.entries(state).filter(([, t]) => nowSec - t < 86_400));
}

export interface TelegramConfig {
  token: string | undefined;
  chatId: string | undefined;
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** Send one message. Never throws; the error text is scrubbed. */
export async function sendTelegram(cfg: TelegramConfig, text: string, scrubText: (s: string) => string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!cfg.token || !cfg.chatId) return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)" };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: scrubText(text).slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: scrubText(`Telegram answered ${res.status}`) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: scrubText(errText(err)) };
  }
}

const hype = (wei: bigint | number): string => (typeof wei === "bigint" ? Number(wei) / 1e18 : wei).toFixed(4);

/** The one-line forms of every alert, so wording lives in one place and tests can see it. */
export const msg = {
  treasuryLow: (balanceWei: bigint, lowAt: number) => `Plumbline runner: the treasury holds ${hype(balanceWei)} HYPE, under ${lowAt}. Top it up from the deployer.`,
  treasuryEmpty: (balanceWei: bigint) => `Plumbline runner: the treasury is down to ${hype(balanceWei)} HYPE, too low to top anything up. Wallets will run dry.`,
  topUpFailed: (wallet: string, reason: string) => `Plumbline runner: a top-up of ${wallet} failed (${reason}). It will not be retried until the next check.`,
  halted: (kind: string, reason: string) => `Plumbline runner: halted (${kind}): ${reason}`,
  capHit: (reason: string) => `Plumbline runner: the daily HYPE cap was reached, so the bots stopped for today. ${reason}`,
  walletUnderFloor: (reason: string) => `Plumbline runner: a wallet is under its floor, so the bots stopped. ${reason}`,
  windowFailed: (role: string, reason: string) => `Plumbline runner: ${role} ended early in the window: ${reason}`,
  rpcFallback: () => `Plumbline runner: the private RPC node failed; the runner is using the public nodes, which rate-limit.`,
  kill: () => `Plumbline runner: the kill switch was used. All bots are stopped until /resume.`,
  resumed: () => `Plumbline runner: /resume was used. The kill switch is off.`,
  faucetLow: (plumbusd: number, lowAt: number) => `Plumbline runner: the faucet pool holds ${Math.floor(plumbusd).toLocaleString("en-US")} PLUMBUSD, under ${lowAt.toLocaleString("en-US")}. Mint more from the deployer.`,
  sponsorLow: (plumbusd: number, lowAt: number) => `Plumbline runner: the sponsor wallet holds ${Math.floor(plumbusd).toLocaleString("en-US")} PLUMBUSD, under ${lowAt.toLocaleString("en-US")}. Mint more from the deployer.`,
  test: () => `Plumbline runner: test alert. If you can read this, alerts work.`,
  /** After each window: figures from the chain for the window, then the whole-day HYPE figure, labelled as such. */
  summary: (s: {
    label: string;
    window: { sent: number; landed: number; reverted: number; revertedPct: number; settles: number; gasWei: bigint; revertedGasWei: bigint; revertedGasUsed: bigint; mismatch: boolean } | null;
    /** Why the chain figures are missing, and the runner's own counters instead, if so. */
    unavailable?: { reason: string; counters: { sent: number; landed: number; reverted: number } | null };
    dayWei: bigint;
    minDays: number;
    worst: string;
    treasuryWei: bigint;
    restarts: number[];
  }) => {
    const w = s.window;
    const head = w
      ? `Plumbline runner, window ${s.label}: ${w.sent} probes sent, ${w.landed} landed, ${w.reverted} reverted (${w.revertedPct.toFixed(1)}%), ${w.settles} settles. Keeper gas in the window: ${hype(w.gasWei)} HYPE (reverted probes: ${hype(w.revertedGasWei)} HYPE, ${w.revertedGasUsed.toString()} gas).`
      : `Plumbline runner, window ${s.label}: chain figures unavailable (${s.unavailable?.reason ?? "unknown"}).${s.unavailable?.counters ? ` The runner's own counters, which may be partial: ${s.unavailable.counters.sent} sent, ${s.unavailable.counters.landed} landed, ${s.unavailable.counters.reverted} reverted.` : ""}`;
    const lines = [head];
    if (w?.mismatch) lines.push("Check: landed does not equal sent minus reverted, so some probe is unaccounted for.");
    if (s.restarts.length) lines.push(`The keeper restarted ${s.restarts.length} time(s) in the window, at ${s.restarts.map((t) => new Date(t * 1000).toISOString().slice(11, 19)).join(", ")} UTC.`);
    lines.push(`HYPE spent today (the whole UTC day so far, all six runner wallets, by balance change): ${hype(s.dayWei)}. Least funding left: ${s.worst}, ${s.minDays.toFixed(1)} days. Treasury ${hype(s.treasuryWei)} HYPE.`);
    return lines.join("\n");
  },
  keeperRestarted: (atSec: number, role: string) => `Plumbline runner: the ${role} bot restarted mid-window at ${new Date(atSec * 1000).toISOString().slice(11, 19)} UTC. Its counters were kept.`,
};
