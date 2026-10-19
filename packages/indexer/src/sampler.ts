import { getAddress, type PublicClient } from "viem";
import { deployment, plumbRouterAbi } from "@plumbline/shared";
import type { Logger } from "@plumbline/shared/node";
import { setMeta, type DB } from "./db.js";

/**
 * Snapshots every listed vault's quote and actual inventory via the router's `book` view. These
 * samples back the live ladder, market spread history, and the depth bands in depth reports.
 */
export class Sampler {
  private lastBlockTimeCheck = 0;

  constructor(
    private readonly db: DB,
    private readonly client: PublicClient,
    private readonly log: Logger,
  ) {}

  async sample(): Promise<void> {
    const markets = this.db.prepare("SELECT id, base, quote FROM markets").all() as {
      id: number;
      base: string;
      quote: string;
    }[];
    if (markets.length === 0) return;
    const block = await this.client.getBlock({ blockTag: "latest" });
    const ts = Number(block.timestamp);
    const books = await this.client.multicall({
      contracts: markets.map(
        (m) =>
          ({
            address: deployment.contracts.router,
            abi: plumbRouterAbi,
            functionName: "book",
            args: [getAddress(m.base), getAddress(m.quote)],
          }) as const,
      ),
      allowFailure: true,
      blockNumber: block.number,
    });
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO quotes_sampled (ts, market_id, vault, bid_px, ask_px, bid_size, ask_size, updated_at, live, free_base, free_quote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = this.db.transaction(() => {
      markets.forEach((m, i) => {
        const r = books[i];
        if (!r || r.status !== "success") return;
        for (const e of r.result) {
          insert.run(
            ts,
            m.id,
            e.vault.toLowerCase(),
            e.quote.bidPx.toString(),
            e.quote.askPx.toString(),
            e.quote.bidSize.toString(),
            e.quote.askSize.toString(),
            Number(e.quote.updatedAt),
            e.live ? 1 : 0,
            e.freeBase.toString(),
            e.freeQuote.toString(),
          );
        }
      });
      setMeta(this.db, "last_sample_ts", ts);
      setMeta(this.db, "head_ts", ts);
    });
    write();
  }

  /** Measure average block time over the last 10k blocks, at most once every 10 minutes. */
  async blockTime(): Promise<void> {
    if (Date.now() - this.lastBlockTimeCheck < 600_000) return;
    this.lastBlockTimeCheck = Date.now();
    const latest = await this.client.getBlock({ blockTag: "latest" });
    const span = 10_000n;
    if (latest.number <= span) return;
    const past = await this.client.getBlock({ blockNumber: latest.number - span });
    const ms = (Number(latest.timestamp - past.timestamp) * 1000) / Number(span);
    setMeta(this.db, "avg_block_ms", ms.toFixed(1));
    this.log.debug("block time", { ms });
  }

  prune(keepDays = 8): void {
    const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86_400;
    this.db.prepare("DELETE FROM quotes_sampled WHERE ts < ?").run(cutoff);
  }
}

/** Mainnet HYPE/USD mid, used only to express measured gas costs in dollars. */
export async function fetchHypeUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const v = Number(body.HYPE);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
