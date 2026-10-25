import { useState } from "react";
import {
  ONE_SECOND_CHAIN,
  blocksPerWindow,
  deployment,
  gasCostNative,
  refreshesPerDay,
} from "@plumbline/shared";
import { STATIC, useEconomics, useKeeper } from "../lib/api";
import { ago, fmtDec, fmtInt, fmtNum, fmtUsd } from "../lib/format";
import { ErrorNote, Field, Input, Loading, N, Page, PageHeader, Panel, Stat, StatRow, Table, Td, Th } from "../components/ui";

const REFRESH_MS = 500;

export function EconomicsPage() {
  const econ = useEconomics();
  const keeper = useKeeper();
  const [gwei, setGwei] = useState(String(ONE_SECOND_CHAIN.gasPriceGwei));
  // Null until edited: the comparison gas token then costs the same as HYPE, so the page starts from
  // equal token prices and any dollar difference comes from gas, not from an assumed price gap.
  const [usd, setUsd] = useState<string | null>(null);
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

  const usdText = usd ?? (elyUsd ? elyUsd.toFixed(2) : "");
  const cmp = {
    gwei: Number(gwei) || 0,
    usd: Number(usdText) || 0,
    blockMs: Math.max(1, Number(blockMs) || 1000),
  };

  const side = (bt: number, g: number, price: number) => {
    const refreshes = refreshesPerDay(REFRESH_MS, bt);
    const quoteGasDay = quoteGas * refreshes;
    const probeGasDay = probeGas * probesPerDay;
    const systemGasDay = quoteGasDay * makers + probeGasDay;
    const quoteNative = gasCostNative(quoteGasDay, g);
    const probeNative = gasCostNative(probeGasDay, g);
    const systemNative = gasCostNative(systemGasDay, g);
    return {
      blockMs: bt,
      window: blocksPerWindow(maxAge, bt),
      refreshes,
      systemGasDay,
      systemNative,
      perProbeNative: gasCostNative(probeGas, g),
      quoteUsd: quoteNative * price,
      probeUsd: probeNative * price,
      systemUsd: systemNative * price,
    };
  };
  const ely = side(elyBlockMs, elyGwei, elyUsd);
  const alt = side(cmp.blockMs, cmp.gwei, cmp.usd);
  const totalHype = Number(BigInt(e.probeCostNativeTotal)) / 1e18;
  const samePrice = elyUsd > 0 && Math.abs(cmp.usd - elyUsd) < 0.005;

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
        sub={`Every figure in the Elysium column is measured from this run's receipts${
          STATIC ? ", as of the snapshot" : ""
        }. The other column is a set of assumptions you can change.`}
      />

      <StatRow>
        <Stat label="Probes run" value={fmtInt(e.totalProbes)} sub={e.lastProbeAt ? `last ${ago(e.lastProbeAt)}` : undefined} />
        <Stat label="Gas per probe" value={fmtInt(e.probeGasAvg)} sub="mean, all probes" />
        <Stat label="Probe spend" value={fmtDec(totalHype, 3)} sub={`HYPE · ${elyUsd ? fmtUsd(totalHype * elyUsd) : "price unavailable"}`} />
        <Stat label="Quote updates" value={fmtInt(e.quoteUpdates)} sub={`${fmtInt(e.quoteUpdateGasAvg)} gas each`} />
        <Stat
          label="Block time"
          value={`${fmtNum(e.avgBlockTimeMs, 0)}ms`}
          sub={STATIC ? "last 10k blocks before the snapshot" : "last 10k blocks, live"}
        />
        <Stat
          label="Keeper"
          value={keeper.data ? `${keeper.data.totals.probesPerMinute.toFixed(1)}/m` : "off"}
          sub={keeper.data ? `${fmtInt(keeper.data.totals.probes)} probes this run` : STATIC ? "not running; snapshot" : "not running"}
        />
      </StatRow>

      <section className="rounded-card border-2 border-ink bg-paper p-5 shadow-brut sm:p-7">
        <div className="label text-violet-text">The argument that does not depend on price</div>
        <p className="mt-3 font-display text-2xl font-extrabold leading-tight tracking-display sm:text-3xl">
          A {maxAge}-second quote gets <N>{ely.window}</N> chances to be re-stamped on Elysium and <N>{alt.window}</N> on a{" "}
          {fmtNum(alt.blockMs, 0)}ms chain.
        </p>
        <p className="mt-3 max-w-3xl text-base leading-7">
          On the slower chain, one delayed or dropped transaction lets the quote expire, the book is empty, and the next probe
          records the gap. No fee buys more blocks inside the window: a higher gas price can move a transaction up the queue,
          not make the chain produce blocks faster. On Elysium, <N>{fmtNum(ely.blockMs, 0)}ms</N> blocks leave room for
          several misses in a row before the quote ages out. That is what makes a {maxAge}-second freshness rule, and so
          constant checking, workable at all.
        </p>
      </section>

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
                  ["Block time", `${fmtNum(ely.blockMs, 0)} ms`, `${fmtNum(alt.blockMs, 0)} ms`, true],
                  [`Blocks inside a ${maxAge}s quote`, String(ely.window), String(alt.window), true],
                  ["Quote refreshes / maker / day", fmtInt(ely.refreshes), fmtInt(alt.refreshes), false],
                  ["Gas used / day, whole system", fmtInt(ely.systemGasDay), fmtInt(alt.systemGasDay), false],
                  ["Gas price", `${fmtDec(elyGwei, 3)} gwei`, `${fmtDec(cmp.gwei, 3)} gwei`, false],
                  ["Gas token spent / day, whole system", `${fmtDec(ely.systemNative, 3)} HYPE`, `${fmtDec(alt.systemNative, 3)} native`, false],
                  ["Cost per probe", `${fmtDec(ely.perProbeNative, 3)} HYPE`, `${fmtDec(alt.perProbeNative, 3)} native`, false],
                  ["Probing / day, USD*", fmtUsd(ely.probeUsd), fmtUsd(alt.probeUsd), false],
                  ["Quoting / maker / day, USD*", fmtUsd(ely.quoteUsd), fmtUsd(alt.quoteUsd), false],
                  ["Whole system / day, USD*", fmtUsd(ely.systemUsd), fmtUsd(alt.systemUsd), false],
                ] as const
              ).map(([k, a, b, lead]) => (
                <tr key={k} className={lead ? "bg-highlight" : undefined}>
                  <Td className={lead ? "font-bold" : undefined}>{k}</Td>
                  <Td right mono className={lead ? "font-bold" : undefined}>
                    {a}
                  </Td>
                  <Td right mono className={lead ? "font-bold" : undefined}>
                    {b}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="space-y-3 p-5 text-sm leading-6">
            <p>
              <strong>*Dollar rows depend on each chain's gas token price.</strong> In its own tokens Elysium spends more gas per
              day than the comparison chain: more blocks to refresh in, at a higher gas price. At equal token prices
              {samePrice ? " (the default here)" : ""} that leaves no dollar advantage for Elysium; a cheaper-looking total only
              appears if HYPE is assumed to be cheaper than the other chain's token. The freshness argument above does not
              depend on any price.
            </p>
            <p className="text-xs text-muted">
              Probe gas from every probe receipt; quote gas from sampled setQuote receipts. HYPE at the Hyperliquid mid
              {STATIC ? " when the snapshot was taken" : ""} (<N>{elyUsd ? fmtUsd(elyUsd) : "unavailable"}</N>). Probes per day
              use this run's measured cadence on the live contracts.
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
            <Field label="Gas token price" hint={samePrice ? "same as HYPE" : `HYPE is ${fmtUsd(elyUsd)}`}>
              <Input value={usdText} onChange={(ev) => setUsd(ev.target.value)} suffix="USD" />
            </Field>
            <p className="text-xs leading-5 text-muted">
              Gas per probe (<N>{fmtInt(probeGas)}</N>) and per quote update (<N>{fmtInt(quoteGas)}</N>) stay at the values
              measured on Elysium. Only price and block time change. The gas token price starts equal to HYPE's.
            </p>
          </div>
        </Panel>
      </div>
    </Page>
  );
}
