import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@plumbline/shared/node";

export interface ProbeRecord {
  tx: `0x${string}`;
  block: number;
  ts: number;
  gasUsed: number;
  gasPriceWei: string;
  latencyMs: number;
  checked: number;
  passed: number;
  feeWei: string;
}

export interface CampaignStats {
  id: number;
  probesOk: number;
  probesReverted: number;
  /** Gate closed between our read and the estimate (another keeper won, or the window moved). */
  raceLost: number;
  errors: number;
  gasUsed: number;
  costWei: string;
  feesEarnedWei: string;
  latencyMsTotal: number;
  vaultsChecked: number;
  vaultsPassed: number;
  lastProbeAt: number | null;
  recent: ProbeRecord[];
}

export interface KeeperTotals {
  startedAt: number;
  settles: number;
  claims: number;
  claimedWei: string;
  gasUsed: number;
  costWei: string;
}

interface Persisted {
  totals: KeeperTotals;
  campaigns: Record<string, CampaignStats>;
}

const RECENT = 100;

export class Stats {
  private readonly path = join(dataDir(), "keeper-stats.json");
  totals: KeeperTotals = { startedAt: Math.floor(Date.now() / 1000), settles: 0, claims: 0, claimedWei: "0", gasUsed: 0, costWei: "0" };
  campaigns = new Map<number, CampaignStats>();
  /** Wall-clock times of successful probes, for rate calculations. */
  private probeTimes: number[] = [];

  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const p = JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
      this.totals = { ...p.totals, startedAt: this.totals.startedAt };
      for (const [k, v] of Object.entries(p.campaigns)) this.campaigns.set(Number(k), v);
    } catch {
      // A corrupt stats file is not worth failing the keeper over; start fresh.
    }
  }

  save(): void {
    mkdirSync(dataDir(), { recursive: true });
    const p: Persisted = { totals: this.totals, campaigns: Object.fromEntries(this.campaigns) };
    writeFileSync(this.path, JSON.stringify(p));
  }

  of(id: number): CampaignStats {
    let s = this.campaigns.get(id);
    if (!s) {
      s = {
        id,
        probesOk: 0,
        probesReverted: 0,
        raceLost: 0,
        errors: 0,
        gasUsed: 0,
        costWei: "0",
        feesEarnedWei: "0",
        latencyMsTotal: 0,
        vaultsChecked: 0,
        vaultsPassed: 0,
        lastProbeAt: null,
        recent: [],
      };
      this.campaigns.set(id, s);
    }
    return s;
  }

  private addGas(gasUsed: number, cost: bigint): void {
    this.totals.gasUsed += gasUsed;
    this.totals.costWei = (BigInt(this.totals.costWei) + cost).toString();
  }

  probeOk(id: number, r: ProbeRecord): void {
    const s = this.of(id);
    const cost = BigInt(r.gasUsed) * BigInt(r.gasPriceWei);
    s.probesOk += 1;
    s.gasUsed += r.gasUsed;
    s.costWei = (BigInt(s.costWei) + cost).toString();
    s.feesEarnedWei = (BigInt(s.feesEarnedWei) + BigInt(r.feeWei)).toString();
    s.latencyMsTotal += r.latencyMs;
    s.vaultsChecked += r.checked;
    s.vaultsPassed += r.passed;
    s.lastProbeAt = r.ts;
    s.recent.unshift(r);
    if (s.recent.length > RECENT) s.recent.length = RECENT;
    this.addGas(r.gasUsed, cost);
    this.probeTimes.push(Date.now());
  }

  probeReverted(id: number, gasUsed: number, gasPriceWei: bigint): void {
    const s = this.of(id);
    s.probesReverted += 1;
    s.gasUsed += gasUsed;
    const cost = BigInt(gasUsed) * gasPriceWei;
    s.costWei = (BigInt(s.costWei) + cost).toString();
    this.addGas(gasUsed, cost);
  }

  otherTx(gasUsed: number, gasPriceWei: bigint): void {
    this.addGas(gasUsed, BigInt(gasUsed) * gasPriceWei);
  }

  /** Successful probes per minute over the trailing window. */
  probesPerMinute(windowMs = 10 * 60_000): number {
    const cutoff = Date.now() - windowMs;
    this.probeTimes = this.probeTimes.filter((t) => t >= cutoff);
    const span = Math.min(windowMs, Date.now() - this.totals.startedAt * 1000);
    return span > 0 ? (this.probeTimes.length * 60_000) / span : 0;
  }
}
