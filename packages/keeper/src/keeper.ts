import { decodeEventLog, encodeFunctionData, type PublicClient, type TransactionReceipt } from "viem";
import { deployment, plumbCampaignsAbi } from "@plumbline/shared";
import { TxSender, WouldRevertError, type Logger } from "@plumbline/shared/node";
import type { KeeperConfig } from "./config.js";
import type { Stats } from "./stats.js";

interface Track {
  id: number;
  startTime: number;
  epochLength: number;
  numEpochs: number;
  minProbeInterval: number;
  settledEpochs: number;
  rewardToken: `0x${string}`;
  lastProbeAt: number;
  inFlight: boolean;
  settling: boolean;
  /** No new attempt before this time (ms): pollers still seeing an opening that this probe just used up would resend. */
  quietUntil?: number;
}

/**
 * Probes every eligible campaign the moment its jitter gate opens, settles finished epochs, and
 * claims accrued probe fees.
 */
export class Keeper {
  private readonly tracks = new Map<number, Track>();
  private readonly campaigns = deployment.contracts.campaigns;
  private clockSkew = 0;
  private stopped = false;
  lastPollAt = 0;
  /** Set by the budget guard; the keeper keeps serving stats but sends nothing. */
  budgetExhausted = false;
  lastHead = 0;
  balanceWei = 0n;

  constructor(
    private readonly cfg: KeeperConfig,
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly stats: Stats,
    private readonly log: Logger,
    /** Clients (usually one per RPC endpoint) the gate pollers take turns on. Defaults to `client`. */
    private readonly pollClients: PublicClient[] = [client],
  ) {}

  /** Chain time estimate in seconds (local clock corrected by the last observed block). */
  now(): number {
    return Math.floor(Date.now() / 1000) + this.clockSkew;
  }

  activeTracks(): Track[] {
    return [...this.tracks.values()];
  }

  async start(): Promise<void> {
    if (!deployment.deployed) throw new Error("Plumbline is not deployed; run pnpm contracts:deploy first");
    await this.sender.resync();
    await this.refresh();
    this.loop("refresh", this.cfg.refreshMs, () => this.refresh());
    // The gate stays open for about a second (8 L2 blocks) and a poll takes half a second on a public
    // node, so one poller misses most openings. Several, spread over the endpoints and started
    // staggered, see an opening within a fraction of a round trip.
    const pollers = Math.max(1, this.cfg.pollers);
    for (let i = 0; i < pollers; i++) {
      const c = this.pollClients[i % this.pollClients.length] ?? this.client;
      setTimeout(() => this.loop(`gates-${i}`, this.cfg.pollMs, () => this.pollGates(c)), Math.round((i * this.cfg.pollMs) / pollers));
    }
    if (this.cfg.autoSettle) this.loop("settle", 2_000, () => this.settleDue());
    this.loop("claim", 60_000, () => this.claimFees());
    this.loop("persist", 10_000, async () => this.stats.save());
  }

  stop(): void {
    this.stopped = true;
    this.stats.save();
  }

  private loop(name: string, everyMs: number, fn: () => Promise<void>): void {
    const tick = async () => {
      if (this.stopped) return;
      const t0 = Date.now();
      try {
        await fn();
      } catch (err) {
        this.log.warn(`${name} loop error`, { err: err instanceof Error ? err.message : String(err) });
      }
      setTimeout(() => void tick(), Math.max(0, everyMs - (Date.now() - t0)));
    };
    void tick();
  }

  /** Discover campaigns and refresh their state. */
  private async refresh(): Promise<void> {
    const [count, block, balance] = await Promise.all([
      this.client.readContract({ address: this.campaigns, abi: plumbCampaignsAbi, functionName: "campaignCount" }),
      this.client.getBlock({ blockTag: "latest" }),
      this.client.getBalance({ address: this.sender.address }),
    ]);
    this.clockSkew = Number(block.timestamp) - Math.floor(Date.now() / 1000);
    this.balanceWei = balance;
    if (this.cfg.stopBelowWei > 0n && balance < this.cfg.stopBelowWei && !this.budgetExhausted) {
      this.budgetExhausted = true;
      this.log.warn("gas budget spent; no further transactions", { balanceWei: balance });
    }

    const wanted = this.cfg.campaignIds.length
      ? this.cfg.campaignIds.filter((id) => id <= Number(count))
      : Array.from({ length: Number(count) }, (_, i) => i + 1);

    const reads = await this.client.multicall({
      contracts: wanted.flatMap((id) => [
        { address: this.campaigns, abi: plumbCampaignsAbi, functionName: "terms", args: [BigInt(id)] } as const,
        { address: this.campaigns, abi: plumbCampaignsAbi, functionName: "state", args: [BigInt(id)] } as const,
      ]),
      allowFailure: false,
    });

    for (let i = 0; i < wanted.length; i++) {
      const id = wanted[i] as number;
      const terms = reads[2 * i] as { epochLength: bigint; minProbeInterval: number };
      const state = reads[2 * i + 1] as {
        startTime: bigint;
        numEpochs: number;
        settledEpochs: number;
        rewardToken: `0x${string}`;
        lastProbeAt: bigint;
      };
      const done = state.settledEpochs >= state.numEpochs;
      if (done) {
        this.tracks.delete(id);
        continue;
      }
      const fresh = {
        startTime: Number(state.startTime),
        epochLength: Number(terms.epochLength),
        numEpochs: state.numEpochs,
        minProbeInterval: terms.minProbeInterval,
        rewardToken: state.rewardToken,
        lastProbeAt: Number(state.lastProbeAt),
      };
      const existing = this.tracks.get(id);
      if (existing) {
        // Update in place: in-flight probes and settles hold a reference to this object.
        Object.assign(existing, fresh);
        if (!existing.settling) existing.settledEpochs = Math.max(existing.settledEpochs, state.settledEpochs);
      } else {
        this.tracks.set(id, { id, ...fresh, settledEpochs: state.settledEpochs, inFlight: false, settling: false });
        this.log.info("tracking campaign", { id, epochs: fresh.numEpochs, epochLength: fresh.epochLength });
      }
    }
  }

  /** One multicall per poll: which running campaigns have an open gate right now. */
  private async pollGates(client: PublicClient): Promise<void> {
    const now = this.now();
    // The gate cannot open inside minProbeInterval, so do not spend RPC requests asking.
    const candidates = this.activeTracks().filter(
      (t) =>
        !t.inFlight &&
        Date.now() >= (t.quietUntil ?? 0) &&
        now >= t.startTime &&
        now < t.startTime + t.numEpochs * t.epochLength &&
        now >= t.lastProbeAt + t.minProbeInterval - 1,
    );
    this.lastPollAt = Date.now();
    if (candidates.length === 0) return;
    const open = await client.multicall({
      contracts: candidates.map(
        (t) =>
          ({
            address: this.campaigns,
            abi: plumbCampaignsAbi,
            functionName: "probeGateOpen",
            args: [BigInt(t.id)],
          }) as const,
      ),
      allowFailure: true,
    });
    candidates.forEach((t, i) => {
      const r = open[i];
      // Re-checked here: another poller may have started a probe while this poll was in flight.
      if (r && r.status === "success" && r.result === true && !t.inFlight && Date.now() >= (t.quietUntil ?? 0)) void this.probe(t);
    });
  }

  private async probe(t: Track): Promise<void> {
    if (this.budgetExhausted) return;
    t.inFlight = true;
    const st = this.stats.of(t.id);
    try {
      const sent = await this.sender.send({
        to: this.campaigns,
        data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "probe", args: [BigInt(t.id)] }),
        abi: plumbCampaignsAbi,
        // The gate window is ~8 blocks (~1.2s). A fixed limit skips the estimate round trip so the
        // probe lands inside it; measured probes cost 158k-232k gas.
        gas: BigInt(process.env.KEEPER_PROBE_GAS ?? 450_000),
        label: `probe#${t.id}`,
      });
      const receipt = await this.sender.wait(sent.hash);
      const latencyMs = Date.now() - sent.sentAt;
      const gasUsed = Number(receipt.gasUsed);
      if (receipt.status !== "success") {
        this.stats.probeReverted(t.id, gasUsed, receipt.effectiveGasPrice);
        this.log.warn("probe reverted", { id: t.id, tx: sent.hash });
        return;
      }
      const probed = this.decodeProbed(receipt);
      const block = await this.blockTs(receipt);
      t.lastProbeAt = Math.max(t.lastProbeAt, block);
      this.stats.probeOk(t.id, {
        tx: sent.hash,
        block: Number(receipt.blockNumber),
        ts: block,
        gasUsed,
        gasPriceWei: receipt.effectiveGasPrice.toString(),
        latencyMs,
        checked: probed?.checked ?? 0,
        passed: probed?.passed ?? 0,
        feeWei: (probed?.fee ?? 0n).toString(),
      });
      this.log.info("probed", {
        id: t.id,
        nonce: probed?.nonce,
        passed: `${probed?.passed ?? 0}/${probed?.checked ?? 0}`,
        gas: gasUsed,
        ms: latencyMs,
        tx: sent.hash,
      });
    } catch (err) {
      if (err instanceof WouldRevertError) {
        st.raceLost += 1;
        this.log.debug("gate closed before send", { id: t.id, reason: err.errorName });
      } else {
        st.errors += 1;
        this.log.warn("probe failed", { id: t.id, err: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      t.inFlight = false;
      t.quietUntil = Date.now() + 2_000;
    }
  }

  private decodeProbed(receipt: TransactionReceipt) {
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== this.campaigns.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: plumbCampaignsAbi, data: lg.data, topics: lg.topics });
        if (ev.eventName === "Probed") {
          return {
            nonce: Number(ev.args.nonce),
            checked: Number(ev.args.checked),
            passed: Number(ev.args.passed),
            fee: ev.args.fee,
          };
        }
      } catch {
        // not one of ours
      }
    }
    return null;
  }

  private async blockTs(receipt: TransactionReceipt): Promise<number> {
    const b = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    this.lastHead = Math.max(this.lastHead, Number(b.number));
    return Number(b.timestamp);
  }

  /** Settle any epoch whose time is up. Anyone may settle; the keeper just makes sure someone does. */
  private async settleDue(): Promise<void> {
    if (this.budgetExhausted) return;
    const now = this.now();
    for (const t of this.activeTracks()) {
      if (t.settling || t.settledEpochs >= t.numEpochs) continue;
      const due = t.startTime + (t.settledEpochs + 1) * t.epochLength;
      if (now < due + 1) continue;
      t.settling = true;
      try {
        const { sent, receipt } = await this.sender.sendAndWait({
          to: this.campaigns,
          data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "settle", args: [BigInt(t.id)] }),
          abi: plumbCampaignsAbi,
          label: `settle#${t.id}`,
        });
        this.stats.totals.settles += 1;
        this.stats.otherTx(Number(receipt.gasUsed), receipt.effectiveGasPrice);
        t.settledEpochs += 1;
        this.log.info("settled epoch", { id: t.id, epoch: t.settledEpochs - 1, tx: sent.hash });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof WouldRevertError && err.errorName === "EpochNotOver") return;
        this.log.warn("settle failed", { id: t.id, err: msg });
      } finally {
        t.settling = false;
      }
    }
  }

  /** Withdraw accrued probe fees once they are worth a transaction. */
  private async claimFees(): Promise<void> {
    if (this.budgetExhausted) return;
    const tokens = new Set(this.activeTracks().map((t) => t.rewardToken));
    for (const token of tokens) {
      const owed = await this.client.readContract({
        address: this.campaigns,
        abi: plumbCampaignsAbi,
        functionName: "claimable",
        args: [token, this.sender.address],
      });
      if (owed < this.cfg.claimThresholdWei) continue;
      const { receipt } = await this.sender.sendAndWait({
        to: this.campaigns,
        data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "claim", args: [token] }),
        abi: plumbCampaignsAbi,
        label: "claim",
      });
      this.stats.totals.claims += 1;
      this.stats.totals.claimedWei = (BigInt(this.stats.totals.claimedWei) + owed).toString();
      this.stats.otherTx(Number(receipt.gasUsed), receipt.effectiveGasPrice);
      this.log.info("claimed fees", { token, owed });
    }
  }
}
