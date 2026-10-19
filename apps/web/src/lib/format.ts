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

/** Very small or very large numbers in a readable fixed or scientific form. */
export function fmtSci(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 0.001 && a < 1e9) return x.toLocaleString("en-US", { maximumSignificantDigits: digits + 1 });
  return x.toExponential(digits);
}

export function short(addr: string | null | undefined, n = 4): string {
  if (!addr) return "—";
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}

export function ago(ts: number | null | undefined, nowSec = Math.floor(Date.now() / 1000)): string {
  if (!ts) return "—";
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
  return `$${x.toPrecision(2)}`;
}
