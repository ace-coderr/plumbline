/**
 * Log redaction. Every line the runner writes goes through here, so a private key or a secret value
 * cannot reach a log even if some code path interpolates one by mistake.
 *
 * Two layers: the exact secret values the runner holds (in every common spelling), and a pattern for
 * anything shaped like a 32-byte hex value, which is what a private key looks like. A transaction hash
 * has the same shape, so hashes are shortened with `shortHash` before they are logged.
 */
/**
 * The pieces of a secret that must also be removed on their own. A node URL carries its API key in the
 * path (or query), and an error may print the whole URL, only the path, a segment, or the encoded form.
 */
export function expandSecrets(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    out.add(v);
    try {
      out.add(decodeURIComponent(v));
    } catch {
      // not URI-encoded
    }
    out.add(encodeURIComponent(v));
    try {
      const u = new URL(v);
      for (const part of [u.pathname, u.pathname.slice(1), u.search, u.search.slice(1), u.username, u.password, u.href, u.href.replace(/\/$/, "")]) out.add(part);
      for (const seg of u.pathname.split("/")) if (seg) out.add(seg);
      for (const val of u.searchParams.values()) out.add(val);
    } catch {
      // not a URL
    }
  }
  return [...out].filter((s) => s.length >= 8);
}

const SHAPE = /(?:0x)?[0-9a-fA-F]{64}/g;

export function makeRedactor(secrets: readonly (string | undefined | null)[]): (text: string) => string {
  const needles = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    const bare = s.replace(/^0x/i, "");
    for (const v of [s, s.toLowerCase(), s.toUpperCase(), bare, bare.toLowerCase(), bare.toUpperCase(), `0x${bare.toLowerCase()}`]) {
      if (v.length >= 8) needles.add(v);
    }
  }
  // Longest first, so a secret that contains another is removed whole.
  const list = [...needles].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const n of list) out = out.split(n).join("[redacted]");
    return out.replace(SHAPE, "[redacted-hex]");
  };
}

/** A transaction hash as it may be logged: enough to find on the explorer, not 64 hex characters. */
export const shortHash = (h: string): string => (h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
