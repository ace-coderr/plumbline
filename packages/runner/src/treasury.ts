import type { PublicClient } from "viem";
import { RUNNER_WALLETS, utcDay, type BotsSchedule, type RunnerWallet } from "@plumbline/shared";
import { Signer, tryEach } from "./chain.js";
import { accountFor, type Env } from "./env.js";
import { type Balances, toWei } from "./core/budget.js";
import { msg } from "./core/alerts.js";
import { errText, type Logger } from "./core/log.js";
import { shortHash } from "./core/redact.js";
import { isListed, parseSent, planTopUp, recordSent, serialiseSent, type Send, type TopUpPlan } from "./core/topup.js";

/**
 * The treasury: sends HYPE to the runner wallets and to nobody else. Every transfer is checked against
 * bots.schedule.json at the moment of sending (a recipient that is not listed is refused), counted against
 * the day's limits before it is sent, and attempted once. A failure stops the rest of that check and
 * waits for the next one, 30 minutes on.
 */
export interface TreasuryCtx {
  env: Env;
  schedule: BotsSchedule;
  storage: DurableObjectStorage;
  clients: PublicClient[];
  log: Logger;
  alert: (key: string, text: string) => Promise<void>;
  /** Asked before every transfer: false once the kill switch is on. */
  stillOn: () => Promise<boolean>;
}

export interface LastTopUp {
  at: number;
  wallet: RunnerWallet;
  amountWei: string;
  tx: string;
}

export interface TopUpResult {
  plan: TopUpPlan | null;
  sent: Send[];
  note: string;
  treasuryWei: bigint | null;
}

const TRANSFER_GAS = 21_000n;
/** At most this many transfers in one check, so a check stays inside the Worker's subrequest budget. */
const MAX_SENDS_PER_CHECK = 4;

/** The treasury's HYPE, from whichever node answers. */
export async function treasuryBalance(c: Pick<TreasuryCtx, "clients" | "schedule">): Promise<bigint | null> {
  const a = c.schedule.treasury.address;
  if (!a) return null;
  return tryEach(c.clients, (cl) => cl.getBalance({ address: a })).catch(() => null);
}

async function sentToday(c: TreasuryCtx, day: string) {
  return parseSent(await c.storage.get<{ day: string; perWallet: Record<string, string>; total: string }>("topUpSent"), day);
}

/** The plan for now, without sending anything. */
export async function planNow(c: TreasuryCtx, nowSec: number, balances: Balances): Promise<{ plan: TopUpPlan; treasuryWei: bigint | null }> {
  const day = utcDay(nowSec);
  const treasuryWei = await treasuryBalance(c);
  if (treasuryWei === null) {
    return { plan: { sends: [], skipped: [], treasuryLow: false, treasuryEmpty: false, off: "the treasury balance could not be read" }, treasuryWei };
  }
  return { plan: planTopUp({ schedule: c.schedule, balances, treasuryWei, sent: await sentToday(c, day), day }), treasuryWei };
}

/** Send one top-up transfer, counted first. Throws if the recipient is not listed or the transfer fails. */
async function sendOne(c: TreasuryCtx, signer: Signer, s: Send, nowSec: number): Promise<void> {
  if (!(await c.stillOn())) throw new Error("the kill switch is on");
  if (!isListed(c.schedule, s.to) || c.schedule.wallets[s.wallet]?.toLowerCase() !== s.to.toLowerCase()) {
    throw new Error(`${s.to} is not a wallet listed in bots.schedule.json`);
  }
  const day = utcDay(nowSec);
  // Counted before it is sent, and kept if the receipt never comes: the limits are upper bounds.
  await c.storage.put("topUpSent", serialiseSent(recordSent(await sentToday(c, day), day, s.wallet, s.amountWei)));
  const receipt = await signer.sendAndConfirm(s.to, "0x", TRANSFER_GAS, 15_000, s.amountWei);
  const last: LastTopUp = { at: nowSec, wallet: s.wallet, amountWei: s.amountWei.toString(), tx: shortHash(receipt.transactionHash) };
  await c.storage.put("lastTopUp", last);
  c.log.info("top-up sent", { wallet: s.wallet, hype: Number(s.amountWei) / 1e18, tx: last.tx });
}

/** One top-up check: plan, then send, once each. Alerts on a low or empty treasury and on a failure. */
export async function runTopUp(c: TreasuryCtx, nowSec: number, balances: Balances): Promise<TopUpResult> {
  const { plan, treasuryWei } = await planNow(c, nowSec, balances);
  if (plan.off) return { plan, sent: [], note: plan.off, treasuryWei };
  if (plan.treasuryEmpty && treasuryWei !== null) await c.alert("treasury-empty", msg.treasuryEmpty(treasuryWei));
  else if (plan.treasuryLow && treasuryWei !== null) await c.alert("treasury-low", msg.treasuryLow(treasuryWei, c.schedule.treasury.lowAlertHype));
  if (plan.sends.length === 0) return { plan, sent: [], note: plan.treasuryEmpty ? "the treasury is too low to top anything up" : "no wallet needs a top-up", treasuryWei };

  let signer: Signer;
  try {
    const account = accountFor(c.env, "treasury", c.schedule);
    if (!account) return { plan, sent: [], note: "TREASURY_KEY is not set", treasuryWei };
    signer = new Signer(account, c.clients);
  } catch (err) {
    await c.alert("topup-key", msg.topUpFailed("treasury", errText(err)));
    return { plan, sent: [], note: errText(err), treasuryWei };
  }
  const sent: Send[] = [];
  for (const s of plan.sends.slice(0, MAX_SENDS_PER_CHECK)) {
    try {
      await sendOne(c, signer, s, nowSec);
      sent.push(s);
    } catch (err) {
      const why = errText(err);
      c.log.warn("top-up failed", { wallet: s.wallet, err: why });
      await c.alert(`topup-failed:${s.wallet}`, msg.topUpFailed(s.wallet, why));
      await c.storage.put("topUpError", { at: nowSec, wallet: s.wallet, reason: why });
      // One failure ends this check; the next one is a scheduled check, not a retry.
      return { plan, sent, note: `a transfer to ${s.wallet} failed: ${why}`, treasuryWei };
    }
  }
  return { plan, sent, note: `topped up ${sent.map((s) => s.wallet).join(", ")}`, treasuryWei };
}

/** The balances after top-ups: what was sent is added, so the cap and floor rules see the new amounts. */
export function withSent(b: Balances, sent: Send[]): Balances {
  const out = { ...b };
  for (const s of sent) out[s.wallet] = out[s.wallet] + s.amountWei;
  return out;
}

/**
 * A live, small test through the same guarded path: one transfer to a listed wallet, at most 0.001 HYPE,
 * counted against the day's limits like any other. For checking the treasury works before relying on it.
 */
export async function testSend(c: TreasuryCtx, nowSec: number, wallet: string, hype: number): Promise<{ ok: boolean; note: string }> {
  if (!(RUNNER_WALLETS as readonly string[]).includes(wallet)) return { ok: false, note: `"${wallet}" is not one of ${RUNNER_WALLETS.join(", ")}` };
  if (!(hype > 0 && hype <= 0.001)) return { ok: false, note: "the test amount must be more than 0 and at most 0.001 HYPE" };
  const w = wallet as RunnerWallet;
  const to = c.schedule.wallets[w];
  if (!to) return { ok: false, note: `${w} has no address in bots.schedule.json` };
  const account = accountFor(c.env, "treasury", c.schedule);
  if (!account) return { ok: false, note: "TREASURY_KEY is not set" };
  const bal = await treasuryBalance(c);
  if (bal === null || bal < toWei(c.schedule.treasury.minHype) + toWei(hype)) return { ok: false, note: "the treasury cannot cover that" };
  try {
    await sendOne(c, new Signer(account, c.clients), { wallet: w, to, amountWei: toWei(hype) }, nowSec);
    return { ok: true, note: `sent ${hype} HYPE to ${w}` };
  } catch (err) {
    return { ok: false, note: errText(err) };
  }
}
