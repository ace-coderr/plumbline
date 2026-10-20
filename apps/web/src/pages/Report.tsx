import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { addressUrl, deployment, SNAPSHOT_WINDOW, type DepthReport } from "@plumbline/shared";
import { STATIC, useCampaign, useReport, useReportProbes } from "../lib/api";
import { dateTime, duration, fmtAmt, fmtInt, fmtPct, short, tone, toneText, utcWindow } from "../lib/format";
import { EpochGrid } from "../components/charts";
import { Wordmark } from "../components/Brand";
import { SnapshotStamp } from "../components/Snapshot";
import { Button, DemoTag, ErrorNote, Loading, N, Page, Segmented, Stamp, Table, Td, Th, TxLink, cx } from "../components/ui";

// Rolling windows for live data. Frozen data has one window, the campaigns' own (see snapshot.ts).
const WINDOWS = ["24h", "7d", "30d"] as const;
type Win = (typeof WINDOWS)[number];
const PAGE = 25;

/**
 * Depth figures. Makers post one price level each, so when every band holds the same quotes the
 * bands are collapsed into one figure instead of printing the same number twice.
 */
function DepthFigures({ r }: { r: DepthReport }) {
  const [first] = r.depth;
  if (!first) return null;
  const same = r.depth.every((d) => d.bidQuote === first.bidQuote && d.askBase === first.askBase);
  const widest = r.depth.at(-1) ?? first;
  const backed = "Medians over probes, counting only quotes the probe verified as backed.";
  if (same) {
    return (
      <div className="sm:col-span-2">
        <Figure
          label="Verified depth"
          value={fmtAmt(widest.bidQuote, r.quote.decimals, 2)}
          unit={r.quote.symbol}
          sub={
            <>
              Bid side; ask side <N>{fmtAmt(widest.askBase, r.token.decimals, 4)}</N> {r.token.symbol}. Each maker posts a
              single price level, and every verified quote sat inside ±{first.bps} bps of mid, so the ±
              {r.depth.map((d) => d.bps).join(" and ±")} bps bands hold the same quotes. {backed}
            </>
          }
        />
      </div>
    );
  }
  return (
    <>
      {r.depth.map((d) => (
        <Figure
          key={d.bps}
          label={`Depth ±${d.bps} bps`}
          value={fmtAmt(d.bidQuote, r.quote.decimals, 2)}
          unit={r.quote.symbol}
          sub={
            <>
              bid side; ask side <N>{fmtAmt(d.askBase, r.token.decimals, 4)}</N> {r.token.symbol}. {backed}
            </>
          }
        />
      ))}
    </>
  );
}

function Figure({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: React.ReactNode }) {
  return (
    <div className="border-t-2 border-ink pt-3">
      <div className="label text-ink">{label}</div>
      <div className="num mt-2 text-[34px] font-bold leading-none sm:text-[40px]">
        {value}
        {unit && <span className="ml-1.5 text-base font-semibold text-muted">{unit}</span>}
      </div>
      {sub !== undefined && <div className="mt-2 text-xs leading-5 text-muted">{sub}</div>}
    </div>
  );
}

/** Campaign terms in plain sentences: what a maker had to do to earn a point. */
function Terms({ id }: { id: number }) {
  const q = useCampaign(id);
  const c = q.data?.campaign;
  if (!c) return null;
  return (
    <ul className="space-y-2 text-sm leading-6">
      <li>
        Quotes expire after <N>{deployment.params.maxAge}s</N>; a stale quote scores nothing.
      </li>
      <li>
        Spread must be at most <N>{c.maxSpreadBps} bps</N>, measured around each quote's own mid.
      </li>
      <li>
        At least <N>{fmtAmt(c.minDepthBase, c.base.decimals, 4)}</N> {c.base.symbol} offered and{" "}
        <N>{fmtAmt(c.minDepthQuote, c.quote.decimals, 2)}</N> {c.quote.symbol} bid.
      </li>
      <li>Both sides fully backed by tokens the vault held at the instant of the probe, net of queued withdrawals.</li>
      <li>
        Probes at least <N>{c.minProbeInterval}s</N> apart plus an unpredictable gate wait; epochs of{" "}
        <N>{duration(c.epochLength)}</N>; makers bond <N>{fmtAmt(c.makerBond, c.rewardDecimals, 2)}</N> {c.rewardSymbol},
        and <N>20%</N> is slashed for every quote that fails to fill.
      </li>
    </ul>
  );
}

export function ReportPage() {
  const { token = "WHYPE" } = useParams();
  const [win, setWin] = useState<Win>("24h");
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  const report = useReport(token, STATIC ? SNAPSHOT_WINDOW : win);
  const probes = useReportProbes(token, page * PAGE, PAGE);

  if (report.isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12">
        <Loading rows={8} />
      </div>
    );
  }
  if (report.isError || !report.data) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12">
        <ErrorNote error={report.error ?? "no report"} />
      </div>
    );
  }
  const r = report.data;
  const total = probes.data?.total ?? r.probes;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const demo = Boolean(r.quote.demo || r.token.demo);
  const firstCampaign = r.campaigns[0];

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Page density="expressive">
      <div className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:pt-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link to="/" aria-label="Plumbline">
            <Wordmark size={22} />
          </Link>
          <div className="flex items-center gap-2">
            {STATIC ? (
              <span className="num rounded-[8px] border-2 border-ink bg-paper px-3 py-1.5 text-xs">
                <span className="font-bold uppercase tracking-label">Campaign window</span> {utcWindow(r.windowFrom, r.windowTo)}
              </span>
            ) : (
              <Segmented
                value={win}
                options={WINDOWS}
                onChange={(w) => {
                  setWin(w);
                  setPage(0);
                }}
              />
            )}
            <Button className="h-9 px-3 text-xs" onClick={() => void share()}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </header>

        <div className="mt-4">
          <SnapshotStamp />
        </div>

        {/* The certificate */}
        <article className="mt-6 rounded-card border-2 border-ink bg-paper p-1.5 shadow-brut">
          <div className="rounded-[7px] border border-ink px-5 py-7 sm:px-10 sm:py-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="label text-violet">Verified depth report</div>
                <h1 className="display mt-2 text-[40px] leading-[0.95] sm:text-[60px]">
                  <span className="num">{r.token.symbol}</span>
                  <span className="text-muted"> / </span>
                  <span className="num">{r.quote.symbol}</span>
                </h1>
                {demo && (
                  <div className="mt-3">
                    <DemoTag />
                  </div>
                )}
              </div>
              <Stamp>verified on-chain</Stamp>
            </div>

            <div className="mt-10">
              <div className="label text-ink">Verified uptime</div>
              <div
                className={cx(
                  "num mt-2 text-[72px] font-bold leading-[0.9] tracking-tight sm:text-[128px]",
                  toneText[tone(r.verifiedUptime)],
                )}
              >
                {fmtPct(r.verifiedUptime, 2)}
              </div>
              <p className="mt-4 max-w-2xl text-base leading-7">
                Of <N>{fmtInt(r.probes)}</N> on-chain probes between <N>{dateTime(r.windowFrom)}</N> and{" "}
                <N>{dateTime(r.windowTo)}</N>, this share found at least one maker quoting fresh, tight, deep and fully
                backed. <span className="marker">Every probe is an Elysium transaction you can open.</span>
              </p>
            </div>

            <div className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-3">
              <Figure label="Median spread" value={r.medianSpreadBps === null ? "—" : r.medianSpreadBps.toFixed(1)} unit="bps" sub="best bid to best ask, at each probe" />
              <DepthFigures r={r} />
              <Figure label="Probes" value={fmtInt(r.probes)} sub={<><N>{fmtInt(r.vaultChecks)}</N> individual vault checks</>} />
              <Figure label="Makers probed" value={fmtInt(r.makers)} sub="distinct vault owners" />
              <Figure label="Campaigns" value={r.campaigns.map((c) => `#${c}`).join(" ") || "—"} sub="funding the probes" />
            </div>

            {firstCampaign !== undefined && (
              <section className="mt-10 border-t-2 border-ink pt-5">
                <h2 className="font-display text-xl font-extrabold tracking-display">
                  The terms, <N>#{firstCampaign}</N>
                </h2>
                <div className="mt-3">
                  <Terms id={firstCampaign} />
                </div>
              </section>
            )}

            {r.epochs.length > 0 && (
              <section className="mt-10 border-t-2 border-ink pt-5">
                <h2 className="font-display text-xl font-extrabold tracking-display">Uptime by epoch</h2>
                <p className="mt-1 text-xs leading-5 text-muted">
                  One cell per campaign epoch, filled by the share of its probes that found a passing maker and labelled
                  covered/probes. An epoch no probe reached is an empty cell labelled 0; it scores nothing for any maker.
                </p>
                <div className="mt-3">
                  <EpochGrid epochs={r.epochs} />
                </div>
              </section>
            )}

            <section className="mt-10 border-t-2 border-ink pt-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl font-extrabold tracking-display">Probe log</h2>
                  <p className="mt-1 text-xs text-muted">
                    <N>{fmtInt(total)}</N> probes, newest first.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button className="h-8 px-3 text-xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    Newer
                  </Button>
                  <span className="num text-xs">
                    {page + 1}/{pages}
                  </span>
                  <Button className="h-8 px-3 text-xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                    Older
                  </Button>
                </div>
              </div>
              <div className="mt-3 overflow-hidden rounded-[8px] border-2 border-ink">
                <Table>
                  <thead>
                    <tr>
                      <Th>Time (UTC)</Th>
                      <Th right>Probe</Th>
                      <Th right>Passed</Th>
                      <Th>Result</Th>
                      <Th>Transaction</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(probes.data?.probes ?? r.probeLog.slice(0, PAGE)).map((p) => (
                      <tr key={`${p.campaignId}-${p.nonce}`}>
                        <Td mono>{dateTime(p.ts)}</Td>
                        <Td right mono>
                          #{p.campaignId}.{p.nonce}
                        </Td>
                        <Td right mono>
                          {p.passed}/{p.checked}
                        </Td>
                        <Td>
                          <span className={cx("text-xs font-semibold", p.passed > 0 ? "text-success" : "text-danger")}>
                            {p.passed > 0 ? "covered" : "uncovered"}
                          </span>
                        </Td>
                        <Td>
                          <TxLink hash={p.txHash} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </section>

            {demo && (
              <p className="mt-8 border-t-2 border-ink pt-4 text-xs leading-5 text-muted">
                {r.quote.symbol} is a mintable demo token standing in for USDC, which is not faucet-available on Elysium
                testnet. The probes, inventory checks and transactions are real; the quote asset is not money.
              </p>
            )}
          </div>
        </article>

        <footer className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          <span className="num">Elysium testnet · chain {deployment.chainId}</span>
          {(["campaigns", "factory", "router"] as const).map((k) => (
            <a key={k} href={addressUrl(r.contracts[k])} target="_blank" rel="noreferrer" className="num hover:text-violet">
              {k} {short(r.contracts[k], 6)}
            </a>
          ))}
          <span className="num">generated {dateTime(r.generatedAt)}</span>
        </footer>
      </div>
    </Page>
  );
}
