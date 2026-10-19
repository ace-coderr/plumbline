import { Link } from "react-router-dom";
import type { MarketSummary } from "@plumbline/shared";
import { STATIC, useCampaigns, useEconomics, useMarkets } from "../lib/api";
import { useNow } from "../components/Snapshot";
import { ago, fmtAmt, fmtBps, fmtInt, fmtPct, fmtPx, tone, toneText } from "../lib/format";
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

function PairName({ m }: { m: MarketSummary }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link to={`/market/${m.pair}`} className="num font-bold text-ink underline decoration-2 underline-offset-4 hover:text-violet">
        {m.base.symbol}/{m.quote.symbol}
      </Link>
      {(m.quote.demo || m.base.demo) && <DemoTag />}
    </span>
  );
}

/** Phone layout: one card per pair instead of a twelve-column table. */
function MarketCard({ m, now }: { m: MarketSummary; now: number }) {
  return (
    <div className="rounded-card border-2 border-ink bg-paper p-4 shadow-brut">
      <div className="flex items-start justify-between gap-2">
        <PairName m={m} />
        <span className={cx("num text-2xl font-bold", toneText[tone(m.uptime24h)])}>{fmtPct(m.uptime24h, 1)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        {[
          ["bid", fmtPx(m.bestBidPx)],
          ["ask", fmtPx(m.bestAskPx)],
          ["spread", m.spreadBps === null ? "—" : `${m.spreadBps} bps`],
          ["probes 24h", fmtInt(m.probes24h)],
          ["makers", String(m.makerCount)],
          ["last probe", ago(m.lastProbeAt, now)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="label">{k}</dt>
            <dd className="num mt-0.5 font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/report/${m.base.symbol}`}>
          <Badge tone="violet">report</Badge>
        </Link>
        {m.campaignIds.map((id) => (
          <Link key={id} to={`/campaign/${id}`}>
            <Badge tone="none">
              <N>c{id}</N>
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
  const list = [...(markets.data ?? [])].sort((a, b) => b.probes24h - a.probes24h || b.vaultCount - a.vaultCount);
  const now = useNow();
  const activeCampaigns = (campaigns.data ?? []).filter((c) => now < c.startTime + c.numEpochs * c.epochLength).length;

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
        <Stat label="Markets" value={fmtInt(list.length)} />
        <Stat label={STATIC ? "Quoting at snapshot" : "Live vaults"} value={fmtInt(list.reduce((a, m) => a + m.liveVaults, 0))} sub={`${fmtInt(list.reduce((a, m) => a + m.vaultCount, 0))} listed`} />
        <Stat label={STATIC ? "Running at snapshot" : "Live campaigns"} value={fmtInt(activeCampaigns)} />
        <Stat label="Probes run" value={fmtInt(econ.data?.totalProbes)} />
        <Stat label="Probes / hour" value={econ.data?.probesPerHour ? fmtInt(econ.data.probesPerHour) : "—"} />
        <Stat label="Quote updates" value={fmtInt(econ.data?.quoteUpdates)} sub={econ.data?.quoteUpdatesPerHour ? `${fmtInt(econ.data.quoteUpdatesPerHour)} / hour` : undefined} />
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
          <Panel title="Pairs" pad={false} right={<span>{STATIC ? "as of the snapshot" : "refreshes every 3s"}</span>} className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Pair</Th>
                  <Th right>Uptime 24h</Th>
                  <Th right>Probes</Th>
                  <Th right>Bid</Th>
                  <Th right>Ask</Th>
                  <Th right>Spread</Th>
                  <Th right>Bid depth</Th>
                  <Th right>Ask depth</Th>
                  <Th right>Makers</Th>
                  <Th>Last probe</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.pair} className="hover:bg-highlight/40">
                    <Td>
                      <PairName m={m} />
                    </Td>
                    <Td right mono className={cx("text-base font-bold", toneText[tone(m.uptime24h)])}>
                      {fmtPct(m.uptime24h, 2)}
                    </Td>
                    <Td right mono>
                      {fmtInt(m.probes24h)}
                    </Td>
                    <Td right mono className="text-success">
                      {fmtPx(m.bestBidPx)}
                    </Td>
                    <Td right mono className="text-danger">
                      {fmtPx(m.bestAskPx)}
                    </Td>
                    <Td right mono>
                      {fmtBps(m.spreadBps, 0)}
                    </Td>
                    <Td right mono>
                      {fmtAmt(m.bidDepth, m.quote.decimals, 3)} <span className="text-muted">{m.quote.symbol}</span>
                    </Td>
                    <Td right mono>
                      {fmtAmt(m.askDepth, m.base.decimals, 4)} <span className="text-muted">{m.base.symbol}</span>
                    </Td>
                    <Td right mono>
                      {m.makerCount}
                    </Td>
                    <Td mono className="text-muted">
                      {ago(m.lastProbeAt, now)}
                    </Td>
                    <Td>
                      <div className="flex gap-1.5">
                        <Link to={`/report/${m.base.symbol}`}>
                          <Badge tone="violet">report</Badge>
                        </Link>
                        {m.campaignIds.slice(0, 3).map((id) => (
                          <Link key={id} to={`/campaign/${id}`}>
                            <Badge tone="none">
                              <N>c{id}</N>
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </>
      )}
    </Page>
  );
}
