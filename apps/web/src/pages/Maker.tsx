import { useState } from "react";
import { Link } from "react-router-dom";
import { decodeEventLog, erc20Abi, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import {
  MEASURED_GAS,
  deployment,
  elysiumTestnet,
  knownTokens,
  plumbCampaignsAbi,
  plumbQuoteAbi,
  plumbQuoteFactoryAbi,
  spreadBps,
  toPx,
  type CampaignView,
  type TokenRef,
} from "@plumbline/shared";
import { STATIC, useCampaigns, useMaker, useMarkets } from "../lib/api";
import { wagmiConfig } from "../lib/wagmi";
import { ago, fmtAmt, fmtInt, fmtPct, fmtPx, short, tone, toneText } from "../lib/format";
import { useTxRunner } from "../lib/tx";
import { TxStatus } from "../components/TxStatus";
import { GasCost, WriteNotice } from "../components/Write";
import { WalletButton } from "../components/Layout";
import {
  AddrLink,
  Badge,
  Button,
  Empty,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Stat,
  StatRow,
  Table,
  Td,
  Th,
  Page,
} from "../components/ui";

type Step = { label: string; send: () => Promise<`0x${string}`> };

const CHAIN = elysiumTestnet.id;

/**
 * Vaults the wallet owns, read from the factory on-chain. The indexer (or snapshot) lists vaults too,
 * but a vault deployed after the snapshot exists only here, and the console must still reach it.
 */
function useChainVaults(owner: Address | undefined, count: number): Address[] {
  const n = Math.min(count, 500);
  const at = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: deployment.contracts.factory,
      abi: plumbQuoteFactoryAbi,
      functionName: "vaultAt" as const,
      args: [BigInt(i)] as const,
      chainId: CHAIN,
    })),
    query: { enabled: Boolean(owner) && n > 0 },
  });
  const all = (at.data ?? []).map((r) => r.result as Address | undefined).filter((a): a is Address => Boolean(a));
  const owners = useReadContracts({
    contracts: all.map((a) => ({ address: a, abi: plumbQuoteAbi, functionName: "owner" as const, chainId: CHAIN })),
    query: { enabled: all.length > 0 },
  });
  return all.filter((_, i) => String(owners.data?.[i]?.result ?? "").toLowerCase() === owner?.toLowerCase());
}

function DeployVault({ onCreated }: { onCreated: (vault: Address) => void }) {
  const tokens = knownTokens();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTxRunner();
  const [base, setBase] = useState(tokens.find((t) => t.symbol === "WHYPE")?.address ?? "");
  const [quote, setQuote] = useState(tokens.find((t) => t.symbol === "PLUMBUSD")?.address ?? "");
  const [created, setCreated] = useState<Address | null>(null);

  async function deploy() {
    let hash: `0x${string}` | null = null;
    const ok = await tx.run([
      {
        label: "create vault",
        send: async () => {
          hash = await writeContractAsync({
            address: deployment.contracts.factory,
            abi: plumbQuoteFactoryAbi,
            functionName: "createVault",
            args: [base as Address, quote as Address, (quoter || zeroAddress) as Address],
          });
          return hash;
        },
      },
    ]);
    if (!ok || !hash) return;
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    for (const l of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: plumbQuoteFactoryAbi, data: l.data, topics: l.topics });
        if (e.eventName === "VaultCreated") {
          setCreated(e.args.vault);
          onCreated(e.args.vault);
          return;
        }
      } catch {
        // not a factory event
      }
    }
  }
  const [quoter, setQuoter] = useState("");
  const validQuoter = quoter === "" || /^0x[0-9a-fA-F]{40}$/.test(quoter);

  return (
    <Panel title="Deploy a vault">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Base">
          <Select value={base} onChange={(e) => setBase(e.target.value)}>
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quote">
          <Select value={quote} onChange={(e) => setQuote(e.target.value)}>
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quoter key" hint="hot key for your bot; it can quote, never withdraw">
          <Input value={quoter} onChange={(e) => setQuoter(e.target.value.trim())} placeholder="0x… (optional)" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="primary" disabled={!address || base === quote || !validQuoter || tx.busy} onClick={() => void deploy()}>
          Deploy vault
        </Button>
        <GasCost gas={MEASURED_GAS.createVault} label="costs" />
      </div>
      <p className="mt-2 text-2xs text-muted">
        The most expensive action in the protocol: the factory deploys a whole contract. PLUMBUSD can only be minted by the
        Plumbline deployer, so a new WHYPE/PLUMBUSD vault can fund its ask side with WHYPE but not its bid side.
      </p>
      <TxStatus state={tx.state} />
      {created && (
        <p className="num mt-2 text-xs">
          Vault <AddrLink address={created} n={6} /> created; it is selected in the console above.
        </p>
      )}
    </Panel>
  );
}

function VaultConsole({ vault, campaigns }: { vault: Address; campaigns: CampaignView[] }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTxRunner();
  const reads = useReadContracts({
    contracts: [
      { address: vault, abi: plumbQuoteAbi, functionName: "quote" },
      { address: vault, abi: plumbQuoteAbi, functionName: "baseToken" },
      { address: vault, abi: plumbQuoteAbi, functionName: "quoteToken" },
      { address: vault, abi: plumbQuoteAbi, functionName: "isLive" },
      { address: vault, abi: plumbQuoteAbi, functionName: "owner" },
      { address: vault, abi: plumbQuoteAbi, functionName: "quoter" },
    ],
    query: { refetchInterval: 1_000 },
  });
  const [q, baseAddr, quoteAddr, live, owner, quoter] = reads.data?.map((r) => r.result) ?? [];
  const tokens = knownTokens();
  const base = tokens.find((t) => t.address.toLowerCase() === String(baseAddr).toLowerCase());
  const quote = tokens.find((t) => t.address.toLowerCase() === String(quoteAddr).toLowerCase());
  const balances = useReadContracts({
    contracts: [
      { address: vault, abi: plumbQuoteAbi, functionName: "freeBalance", args: [(baseAddr ?? zeroAddress) as Address] },
      { address: vault, abi: plumbQuoteAbi, functionName: "freeBalance", args: [(quoteAddr ?? zeroAddress) as Address] },
      { address: vault, abi: plumbQuoteAbi, functionName: "pendingWithdrawal", args: [(baseAddr ?? zeroAddress) as Address] },
      { address: vault, abi: plumbQuoteAbi, functionName: "pendingWithdrawal", args: [(quoteAddr ?? zeroAddress) as Address] },
    ],
    query: { enabled: Boolean(baseAddr && quoteAddr), refetchInterval: 2_000 },
  });
  const [freeBase, freeQuote, pendBase, pendQuote] = balances.data?.map((r) => r.result) ?? [];

  const [bid, setBid] = useState("");
  const [ask, setAsk] = useState("");
  const [size, setSize] = useState("1");
  const [fundToken, setFundToken] = useState<"base" | "quote">("base");
  const [fundAmt, setFundAmt] = useState("");
  const [wdToken, setWdToken] = useState<"base" | "quote">("base");
  const [wdAmt, setWdAmt] = useState("");
  const [campaignId, setCampaignId] = useState("");

  if (!base || !quote || !q || typeof q !== "object") return <Empty>Loading vault…</Empty>;
  const quoteData = q as { bidPx: bigint; askPx: bigint; bidSize: bigint; askSize: bigint; updatedAt: bigint; seq: bigint };
  const isOwner = typeof owner === "string" && owner.toLowerCase() === address?.toLowerCase();
  const pick = (k: "base" | "quote"): TokenRef => (k === "base" ? base : quote);
  const pairCampaigns = campaigns.filter(
    (c) => c.base.address.toLowerCase() === base.address.toLowerCase() && c.quote.address.toLowerCase() === quote.address.toLowerCase(),
  );

  const run = (steps: Step[]) => void tx.run(steps);
  const vaultCall = <F extends "setQuote" | "cancel" | "requestWithdraw" | "executeWithdraw" | "cancelWithdraw">(
    label: string,
    functionName: F,
    args: readonly unknown[],
  ): Step => ({
    label,
    send: () =>
      writeContractAsync({ address: vault, abi: plumbQuoteAbi, functionName, args } as Parameters<typeof writeContractAsync>[0]),
  });

  const setQuote = () => {
    try {
      const b = toPx(bid);
      const a = toPx(ask);
      const s = parseUnits(size, base.decimals);
      run([vaultCall("set quote", "setQuote", [b, a, s, s])]);
    } catch {
      // invalid input; the button stays disabled for empty fields
    }
  };

  const fund = () => {
    const t = pick(fundToken);
    const amt = parseUnits(fundAmt || "0", t.decimals);
    run([
      {
        label: `approve ${t.symbol}`,
        send: () => writeContractAsync({ address: t.address, abi: erc20Abi, functionName: "approve", args: [vault, amt] }),
      },
      {
        label: `deposit ${t.symbol}`,
        send: () => writeContractAsync({ address: vault, abi: plumbQuoteAbi, functionName: "deposit", args: [t.address, amt] }),
      },
    ]);
  };

  const pendingRows = [
    { t: base, p: pendBase as readonly [bigint, bigint] | undefined },
    { t: quote, p: pendQuote as readonly [bigint, bigint] | undefined },
  ];
  const now = Math.floor(Date.now() / 1000);
  const sp = spreadBps(quoteData.bidPx, quoteData.askPx);

  return (
    <div className="space-y-4">
      <StatRow>
        <Stat label="Status" value={live ? "live" : "stale"} tone={live ? "pass" : "fail"} sub={`seq ${quoteData.seq.toString()}`} />
        <Stat label="Bid" value={fmtPx(quoteData.bidPx)} sub={`${fmtAmt(quoteData.bidSize, base.decimals, 3)} ${base.symbol}`} />
        <Stat label="Ask" value={fmtPx(quoteData.askPx)} sub={`${fmtAmt(quoteData.askSize, base.decimals, 3)} ${base.symbol}`} />
        <Stat label="Spread" value={sp < 0n ? "—" : `${sp.toString()} bps`} sub={quoteData.updatedAt ? ago(Number(quoteData.updatedAt), now) : "never"} />
        <Stat label={`Free ${base.symbol}`} value={fmtAmt(freeBase as bigint | undefined, base.decimals, 3)} />
        <Stat label={`Free ${quote.symbol}`} value={fmtAmt(freeQuote as bigint | undefined, quote.decimals, 2)} />
      </StatRow>
      <div className="font-mono text-2xs text-muted">
        vault <AddrLink address={vault} n={6} /> · owner <AddrLink address={String(owner)} /> · quoter{" "}
        {quoter && quoter !== zeroAddress ? <AddrLink address={String(quoter)} /> : "owner only"}
        {!isOwner && <span className="ml-2 text-ink">connected wallet is not the owner</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Quote manually">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bid">
              <Input value={bid} onChange={(e) => setBid(e.target.value)} placeholder="42.40" suffix={quote.symbol} />
            </Field>
            <Field label="Ask">
              <Input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="42.50" suffix={quote.symbol} />
            </Field>
            <Field label="Size each side">
              <Input value={size} onChange={(e) => setSize(e.target.value)} suffix={base.symbol} />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={!bid || !ask || tx.busy} onClick={setQuote}>
              Post quote
            </Button>
            <Button variant="danger" disabled={tx.busy} onClick={() => run([vaultCall("cancel", "cancel", [])])}>
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-2xs text-muted">A quote is fillable for 2 seconds. Bots refresh it every 500ms.</p>
        </Panel>

        <Panel title="Inventory">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Token">
              <Select value={fundToken} onChange={(e) => setFundToken(e.target.value as "base" | "quote")}>
                <option value="base">{base.symbol}</option>
                <option value="quote">{quote.symbol}</option>
              </Select>
            </Field>
            <Field label="Deposit">
              <Input value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} suffix={pick(fundToken).symbol} />
            </Field>
          </div>
          <Button className="mt-3" disabled={!fundAmt || tx.busy} onClick={fund}>
            Approve and deposit
          </Button>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Withdraw">
              <Select value={wdToken} onChange={(e) => setWdToken(e.target.value as "base" | "quote")}>
                <option value="base">{base.symbol}</option>
                <option value="quote">{quote.symbol}</option>
              </Select>
            </Field>
            <Field label="Amount">
              <Input value={wdAmt} onChange={(e) => setWdAmt(e.target.value)} suffix={pick(wdToken).symbol} />
            </Field>
          </div>
          <Button
            className="mt-3"
            disabled={!wdAmt || !isOwner || tx.busy}
            onClick={() =>
              run([
                vaultCall("request withdraw", "requestWithdraw", [
                  pick(wdToken).address,
                  parseUnits(wdAmt || "0", pick(wdToken).decimals),
                ]),
              ])
            }
          >
            Queue withdrawal
          </Button>
          {pendingRows
            .filter((r) => r.p && r.p[0] > 0n)
            .map(({ t, p }) => {
              const ready = Number(p?.[1] ?? 0n) <= now;
              return (
                <div key={t.address} className="mt-2 flex items-center justify-between font-mono text-2xs">
                  <span>
                    {fmtAmt(p?.[0], t.decimals, 3)} {t.symbol} {ready ? "ready" : `in ${Number(p?.[1] ?? 0n) - now}s`}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      className="h-6"
                      disabled={!ready || tx.busy}
                      onClick={() => run([vaultCall("withdraw", "executeWithdraw", [t.address, address])])}
                    >
                      Execute
                    </Button>
                    <Button className="h-6" variant="ghost" onClick={() => run([vaultCall("cancel withdrawal", "cancelWithdraw", [t.address])])}>
                      Drop
                    </Button>
                  </span>
                </div>
              );
            })}
          <p className="mt-2 text-2xs text-muted">
            Withdrawals are timelocked {deployment.params.withdrawDelay}s and stop counting as inventory the moment they are queued.
          </p>
        </Panel>

        <Panel title="Bond into a campaign">
          {pairCampaigns.length === 0 ? (
            <Empty>No campaigns for this pair.</Empty>
          ) : (
            <>
              <Field label="Campaign">
                <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                  <option value="">choose…</option>
                  {pairCampaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.id} · {fmtAmt(c.rewardPerEpoch, c.rewardDecimals, 2)} {c.rewardSymbol}/epoch · bond {fmtAmt(c.makerBond, c.rewardDecimals, 2)}
                    </option>
                  ))}
                </Select>
              </Field>
              {(() => {
                const c = pairCampaigns.find((x) => String(x.id) === campaignId);
                if (!c) return null;
                const native = c.rewardToken === zeroAddress;
                const steps: Step[] = [];
                if (!native) {
                  steps.push({
                    label: `approve ${c.rewardSymbol}`,
                    send: () =>
                      writeContractAsync({
                        address: c.rewardToken,
                        abi: erc20Abi,
                        functionName: "approve",
                        args: [deployment.contracts.campaigns, BigInt(c.makerBond)],
                      }),
                  });
                }
                steps.push({
                  label: "register",
                  send: () =>
                    writeContractAsync({
                      address: deployment.contracts.campaigns,
                      abi: plumbCampaignsAbi,
                      functionName: "register",
                      args: [BigInt(c.id), vault],
                      value: native ? BigInt(c.makerBond) : 0n,
                    }),
                });
                return (
                  <div className="mt-3 space-y-2">
                    <div className="font-mono text-2xs text-muted">
                      spread ≤ {c.maxSpreadBps} bps · ask ≥ {fmtAmt(c.minDepthBase, c.base.decimals, 2)} {c.base.symbol} · bid ≥{" "}
                      {fmtAmt(c.minDepthQuote, c.quote.decimals, 0)} {c.quote.symbol}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="primary" disabled={!isOwner || tx.busy} onClick={() => run(steps)}>
                        Bond {fmtAmt(c.makerBond, c.rewardDecimals, 2)} {c.rewardSymbol}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!isOwner || tx.busy}
                        onClick={() =>
                          run([
                            {
                              label: "request unbond",
                              send: () =>
                                writeContractAsync({
                                  address: deployment.contracts.campaigns,
                                  abi: plumbCampaignsAbi,
                                  functionName: "requestUnbond",
                                  args: [BigInt(c.id), vault],
                                }),
                            },
                          ])
                        }
                      >
                        Unbond
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!isOwner || tx.busy}
                        onClick={() =>
                          run([
                            {
                              label: "release bond",
                              send: () =>
                                writeContractAsync({
                                  address: deployment.contracts.campaigns,
                                  abi: plumbCampaignsAbi,
                                  functionName: "releaseBond",
                                  args: [BigInt(c.id), vault],
                                }),
                            },
                          ])
                        }
                      >
                        Release
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </Panel>
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}

function Claimables({ campaigns }: { campaigns: CampaignView[] }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTxRunner();
  const rewardTokens = [...new Map(campaigns.map((c) => [c.rewardToken, c])).values()];
  const reads = useReadContracts({
    contracts: rewardTokens.map((c) => ({
      address: deployment.contracts.campaigns,
      abi: plumbCampaignsAbi,
      functionName: "claimable" as const,
      args: [c.rewardToken, address ?? zeroAddress] as const,
    })),
    query: { enabled: Boolean(address), refetchInterval: 3_000 },
  });
  return (
    <Panel title="Claimable">
      {rewardTokens.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <div className="space-y-2">
          {rewardTokens.map((c, i) => {
            const amt = (reads.data?.[i]?.result as bigint | undefined) ?? 0n;
            return (
              <div key={c.rewardToken} className="flex items-center justify-between">
                <span className="num text-sm">
                  {fmtAmt(amt, c.rewardDecimals, 4)} <span className="text-muted">{c.rewardSymbol}</span>
                </span>
                <Button
                  disabled={amt === 0n || tx.busy}
                  onClick={() =>
                    void tx.run([
                      {
                        label: `claim ${c.rewardSymbol}`,
                        send: () =>
                          writeContractAsync({
                            address: deployment.contracts.campaigns,
                            abi: plumbCampaignsAbi,
                            functionName: "claim",
                            args: [c.rewardToken],
                          }),
                      },
                    ])
                  }
                >
                  Claim
                </Button>
              </div>
            );
          })}
          <p className="text-2xs text-muted">Rewards, released bonds, probe fees and slash bounties all accrue here.</p>
        </div>
      )}
      <TxStatus state={tx.state} />
    </Panel>
  );
}

export function MakerPage() {
  const { address } = useAccount();
  const maker = useMaker(address);
  const campaigns = useCampaigns();
  const markets = useMarkets();
  const [selected, setSelected] = useState<string>("");
  const count = useReadContract({
    address: deployment.contracts.factory,
    abi: plumbQuoteFactoryAbi,
    functionName: "vaultCount",
    chainId: CHAIN,
  });
  const chainCount = count.data === undefined ? null : Number(count.data);
  const chainVaults = useChainVaults(address, chainCount ?? 0);
  const snapshotCount = markets.data ? markets.data.reduce((a, m) => a + m.vaultCount, 0) : null;
  // The snapshot's count from the frozen data, the live count straight from the factory; "…" until
  // known, never a zero that only means "not loaded yet".
  const totalLine = STATIC ? (
    <>
      <span className="num">{snapshotCount ?? "…"}</span> vaults on Plumbline at the snapshot
      {chainCount !== null && snapshotCount !== null && chainCount !== snapshotCount && (
        <>
          {" "}
          · <span className="num">{chainCount}</span> on-chain now
        </>
      )}
    </>
  ) : (
    <>
      <span className="num">{chainCount ?? (count.isError ? "—" : "…")}</span> vaults on Plumbline
    </>
  );

  if (!address) {
    return (
      <Page density="dense">
        <PageHeader title="Maker console" sub={<>Deploy a vault, fund it, quote it, bond it, earn. {totalLine}.</>} />
        <WriteNotice className="mb-4" />
        <Panel>
          <div className="flex flex-col items-center gap-3 py-10">
            <p className="text-xs text-ink">Connect the wallet that owns (or will own) your vaults.</p>
            <WalletButton />
          </div>
        </Panel>
      </Page>
    );
  }

  const p = maker.data;
  const indexed = p?.vaults ?? [];
  const known = new Set(indexed.map((v) => v.vault.toLowerCase()));
  const vaults = [
    ...indexed.map((v) => ({ vault: v.vault, label: `${v.pair} ${short(v.vault, 4)}` })),
    ...chainVaults
      .filter((v) => !known.has(v.toLowerCase()))
      .map((v) => ({ vault: v, label: `${short(v, 4)}${STATIC ? " (after snapshot)" : ""}` })),
  ];
  const active = (selected || vaults[0]?.vault || "") as Address;
  const cs = campaigns.data ?? [];
  // Frozen data: pass rate over every scored check, not a 24h window measured from export time.
  const checks = p?.scores.reduce((a, s) => a + s.checks, 0) ?? 0;
  const points = p?.scores.reduce((a, s) => a + s.points, 0) ?? 0;
  const passRate = checks ? points / checks : null;

  return (
    <Page density="dense">
      <PageHeader
        title="Maker console"
        sub={
          <>
            <span className="num">{vaults.length}</span> vault{vaults.length === 1 ? "" : "s"} for this wallet · {totalLine}
          </>
        }
      />
      <WriteNotice className="mb-4" />
      <StatRow>
        {STATIC ? (
          <Stat
            label="Pass rate"
            value={fmtPct(passRate)}
            tone={tone(passRate)}
            sub={checks ? `${fmtInt(points)} of ${fmtInt(checks)} checks` : "no probes scored"}
          />
        ) : (
          <Stat label="Uptime 24h" value={fmtPct(p?.uptime24h)} tone={tone(p?.uptime24h)} />
        )}
        <Stat label="Vaults" value={vaults.length} />
        <Stat label="Bonds" value={p?.registrations.filter((r) => r.status !== "released").length ?? 0} />
        <Stat
          label="Earned"
          value={p?.totalEarned.length ? p.totalEarned.map((e) => `${fmtAmt(e.amount, e.decimals, 3)} ${e.symbol}`).join(" · ") : "—"}
        />
        <Stat
          label={STATIC ? "Quote updates" : "Quote updates 24h"}
          value={fmtInt(indexed.reduce((a, v) => a + v.quoteUpdates24h, 0))}
          sub={STATIC ? "in the 24h before the snapshot" : undefined}
        />
        <Stat label="Epochs scored" value={p?.scores.length ?? 0} />
      </StatRow>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0">
        <div className="space-y-4">
          {vaults.length > 0 && (
            <Panel
              title="Vault"
              right={
                vaults.length > 1 ? (
                  <Select value={active} onChange={(e) => setSelected(e.target.value)} className="h-6 w-56">
                    {vaults.map((v) => (
                      <option key={v.vault} value={v.vault}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                ) : undefined
              }
            >
              <VaultConsole key={active} vault={active} campaigns={cs} />
            </Panel>
          )}
          <DeployVault onCreated={(v) => setSelected(v)} />
          <Panel title="Scores by epoch" pad={false}>
            {!p?.scores.length ? (
              <Empty>No probes have scored your vaults yet.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Epoch</Th>
                    <Th>Vault</Th>
                    <Th right>Points</Th>
                    <Th right>Pass rate</Th>
                    <Th right>Reward</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...p.scores].reverse().map((s) => {
                    const c = cs.find((x) => x.id === s.campaignId);
                    const rate = s.checks ? s.points / s.checks : null;
                    return (
                      <tr key={`${s.campaignId}-${s.epoch}-${s.vault}`}>
                        <Td mono>
                          <Link className="link" to={`/campaign/${s.campaignId}`}>
                            #{s.campaignId}
                          </Link>
                        </Td>
                        <Td mono>e{s.epoch}</Td>
                        <Td>
                          <AddrLink address={s.vault} />
                        </Td>
                        <Td right mono>
                          {s.points}/{s.checks}
                        </Td>
                        <Td right mono className={toneText[tone(rate)]}>
                          {fmtPct(rate)}
                        </Td>
                        <Td right mono className="text-violet">
                          {s.reward && c ? `${fmtAmt(s.reward, c.rewardDecimals, 4)} ${c.rewardSymbol}` : <span className="text-muted">pending</span>}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>
        <div className="space-y-4">
          <Claimables campaigns={cs} />
          <Panel title="Bonds">
            {!p?.registrations.length ? (
              <Empty>No bonds posted.</Empty>
            ) : (
              p.registrations.map((r) => {
                const c = cs.find((x) => x.id === r.campaignId);
                return (
                  <div key={`${r.campaignId}-${r.vault}`} className="flex items-center justify-between border-b border-ink py-1.5 font-mono text-2xs">
                    <Link className="link" to={`/campaign/${r.campaignId}`}>
                      #{r.campaignId}
                    </Link>
                    <AddrLink address={r.vault} />
                    <span>{c ? `${fmtAmt(r.bond, c.rewardDecimals, 3)} ${c.rewardSymbol}` : r.bond}</span>
                    <Badge tone={r.status === "active" ? "pass" : r.status === "unbonding" ? "warn" : "none"}>{r.status}</Badge>
                  </div>
                );
              })
            )}
          </Panel>
        </div>
      </div>
    </Page>
  );
}
