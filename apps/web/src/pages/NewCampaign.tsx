import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { decodeEventLog, erc20Abi, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { deployment, knownTokens, plumbCampaignsAbi } from "@plumbline/shared";
import { wagmiConfig } from "../lib/wagmi";
import { useTxRunner } from "../lib/tx";
import { duration } from "../lib/format";
import { TxStatus } from "../components/TxStatus";
import { Button, Field, Input, PageHeader, Panel, Select, Page } from "../components/ui";

const MAX_PROBE_SHARE_BPS = 5_000;
const GATE_ODDS = 64;

interface Form {
  base: string;
  quote: string;
  rewardToken: string;
  rewardPerEpoch: string;
  numEpochs: string;
  epochLength: string;
  maxSpreadBps: string;
  minDepthBase: string;
  minDepthQuote: string;
  minProbeInterval: string;
  probeFeeBps: string;
  makerBond: string;
}

export function NewCampaignPage() {
  const tokens = knownTokens();
  const nav = useNavigate();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTxRunner();
  const [f, setF] = useState<Form>({
    base: tokens.find((t) => t.symbol === "WHYPE")?.address ?? tokens[0]?.address ?? "",
    quote: tokens.find((t) => t.symbol === "USDC")?.address ?? tokens[1]?.address ?? "",
    rewardToken: zeroAddress,
    rewardPerEpoch: "1",
    numEpochs: "24",
    epochLength: "3600",
    maxSpreadBps: "30",
    minDepthBase: "1",
    minDepthQuote: "40",
    minProbeInterval: "20",
    probeFeeBps: "10",
    makerBond: "0.5",
  });
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const base = tokens.find((t) => t.address === f.base);
  const quote = tokens.find((t) => t.address === f.quote);
  const reward = f.rewardToken === zeroAddress ? { symbol: "HYPE", decimals: 18, address: zeroAddress } : tokens.find((t) => t.address === f.rewardToken);

  const derived = useMemo(() => {
    const epochLength = Number(f.epochLength);
    const interval = Number(f.minProbeInterval);
    const feeBps = Number(f.probeFeeBps);
    const maxProbes = interval > 0 ? Math.floor(epochLength / interval) : 0;
    // Expected cadence: the interval plus a geometric wait of GATE_ODDS blocks at ~120ms.
    const expectedGap = interval + (GATE_ODDS * 120) / 1000;
    const expectedProbes = expectedGap > 0 ? Math.floor(epochLength / expectedGap) : 0;
    const errors: string[] = [];
    if (!base || !quote || base.address === quote.address) errors.push("pick two different tokens");
    if (epochLength < 60) errors.push("epochs must be at least 60s");
    if (interval <= 0 || interval >= epochLength) errors.push("probe interval must be positive and shorter than an epoch");
    if (feeBps * maxProbes > MAX_PROBE_SHARE_BPS)
      errors.push(`probe fees could reach ${((feeBps * maxProbes) / 100).toFixed(0)}% of the pot; the cap is 50%`);
    const sp = Number(f.maxSpreadBps);
    if (!(sp >= 1 && sp <= 10_000)) errors.push("max spread must be 1–10000 bps");
    if (!(Number(f.numEpochs) >= 1)) errors.push("fund at least one epoch");
    if (!(Number(f.rewardPerEpoch) > 0)) errors.push("reward per epoch must be positive");
    if (!(Number(f.makerBond) > 0)) errors.push("maker bond must be positive");
    return { maxProbes, expectedProbes, maxFeeShare: (feeBps * maxProbes) / 100, expectedFeeShare: (feeBps * expectedProbes) / 100, errors };
  }, [f, base, quote]);

  const total = reward ? (() => {
    try {
      return parseUnits(f.rewardPerEpoch || "0", reward.decimals) * BigInt(Number(f.numEpochs) || 0);
    } catch {
      return 0n;
    }
  })() : 0n;

  async function submit() {
    if (!base || !quote || !reward || !address) return;
    const terms = {
      base: base.address,
      quote: quote.address,
      epochLength: BigInt(f.epochLength),
      rewardPerEpoch: parseUnits(f.rewardPerEpoch, reward.decimals),
      maxSpreadBps: Number(f.maxSpreadBps),
      minDepthBase: parseUnits(f.minDepthBase, base.decimals),
      minDepthQuote: parseUnits(f.minDepthQuote, quote.decimals),
      minProbeInterval: Number(f.minProbeInterval),
      probeFeeBps: Number(f.probeFeeBps),
      makerBond: parseUnits(f.makerBond, reward.decimals),
    };
    const native = reward.address === zeroAddress;
    let openHash: `0x${string}` | null = null;
    const steps: { label: string; send: () => Promise<`0x${string}`> }[] = [];
    if (!native) {
      steps.push({
        label: `approve ${reward.symbol}`,
        send: () =>
          writeContractAsync({
            address: reward.address as Address,
            abi: erc20Abi,
            functionName: "approve",
            args: [deployment.contracts.campaigns, total],
          }),
      });
    }
    steps.push({
      label: "open campaign",
      send: async () => {
        openHash = await writeContractAsync({
          address: deployment.contracts.campaigns,
          abi: plumbCampaignsAbi,
          functionName: "openCampaign",
          args: [terms, reward.address as Address, Number(f.numEpochs), 0n, zeroAddress],
          value: native ? total : 0n,
        });
        return openHash;
      },
    });
    const ok = await tx.run(steps);
    if (ok && openHash) {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: openHash });
      for (const l of receipt.logs) {
        try {
          const e = decodeEventLog({ abi: plumbCampaignsAbi, data: l.data, topics: l.topics });
          if (e.eventName === "CampaignOpened") {
            nav(`/campaign/${e.args.id.toString()}`);
            return;
          }
        } catch {
          // not ours
        }
      }
    }
  }

  return (
    <Page density="expressive">
      <PageHeader
        kicker="New campaign"
        title={
          <>
            Pay for liquidity
            <br />
            that <span className="marker">shows up</span>.
          </>
        }
        sub="Set the bar a quote has to clear, fund the pot, and let permissionless probes decide who earns it. Makers who advertise size they cannot pay lose part of their bond."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
        <Panel title="Terms">
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="Base token">
              <Select value={f.base} onChange={set("base")}>
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quote token">
              <Select value={f.quote} onChange={set("quote")}>
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reward token" hint="bonds are posted in the same token">
              <Select value={f.rewardToken} onChange={set("rewardToken")}>
                <option value={zeroAddress}>HYPE (native)</option>
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reward per epoch">
              <Input value={f.rewardPerEpoch} onChange={set("rewardPerEpoch")} suffix={reward?.symbol} />
            </Field>
            <Field label="Epochs">
              <Input value={f.numEpochs} onChange={set("numEpochs")} />
            </Field>
            <Field label="Epoch length" hint={duration(Number(f.epochLength) || 0)}>
              <Input value={f.epochLength} onChange={set("epochLength")} suffix="s" />
            </Field>
            <Field label="Max spread" hint="measured around each quote's mid">
              <Input value={f.maxSpreadBps} onChange={set("maxSpreadBps")} suffix="bps" />
            </Field>
            <Field label="Min ask size">
              <Input value={f.minDepthBase} onChange={set("minDepthBase")} suffix={base?.symbol} />
            </Field>
            <Field label="Min bid notional">
              <Input value={f.minDepthQuote} onChange={set("minDepthQuote")} suffix={quote?.symbol} />
            </Field>
            <Field label="Min probe interval" hint="plus an unpredictable gate wait">
              <Input value={f.minProbeInterval} onChange={set("minProbeInterval")} suffix="s" />
            </Field>
            <Field label="Probe fee" hint="paid to whoever probes, per probe">
              <Input value={f.probeFeeBps} onChange={set("probeFeeBps")} suffix="bps" />
            </Field>
            <Field label="Maker bond" hint="20% slashed per verified failed fill">
              <Input value={f.makerBond} onChange={set("makerBond")} suffix={reward?.symbol} />
            </Field>
          </div>
        </Panel>
        <Panel title="Summary">
          <dl className="space-y-2.5 text-sm">
            {[
              ["Funding now", `${f.rewardPerEpoch && f.numEpochs ? (Number(f.rewardPerEpoch) * Number(f.numEpochs)).toLocaleString() : "—"} ${reward?.symbol ?? ""}`],
              ["Duration", duration((Number(f.epochLength) || 0) * (Number(f.numEpochs) || 0))],
              ["Probes / epoch, max", String(derived.maxProbes)],
              ["Probes / epoch, expected", `~${derived.expectedProbes}`],
              ["Probe fees, expected", `~${derived.expectedFeeShare.toFixed(1)}% of pot`],
              ["Probe fees, worst case", `${derived.maxFeeShare.toFixed(1)}% of pot`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd className="num text-right font-semibold text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          {derived.errors.length > 0 && (
            <ul className="mt-4 space-y-1 rounded-[8px] border-2 border-ink bg-danger px-3 py-2 text-xs font-semibold text-paper">
              {derived.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <Button
            variant="primary"
            className="mt-4 w-full"
            disabled={!address || derived.errors.length > 0 || tx.busy}
            onClick={() => void submit()}
          >
            {address ? "Fund and open" : "Connect a wallet"}
          </Button>
          <TxStatus state={tx.state} />
        </Panel>
      </div>
    </Page>
  );
}
