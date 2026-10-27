import { RUNNER_WALLETS, type BotsSchedule } from "@plumbline/shared";
import { daysLeft } from "./topup.js";
import { toWei, type Balances } from "./budget.js";
import type { WindowFigures } from "./windowSummary.js";

/**
 * The health checks as plain data, so the runner's daily summary and `pnpm check:all` use the same code. Each builder takes
 * values somebody has already read (balances, a node's answer, the runner's state) and returns lines; none of them reads the
 * network, so the runner reuses what its summary has already fetched.
 */
export interface HealthLine {
  /** The block this line belongs to in the short Telegram form. */
  group: "RPC" | "Runner" | "Wallets" | "Treasury" | "PLUMBUSD" | "Window";
  name: string;
  ok: boolean;
  detail: string;
}

const line = (group: HealthLine["group"], name: string, ok: boolean, detail: string): HealthLine => ({ group, name, ok, detail });
const hype = (wei: bigint) => (Number(wei) / 1e18).toFixed(4);

export interface NodeResult {
  name: string;
  ok: boolean;
  /** Block number and time on success, a short reason on failure. Never a URL. */
  detail: string;
}

export const rpcLines = (nodes: NodeResult[]): HealthLine[] => nodes.map((n) => line("RPC", `RPC ${n.name}`, n.ok, n.detail));

export interface RunnerState {
  nowSec: number;
  lastTickAt: number | null;
  killed: boolean;
  halt: { kind: string; reason: string } | null;
  scheduleEnabled: boolean;
}

/** The runner's own state. A tick older than three minutes means the every-minute cron is not waking it. */
export function runnerLines(s: RunnerState): HealthLine[] {
  const age = s.lastTickAt ? s.nowSec - s.lastTickAt : null;
  return [
    age === null || age > 180
      ? line("Runner", "runner health", false, `the supervisor's last tick was ${age === null ? "never" : `${age} s ago`} (the cron should wake it every minute)`)
      : line("Runner", "runner health", true, `last tick ${age} s ago`),
    s.killed ? line("Runner", "runner kill switch", false, "the kill switch is ON") : line("Runner", "runner kill switch", true, "off"),
    s.halt ? line("Runner", "runner halt", false, `halted (${s.halt.kind}): ${s.halt.reason}`) : line("Runner", "runner halt", true, "no halt"),
    s.scheduleEnabled ? line("Runner", "runner schedule", true, "on") : line("Runner", "runner schedule", false, "bots.schedule.json has enabled:false"),
  ];
}

/** Every listed bot wallet against its floor, with the days of funding left. */
export function walletLines(schedule: BotsSchedule, balances: Balances): HealthLine[] {
  return RUNNER_WALLETS.filter((w) => schedule.wallets[w] !== null).map((w) => {
    const floor = schedule.floorHype[w];
    const days = daysLeft(schedule, w, balances[w]).toFixed(1);
    return balances[w] < toWei(floor)
      ? line("Wallets", `wallet ${w}`, false, `${hype(balances[w])} HYPE is under its floor of ${floor}`)
      : line("Wallets", `wallet ${w}`, true, `${hype(balances[w])} HYPE, ${days} days of funding (floor ${floor})`);
  });
}

export function treasuryLine(schedule: BotsSchedule, wei: bigint | null): HealthLine {
  if (schedule.treasury.address === null) return line("Treasury", "treasury", false, "no treasury address in bots.schedule.json");
  if (wei === null) return line("Treasury", "treasury", false, "the balance could not be read");
  return wei < toWei(schedule.treasury.lowAlertHype)
    ? line("Treasury", "treasury", false, `${hype(wei)} HYPE is under ${schedule.treasury.lowAlertHype}`)
    : line("Treasury", "treasury", true, `${hype(wei)} HYPE (alert under ${schedule.treasury.lowAlertHype})`);
}

/** Whole-token PLUMBUSD at the sponsor and the faucet; null means unreadable or not set. */
export function plumbusdLines(schedule: BotsSchedule, sponsor: number | null, faucet: number | null, hasFaucet = true): HealthLine[] {
  const n = (x: number) => Math.floor(x).toLocaleString("en-US");
  const out: HealthLine[] = [];
  if (schedule.wallets.sponsor) {
    const low = schedule.alerts.sponsorLowPlumbusd;
    out.push(
      sponsor === null
        ? line("PLUMBUSD", "sponsor PLUMBUSD", false, "the balance could not be read")
        : sponsor < low
          ? line("PLUMBUSD", "sponsor PLUMBUSD", false, `${n(sponsor)} is under ${n(low)}`)
          : line("PLUMBUSD", "sponsor PLUMBUSD", true, `${n(sponsor)} (alert under ${n(low)})`),
    );
  }
  if (hasFaucet) {
    const low = schedule.alerts.faucetLowPlumbusd;
    out.push(
      faucet === null
        ? line("PLUMBUSD", "faucet pool PLUMBUSD", false, "the balance could not be read")
        : faucet < low
          ? line("PLUMBUSD", "faucet pool PLUMBUSD", false, `${n(faucet)} is under ${n(low)}`)
          : line("PLUMBUSD", "faucet pool PLUMBUSD", true, `${n(faucet)} (alert under ${n(low)})`),
    );
  }
  return out;
}

/**
 * The window's figures against themselves and, if the runner kept its own tally, against that. Landed must be sent minus
 * reverted; the runner's counters may differ by up to two (probes still in flight when the window ended).
 */
export function windowLines(f: WindowFigures | null, counters: { sent: number; landed: number; reverted: number } | null, reason?: string): HealthLine[] {
  if (!f) return [line("Window", "window summary vs chain", false, `the chain figures could not be read${reason ? `: ${reason}` : ""}`)];
  if (f.mismatch) return [line("Window", "window summary vs chain", false, "landed does not equal sent minus reverted")];
  if (counters) {
    const d = Math.max(Math.abs(counters.sent - f.probesSent), Math.abs(counters.landed - f.probesLanded), Math.abs(counters.reverted - f.probesReverted));
    if (d > 2) return [line("Window", "window summary vs chain", false, `the runner's own tally (${counters.sent}/${counters.landed}/${counters.reverted}) differs from the chain (${f.probesSent}/${f.probesLanded}/${f.probesReverted})`)];
  }
  return [line("Window", "window summary vs chain", true, counters ? "the runner's tally matches the chain" : "landed equals sent minus reverted")];
}

const GROUP_ORDER: HealthLine["group"][] = ["RPC", "Runner", "Wallets", "Treasury", "PLUMBUSD", "Window"];

/** The short form for Telegram: one line per group, with the detail only where something failed. */
export function formatHealth(lines: HealthLine[]): { text: string; failed: HealthLine[] } {
  const failed = lines.filter((l) => !l.ok);
  const rows = GROUP_ORDER.flatMap((g) => {
    const mine = lines.filter((l) => l.group === g);
    if (mine.length === 0) return [];
    const bad = mine.filter((l) => !l.ok);
    if (bad.length === 0) return [`PASS ${g}${g === "RPC" || g === "Wallets" ? ` (${mine.length}/${mine.length})` : ""}`];
    return bad.map((l) => `FAIL ${l.name}: ${l.detail}`);
  });
  return { text: `Health: ${failed.length === 0 ? "all checks passed" : `${failed.length} failed`}\n${rows.join("\n")}`, failed };
}
