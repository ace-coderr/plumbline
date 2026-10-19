import { decodeEventLog, erc20Abi, getAddress, type Hex, type PublicClient } from "viem";
import {
  deployment,
  pairSlug,
  plumbCampaignsAbi,
  plumbQuoteAbi,
  plumbQuoteFactoryAbi,
  plumbRouterAbi,
} from "@plumbline/shared";
import type { Logger } from "@plumbline/shared/node";
import { addStr, getMeta, setMeta, type DB } from "./db.js";

/** Raw eth_getLogs entry. Elysium's RPC includes blockTimestamp, which saves a block fetch per log. */
interface RawLog {
  address: Hex;
  topics: [Hex, ...Hex[]] | [];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

interface Ctx {
  block: number;
  ts: number;
  tx: Hex;
  logIndex: number;
}

const lower = (a: string) => a.toLowerCase();

/**
 * Log-driven indexer. Polls eth_getLogs over an adaptive block range filtered to Plumbline
 * addresses, applies each chunk in one SQLite transaction, and persists the block cursor with it.
 */
export class Syncer {
  private readonly factory = lower(deployment.contracts.factory);
  private readonly campaigns = lower(deployment.contracts.campaigns);
  private readonly router = lower(deployment.contracts.router);
  private range = 20_000;
  private readonly receiptQueue: { hash: Hex; kind: "probe" | "setQuote"; campaignId?: number; nonce?: number; ts: number }[] = [];
  private lastQuoteSample = new Map<string, number>();
  head = 0;
  cursor = 0;

  constructor(
    private readonly db: DB,
    private readonly client: PublicClient,
    private readonly log: Logger,
  ) {
    const saved = getMeta(db, "cursor");
    this.cursor = saved ? Number(saved) : Math.max(0, deployment.deployBlock - 1);
  }

  private vaultAddresses(): string[] {
    return (this.db.prepare("SELECT address FROM vaults").all() as { address: string }[]).map((r) => r.address);
  }

  /** Index up to the current head. Returns the number of logs applied. */
  async step(): Promise<number> {
    this.head = Number(await this.client.getBlockNumber());
    if (this.cursor >= this.head) return 0;
    const from = this.cursor + 1;
    const to = Math.min(this.head, from + this.range - 1);

    let logs: RawLog[];
    try {
      logs = await this.fetchLogs([this.factory, this.campaigns, this.router, ...this.vaultAddresses()], from, to);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/limit|range|too many|exceed/i.test(msg) && this.range > 50) {
        this.range = Math.max(50, Math.floor(this.range / 2));
        this.log.warn("shrinking log range", { range: this.range });
        return 0;
      }
      throw err;
    }

    // Vaults created in this chunk were not in the address filter; fetch their logs too.
    const created = logs
      .filter((l) => lower(l.address) === this.factory)
      .map((l) => this.decodeFactory(l))
      .flatMap((e) => (e && e.eventName === "VaultCreated" ? [lower(e.args.vault)] : []));
    if (created.length) logs = logs.concat(await this.fetchLogs(created, from, to));

    logs.sort((a, b) => {
      const bn = Number(BigInt(a.blockNumber) - BigInt(b.blockNumber));
      return bn !== 0 ? bn : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
    });

    await this.prefetchMarkets(logs);
    const apply = this.db.transaction((items: RawLog[]) => {
      for (const l of items) this.apply(l);
      setMeta(this.db, "cursor", to);
    });
    apply(logs);
    this.cursor = to;
    if (logs.length < 2_000 && this.range < 50_000) this.range = Math.min(50_000, this.range * 2);
    if (logs.length) this.log.debug("indexed", { from, to, logs: logs.length });
    return logs.length;
  }

  private async fetchLogs(addresses: string[], from: number, to: number): Promise<RawLog[]> {
    if (addresses.length === 0) return [];
    const out: RawLog[] = [];
    // Keep each request's address list modest.
    for (let i = 0; i < addresses.length; i += 40) {
      const batch = addresses.slice(i, i + 40) as Hex[];
      const res = (await this.client.request({
        method: "eth_getLogs",
        params: [{ address: batch, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      })) as unknown as RawLog[];
      out.push(...res);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Markets need token metadata, which is async; fetch it before the synchronous apply pass.
  // -------------------------------------------------------------------------------------------

  private async prefetchMarkets(logs: RawLog[]): Promise<void> {
    const pairs: { base: string; quote: string; block: number; ts: number }[] = [];
    for (const l of logs) {
      const addr = lower(l.address);
      let base: string | null = null;
      let quote: string | null = null;
      if (addr === this.factory) {
        const e = this.decodeFactory(l);
        if (e?.eventName === "PairListed") [base, quote] = [e.args.base, e.args.quote];
      } else if (addr === this.campaigns) {
        const e = this.decodeCampaigns(l);
        if (e?.eventName === "CampaignOpened") [base, quote] = [e.args.base, e.args.quote];
      }
      if (base && quote && !this.marketId(base, quote)) {
        pairs.push({ base, quote, block: Number(BigInt(l.blockNumber)), ts: this.ts(l) });
      }
    }
    for (const p of pairs) {
      if (this.marketId(p.base, p.quote)) continue;
      const res = await this.client.multicall({
        contracts: [
          { address: getAddress(p.base), abi: erc20Abi, functionName: "symbol" },
          { address: getAddress(p.base), abi: erc20Abi, functionName: "decimals" },
          { address: getAddress(p.quote), abi: erc20Abi, functionName: "symbol" },
          { address: getAddress(p.quote), abi: erc20Abi, functionName: "decimals" },
        ],
        allowFailure: false,
      });
      const [bs, bd, qs, qd] = res;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO markets (base, quote, slug, base_symbol, quote_symbol, base_decimals, quote_decimals, listed_block, listed_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(lower(p.base), lower(p.quote), pairSlug(bs, qs), bs, qs, bd, qd, p.block, p.ts);
      this.log.info("market", { pair: pairSlug(bs, qs) });
    }
  }

  private marketId(base: string, quote: string): number | null {
    const r = this.db.prepare("SELECT id FROM markets WHERE base = ? AND quote = ?").get(lower(base), lower(quote)) as
      | { id: number }
      | undefined;
    return r?.id ?? null;
  }

  private vaultMarket(vault: string): number | null {
    const r = this.db.prepare("SELECT market_id FROM vaults WHERE address = ?").get(lower(vault)) as
      | { market_id: number }
      | undefined;
    return r?.market_id ?? null;
  }

  private ts(l: RawLog): number {
    return l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : Math.floor(Date.now() / 1000);
  }

  // -------------------------------------------------------------------------------------------
  // Decoding
  // -------------------------------------------------------------------------------------------

  private decodeFactory(l: RawLog) {
    try {
      return decodeEventLog({ abi: plumbQuoteFactoryAbi, data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  }

  private decodeCampaigns(l: RawLog) {
    try {
      return decodeEventLog({ abi: plumbCampaignsAbi, data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  }

  private apply(l: RawLog): void {
    const addr = lower(l.address);
    const ctx: Ctx = {
      block: Number(BigInt(l.blockNumber)),
      ts: this.ts(l),
      tx: l.transactionHash,
      logIndex: Number(BigInt(l.logIndex)),
    };
    if (addr === this.factory) return this.onFactory(l, ctx);
    if (addr === this.campaigns) return this.onCampaigns(l, ctx);
    if (addr === this.router) return this.onRouter(l, ctx);
    return this.onVault(l, ctx);
  }

  private onFactory(l: RawLog, c: Ctx): void {
    const e = this.decodeFactory(l);
    if (!e) return;
    switch (e.eventName) {
      case "VaultCreated": {
        const market = this.marketId(e.args.base, e.args.quote);
        if (market === null) return;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO vaults (address, market_id, owner, quoter, created_block, created_ts, listed)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(lower(e.args.vault), market, lower(e.args.owner), lower(e.args.quoter), c.block, c.ts);
        return;
      }
      case "VaultDelisted":
        this.db.prepare("UPDATE vaults SET listed = 0 WHERE address = ?").run(lower(e.args.vault));
        return;
      case "VaultRelisted":
        this.db.prepare("UPDATE vaults SET listed = 1 WHERE address = ?").run(lower(e.args.vault));
        return;
      default:
        return;
    }
  }

  private onVault(l: RawLog, c: Ctx): void {
    let e;
    try {
      e = decodeEventLog({ abi: plumbQuoteAbi, data: l.data, topics: l.topics });
    } catch {
      return;
    }
    const vault = lower(l.address);
    switch (e.eventName) {
      case "QuoteSet": {
        const hour = Math.floor(c.ts / 3600) * 3600;
        this.db
          .prepare(
            `INSERT INTO quote_updates (vault, hour, count) VALUES (?, ?, 1)
             ON CONFLICT(vault, hour) DO UPDATE SET count = count + 1`,
          )
          .run(vault, hour);
        // Sample one setQuote receipt per vault per minute for gas accounting.
        const last = this.lastQuoteSample.get(vault) ?? 0;
        if (c.ts - last >= 60) {
          this.lastQuoteSample.set(vault, c.ts);
          this.receiptQueue.push({ hash: c.tx, kind: "setQuote", ts: c.ts });
        }
        return;
      }
      case "QuoterSet":
        this.db.prepare("UPDATE vaults SET quoter = ? WHERE address = ?").run(lower(e.args.quoter), vault);
        return;
      case "Filled": {
        const market = this.vaultMarket(vault);
        if (market === null) return;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO fills (tx_hash, log_index, block, ts, market_id, vault, taker, recipient, buying_base, amount_in, amount_out, px)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            c.tx,
            c.logIndex,
            c.block,
            c.ts,
            market,
            vault,
            lower(e.args.taker),
            lower(e.args.recipient),
            e.args.buyingBase ? 1 : 0,
            e.args.amountIn.toString(),
            e.args.amountOut.toString(),
            e.args.px.toString(),
          );
        return;
      }
      default:
        return;
    }
  }

  private onRouter(l: RawLog, c: Ctx): void {
    let e;
    try {
      e = decodeEventLog({ abi: plumbRouterAbi, data: l.data, topics: l.topics });
    } catch {
      return;
    }
    if (e.eventName !== "FillFailed") return;
    const market = this.vaultMarket(e.args.vault);
    if (market === null) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO failed_fills (tx_hash, log_index, block, ts, market_id, vault, taker, amount_in, status, selector, penalized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.tx,
        c.logIndex,
        c.block,
        c.ts,
        market,
        lower(e.args.vault),
        lower(e.args.taker),
        e.args.amountIn.toString(),
        e.args.status,
        e.args.selector,
        e.args.penalized ? 1 : 0,
      );
  }

  private onCampaigns(l: RawLog, c: Ctx): void {
    const e = this.decodeCampaigns(l);
    if (!e) return;
    const db = this.db;
    switch (e.eventName) {
      case "CampaignOpened": {
        const market = this.marketId(e.args.base, e.args.quote);
        if (market === null) return;
        const t = e.args.terms;
        db.prepare(
          `INSERT OR IGNORE INTO campaigns (id, market_id, creator, reward_token, start_time, num_epochs, epoch_length,
             reward_per_epoch, max_spread_bps, min_depth_base, min_depth_quote, min_probe_interval, probe_fee_bps,
             maker_bond, reference_price, opened_block, opened_ts, tx_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          Number(e.args.id),
          market,
          lower(e.args.creator),
          lower(e.args.rewardToken),
          Number(e.args.startTime),
          e.args.numEpochs,
          Number(t.epochLength),
          t.rewardPerEpoch.toString(),
          t.maxSpreadBps,
          t.minDepthBase.toString(),
          t.minDepthQuote.toString(),
          t.minProbeInterval,
          t.probeFeeBps,
          t.makerBond.toString(),
          lower(e.args.referencePrice),
          c.block,
          c.ts,
          c.tx,
        );
        return;
      }
      case "MakerRegistered":
        db.prepare(
          `INSERT INTO registrations (campaign_id, vault, maker, bond, status, registered_ts) VALUES (?, ?, ?, ?, 'active', ?)
           ON CONFLICT(campaign_id, vault) DO UPDATE SET maker = excluded.maker, bond = excluded.bond, status = 'active', registered_ts = excluded.registered_ts`,
        ).run(Number(e.args.id), lower(e.args.vault), lower(e.args.maker), e.args.bond.toString(), c.ts);
        return;
      case "BondToppedUp":
        db.prepare("UPDATE registrations SET bond = ? WHERE campaign_id = ? AND vault = ?").run(
          e.args.bond.toString(),
          Number(e.args.id),
          lower(e.args.vault),
        );
        return;
      case "UnbondRequested":
        db.prepare("UPDATE registrations SET status = 'unbonding' WHERE campaign_id = ? AND vault = ?").run(
          Number(e.args.id),
          lower(e.args.vault),
        );
        return;
      case "BondReleased":
        db.prepare("UPDATE registrations SET status = 'released', bond = '0' WHERE campaign_id = ? AND vault = ?").run(
          Number(e.args.id),
          lower(e.args.vault),
        );
        return;
      case "ProbeResult": {
        const id = Number(e.args.id);
        const epoch = Number(e.args.epoch);
        const vault = lower(e.args.vault);
        db.prepare(
          `INSERT OR IGNORE INTO probe_results (campaign_id, nonce, vault, epoch, passed, fail_mask, spread_bps,
             bid_px, ask_px, bid_size, ask_size, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          Number(e.args.nonce),
          vault,
          epoch,
          e.args.passed ? 1 : 0,
          e.args.failMask,
          e.args.spreadBps,
          e.args.bidPx.toString(),
          e.args.askPx.toString(),
          e.args.bidSize.toString(),
          e.args.askSize.toString(),
          c.ts,
        );
        const maker =
          (db.prepare("SELECT maker FROM registrations WHERE campaign_id = ? AND vault = ?").get(id, vault) as
            | { maker: string }
            | undefined)?.maker ?? "";
        db.prepare(
          `INSERT INTO maker_scores (campaign_id, epoch, vault, maker, points, checks) VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(campaign_id, epoch, vault) DO UPDATE SET points = points + excluded.points, checks = checks + 1`,
        ).run(id, epoch, vault, maker, e.args.passed ? 1 : 0);
        return;
      }
      case "Probed": {
        const id = Number(e.args.id);
        const epoch = Number(e.args.epoch);
        const nonce = Number(e.args.nonce);
        db.prepare(
          `INSERT OR IGNORE INTO probes (campaign_id, nonce, epoch, prober, tx_hash, block, ts, checked, passed, fee, ref_px)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          nonce,
          epoch,
          lower(e.args.prober),
          c.tx,
          c.block,
          c.ts,
          Number(e.args.checked),
          Number(e.args.passed),
          e.args.fee.toString(),
          e.args.referencePx.toString(),
        );
        db.prepare(
          `INSERT INTO epochs (campaign_id, epoch, probes, total_points) VALUES (?, ?, 1, ?)
           ON CONFLICT(campaign_id, epoch) DO UPDATE SET probes = probes + 1, total_points = total_points + excluded.total_points`,
        ).run(id, epoch, Number(e.args.passed));
        this.receiptQueue.push({ hash: c.tx, kind: "probe", campaignId: id, nonce, ts: c.ts });
        return;
      }
      case "Penalized": {
        const id = Number(e.args.id);
        const vault = lower(e.args.vault);
        db.prepare(
          `INSERT OR IGNORE INTO penalties (tx_hash, log_index, campaign_id, vault, reporter, slashed, to_reporter, to_makers, forfeited, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          c.tx,
          c.logIndex,
          id,
          vault,
          lower(e.args.reporter),
          e.args.slashed.toString(),
          e.args.toReporter.toString(),
          e.args.toMakers.toString(),
          Number(e.args.pointsForfeited),
          c.ts,
        );
        const reg = db.prepare("SELECT bond FROM registrations WHERE campaign_id = ? AND vault = ?").get(id, vault) as
          | { bond: string }
          | undefined;
        if (reg) {
          db.prepare("UPDATE registrations SET bond = ? WHERE campaign_id = ? AND vault = ?").run(
            (BigInt(reg.bond) - e.args.slashed).toString(),
            id,
            vault,
          );
        }
        const forfeited = Number(e.args.pointsForfeited);
        if (forfeited > 0) {
          const camp = db.prepare("SELECT start_time, epoch_length FROM campaigns WHERE id = ?").get(id) as
            | { start_time: number; epoch_length: number }
            | undefined;
          if (camp) {
            const epoch = Math.floor((c.ts - camp.start_time) / camp.epoch_length);
            db.prepare("UPDATE maker_scores SET points = 0 WHERE campaign_id = ? AND epoch = ? AND vault = ?").run(id, epoch, vault);
            db.prepare("UPDATE epochs SET total_points = total_points - ? WHERE campaign_id = ? AND epoch = ?").run(
              forfeited,
              id,
              epoch,
            );
          }
        }
        return;
      }
      case "EpochSettled": {
        const id = Number(e.args.id);
        const epoch = Number(e.args.epoch);
        db.prepare(
          `INSERT INTO epochs (campaign_id, epoch, probes, total_points, maker_pot, refunded, settled, settled_tx, settled_ts)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(campaign_id, epoch) DO UPDATE SET maker_pot = excluded.maker_pot, refunded = excluded.refunded,
             settled = 1, settled_tx = excluded.settled_tx, settled_ts = excluded.settled_ts,
             probes = excluded.probes, total_points = excluded.total_points`,
        ).run(
          id,
          epoch,
          Number(e.args.probes),
          Number(e.args.totalPoints),
          e.args.makerPot.toString(),
          e.args.refunded.toString(),
          c.tx,
          c.ts,
        );
        db.prepare("UPDATE campaigns SET settled_epochs = MAX(settled_epochs, ?) WHERE id = ?").run(epoch + 1, id);
        return;
      }
      case "RewardCredited": {
        const id = Number(e.args.id);
        const epoch = Number(e.args.epoch);
        const vault = lower(e.args.vault);
        const prev = db
          .prepare("SELECT reward FROM maker_scores WHERE campaign_id = ? AND epoch = ? AND vault = ?")
          .get(id, epoch, vault) as { reward: string | null } | undefined;
        db.prepare(
          `INSERT INTO maker_scores (campaign_id, epoch, vault, maker, points, checks, reward) VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(campaign_id, epoch, vault) DO UPDATE SET reward = excluded.reward, maker = excluded.maker`,
        ).run(id, epoch, vault, lower(e.args.maker), Number(e.args.points), addStr(prev?.reward, e.args.amount));
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Receipts: gas accounting for probes and a sample of quote refreshes.
  // -------------------------------------------------------------------------------------------

  async drainReceipts(max = 20): Promise<void> {
    const batch = this.receiptQueue.splice(0, max);
    await Promise.all(
      batch.map(async (job) => {
        try {
          const r = await this.client.getTransactionReceipt({ hash: job.hash });
          if (job.kind === "probe") {
            this.db
              .prepare("UPDATE probes SET gas_used = ?, gas_price = ? WHERE campaign_id = ? AND nonce = ?")
              .run(Number(r.gasUsed), r.effectiveGasPrice.toString(), job.campaignId ?? 0, job.nonce ?? 0);
          } else {
            this.db
              .prepare("INSERT OR IGNORE INTO gas_samples (tx_hash, kind, gas_used, gas_price, ts) VALUES (?, ?, ?, ?, ?)")
              .run(job.hash, job.kind, Number(r.gasUsed), r.effectiveGasPrice.toString(), job.ts);
          }
        } catch {
          this.receiptQueue.push(job);
        }
      }),
    );
  }

  /** Re-queue probes whose gas was never recorded (e.g. after a restart). */
  requeueMissingGas(): void {
    const rows = this.db
      .prepare("SELECT campaign_id, nonce, tx_hash, ts FROM probes WHERE gas_used IS NULL LIMIT 500")
      .all() as { campaign_id: number; nonce: number; tx_hash: Hex; ts: number }[];
    for (const r of rows) {
      this.receiptQueue.push({ hash: r.tx_hash, kind: "probe", campaignId: r.campaign_id, nonce: r.nonce, ts: r.ts });
    }
  }

  pendingReceipts(): number {
    return this.receiptQueue.length;
  }
}
