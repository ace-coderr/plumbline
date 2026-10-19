import { useState } from "react";
import {
  ONE_SECOND_CHAIN,
  blocksPerWindow,
  deployment,
  gasCostNative,
  refreshesPerDay,
} from "@plumbline/shared";
import { useEconomics, useKeeper } from "../lib/api";
import { ago, fmtInt, fmtNum, fmtSci, fmtUsd } from "../lib/format";
import { ErrorNote, Field, Input, Loading, N, Page, PageHeader, Panel, Stat, StatRow, Table, Td, Th } from "../components/ui";

const REFRESH_MS = 500;

export function EconomicsPage() {
  const econ = useEconomics();
  const keeper = useKeeper();
  const [gwei, setGwei] = useState(String(ONE_SECOND_CHAIN.gasPriceGwei));
  const [usd, setUsd] = useState(String(ONE_SECOND_CHAIN.nativeUsd));
  const [blockMs, setBlockMs] = useState(String(ONE_SECOND_CHAIN.blockTimeMs));

  if (econ.isLoading) return <Loading rows={6} />;
  if (econ.isError || !econ.data) return <ErrorNote error={econ.error} />;
  const e = econ.data;

  const maxAge = deployment.params.maxAge;
  const elyBlockMs = e.avgBlockTimeMs ?? 150;
  const elyGwei = e.avgGasPriceWei ? Number(e.avgGasPriceWei) / 1e9 : 0.1;
  const elyUsd = e.hypeUsd ?? 0;
  const probeGas = e.probeGasAvg ?? 0;
  const quoteGas = e.quoteUpdateGasAvg ?? 0;
  const probesPerDay = (e.probesPerHour ?? 0) * 24;
  const makers = 2;

  const cmp = {
    gwei: Number(gwei) || 0,
    usd: Number(usd) || 0,
    blockMs: Math.max(1, Number(blockMs) || 1000),
  };

  const side = (bt: number, g: number, price: number) => {
    const refreshes = refreshesPerDay(REFRESH_MS, bt);
    const quoteNative = gasCostNative(quoteGas * refreshes, g);
    const probeNative = gasCostNative(probeGas * probesPerDay, g);
    return {
      blockMs: bt,
      window: blocksPerWindow(maxAge, bt),
      refreshes,
      perProbeNative: gasCostNative(probeGas, g),
      quoteUsd: quoteNative * price,
      probeUsd: probeNative * price,
      systemUsd: (quoteNative * makers + probeNative) * price,
    };
  };
  const ely = side(elyBlockMs, elyGwei, elyUsd);
  const alt = side(cmp.blockMs, cmp.gwei, cmp.usd);
  const ratio = ely.systemUsd > 0 ? alt.systemUsd / ely.systemUsd : null;
  const totalHype = Number(BigInt(e.probeCostNativeTotal)) / 1e18;

  return (
    <Page density="expressive">
      <PageHeader
        kicker="Economics"
        title={
          <>
            A 2-second quote needs
            <br />a chain that <span className="marker">keeps up</span>.
          </>
        }
        sub="Every figure in the Elysium column is measured from receipts. The other column is a set of assumptions you can change."
      />

      <StatRow>
        <Stat label="Probes run" value={fmtInt(e.totalProbes)} sub={e.lastProbeAt ? `last ${ago(e.lastProbeAt)}` : undefined} />
        <Stat label="Gas per probe" value={fmtInt(e.probeGasAvg)} sub="mean, all probes" />
        <Stat label="Probe spend" value={fmtSci(totalHype, 2)} sub={`HYPE · ${elyUsd ? fmtUsd(totalHype * elyUsd) : "price unavailable"}`} />
        <Stat label="Quote updates" value={fmtInt(e.quoteUpdates)} sub={`${fmtInt(e.quoteUpdateGasAvg)} gas each`} />
        <Stat label="Block time" value={`${fmtNum(e.avgBlockTimeMs, 0)}ms`} sub="last 10k blocks" />
        <Stat
          label="Keeper"
          value={keeper.data ? `${keeper.data.totals.probesPerMinute.toFixed(1)}/m` : "—"}
          sub={keeper.data ? `${fmtInt(keeper.data.totals.probes)} probes this run` : "stats unreachable"}
        />
      </StatRow>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0">
        <Panel title="Same cadence, two chains" pad={false} right={<span className="num">{makers} makers · {REFRESH_MS}ms refresh · {maxAge}s freshness</span>}>
          <Table>
            <thead>
              <tr>
                <Th />
                <Th right>Elysium, measured</Th>
                <Th right>{ONE_SECOND_CHAIN.label}, assumed</Th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Block time", `${fmtNum(ely.blockMs, 0)} ms`, `${fmtNum(alt.blockMs, 0)} ms`],
                  [`Blocks inside a ${maxAge}s quote`, String(ely.window), String(alt.window)],
                  ["Quote refreshes / maker / day", fmtInt(ely.refreshes), fmtInt(alt.refreshes)],
                  ["Gas price", `${fmtSci(elyGwei, 3)} gwei`, `${fmtSci(cmp.gwei, 3)} gwei`],
                  ["Cost per probe", `${fmtSci(ely.perProbeNative)} HYPE`, `${fmtSci(alt.perProbeNative)} native`],
                  ["Probing / day", fmtUsd(ely.probeUsd), fmtUsd(alt.probeUsd)],
                  ["Quoting / maker / day", fmtUsd(ely.quoteUsd), fmtUsd(alt.quoteUsd)],
                  ["Whole system / day", fmtUsd(ely.systemUsd), fmtUsd(alt.systemUsd)],
                ] as const
              ).map(([k, a, b], i, arr) => {
                const last = i === arr.length - 1;
                return (
                  <tr key={k} className={last ? "bg-highlight" : undefined}>
                    <Td className={last ? "font-bold" : undefined}>{k}</Td>
                    <Td right mono className={last ? "font-bold" : undefined}>
                      {a}
                    </Td>
                    <Td right mono className={last ? "font-bold" : undefined}>
                      {b}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div className="space-y-3 p-5 text-sm leading-6">
            {ratio !== null && Number.isFinite(ratio) && (
              <p className="font-display text-2xl font-extrabold leading-tight tracking-display">
                The same verified uptime costs <N>{ratio >= 10 ? fmtInt(ratio) : fmtNum(ratio, 1)}×</N> more on the comparison chain.
              </p>
            )}
            <p>
              Price is half of it. With <N>{fmtNum(alt.blockMs, 0)}ms</N> blocks a maker gets <N>{alt.window}</N> chance
              {alt.window === 1 ? "" : "s"} to re-stamp a <N>{maxAge}s</N> quote, so one delayed transaction leaves the book empty
              and the next probe records it. On Elysium the same window spans <N>{ely.window}</N> blocks.
            </p>
            <p className="text-xs text-muted">
              Probe gas from every probe receipt; quote gas from sampled setQuote receipts. Dollars use the Hyperliquid HYPE mid
              (<N>{elyUsd ? fmtUsd(elyUsd) : "unavailable"}</N>).
            </p>
          </div>
        </Panel>
        <Panel title="Assumptions">
          <div className="space-y-4">
            <Field label="Block time">
              <Input value={blockMs} onChange={(ev) => setBlockMs(ev.target.value)} suffix="ms" />
            </Field>
            <Field label="Gas price">
              <Input value={gwei} onChange={(ev) => setGwei(ev.target.value)} suffix="gwei" />
            </Field>
            <Field label="Gas token price">
              <Input value={usd} onChange={(ev) => setUsd(ev.target.value)} suffix="USD" />
            </Field>
            <p className="text-xs leading-5 text-muted">
              Gas per probe (<N>{fmtInt(probeGas)}</N>) and per quote update (<N>{fmtInt(quoteGas)}</N>) stay at the values
              measured on Elysium. Only price and block time change.
            </p>
          </div>
        </Panel>
      </div>
    </Page>
  );
}
