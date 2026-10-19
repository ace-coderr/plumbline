import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { failLabels, txUrl, type ProbeView, type UptimeBucket } from "@plumbline/shared";
import { clock, dateTime, fmtPct } from "../lib/format";
import { palette } from "../../tailwind.config";

const AXIS = { stroke: palette.ink, tick: { fill: palette.muted, fontSize: 11, fontFamily: "IBM Plex Mono" } } as const;
const GRID = { stroke: palette.ink, strokeOpacity: 0.12, vertical: false } as const;

function TooltipBox({ children }: { children: React.ReactNode }) {
  return <div className="num rounded-[8px] border-2 border-ink bg-paper px-2.5 py-1.5 text-xs text-ink shadow-brut">{children}</div>;
}

/**
 * Uptime over time: per bucket, probes where at least one vault passed (pass) versus none (fail),
 * with the median measured spread overlaid.
 */
export function UptimeChart({ buckets, bucketSeconds }: { buckets: UptimeBucket[]; bucketSeconds: number }) {
  const data = buckets.map((b) => ({
    t: b.t,
    covered: b.covered,
    missed: b.probes - b.covered,
    spread: b.medianSpreadBps,
    rate: b.probes ? b.covered / b.probes : null,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap={1}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="t" {...AXIS} tickFormatter={(t: number) => clock(t).slice(0, 5)} minTickGap={40} />
        <YAxis yAxisId="n" {...AXIS} allowDecimals={false} width={40} />
        <YAxis yAxisId="bps" orientation="right" {...AXIS} width={36} unit="" />
        <Tooltip
          cursor={{ fill: palette.highlight, fillOpacity: 0.35 }}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const d = payload[0].payload as (typeof data)[number];
            return (
              <TooltipBox>
                <div className="text-muted">
                  {dateTime(d.t)} +{Math.round(bucketSeconds / 60)}m
                </div>
                <div>
                  <span className="text-success">{d.covered} covered</span> · <span className="text-danger">{d.missed} missed</span>
                </div>
                <div>uptime {fmtPct(d.rate)}</div>
                <div>median spread {d.spread === null ? "—" : `${d.spread} bps`}</div>
              </TooltipBox>
            );
          }}
        />
        <Bar yAxisId="n" dataKey="covered" stackId="p" fill={palette.success} isAnimationActive={false} />
        <Bar yAxisId="n" dataKey="missed" stackId="p" fill={palette.danger} isAnimationActive={false} />
        <Line
          yAxisId="bps"
          dataKey="spread"
          stroke={palette.violet}
          strokeWidth={2}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** One tick per probe, newest on the right. Each tick links to its transaction. */
export function ProbeStrip({ probes, max = 120 }: { probes: ProbeView[]; max?: number }) {
  const list = probes.slice(0, max).reverse();
  if (list.length === 0) return <div className="h-7 text-xs text-muted">no probes yet</div>;
  return (
    <div className="flex h-7 items-end gap-[3px] overflow-hidden">
      {list.map((p) => {
        const ok = p.passed > 0;
        const full = p.checked > 0 && p.passed === p.checked;
        const reasons = p.results.filter((r) => !r.passed).flatMap((r) => failLabels(r.failMask));
        return (
          <a
            key={`${p.campaignId}-${p.nonce}`}
            href={txUrl(p.txHash)}
            target="_blank"
            rel="noreferrer"
            title={`#${p.nonce} ${dateTime(p.ts)} · ${p.passed}/${p.checked} passed${reasons.length ? ` · ${[...new Set(reasons)].join(", ")}` : ""}`}
            className={`block w-[6px] shrink-0 border border-ink hover:bg-violet ${
              ok ? (full ? "h-7 bg-success" : "h-5 bg-success") : "h-7 bg-danger"
            }`}
          />
        );
      })}
    </div>
  );
}

/** Small bar chart of per-epoch probes and points. */
export function EpochBars({ data }: { data: { epoch: number; probes: number; points: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 6, right: 4, left: -18, bottom: 0 }} barGap={1}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="epoch" {...AXIS} tickFormatter={(e: number) => `e${e}`} />
        <YAxis {...AXIS} allowDecimals={false} width={40} />
        <Tooltip
          cursor={{ fill: palette.highlight, fillOpacity: 0.35 }}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const d = payload[0].payload as (typeof data)[number];
            return (
              <TooltipBox>
                <div>epoch {d.epoch}</div>
                <div>{d.probes} probes</div>
                <div className="text-violet">{d.points} points</div>
              </TooltipBox>
            );
          }}
        />
        <Bar dataKey="probes" fill={palette.muted} stroke={palette.ink} isAnimationActive={false} />
        <Bar dataKey="points" fill={palette.violet} stroke={palette.ink} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Daily uptime bars for the public report. */
export function DailyBars({ data }: { data: { day: number; uptime: number | null; probes: number }[] }) {
  const rows = data.map((d) => ({ ...d, pct: d.uptime === null ? 0 : d.uptime * 100 }));
  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={rows} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <XAxis dataKey="day" {...AXIS} tickFormatter={(d: number) => new Date(d * 1000).toISOString().slice(5, 10)} />
        <YAxis {...AXIS} domain={[0, 100]} width={40} tickFormatter={(v: number) => `${v}`} />
        <Tooltip
          cursor={{ fill: palette.highlight, fillOpacity: 0.35 }}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const d = payload[0].payload as (typeof rows)[number];
            return (
              <TooltipBox>
                <div>{new Date(d.day * 1000).toISOString().slice(0, 10)}</div>
                <div>uptime {fmtPct(d.uptime, 2)}</div>
                <div>{d.probes} probes</div>
              </TooltipBox>
            );
          }}
        />
        <Bar dataKey="pct" fill={palette.success} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
