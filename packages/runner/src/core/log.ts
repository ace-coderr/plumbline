/**
 * The runner's only logger. Output is one JSON object per line, redacted as a whole, so nothing that
 * reaches the Workers log can hold a secret. Fields with a secret-sounding name are dropped before
 * they are even serialised.
 */
const SECRET_NAME = /key|secret|token|password|passphrase|mnemonic|seed|auth|bearer|signature/i;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function makeLogger(redact: (s: string) => string, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) safe[k] = SECRET_NAME.test(k) ? "[redacted]" : v;
    let body: string;
    try {
      body = JSON.stringify({ level, event, ...safe }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v));
    } catch {
      body = JSON.stringify({ level, event, note: "fields not serialisable" });
    }
    sink(redact(body));
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

/** First line of an error message, plus the node's own detail when there is one, for a log field. */
export const errText = (e: unknown): string => {
  const x = e as { shortMessage?: string; details?: string } | null;
  const base = (x?.shortMessage ?? (e instanceof Error ? e.message : String(e))).split("\n")[0] ?? "error";
  const detail = typeof x?.details === "string" && x.details && !base.includes(x.details) ? ` (${x.details.split("\n")[0]?.slice(0, 90)})` : "";
  return `${base}${detail}`.slice(0, 220);
};
