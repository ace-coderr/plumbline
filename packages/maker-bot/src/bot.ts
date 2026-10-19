import { encodeFunctionData, parseUnits, type PublicClient } from "viem";
import { plumbQuoteAbi, fromPx } from "@plumbline/shared";
import { TxSender, type Logger } from "@plumbline/shared/node";
import type { BotConfig } from "./config.js";
import { buildQuote } from "./pricing.js";
import type { ReferenceFeed } from "./reference.js";

export interface BotStats {
  sent: number;
  confirmed: number;
  failed: number;
  cancels: number;
  gasUsedTotal: number; // estimated: sampled receipt gas x confirmed quotes
  lastQuote: { bidPx: string; askPx: string; bidSize: string; askSize: string; mid: string; at: number } | null;
  quoting: boolean;
  /** Set when the gas budget guard stopped the bot. */
  budgetExhausted: boolean;
}

/**
 * Keeps one vault quoted. Every refresh it recomputes the quote from the reference mid and the
 * vault's free inventory and posts it. If the reference goes stale it cancels instead of quoting
 * on old data, and resumes when the feed recovers.
 */
export class MakerBot {
  readonly stats: BotStats = {
    sent: 0,
    confirmed: 0,
    failed: 0,
    cancels: 0,
    gasUsedTotal: 0,
    lastQuote: null,
    quoting: false,
    budgetExhausted: false,
  };
  private freeBase = 0n;
  private freeQuote = 0n;
  /** Nonce of the next transaction this bot will send, and the chain's confirmed count. */
  private sentNonce = 0;
  private confirmedNonce = 0;
  private startNonce = 0;
  private lastHash: `0x${string}` | null = null;
  private cancelled = true;
  private stopped = false;
  private readonly stopHooks: (() => void)[] = [];
  private readonly targetSize: bigint;

  constructor(
    private readonly cfg: BotConfig,
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly feed: ReferenceFeed,
    private readonly log: Logger,
  ) {
    this.targetSize = parseUnits(cfg.size, cfg.base.decimals);
  }

  async start(): Promise<void> {
    const [quoter, owner] = await Promise.all([
      this.client.readContract({ address: this.cfg.vault, abi: plumbQuoteAbi, functionName: "quoter" }),
      this.client.readContract({ address: this.cfg.vault, abi: plumbQuoteAbi, functionName: "owner" }),
    ]);
    const me = this.sender.address.toLowerCase();
    if (quoter.toLowerCase() !== me && owner.toLowerCase() !== me) {
      throw new Error(`key ${this.sender.address} is neither quoter nor owner of ${this.cfg.vault}`);
    }
    // The vault may hold a quote from a previous run; treat it as live so a stale feed cancels it.
    this.cancelled = false;
    await this.sender.resync();
    await Promise.all([this.feed.poll(), this.readInventory()]);
    // Overlapping polls: one slow response must not starve the feed while others would succeed.
    const poll = setInterval(() => void this.feed.poll(), 750);
    this.stopHooks.push(() => clearInterval(poll));
    // Kept sparse: public RPCs rate-limit, and every read competes with the quotes themselves.
    this.startNonce = this.confirmedNonce = this.sentNonce = await this.client.getTransactionCount({ address: this.sender.address });
    this.loop(10_000, () => this.readInventory());
    this.loop(10_000, () => this.track());
    this.loop(this.cfg.refreshMs, () => this.tick());
    if (this.cfg.stopBelowWei > 0n) this.loop(5_000, () => this.checkBudget());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const h of this.stopHooks) h();
    await this.cancel("shutdown");
  }

  private loop(everyMs: number, fn: () => Promise<void>): void {
    const run = async () => {
      if (this.stopped) return;
      const t0 = Date.now();
      try {
        await fn();
      } catch (err) {
        this.log.warn("loop error", { err: err instanceof Error ? err.message : String(err) });
      }
      setTimeout(() => void run(), Math.max(0, everyMs - (Date.now() - t0)));
    };
    void run();
  }

  /** Confirmed quote count from the nonce, plus one sampled receipt for gas accounting. */
  private async track(): Promise<void> {
    this.confirmedNonce = await this.client.getTransactionCount({ address: this.sender.address });
    this.stats.confirmed = this.confirmedNonce - this.startNonce;
    if (this.lastHash) {
      const r = await this.client.getTransactionReceipt({ hash: this.lastHash }).catch(() => null);
      if (r) this.stats.gasUsedTotal = Number(r.gasUsed) * this.stats.confirmed;
    }
  }

  /** Budget guard: once the quoter's gas allocation is spent, pull the quote and stop. */
  private async checkBudget(): Promise<void> {
    const bal = await this.client.getBalance({ address: this.sender.address });
    if (bal >= this.cfg.stopBelowWei) return;
    this.log.warn("gas budget spent; cancelling and stopping", { balanceWei: bal, floorWei: this.cfg.stopBelowWei });
    this.stats.budgetExhausted = true;
    await this.stop();
  }

  private async readInventory(): Promise<void> {
    const [b, q] = await this.client.multicall({
      contracts: [
        { address: this.cfg.vault, abi: plumbQuoteAbi, functionName: "freeBalance", args: [this.cfg.base.address] },
        { address: this.cfg.vault, abi: plumbQuoteAbi, functionName: "freeBalance", args: [this.cfg.quote.address] },
      ],
      allowFailure: false,
    });
    this.freeBase = b;
    this.freeQuote = q;
  }

  private async tick(): Promise<void> {
    if (this.feed.mid === null || this.feed.age() > this.cfg.maxReferenceAgeMs) {
      await this.cancel("reference stale");
      return;
    }
    // Backstop against a stuck node. confirmedNonce is refreshed every 10s, so the cap must exceed
    // what 10s of normal sending produces or the bot would pause itself and let its quote expire.
    if (this.sentNonce - this.confirmedNonce >= 60) return;

    const mid = this.feed.mid;
    const q = buildQuote({
      mid,
      spreadBps: this.cfg.spreadBps,
      skewBps: this.cfg.skewBps,
      targetSize: this.targetSize,
      freeBase: this.freeBase,
      freeQuote: this.freeQuote,
      baseDecimals: this.cfg.base.decimals,
      quoteDecimals: this.cfg.quote.decimals,
    });
    if (q.bidSize === 0n && q.askSize === 0n) {
      await this.cancel("no inventory");
      return;
    }

    this.stats.sent += 1;
    try {
      const sent = await this.sender.send({
        to: this.cfg.vault,
        data: encodeFunctionData({
          abi: plumbQuoteAbi,
          functionName: "setQuote",
          args: [q.bidPx, q.askPx, q.bidSize, q.askSize],
        }),
        // setQuote has near-constant cost; a fixed limit skips an estimate round trip per refresh.
        gas: 150_000n,
        label: "setQuote",
      });
      // No per-quote receipt polling: confirmations are tracked from the nonce every few seconds.
      this.sentNonce = sent.nonce + 1;
      this.lastHash = sent.hash;
      this.cancelled = false;
      this.stats.quoting = true;
      this.stats.lastQuote = {
        bidPx: q.bidPx.toString(),
        askPx: q.askPx.toString(),
        bidSize: q.bidSize.toString(),
        askSize: q.askSize.toString(),
        mid,
        at: Date.now(),
      };
      if (this.stats.sent % 120 === 1) {
        this.log.info("quoting", {
          mid,
          bid: fromPx(q.bidPx).toFixed(4),
          ask: fromPx(q.askPx).toFixed(4),
          imbalance: q.imbalance,
          sent: this.stats.sent,
          confirmed: this.stats.confirmed,
        });
      }
    } catch (err) {
      this.stats.failed += 1;
      this.log.warn("setQuote failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private async cancel(reason: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stats.quoting = false;
    try {
      await this.sender.sendAndWait({
        to: this.cfg.vault,
        data: encodeFunctionData({ abi: plumbQuoteAbi, functionName: "cancel" }),
        gas: 100_000n,
        label: "cancel",
      });
      this.stats.cancels += 1;
      this.log.warn("quote cancelled", { reason });
    } catch (err) {
      this.cancelled = false;
      this.log.error("cancel failed", { reason, err: err instanceof Error ? err.message : String(err) });
    }
  }
}
