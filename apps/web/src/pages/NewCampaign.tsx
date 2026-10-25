import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { decodeEventLog, erc20Abi, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { MEASURED_GAS, deployment, knownTokens, plumbCampaignsAbi } from "@plumbline/shared";
import { wagmiConfig } from "../lib/wagmi";
import { useTxRunner } from "../lib/tx";
import { STATIC } from "../lib/api";
import { duration, fmtDec } from "../lib/format";
import { TxStatus } from "../components/TxStatus";
import { GasCost, WriteNotice, gasHype } from "../components/Write";
import { Button, Field, Input, PageHeader, Panel, Select, Page, TxLink } from "../components/ui";

const MAX_PROBE_SHARE_BPS = 5_000;
const GATE_ODDS = 64;
/** Measured L2 block time on Elysium; the gate's mean wait is GATE_ODDS of these. */
const BLOCK_MS = 139;

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
  const [opened, setOpened] = useState<{ id: string; hash: `0x${string}` } | null>(null);
  // Defaults a testnet-faucet wallet can afford (a faucet drip is about 0.1 HYPE): a one-hour
  // campaign paying 0.012 HYPE in total, on the market the demo makers quote, at their size.
  const [f, setF] = useState<Form>({
    base: tokens.find((t) => t.symbol === "WHYPE")?.address ?? tokens[0]?.address ?? "",
    quote: tokens.find((t) => t.symbol === "PLUMBUSD")?.address ?? tokens[1]?.address ?? "",
    rewardToken: zeroAddress,
    rewardPerEpoch: "0.001",
    numEpochs: "12",
    epochLength: "300",
    maxSpreadBps: "30",
    minDepthBase: "0.0005",
    minDepthQuote: "0.02",
    minProbeInterval: "13",
    probeFeeBps: "10",
    makerBond: "0.001",
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
    // Expected cadence: the interval plus a geometric wait of GATE_ODDS blocks.
    const expectedGap = interval + (GATE_ODDS * BLOCK_MS) / 1000;
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
      const hash: `0x${string}` = openHash;
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
      for (const l of receipt.logs) {
        try {
          const e = decodeEventLog({ abi: plumbCampaignsAbi, data: l.data, topics: l.topics });
          if (e.eventName === "CampaignOpened") {
            // A snapshot has no page for a campaign opened after it; say what happened instead.
            if (STATIC) setOpened({ id: e.args.id.toString(), hash });
            else nav(`/campaign/${e.args.id.toString()}`);
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
      <WriteNotice className="mb-6" />
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
              ["Funding now", `${f.rewardPerEpoch && f.numEpochs ? fmtDec(Number(f.rewardPerEpoch) * Number(f.numEpochs), 4) : "—"} ${reward?.symbol ?? ""}`],
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
            <ul className="mt-4 space-y-1 rounded-[8px] border-2 border-ink bg-danger-text px-3 py-2 text-xs font-semibold text-paper">
              {derived.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 rounded-[8px] border-2 border-ink bg-bg px-3 py-2.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold">You pay now</span>
              <span className="num font-bold">
                {fmtDec(Number(f.rewardPerEpoch) * Number(f.numEpochs) || 0, 4)} {reward?.symbol}
              </span>
            </div>
            <div className="num mt-0.5 text-xs text-muted">
              {f.rewardPerEpoch || "0"} × {f.numEpochs || "0"} epochs
              {reward?.address !== zeroAddress ? " + approve" : ""} · network fee ≈{" "}
              {fmtDec(gasHype(MEASURED_GAS.openCampaign + (reward?.address !== zeroAddress ? MEASURED_GAS.approve : 0)), 2)} HYPE
            </div>
            <div className="num mt-1.5 text-xs">
              Each maker that joins posts a {f.makerBond || "0"} {reward?.symbol} bond (theirs, not yours; returned on unbond).
            </div>
          </div>
          <Button
            variant="primary"
            className="mt-3 w-full"
            disabled={!address || derived.errors.length > 0 || tx.busy}
            onClick={() => void submit()}
          >
            {address ? `Fund ${fmtDec(Number(f.rewardPerEpoch) * Number(f.numEpochs) || 0, 4)} ${reward?.symbol ?? ""} and open` : "Connect a wallet"}
          </Button>
          <div className="mt-1.5">
            <GasCost gas={MEASURED_GAS.openCampaign} />
          </div>
          <TxStatus state={tx.state} />
          {opened && (
            <div className="mt-3 rounded-[8px] border-2 border-ink bg-highlight px-3 py-2.5 text-sm leading-6">
              <div className="font-bold">
                Campaign <span className="num">#{opened.id}</span> is open on-chain.
              </div>
              <p>
                Opened in <TxLink hash={opened.hash} />. Makers can bond into it and anyone can probe it now. This site shows a
                snapshot taken before it existed, so it has no page for it until the snapshot is refreshed.
              </p>
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}
