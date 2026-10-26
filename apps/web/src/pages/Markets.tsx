import { Link } from "react-router-dom";
import { campaignLabel, campaignPath, type MarketSummary } from "@plumbline/shared";
import { STATIC, useCampaigns, useEconomics, useMarkets } from "../lib/api";
import { ago, fmtAmt, fmtBps, fmtInt, fmtPct, fmtPx, tone, toneText, utcWindow } from "../lib/format";
import { useNow } from "../components/Snapshot";
import {
  Badge,
  DemoTag,
  Empty,
  ErrorNote,
  Loading,
  N,
  Page,
  PageHeader,
  Panel,
  Stamp,
  Stat,
  StatRow,
  Table,
  Td,
  Th,
  cx,
} from "../components/ui";

/**
 * What a row shows. Static mode (frozen data) uses figures verified by probe events, over every
 * probe the market had; live mode shows the current book and the trailing 24 hours.
 */
function rowFigures(m: MarketSummary) {
  const v = m.verified;
  const probed = v.probes > 0;
  if (STATIC) {
    return {
      uptime: v.uptime,
      uptimeSub: probed ? utcWindow(v.from, v.to) : "no probes",
      probes: v.probes,
      bid: v.lastBidPx,
      ask: v.lastAskPx,
      spread: v.medianSpreadBps,
      bidDepth: probed ? fmtAmt(v.bidDepth50, m.quote.decimals, 3) : "—",
      askDepth: probed ? fmtAmt(v.askDepth50, m.base.decimals, 4) : "—",
    };
  }
  return {
    uptime: m.uptime24h,
    uptimeSub: "last 24h",
    probes: m.probes24h,
    bid: m.bestBidPx,
    ask: m.bestAskPx,
    spread: m.spreadBps,
    bidDepth: fmtAmt(m.bidDepth, m.quote.decimals, 3),
    askDepth: fmtAmt(m.askDepth, m.base.decimals, 4),
  };
}

const COLS = STATIC
  ? { uptime: "Uptime", probes: "Probes", bid: "Verified bid", ask: "Verified ask", spread: "Median spread", depth: "±50 bps" }
  : { uptime: "Uptime 24h", probes: "Probes 24h", bid: "Bid", ask: "Ask", spread: "Spread", depth: "" };

function PairName({ m }: { m: MarketSummary }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link to={`/market/${m.pair}`} className="num font-bold text-ink underline decoration-2 underline-offset-4 hover:text-violet-text">
        {m.base.symbol}/{m.quote.symbol}
      </Link>
      {(m.quote.demo || m.base.demo) && <DemoTag />}
    </span>
  );
}

/** Phone layout: one card per pair instead of a wide table. */
function MarketCard({ m, now }: { m: MarketSummary; now: number }) {
  const f = rowFigures(m);
  return (
    <div className="rounded-card border-2 border-ink bg-paper p-4 shadow-brut">
      <div className="flex items-start justify-between gap-2">
        <PairName m={m} />
        <div className="text-right">
          <div className={cx("num text-2xl font-bold", toneText[tone(f.uptime)])}>{fmtPct(f.uptime, 1)}</div>
          <div className="num text-2xs text-muted">{f.uptimeSub}</div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        {[
          [COLS.bid.toLowerCase(), fmtPx(f.bid)],
          [COLS.ask.toLowerCase(), fmtPx(f.ask)],
          [COLS.spread.toLowerCase(), f.spread === null ? "—" : `${f.spread} bps`],
          ["probes", fmtInt(f.probes)],
          ["makers", String(m.makerCount)],
          ["last probe", ago(m.lastProbeAt)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="label">{k}</dt>
            <dd className="num mt-0.5 font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {m.verified.probes > 0 ? (
          <Link to={`/report/${m.base.symbol}`}>
            <Badge tone="violet">report</Badge>
          </Link>
        ) : (
          <span title="A report needs probes, and this market has none">
            <Badge tone="none">no report</Badge>
          </span>
        )}
        {m.campaignIds.map((id) => (
          <Link key={id} to={campaignPath(id)}>
            <Badge tone="none">
              <N>{campaignLabel(id)}</N>
            </Badge>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function MarketsPage() {
  const markets = useMarkets();
  const campaigns = useCampaigns();
  const econ = useEconomics();
  // Most-probed markets first: an unseeded pair should not lead the page.
  const list = [...(markets.data ?? [])].sort((a, b) => b.verified.probes - a.verified.probes || b.vaultCount - a.vaultCount);
  const now = useNow();
  const cs = campaigns.data ?? [];
  const running = cs.filter((c) => now >= c.startTime && now < c.startTime + c.numEpochs * c.epochLength).length;
  const settled = cs.filter((c) => c.settledEpochs >= c.numEpochs).length;

  // Network-wide verified figures: probes, uptime over them, and the busiest market's spread.
  const probes = list.reduce((a, m) => a + m.verified.probes, 0);
  const covered = list.reduce((a, m) => a + (m.verified.uptime ?? 0) * m.verified.probes, 0);
  const uptime = probes ? covered / probes : null;
  const top = list[0];

  return (
    <Page density="expressive">
      <div className="grid items-end gap-6 lg:grid-cols-[1fr_auto]">
        <PageHeader
          kicker="Elysium testnet"
          title={
            <>
              Liquidity you can
              <br />
              <span className="marker">check</span>, not trust.
            </>
          }
          sub="Uptime here is the share of on-chain probes in which at least one maker held a quote that was fresh, tight, deep, and backed by tokens actually sitting in its vault."
        />
        <div className="hidden lg:block">
          <Stamp>probe-verified</Stamp>
        </div>
      </div>

      <StatRow>
        <Stat label="Probes run" value={fmtInt(econ.data?.totalProbes ?? probes)} sub="on-chain transactions" />
        <Stat
          label="Verified uptime"
          value={fmtPct(uptime, 2)}
          tone={tone(uptime)}
          sub={top?.verified.from ? utcWindow(top.verified.from, top.verified.to) : undefined}
        />
        <Stat label="Quote updates" value={fmtInt(econ.data?.quoteUpdates)} sub="setQuote transactions" />
        <Stat
          label="Median spread"
          value={top?.verified.medianSpreadBps == null ? "—" : `${top.verified.medianSpreadBps.toFixed(1)} bps`}
          sub={top ? `${top.pair}, verified` : undefined}
        />
        <Stat label="Campaigns" value={fmtInt(cs.length)} sub={STATIC ? `${settled} settled` : `${running} running · ${settled} settled`} />
        <Stat label="Markets" value={fmtInt(list.length)} sub={`${fmtInt(list.reduce((a, m) => a + m.vaultCount, 0))} vaults listed`} />
      </StatRow>

      {markets.isLoading ? (
        <Loading rows={4} />
      ) : markets.isError ? (
        <ErrorNote error={markets.error} />
      ) : list.length === 0 ? (
        <Panel>
          <Empty>No vaults have been deployed yet.</Empty>
        </Panel>
      ) : (
        <>
          <div className="space-y-4 md:hidden">
            {list.map((m) => (
              <MarketCard key={m.pair} m={m} now={now} />
            ))}
          </div>
          <Panel
            title="Pairs"
            pad={false}
            right={<span>{STATIC ? "verified by probes, over each market's probe window" : "refreshes every 3s"}</span>}
            className="hidden md:block"
          >
            <Table>
              <thead>
                <tr>
                  <Th>Pair</Th>
                  <Th right>{COLS.uptime}</Th>
                  <Th right>{COLS.probes}</Th>
                  <Th right>{COLS.bid}</Th>
                  <Th right>{COLS.ask}</Th>
                  <Th right>{COLS.spread}</Th>
                  <Th right>Bid depth {COLS.depth}</Th>
                  <Th right>Ask depth {COLS.depth}</Th>
                  <Th right>Makers</Th>
                  <Th>Last probe</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.map((m) => {
                  const f = rowFigures(m);
                  return (
                    <tr key={m.pair} className="hover:bg-highlight/40">
                      <Td>
                        <PairName m={m} />
                      </Td>
                      <Td right mono>
                        <div className={cx("text-base font-bold", toneText[tone(f.uptime)])}>{fmtPct(f.uptime, 2)}</div>
                        <div className="text-2xs text-muted">{f.uptimeSub}</div>
                      </Td>
                      <Td right mono>
                        {fmtInt(f.probes)}
                      </Td>
                      <Td right mono className="text-success-text">
                        {fmtPx(f.bid)}
                      </Td>
                      <Td right mono className="text-danger-text">
                        {fmtPx(f.ask)}
                      </Td>
                      <Td right mono>
                        {f.spread === null ? "—" : `${fmtBps(f.spread, STATIC ? 1 : 0)} bps`}
                      </Td>
                      <Td right mono>
                        {f.bidDepth} {f.bidDepth !== "—" && <span className="text-muted">{m.quote.symbol}</span>}
                      </Td>
                      <Td right mono>
                        {f.askDepth} {f.askDepth !== "—" && <span className="text-muted">{m.base.symbol}</span>}
                      </Td>
                      <Td right mono>
                        {m.makerCount}
                      </Td>
                      <Td mono className="text-muted">
                        {ago(m.lastProbeAt)}
                      </Td>
                      <Td>
                        <div className="flex gap-1.5">
                          {m.verified.probes > 0 ? (
                            <Link to={`/report/${m.base.symbol}`}>
                              <Badge tone="violet">report</Badge>
                            </Link>
                          ) : (
                            <span title="A report needs probes, and this market has none">
                              <Badge tone="none">no report</Badge>
                            </span>
                          )}
                          {m.campaignIds.slice(0, 3).map((id) => (
                            <Link key={id} to={campaignPath(id)}>
                              <Badge tone="none">
                                <N>{campaignLabel(id)}</N>
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Panel>
        </>
      )}
    </Page>
  );
}
