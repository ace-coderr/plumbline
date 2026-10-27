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
  summary: (s: { probesLanded: number; probesSent: number; probesReverted: number; spentWei: bigint; minDays: number; worst: string; treasuryWei: bigint }) =>
    `Plumbline runner, window done: ${s.probesLanded} probes landed (${s.probesSent} sent, ${s.probesReverted} reverted), ${hype(s.spentWei)} HYPE spent. Least funding left: ${s.worst}, ${s.minDays.toFixed(1)} days. Treasury ${hype(s.treasuryWei)} HYPE.`,
};
