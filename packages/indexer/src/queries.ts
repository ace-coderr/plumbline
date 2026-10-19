import { getAddress } from "viem";
import {
  deployment,
  isDemoToken,
  quoteNotional,
  spreadBps,
  tokenByAddress,
  type Address,
  type CampaignDetail,
  type CampaignView,
  type DepthReport,
  type EconomicsResponse,
  type EpochView,
  type FailedFillView,
  type FillView,
  type LeaderboardRow,
  type MakerProfile,
  type MarketDetail,
  type MarketSummary,
  type PenaltyView,
  type ProbeView,
  type QuoteView,
  type RegistrationView,
  type TokenRef,
  type UptimeBucket,
  type UptimeResponse,
  type Hash,
} from "@plumbline/shared";
import { getMeta, type DB } from "./db.js";

// ---------------------------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------------------------

interface MarketRow {
  id: number;
  base: string;
  quote: string;
  slug: string;
  base_symbol: string;
  quote_symbol: string;
  base_decimals: number;
  quote_decimals: number;
}

interface SampleRow {
  ts: number;
  vault: string;
  bid_px: string;
  ask_px: string;
  bid_size: string;
  ask_size: string;
  updated_at: number;
  live: number;
  free_base: string;
  free_quote: string;
}

interface ProbeRow {
  campaign_id: number;
  nonce: number;
  epoch: number;
  prober: string;
  tx_hash: string;
  block: number;
  ts: number;
  checked: number;
  passed: number;
  fee: string;
  gas_used: number | null;
}

interface CampaignRow {
  id: number;
  market_id: number;
  creator: string;
  reward_token: string;
  start_time: number;
  num_epochs: number;
  epoch_length: number;
  reward_per_epoch: string;
  max_spread_bps: number;
  min_depth_base: string;
  min_depth_quote: string;
  min_probe_interval: number;
  probe_fee_bps: number;
  maker_bond: string;
  reference_price: string;
  tx_hash: string;
  settled_epochs: number;
}

const now = () => Math.floor(Date.now() / 1000);
const addr = (a: string) => getAddress(a) as Address;
const CROSSED = 4_294_967_295;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function medianBig(xs: bigint[]): bigint {
  if (xs.length === 0) return 0n;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)] as bigint;
}

/** Parse "15m", "6h", "24h", "7d" into seconds. */
export function parseWindow(w: string | undefined, fallback = 86_400): number {
  if (!w) return fallback;
  const m = /^(\d+)([mhd])$/.exec(w);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86_400;
  return Math.min(n * unit, 30 * 86_400);
}

export class Queries {
  constructor(private readonly db: DB) {}

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  private markets(): MarketRow[] {
    return this.db.prepare("SELECT * FROM markets ORDER BY id").all() as MarketRow[];
  }

  marketBySlug(slug: string): MarketRow | null {
    return (
      (this.db.prepare("SELECT * FROM markets WHERE lower(slug) = lower(?)").get(slug) as MarketRow | undefined) ?? null
    );
  }

  private marketById(id: number): MarketRow | null {
    return (this.db.prepare("SELECT * FROM markets WHERE id = ?").get(id) as MarketRow | undefined) ?? null;
  }

  private refs(m: MarketRow): { base: TokenRef; quote: TokenRef } {
    return {
      base: { address: addr(m.base), symbol: m.base_symbol, decimals: m.base_decimals, demo: isDemoToken(m.base) },
      quote: { address: addr(m.quote), symbol: m.quote_symbol, decimals: m.quote_decimals, demo: isDemoToken(m.quote) },
    };
  }

  private latestSamples(marketId: number): SampleRow[] {
    const t = this.db.prepare("SELECT MAX(ts) AS ts FROM quotes_sampled WHERE market_id = ?").get(marketId) as {
      ts: number | null;
    };
    if (t.ts === null) return [];
    return this.db
      .prepare("SELECT * FROM quotes_sampled WHERE market_id = ? AND ts = ?")
      .all(marketId, t.ts) as SampleRow[];
  }

  private vaultUptime(vault: string, since: number): number | null {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, SUM(passed) AS p FROM probe_results WHERE vault = ? AND ts >= ?")
      .get(vault.toLowerCase(), since) as { n: number; p: number | null };
    return r.n ? (r.p ?? 0) / r.n : null;
  }

  private quoteView(s: SampleRow): QuoteView {
    const owner = (this.db.prepare("SELECT owner FROM vaults WHERE address = ?").get(s.vault) as { owner: string } | undefined)
      ?.owner;
    const bid = BigInt(s.bid_px);
    const ask = BigInt(s.ask_px);
    const sp = spreadBps(bid, ask);
    return {
      vault: addr(s.vault),
      owner: addr(owner ?? s.vault),
      bidPx: s.bid_px,
      askPx: s.ask_px,
      bidSize: s.bid_size,
      askSize: s.ask_size,
      updatedAt: s.updated_at,
      live: s.live === 1,
      freeBase: s.free_base,
      freeQuote: s.free_quote,
      spreadBps: sp < 0n ? null : Number(sp),
      uptime24h: this.vaultUptime(s.vault, now() - 86_400),
    };
  }

  private campaignIdsFor(marketId: number): number[] {
    return (this.db.prepare("SELECT id FROM campaigns WHERE market_id = ? ORDER BY id").all(marketId) as { id: number }[]).map(
      (r) => r.id,
    );
  }

  private probeViews(rows: ProbeRow[]): ProbeView[] {
    if (rows.length === 0) return [];
    const results = this.db.prepare(
      "SELECT vault, passed, fail_mask, spread_bps FROM probe_results WHERE campaign_id = ? AND nonce = ?",
    );
    return rows.map((p) => ({
      campaignId: p.campaign_id,
      epoch: p.epoch,
      nonce: p.nonce,
      txHash: p.tx_hash as Hash,
      block: p.block,
      ts: p.ts,
      prober: addr(p.prober),
      checked: p.checked,
      passed: p.passed,
      fee: p.fee,
      gasUsed: p.gas_used,
      results: (
        results.all(p.campaign_id, p.nonce) as { vault: string; passed: number; fail_mask: number; spread_bps: number }[]
      ).map((r) => ({ vault: addr(r.vault), passed: r.passed === 1, failMask: r.fail_mask, spreadBps: r.spread_bps })),
    }));
  }

  private rewardMeta(token: string): { symbol: string; decimals: number } {
    if (/^0x0{40}$/i.test(token)) return { symbol: "HYPE", decimals: 18 };
    const known = tokenByAddress(token);
    if (known) return { symbol: known.symbol, decimals: known.decimals };
    const m = this.db
      .prepare(
        "SELECT base_symbol AS s, base_decimals AS d FROM markets WHERE base = ? UNION SELECT quote_symbol, quote_decimals FROM markets WHERE quote = ?",
      )
      .get(token.toLowerCase(), token.toLowerCase()) as { s: string; d: number } | undefined;
    return m ? { symbol: m.s, decimals: m.d } : { symbol: "?", decimals: 18 };
  }

  // -------------------------------------------------------------------------------------------
  // Markets
  // -------------------------------------------------------------------------------------------

  marketSummary(m: MarketRow): MarketSummary {
    const { base, quote } = this.refs(m);
    const samples = this.latestSamples(m.id);
    const live = samples.filter((s) => s.live === 1);
    let bestBid: bigint | null = null;
    let bestAsk: bigint | null = null;
    let askDepth = 0n;
    let bidDepth = 0n;
    for (const s of live) {
      const bidSize = BigInt(s.bid_size);
      const askSize = BigInt(s.ask_size);
      const bid = BigInt(s.bid_px);
      const ask = BigInt(s.ask_px);
      if (bidSize > 0n) {
        if (bestBid === null || bid > bestBid) bestBid = bid;
        bidDepth += quoteNotional(bidSize, bid, base.decimals, quote.decimals);
      }
      if (askSize > 0n) {
        if (bestAsk === null || ask < bestAsk) bestAsk = ask;
        askDepth += askSize;
      }
    }
    const since = now() - 86_400;
    const probes = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN p.passed > 0 THEN 1 ELSE 0 END) AS covered, MAX(p.ts) AS last
         FROM probes p JOIN campaigns c ON c.id = p.campaign_id
         WHERE c.market_id = ? AND p.ts >= ? AND p.checked > 0`,
      )
      .get(m.id, since) as { n: number; covered: number | null; last: number | null };
    const lastProbe = this.db
      .prepare("SELECT MAX(p.ts) AS t FROM probes p JOIN campaigns c ON c.id = p.campaign_id WHERE c.market_id = ?")
      .get(m.id) as { t: number | null };
    const counts = this.db
      .prepare("SELECT COUNT(*) AS v, COUNT(DISTINCT owner) AS o FROM vaults WHERE market_id = ? AND listed = 1")
      .get(m.id) as { v: number; o: number };
    const sp = bestBid !== null && bestAsk !== null ? spreadBps(bestBid, bestAsk) : -1n;

    return {
      pair: m.slug,
      base,
      quote,
      vaultCount: counts.v,
      liveVaults: live.length,
      makerCount: counts.o,
      uptime24h: probes.n ? (probes.covered ?? 0) / probes.n : null,
      probes24h: probes.n,
      bestBidPx: bestBid?.toString() ?? null,
      bestAskPx: bestAsk?.toString() ?? null,
      spreadBps: sp < 0n ? null : Number(sp),
      askDepth: askDepth.toString(),
      bidDepth: bidDepth.toString(),
      campaignIds: this.campaignIdsFor(m.id),
      lastProbeAt: lastProbe.t,
      sampledAt: samples[0]?.ts ?? null,
    };
  }

  listMarkets(): MarketSummary[] {
    return this.markets().map((m) => this.marketSummary(m));
  }

  marketDetail(slug: string): MarketDetail | null {
    const m = this.marketBySlug(slug);
    if (!m) return null;
    const book = this.latestSamples(m.id).map((s) => this.quoteView(s));
    book.sort((a, b) => Number(b.live) - Number(a.live) || (a.spreadBps ?? 1e9) - (b.spreadBps ?? 1e9));
    const fills = (
      this.db.prepare("SELECT * FROM fills WHERE market_id = ? ORDER BY ts DESC, log_index DESC LIMIT 50").all(m.id) as {
        tx_hash: string;
        block: number;
        ts: number;
        vault: string;
        taker: string;
        buying_base: number;
        amount_in: string;
        amount_out: string;
        px: string;
      }[]
    ).map(
      (f): FillView => ({
        txHash: f.tx_hash as Hash,
        block: f.block,
        ts: f.ts,
        vault: addr(f.vault),
        taker: addr(f.taker),
        buyingBase: f.buying_base === 1,
        amountIn: f.amount_in,
        amountOut: f.amount_out,
        px: f.px,
      }),
    );
    const failedFills = (
      this.db.prepare("SELECT * FROM failed_fills WHERE market_id = ? ORDER BY ts DESC LIMIT 20").all(m.id) as {
        tx_hash: string;
        block: number;
        ts: number;
        vault: string;
        taker: string;
        amount_in: string;
        status: number;
        penalized: number;
      }[]
    ).map(
      (f): FailedFillView => ({
        txHash: f.tx_hash as Hash,
        block: f.block,
        ts: f.ts,
        vault: addr(f.vault),
        taker: addr(f.taker),
        amountIn: f.amount_in,
        status: f.status,
        penalized: f.penalized === 1,
      }),
    );
    return { summary: this.marketSummary(m), book, fills, failedFills };
  }

  uptime(slug: string, window: string | undefined): UptimeResponse | null {
    const m = this.marketBySlug(slug);
    if (!m) return null;
    const span = parseWindow(window);
    const to = now();
    const from = to - span;
    const bucketSeconds = Math.max(60, Math.ceil(span / 60 / 60) * 60);

    const probeRows = this.db
      .prepare(
        `SELECT p.* FROM probes p JOIN campaigns c ON c.id = p.campaign_id
         WHERE c.market_id = ? AND p.ts >= ? ORDER BY p.ts DESC`,
      )
      .all(m.id, from) as ProbeRow[];
    const resultRows = this.db
      .prepare(
        `SELECT r.ts, r.passed, r.spread_bps FROM probe_results r JOIN campaigns c ON c.id = r.campaign_id
         WHERE c.market_id = ? AND r.ts >= ?`,
      )
      .all(m.id, from) as { ts: number; passed: number; spread_bps: number }[];

    const buckets = new Map<number, UptimeBucket & { spreads: number[] }>();
    const bucketOf = (ts: number) => {
      const t = Math.floor(ts / bucketSeconds) * bucketSeconds;
      let b = buckets.get(t);
      if (!b) {
        b = { t, probes: 0, covered: 0, vaultChecks: 0, vaultPasses: 0, medianSpreadBps: null, spreads: [] };
        buckets.set(t, b);
      }
      return b;
    };
    let checkedProbes = 0;
    let covered = 0;
    for (const p of probeRows) {
      if (p.checked === 0) continue;
      const b = bucketOf(p.ts);
      b.probes += 1;
      checkedProbes += 1;
      if (p.passed > 0) {
        b.covered += 1;
        covered += 1;
      }
    }
    for (const r of resultRows) {
      const b = bucketOf(r.ts);
      b.vaultChecks += 1;
      b.vaultPasses += r.passed;
      if (r.spread_bps !== CROSSED) b.spreads.push(r.spread_bps);
    }
    const out: UptimeBucket[] = [...buckets.values()]
      .sort((a, b) => a.t - b.t)
      .map(({ spreads, ...b }) => ({ ...b, medianSpreadBps: median(spreads) }));

    return {
      pair: m.slug,
      window: window ?? "24h",
      from,
      to,
      bucketSeconds,
      uptime: checkedProbes ? covered / checkedProbes : null,
      buckets: out,
      probes: this.probeViews(probeRows.slice(0, 200)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------------------------

  private campaignView(c: CampaignRow): CampaignView | null {
    const m = this.marketById(c.market_id);
    if (!m) return null;
    const { base, quote } = this.refs(m);
    const reward = this.rewardMeta(c.reward_token);
    const probes = this.db
      .prepare("SELECT COUNT(*) AS n, MAX(ts) AS last FROM probes WHERE campaign_id = ?")
      .get(c.id) as { n: number; last: number | null };
    const elapsed = now() - c.start_time;
    return {
      id: c.id,
      pair: m.slug,
      base,
      quote,
      creator: addr(c.creator),
      rewardToken: addr(c.reward_token),
      rewardSymbol: reward.symbol,
      rewardDecimals: reward.decimals,
      startTime: c.start_time,
      numEpochs: c.num_epochs,
      epochLength: c.epoch_length,
      rewardPerEpoch: c.reward_per_epoch,
      maxSpreadBps: c.max_spread_bps,
      minDepthBase: c.min_depth_base,
      minDepthQuote: c.min_depth_quote,
      minProbeInterval: c.min_probe_interval,
      probeFeeBps: c.probe_fee_bps,
      makerBond: c.maker_bond,
      referencePrice: addr(c.reference_price),
      openedTx: c.tx_hash as Hash,
      currentEpoch: elapsed < 0 ? 0 : Math.floor(elapsed / c.epoch_length),
      settledEpochs: c.settled_epochs,
      totalProbes: probes.n,
      lastProbeAt: probes.last,
    };
  }

  listCampaigns(): CampaignView[] {
    return (this.db.prepare("SELECT * FROM campaigns ORDER BY id DESC").all() as CampaignRow[]).flatMap((c) => {
      const v = this.campaignView(c);
      return v ? [v] : [];
    });
  }

  campaignDetail(id: number): CampaignDetail | null {
    const c = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
    if (!c) return null;
    const campaign = this.campaignView(c);
    if (!campaign) return null;

    const regs = this.db.prepare("SELECT * FROM registrations WHERE campaign_id = ?").all(id) as {
      vault: string;
      maker: string;
      bond: string;
      status: RegistrationView["status"];
    }[];
    const scoreRows = this.db
      .prepare("SELECT vault, SUM(points) AS points, SUM(checks) AS checks FROM maker_scores WHERE campaign_id = ? GROUP BY vault")
      .all(id) as { vault: string; points: number; checks: number }[];
    const rewardRows = this.db
      .prepare("SELECT vault, reward FROM maker_scores WHERE campaign_id = ? AND reward IS NOT NULL")
      .all(id) as { vault: string; reward: string }[];
    const spreadStmt = this.db.prepare(
      "SELECT spread_bps FROM probe_results WHERE campaign_id = ? AND vault = ? AND spread_bps != ? ORDER BY ts DESC LIMIT 500",
    );
    const penaltyCount = this.db.prepare("SELECT COUNT(*) AS n FROM penalties WHERE campaign_id = ? AND vault = ?");

    const leaderboard: LeaderboardRow[] = regs.map((r) => {
      const s = scoreRows.find((x) => x.vault === r.vault);
      const earned = rewardRows.filter((x) => x.vault === r.vault).reduce((a, x) => a + BigInt(x.reward), 0n);
      const spreads = (spreadStmt.all(id, r.vault, CROSSED) as { spread_bps: number }[]).map((x) => x.spread_bps);
      return {
        vault: addr(r.vault),
        maker: addr(r.maker),
        points: s?.points ?? 0,
        checks: s?.checks ?? 0,
        uptime: s && s.checks ? s.points / s.checks : null,
        earned: earned.toString(),
        bond: r.bond,
        status: r.status,
        medianSpreadBps: median(spreads),
        penalties: (penaltyCount.get(id, r.vault) as { n: number }).n,
      };
    });
    leaderboard.sort((a, b) => b.points - a.points || (a.medianSpreadBps ?? 1e9) - (b.medianSpreadBps ?? 1e9));

    const epochRows = this.db.prepare("SELECT * FROM epochs WHERE campaign_id = ?").all(id) as {
      epoch: number;
      probes: number;
      total_points: number;
      maker_pot: string | null;
      refunded: string | null;
      settled: number;
      settled_tx: string | null;
    }[];
    const epochs: EpochView[] = [];
    for (let e = 0; e < c.num_epochs; e++) {
      const r = epochRows.find((x) => x.epoch === e);
      epochs.push({
        epoch: e,
        start: c.start_time + e * c.epoch_length,
        end: c.start_time + (e + 1) * c.epoch_length,
        probes: r?.probes ?? 0,
        totalPoints: r?.total_points ?? 0,
        makerPot: r?.maker_pot ?? null,
        refunded: r?.refunded ?? null,
        settled: r?.settled === 1,
        settledTx: (r?.settled_tx as Hash | null | undefined) ?? null,
      });
    }

    const recent = this.db
      .prepare("SELECT * FROM probes WHERE campaign_id = ? ORDER BY nonce DESC LIMIT 50")
      .all(id) as ProbeRow[];
    return { campaign, leaderboard, epochs, recentProbes: this.probeViews(recent), penalties: this.penalties(id) };
  }

  private penalties(campaignId: number): PenaltyView[] {
    return (
      this.db.prepare("SELECT * FROM penalties WHERE campaign_id = ? ORDER BY ts DESC LIMIT 50").all(campaignId) as {
        campaign_id: number;
        vault: string;
        reporter: string;
        slashed: string;
        to_reporter: string;
        tx_hash: string;
        ts: number;
      }[]
    ).map((p) => ({
      campaignId: p.campaign_id,
      vault: addr(p.vault),
      reporter: addr(p.reporter),
      slashed: p.slashed,
      toReporter: p.to_reporter,
      txHash: p.tx_hash as Hash,
      ts: p.ts,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Makers
  // -------------------------------------------------------------------------------------------

  maker(address: string): MakerProfile {
    const a = address.toLowerCase();
    const since = now() - 86_400;
    const vaultRows = this.db
      .prepare("SELECT v.*, m.slug FROM vaults v JOIN markets m ON m.id = v.market_id WHERE v.owner = ? OR v.quoter = ?")
      .all(a, a) as { address: string; slug: string; quoter: string; created_ts: number; market_id: number }[];
    const updates = this.db.prepare("SELECT SUM(count) AS n FROM quote_updates WHERE vault = ? AND hour >= ?");
    const lastSample = this.db.prepare("SELECT * FROM quotes_sampled WHERE vault = ? ORDER BY ts DESC LIMIT 1");
    const vaults = vaultRows.map((v) => {
      const s = lastSample.get(v.address) as SampleRow | undefined;
      return {
        vault: addr(v.address),
        pair: v.slug,
        quoter: addr(v.quoter),
        createdAt: v.created_ts,
        quoteUpdates24h: (updates.get(v.address, since - 3600) as { n: number | null }).n ?? 0,
        quote: s ? this.quoteView(s) : null,
      };
    });

    const registrations = (
      this.db.prepare("SELECT * FROM registrations WHERE maker = ? ORDER BY campaign_id").all(a) as {
        campaign_id: number;
        vault: string;
        maker: string;
        bond: string;
        status: RegistrationView["status"];
        registered_ts: number;
      }[]
    ).map(
      (r): RegistrationView => ({
        campaignId: r.campaign_id,
        vault: addr(r.vault),
        maker: addr(r.maker),
        bond: r.bond,
        status: r.status,
        registeredAt: r.registered_ts,
      }),
    );

    const scoreRows = this.db
      .prepare(
        `SELECT s.campaign_id, s.epoch, s.vault, s.points, s.checks, s.reward, c.reward_token
         FROM maker_scores s JOIN campaigns c ON c.id = s.campaign_id
         WHERE s.maker = ? OR s.vault IN (SELECT address FROM vaults WHERE owner = ?)
         ORDER BY s.campaign_id, s.epoch`,
      )
      .all(a, a) as {
      campaign_id: number;
      epoch: number;
      vault: string;
      points: number;
      checks: number;
      reward: string | null;
      reward_token: string;
    }[];
    const earned = new Map<string, bigint>();
    for (const s of scoreRows) {
      if (s.reward) earned.set(s.reward_token, (earned.get(s.reward_token) ?? 0n) + BigInt(s.reward));
    }

    let checks = 0;
    let passes = 0;
    for (const v of vaultRows) {
      const r = this.db
        .prepare("SELECT COUNT(*) AS n, SUM(passed) AS p FROM probe_results WHERE vault = ? AND ts >= ?")
        .get(v.address, since) as { n: number; p: number | null };
      checks += r.n;
      passes += r.p ?? 0;
    }

    return {
      address: addr(address),
      vaults,
      registrations,
      scores: scoreRows.map((s) => ({
        campaignId: s.campaign_id,
        epoch: s.epoch,
        vault: addr(s.vault),
        points: s.points,
        checks: s.checks,
        reward: s.reward,
      })),
      totalEarned: [...earned.entries()].map(([token, amount]) => ({
        token: addr(token),
        ...this.rewardMeta(token),
        amount: amount.toString(),
      })),
      uptime24h: checks ? passes / checks : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Depth report
  // -------------------------------------------------------------------------------------------

  /** The market a token's report covers: the one with the most campaigns, i.e. the one being probed. */
  private reportMarket(token: string): MarketRow | undefined {
    return this.db
      .prepare(
        `SELECT m.* FROM markets m LEFT JOIN campaigns c ON c.market_id = m.id
         WHERE lower(m.base_symbol) = lower(?) OR lower(m.base) = lower(?)
         GROUP BY m.id ORDER BY COUNT(c.id) DESC, m.id LIMIT 1`,
      )
      .get(token, token) as MarketRow | undefined;
  }

  report(token: string, window: string | undefined): DepthReport | null {
    const m = this.reportMarket(token);
    if (!m) return null;
    const { base, quote } = this.refs(m);
    const span = parseWindow(window, 7 * 86_400);
    const to = now();
    const from = to - span;

    const probeStats = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN p.passed > 0 THEN 1 ELSE 0 END) AS covered, SUM(p.checked) AS checks
         FROM probes p JOIN campaigns c ON c.id = p.campaign_id WHERE c.market_id = ? AND p.ts >= ? AND p.checked > 0`,
      )
      .get(m.id, from) as { n: number; covered: number | null; checks: number | null };

    // Depth and spread from the quotes each probe verified: a passing ProbeResult means the quote was
    // fresh, tight, deep and fully backed at that instant. Built from on-chain events, so a fresh
    // database rebuilds it exactly by backfilling.
    const verified = this.db
      .prepare(
        `SELECT r.campaign_id, r.nonce, r.bid_px, r.ask_px, r.bid_size, r.ask_size
         FROM probe_results r JOIN campaigns c ON c.id = r.campaign_id
         WHERE c.market_id = ? AND r.ts >= ? AND r.passed = 1
         ORDER BY r.campaign_id, r.nonce`,
      )
      .all(m.id, from) as { campaign_id: number; nonce: number; bid_px: string; ask_px: string; bid_size: string; ask_size: string }[];
    const byProbe = new Map<string, typeof verified>();
    for (const r of verified) {
      const k = `${r.campaign_id}:${r.nonce}`;
      const list = byProbe.get(k);
      if (list) list.push(r);
      else byProbe.set(k, [r]);
    }
    const bands = [25, 50];
    const askAt: bigint[][] = bands.map(() => []);
    const bidAt: bigint[][] = bands.map(() => []);
    const spreads: number[] = [];
    for (const group of byProbe.values()) {
      let bestBid = 0n;
      let bestAsk = 0n;
      for (const q of group) {
        const bid = BigInt(q.bid_px);
        const ask = BigInt(q.ask_px);
        if (BigInt(q.bid_size) > 0n && bid > bestBid) bestBid = bid;
        if (BigInt(q.ask_size) > 0n && (bestAsk === 0n || ask < bestAsk)) bestAsk = ask;
      }
      if (bestBid === 0n || bestAsk === 0n || bestAsk <= bestBid) continue;
      spreads.push(Number(spreadBps(bestBid, bestAsk)));
      const mid = (bestBid + bestAsk) / 2n;
      bands.forEach((bps, bi) => {
        let askBase = 0n;
        let bidQuote = 0n;
        for (const q of group) {
          const ask = BigInt(q.ask_px);
          const bid = BigInt(q.bid_px);
          if (ask * 10_000n <= mid * BigInt(10_000 + bps)) askBase += BigInt(q.ask_size);
          if (bid * 10_000n >= mid * BigInt(10_000 - bps)) {
            bidQuote += quoteNotional(BigInt(q.bid_size), bid, base.decimals, quote.decimals);
          }
        }
        (askAt[bi] as bigint[]).push(askBase);
        (bidAt[bi] as bigint[]).push(bidQuote);
      });
    }

    // Daily rollup.
    const dayRows = this.db
      .prepare(
        `SELECT (p.ts / 86400) * 86400 AS day, COUNT(*) AS n, SUM(CASE WHEN p.passed > 0 THEN 1 ELSE 0 END) AS covered
         FROM probes p JOIN campaigns c ON c.id = p.campaign_id WHERE c.market_id = ? AND p.ts >= ? AND p.checked > 0
         GROUP BY day ORDER BY day`,
      )
      .all(m.id, from) as { day: number; n: number; covered: number }[];
    const daySpread = this.db.prepare(
      `SELECT r.spread_bps FROM probe_results r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.market_id = ? AND r.ts >= ? AND r.ts < ? AND r.passed = 1`,
    );

    const makers = this.db
      .prepare(
        `SELECT COUNT(DISTINCT v.owner) AS n FROM probe_results r JOIN vaults v ON v.address = r.vault
         WHERE v.market_id = ? AND r.ts >= ?`,
      )
      .get(m.id, from) as { n: number };

    const probeRows = this.db
      .prepare(
        `SELECT p.* FROM probes p JOIN campaigns c ON c.id = p.campaign_id
         WHERE c.market_id = ? AND p.ts >= ? ORDER BY p.ts DESC LIMIT 300`,
      )
      .all(m.id, from) as ProbeRow[];

    return {
      token: base,
      pair: m.slug,
      quote,
      generatedAt: to,
      windowFrom: from,
      windowTo: to,
      verifiedUptime: probeStats.n ? (probeStats.covered ?? 0) / probeStats.n : null,
      probes: probeStats.n,
      vaultChecks: probeStats.checks ?? 0,
      medianSpreadBps: median(spreads),
      makers: makers.n,
      depth: bands.map((bps, i) => ({
        bps,
        askBase: medianBig(askAt[i] as bigint[]).toString(),
        bidQuote: medianBig(bidAt[i] as bigint[]).toString(),
      })),
      campaigns: this.campaignIdsFor(m.id),
      daily: dayRows.map((d) => ({
        day: d.day,
        uptime: d.n ? d.covered / d.n : null,
        probes: d.n,
        medianSpreadBps: median(
          (daySpread.all(m.id, d.day, d.day + 86_400) as { spread_bps: number }[]).map((r) => r.spread_bps),
        ),
      })),
      probeLog: this.probeViews(probeRows),
      contracts: {
        campaigns: deployment.contracts.campaigns,
        factory: deployment.contracts.factory,
        router: deployment.contracts.router,
      },
    };
  }

  /** Paginated probe log behind a report, newest first. */
  reportProbes(token: string, offset: number, limit: number): { total: number; probes: ProbeView[] } | null {
    const m = this.reportMarket(token);
    if (!m) return null;
    const total = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM probes p JOIN campaigns c ON c.id = p.campaign_id WHERE c.market_id = ?")
        .get(m.id) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT p.* FROM probes p JOIN campaigns c ON c.id = p.campaign_id WHERE c.market_id = ?
         ORDER BY p.ts DESC, p.nonce DESC LIMIT ? OFFSET ?`,
      )
      .all(m.id, limit, offset) as ProbeRow[];
    return { total, probes: this.probeViews(rows) };
  }

  // -------------------------------------------------------------------------------------------
  // Economics
  // -------------------------------------------------------------------------------------------

  economics(hypeUsd: number | null): EconomicsResponse {
    const p = this.db
      .prepare(
        "SELECT COUNT(*) AS n, SUM(gas_used) AS gas, COUNT(gas_used) AS measured, MIN(ts) AS first, MAX(ts) AS last FROM probes",
      )
      .get() as { n: number; gas: number | null; measured: number; first: number | null; last: number | null };
    const costRows = this.db.prepare("SELECT gas_used, gas_price FROM probes WHERE gas_used IS NOT NULL").all() as {
      gas_used: number;
      gas_price: string;
    }[];
    let cost = 0n;
    let priceSum = 0n;
    for (const r of costRows) {
      cost += BigInt(r.gas_used) * BigInt(r.gas_price);
      priceSum += BigInt(r.gas_price);
    }
    const q = this.db.prepare("SELECT SUM(count) AS n FROM quote_updates").get() as { n: number | null };
    const g = this.db
      .prepare("SELECT AVG(gas_used) AS avg, COUNT(*) AS n FROM gas_samples WHERE kind = 'setQuote'")
      .get() as { avg: number | null; n: number };
    const since = now() - 86_400;
    const p24 = this.db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS first FROM probes WHERE ts >= ?").get(since) as {
      n: number;
      first: number | null;
    };
    const q24 = this.db.prepare("SELECT SUM(count) AS n, MIN(hour) AS first FROM quote_updates WHERE hour >= ?").get(
      since - 3600,
    ) as { n: number | null; first: number | null };
    const hoursOf = (first: number | null) => (first === null ? 0 : Math.max(1 / 60, (now() - first) / 3600));
    const blockMs = getMeta(this.db, "avg_block_ms");

    return {
      totalProbes: p.n,
      probeGasTotal: p.gas ?? 0,
      probeGasAvg: p.measured ? Math.round((p.gas ?? 0) / p.measured) : null,
      probeCostNativeTotal: cost.toString(),
      avgGasPriceWei: costRows.length ? (priceSum / BigInt(costRows.length)).toString() : null,
      quoteUpdates: q.n ?? 0,
      quoteUpdateGasAvg: g.avg === null ? null : Math.round(g.avg),
      quoteUpdateGasSampled: g.n,
      avgBlockTimeMs: blockMs ? Number(blockMs) : null,
      firstProbeAt: p.first,
      lastProbeAt: p.last,
      probesPerHour: p24.n ? p24.n / hoursOf(p24.first) : null,
      quoteUpdatesPerHour: q24.n ? q24.n / Math.min(24, hoursOf(q24.first)) : null,
      hypeUsd,
    };
  }
}
