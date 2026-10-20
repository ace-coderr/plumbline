import { formatUnits } from "viem";

const PX = 1e18;

/** PX_SCALE price string to a display number. */
export function px(raw: string | bigint | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  return Number(BigInt(raw)) / PX;
}

export function fmtPx(raw: string | bigint | null | undefined, digits = 4): string {
  const v = px(raw);
  return v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Raw token amount to a fixed-digit string. */
export function fmtAmt(raw: string | bigint | null | undefined, decimals: number, digits = 2): string {
  if (raw === null || raw === undefined) return "—";
  const n = Number(formatUnits(BigInt(raw), decimals));
  // Small amounts keep four significant digits instead of rounding to zero.
  if (n !== 0 && Math.abs(n) < 1) {
    const frac = Math.min(8, Math.max(digits, 3 - Math.floor(Math.log10(Math.abs(n)))));
    return n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
  }
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function amtNum(raw: string | bigint | null | undefined, decimals: number): number {
  if (raw === null || raw === undefined) return 0;
  return Number(formatUnits(BigInt(raw), decimals));
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtBps(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined) return "—";
  return x.toFixed(digits);
}

export function fmtInt(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return Math.round(x).toLocaleString("en-US");
}

export function fmtNum(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Plain decimal with `digits` significant figures; never scientific notation (0.000488, not 4.88e-4). */
export function fmtDec(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  return x.toLocaleString("en-US", { maximumSignificantDigits: digits, maximumFractionDigits: 20 });
}

export function short(addr: string | null | undefined, n = 4): string {
  if (!addr) return "—";
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}

/**
 * "5m ago". Against frozen data a time relative to the visitor's clock keeps growing, so in static
 * mode, unless a reference time is passed, it is the absolute UTC time instead.
 */
export function ago(ts: number | null | undefined, nowSec?: number): string {
  if (!ts) return "—";
  if (nowSec === undefined && import.meta.env.VITE_DATA_MODE === "static") return utcTime(ts);
  nowSec ??= Math.floor(Date.now() / 1000);
  const d = Math.max(0, nowSec - ts);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

export function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

export function dateTime(ts: number): string {
  const iso = new Date(ts * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

export function day(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function duration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(sec % 3600 ? 1 : 0)}h`;
  return `${(sec / 86_400).toFixed(1)}d`;
}

export type Tone = "pass" | "warn" | "fail" | "none";

/** Uptime tone for color coding. */
export function tone(x: number | null | undefined): Tone {
  if (x === null || x === undefined) return "none";
  if (x >= 0.95) return "pass";
  if (x >= 0.8) return "warn";
  return "fail";
}

export const toneText: Record<Tone, string> = {
  pass: "text-success",
  warn: "text-ink",
  fail: "text-danger",
  none: "text-muted",
};

/** Dollars, switching to significant digits for sub-cent amounts so they never read as $0.00. */
export function fmtUsd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x === 0) return "$0";
  if (Math.abs(x) >= 0.01) return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${fmtDec(x, 2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Oct 11:37–21:54 UTC" (or spanning days): the window a set of probes covers, always in UTC. */
export function utcWindow(from: number | null | undefined, to: number | null | undefined): string {
  if (!from || !to) return "—";
  const a = new Date(from * 1000);
  const b = new Date(to * 1000);
  const dayOf = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}`;
  const hm = (d: Date) => d.toISOString().slice(11, 16);
  return dayOf(a) === dayOf(b)
    ? `${dayOf(a)} ${hm(a)}–${hm(b)} UTC`
    : `${dayOf(a)} ${hm(a)} – ${dayOf(b)} ${hm(b)} UTC`;
}

/** "19 Oct 21:53 UTC". */
export function utcTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.toISOString().slice(11, 16)} UTC`;
}
