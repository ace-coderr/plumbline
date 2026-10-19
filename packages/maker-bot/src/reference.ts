import type { Logger } from "@plumbline/shared/node";

/**
 * Off-chain reference mid from the public Hyperliquid testnet API. Used only because the HyperCore
 * market-data precompile is not live on Elysium yet.
 */
export class ReferenceFeed {
  mid: string | null = null;
  fetchedAt = 0;
  failures = 0;

  constructor(
    private readonly url: string,
    private readonly coin: string,
    private readonly log: Logger,
  ) {}

  /** Age of the last good reading in ms (Infinity if never read). */
  age(): number {
    return this.fetchedAt === 0 ? Infinity : Date.now() - this.fetchedAt;
  }

  async poll(): Promise<void> {
    const startedAt = Date.now();
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const v = body[this.coin];
      if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) {
        throw new Error(`no usable mid for ${this.coin}`);
      }
      // Overlapping polls can resolve out of order; keep only the freshest reading.
      if (startedAt < this.fetchedAt) return;
      this.mid = v;
      this.fetchedAt = startedAt;
      if (this.failures > 0) this.log.info("reference recovered", { coin: this.coin, mid: v });
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 20 === 0) {
        this.log.warn("reference fetch failed", {
          coin: this.coin,
          failures: this.failures,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
