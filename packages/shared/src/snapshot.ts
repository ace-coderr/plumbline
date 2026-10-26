/**
 * Static snapshot layout. The exporter (scripts/export-static.ts) writes each indexer API response to
 * the file this module names, and the web app in static mode reads the same file instead of calling
 * the API. One mapping, used by both sides, so they cannot drift apart.
 */

/** Where snapshot files live under the web app's public root. */
export const SNAPSHOT_DIR = "snapshot";

/**
 * Windows exported for frozen data. Rolling windows (24h, 7d) measured back from export time would
 * all hold the same probes, so a snapshot carries one window: every campaign on the market.
 */
export const SNAPSHOT_WINDOW = "all";

/** Provenance stamped on every snapshot. */
export interface SnapshotMeta {
  chainId: number;
  /** Indexed up to and including this block. */
  block: number;
  /** That block's timestamp, unix seconds (UTC). */
  blockTimestamp: number;
  /** When the export ran, ISO 8601 UTC. */
  takenAt: string;
  contracts: { factory: string; router: string; campaigns: string };
  explorerUrl: string;
}

/**
 * Snapshot file for an API path (path plus optional query string), relative to SNAPSHOT_DIR.
 * Returns null for paths the snapshot does not carry.
 */
export function snapshotFile(apiPath: string): string | null {
  const [path = "", query = ""] = apiPath.split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [head, a, b] = parts;
  const window = params.get("window");
  switch (head) {
    case "health":
      return "health.json";
    case "economics":
      return "economics.json";
    case "markets":
      if (!a) return "markets.json";
      if (b === "uptime") return `markets/${a}/uptime-${window ?? "24h"}.json`;
      return `markets/${a}.json`;
    case "campaigns":
      return a ? `campaigns/${a}.json` : "campaigns.json";
    case "makers":
      return a ? `makers/${a.toLowerCase()}.json` : null;
    case "vaults":
      // /vaults/<address>/scorecard
      return a && b === "scorecard" ? `scorecards/${a.toLowerCase()}.json` : null;
    case "reports":
      if (!a) return null;
      if (b === "probes") return `reports/${a.toUpperCase()}-probes.json`;
      return `reports/${a.toUpperCase()}-${window ?? "7d"}.json`;
    default:
      return null;
  }
}
