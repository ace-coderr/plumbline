import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { erc20Abi, parseUnits, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import {
  FillStatus,
  deployment,
  plumbRouterAbi,
  quoteNotional,
  type MarketSummary,
  type QuoteView,
} from "@plumbline/shared";
import { useMarket, useUptime } from "../lib/api";
import { ago, clock, fmtAmt, fmtBps, fmtInt, fmtPct, fmtPx, px, tone, toneText } from "../lib/format";
import { useTxRunner } from "../lib/tx";
import { ProbeStrip, UptimeChart } from "../components/charts";
import { TxStatus } from "../components/TxStatus";
import {
  AddrLink,
  Badge,
  DemoTag,
  Button,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  PageHeader,
  Panel,
  Segmented,
  Stat,
  StatRow,
  Table,
  Td,
  Th,
  TxLink,
  cx,
  Page,
} from "../components/ui";

const WINDOWS = ["1h", "6h", "24h", "7d"] as const;
type Win = (typeof WINDOWS)[number];

function Ladder({ book, m }: { book: QuoteView[]; m: MarketSummary }) {
  if (book.length === 0) return <Empty>No vaults listed for this pair.</Empty>;
  // Age against chain time at the sample, not the browser clock.
  const now = m.sampledAt ?? Math.floor(Date.now() / 1000);
  return (
    <Table>
      <thead>
        <tr>
          <Th>Vault</Th>
          <Th right>Backed</Th>
          <Th right>Bid size</Th>
          <Th right>Bid</Th>
          <Th right>Ask</Th>
          <Th right>Ask size</Th>
          <Th right>Backed</Th>
          <Th right>Spread</Th>
          <Th right>Age</Th>
          <Th right>Uptime 24h</Th>
        </tr>
      </thead>
      <tbody>
        {book.map((q) => {
          const bidNotional = quoteNotional(BigInt(q.bidSize), BigInt(q.bidPx), m.base.decimals, m.quote.decimals);
          const bidBacked = BigInt(q.freeQuote) >= bidNotional;
          const askBacked = BigInt(q.freeBase) >= BigInt(q.askSize);
          return (
            <tr key={q.vault} className={cx(!q.live && "opacity-45")}>
              <Td>
                <span className="flex items-center gap-2">
                  <AddrLink address={q.vault} />
                  {!q.live && <Badge tone="none">stale</Badge>}
                </span>
              </Td>
              <Td right>
                <Badge tone={bidBacked ? "pass" : "fail"}>{bidBacked ? "yes" : "short"}</Badge>
              </Td>
              <Td right mono className="text-ink">
                {fmtAmt(q.bidSize, m.base.decimals, 3)}
              </Td>
              <Td right mono className="font-medium text-success">
                {fmtPx(q.bidPx)}
              </Td>
              <Td right mono className="font-medium text-danger">
                {fmtPx(q.askPx)}
              </Td>
              <Td right mono className="text-ink">
                {fmtAmt(q.askSize, m.base.decimals, 3)}
              </Td>
              <Td right>
                <Badge tone={askBacked ? "pass" : "fail"}>{askBacked ? "yes" : "short"}</Badge>
              </Td>
              <Td right mono>
                {fmtBps(q.spreadBps, 0)}
              </Td>
              <Td right mono className="text-muted">
                {q.updatedAt ? `${Math.max(0, now - q.updatedAt)}s` : "—"}
              </Td>
              <Td right mono className={toneText[tone(q.uptime24h)]}>
                {fmtPct(q.uptime24h)}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function SwapPanel({ m }: { m: MarketSummary }) {
  const { address } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.01");
  const { writeContractAsync } = useWriteContract();
  const tx = useTxRunner();
  const buying = side === "buy";
  const tokenIn = buying ? m.quote : m.base;
  const tokenOut = buying ? m.base : m.quote;
  let amountIn = 0n;
  try {
    amountIn = amount ? parseUnits(amount, tokenIn.decimals) : 0n;
  } catch {
    amountIn = 0n;
  }

  const preview = useReadContract({
    address: deployment.contracts.router,
    abi: plumbRouterAbi,
    functionName: "previewSwap",
    args: [m.base.address, m.quote.address, buying, amountIn],
    query: { enabled: amountIn > 0n, refetchInterval: 1_000 },
  });
  const allowance = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", deployment.contracts.router],
    query: { enabled: Boolean(address) },
  });
  const [out, filled] = preview.data ?? [0n, 0n];
  const minOut = (out * 9_950n) / 10_000n;

  async function swap() {
    if (!address) return;
    const steps: { label: string; send: () => Promise<`0x${string}`> }[] = [];
    if ((allowance.data ?? 0n) < amountIn) {
      steps.push({
        label: `approve ${tokenIn.symbol}`,
        send: () =>
          writeContractAsync({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [deployment.contracts.router, amountIn],
          }),
      });
    }
    steps.push({
      label: "swap",
      send: () =>
        writeContractAsync({
          address: deployment.contracts.router,
          abi: plumbRouterAbi,
          functionName: "swapExactIn",
          args: [m.base.address, m.quote.address, buying, amountIn, minOut, address as Address],
        }),
    });
    await tx.run(steps);
  }

  return (
    <Panel title="Take liquidity" right={<span>via PlumbRouter</span>}>
      <div className="space-y-3">
        <Segmented value={side} options={["buy", "sell"] as const} onChange={setSide} />
        <Field label={`Pay (${tokenIn.symbol})`}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" suffix={tokenIn.symbol} />
        </Field>
        <div className="space-y-1 font-mono text-2xs">
          <div className="flex justify-between">
            <span className="text-muted">receive</span>
            <span>
              {fmtAmt(out, tokenOut.decimals, 4)} {tokenOut.symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">fillable</span>
            <span className={filled < amountIn ? "text-ink" : undefined}>
              {fmtAmt(filled, tokenIn.decimals, 2)} / {fmtAmt(amountIn, tokenIn.decimals, 2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">min out (50 bps)</span>
            <span>{fmtAmt(minOut, tokenOut.decimals, 4)}</span>
          </div>
        </div>
        <Button
          variant="primary"
          className="w-full"
          disabled={!address || amountIn === 0n || filled < amountIn || tx.busy}
          onClick={() => void swap()}
        >
          {!address ? "Connect a wallet to trade" : filled < amountIn ? "Not enough live depth" : `${side} ${m.base.symbol}`}
        </Button>
        <TxStatus state={tx.state} />
        <p className="text-xs leading-5 text-muted">
          If a vault quotes size it cannot back, its fill reverts, the router verifies the shortfall on-chain, and the
          maker's bond is slashed with half paid to you.
        </p>
      </div>
    </Panel>
  );
}

export function MarketPage() {
  const { pair = "" } = useParams();
  const [win, setWin] = useState<Win>("6h");
  const market = useMarket(pair);
  const uptime = useUptime(pair, win);

  if (market.isLoading) return <Loading rows={6} />;
  if (market.isError || !market.data) return <ErrorNote error={market.error ?? "unknown market"} />;
  const { summary: m, book, fills, failedFills } = market.data;
  const mid =
    m.bestBidPx && m.bestAskPx ? ((px(m.bestBidPx) ?? 0) + (px(m.bestAskPx) ?? 0)) / 2 : null;

  return (
    <Page density="dense">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="num">
              {m.base.symbol}/{m.quote.symbol}
            </span>
            {(m.quote.demo || m.base.demo) && <DemoTag />}
          </span>
        }
        sub={
          <span className="num">
            {m.vaultCount} vaults · {m.makerCount} makers · sampled {ago(m.sampledAt)}
          </span>
        }
        right={
          <div className="flex flex-wrap gap-2">
            <Link to={`/report/${m.base.symbol}`}>
              <Button variant="primary">Depth report</Button>
            </Link>
            {m.campaignIds.map((id) => (
              <Link key={id} to={`/campaign/${id}`}>
                <Button>
                  Campaign <span className="num">#{id}</span>
                </Button>
              </Link>
            ))}
          </div>
        }
      />
      <StatRow>
        <Stat label={`Uptime ${win}`} value={fmtPct(uptime.data?.uptime, 2)} tone={tone(uptime.data?.uptime)} />
        <Stat label="Mid" value={mid === null ? "—" : mid.toFixed(4)} />
        <Stat label="Spread" value={m.spreadBps === null ? "—" : `${m.spreadBps} bps`} />
        <Stat label="Bid depth" value={`${fmtAmt(m.bidDepth, m.quote.decimals, 0)} ${m.quote.symbol}`} />
        <Stat label="Ask depth" value={`${fmtAmt(m.askDepth, m.base.decimals, 2)} ${m.base.symbol}`} />
        <Stat label="Probes 24h" value={fmtInt(m.probes24h)} sub={`last ${ago(m.lastProbeAt)}`} />
      </StatRow>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px] [&>*]:min-w-0">
        <div className="space-y-4">
          <Panel
            title="Uptime timeline"
            right={<Segmented value={win} options={WINDOWS} onChange={setWin} />}
          >
            {uptime.data ? (
              uptime.data.buckets.length ? (
                <UptimeChart buckets={uptime.data.buckets} bucketSeconds={uptime.data.bucketSeconds} />
              ) : (
                <Empty>No probes in this window.</Empty>
              )
            ) : (
              <Loading rows={4} />
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="label">Probe log, newest right · click a tick for its transaction</span>
              <span className="flex gap-3 text-2xs text-muted">
                <span className="flex items-center gap-1">
                  <span className="h-2.5 w-2.5 border border-ink bg-success" /> some or all passed
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2.5 w-2.5 border border-ink bg-danger" /> none passed
                </span>
              </span>
            </div>
            <div className="mt-1.5">
              <ProbeStrip probes={uptime.data?.probes ?? []} max={160} />
            </div>
          </Panel>

          <Panel title="Live quote ladder" pad={false} right={<span>inventory read on-chain</span>}>
            <Ladder book={book} m={m} />
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Recent fills" pad={false}>
              {fills.length === 0 ? (
                <Empty>No fills yet.</Empty>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Time</Th>
                      <Th>Side</Th>
                      <Th right>Price</Th>
                      <Th right>Size</Th>
                      <Th>Vault</Th>
                      <Th>Tx</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {fills.map((f) => (
                      <tr key={`${f.txHash}-${f.vault}`}>
                        <Td mono className="text-muted">
                          {clock(f.ts)}
                        </Td>
                        <Td>
                          <span className={f.buyingBase ? "text-success" : "text-danger"}>{f.buyingBase ? "buy" : "sell"}</span>
                        </Td>
                        <Td right mono>
                          {fmtPx(f.px)}
                        </Td>
                        <Td right mono>
                          {fmtAmt(f.buyingBase ? f.amountOut : f.amountIn, m.base.decimals, 3)}
                        </Td>
                        <Td>
                          <AddrLink address={f.vault} />
                        </Td>
                        <Td>
                          <TxLink hash={f.txHash} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
            <Panel title="Failed fills" pad={false} right={<span>reverts caught by the router</span>}>
              {failedFills.length === 0 ? (
                <Empty>No failed fills. Every quote that was hit, paid.</Empty>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Time</Th>
                      <Th>Vault</Th>
                      <Th>Diagnosis</Th>
                      <Th>Slashed</Th>
                      <Th>Tx</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedFills.map((f) => (
                      <tr key={`${f.txHash}-${f.vault}`}>
                        <Td mono className="text-muted">
                          {clock(f.ts)}
                        </Td>
                        <Td>
                          <AddrLink address={f.vault} />
                        </Td>
                        <Td mono>{FillStatus[f.status] ?? f.status}</Td>
                        <Td>
                          <Badge tone={f.penalized ? "fail" : "none"}>{f.penalized ? "yes" : "no"}</Badge>
                        </Td>
                        <Td>
                          <TxLink hash={f.txHash} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </div>
        </div>
        <div className="space-y-4">
          <SwapPanel m={m} />
          <Panel title="What a probe checks">
            <ol className="space-y-2 text-xs text-ink">
              {[
                ["Fresh", "quote posted within the vault's 2s freshness window"],
                ["Tight", "spread within the campaign's maximum"],
                ["Deep", "ask size and bid notional at or above the minimums"],
                ["Backed", "the vault holds the base and quote it advertises, by balanceOf, net of queued withdrawals"],
              ].map(([k, v], i) => (
                <li key={k} className="flex gap-2">
                  <span className="num font-bold text-violet">{i + 1}</span>
                  <span>
                    <span className="font-semibold text-ink">{k}</span> {v}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
