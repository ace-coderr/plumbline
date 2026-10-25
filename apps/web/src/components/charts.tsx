import { Bar, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { failLabels, txUrl, type EpochUptime, type ProbeView, type UptimeBucket } from "@plumbline/shared";
import { dateTime, fmtPct, utcWindow } from "../lib/format";
import { themed as color } from "../../tailwind.config";

/*
 * Chart rules, shared by every chart in the app:
 *  - every chart carries a legend naming each colour and mark it draws;
 *  - colours come from the theme tokens only: success for covered, danger for missed, violet for the
 *    measured overlay, ink for counts and outlines; no grey fills;
 *  - a period with no probes is drawn as an explicit empty mark, never left as a gap.
 */

const AXIS = { stroke: color.ink, tick: { fill: color.ink, fontSize: 11, fontFamily: "IBM Plex Mono" } } as const;
const GRID = { stroke: color.ink, strokeOpacity: 0.12, vertical: false } as const;

function TooltipBox({ children }: { children: React.ReactNode }) {
  return <div className="num rounded-[8px] border-2 border-ink bg-paper px-2.5 py-1.5 text-xs text-ink shadow-brut">{children}</div>;
}

export interface LegendItem {
  label: React.ReactNode;
  /** fill: a solid swatch; line: a stroke; empty: an outlined box, for periods with no probes. */
  mark: "fill" | "line" | "empty";
  color?: string;
}

/** The legend every chart carries. */
export function ChartLegend({ items, className = "" }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink ${className}`}>
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-1.5">
          {it.mark === "line" ? (
            <span className="h-[3px] w-4" style={{ background: it.color ?? color.ink }} />
          ) : (
            <span
              className="h-2.5 w-2.5 border-[1.5px] border-ink"
              style={{ background: it.mark === "fill" ? (it.color ?? color.ink) : color.paper }}
            />
          )}
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** Outlined marker drawn at the baseline of a bucket with no probes. */
function EmptyMark(props: { x?: number | string; y?: number | string; width?: number | string; value?: number | string }) {
  const { x, y, width, value } = props;
  if (Number(value) !== 0 || x === undefined || y === undefined || width === undefined) return null;
  const s = Math.max(3, Math.min(7, Number(width) - 1));
  return <rect x={Number(x) + Number(width) / 2 - s / 2} y={Number(y) - s - 1} width={s} height={s} fill={color.paper} stroke={color.ink} strokeWidth={1.25} />;
}

export const UPTIME_LEGEND: LegendItem[] = [
  { label: "covered probes", mark: "fill", color: color.success },
  { label: "missed probes", mark: "fill", color: color.danger },
  { label: "no probes", mark: "empty" },
  { label: "median spread, bps (right axis)", mark: "line", color: color.violet },
];

/**
 * Uptime over time: per bucket, probes where at least one vault passed (covered) versus none
 * (missed), with the median measured spread overlaid. Buckets with no probes get an empty mark.
 */
export function UptimeChart({ buckets, bucketSeconds }: { buckets: UptimeBucket[]; bucketSeconds: number }) {
  const data = buckets.map((b) => ({
    t: b.t,
    probes: b.probes,
    covered: b.covered,
    missed: b.probes - b.covered,
    spread: b.medianSpreadBps,
    rate: b.probes ? b.covered / b.probes : null,
  }));
  const span = (buckets.at(-1)?.t ?? 0) - (buckets[0]?.t ?? 0);
  // Axis times are UTC, like every timestamp on the site.
  const tick = (t: number) => (span > 86_400 ? dateTime(t).slice(5, 10) : dateTime(t).slice(11, 16));
  return (
    <div>
      <ChartLegend items={UPTIME_LEGEND} className="mb-2" />
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 10, right: 4, left: 0, bottom: 0 }} barCategoryGap={1}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="t" {...AXIS} tickFormatter={tick} minTickGap={40} />
          <YAxis yAxisId="n" {...AXIS} allowDecimals={false} width={32} />
          <YAxis yAxisId="bps" orientation="right" {...AXIS} width={32} />
          <Tooltip
            cursor={{ fill: color.highlight, fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <TooltipBox>
                  <div>
                    {dateTime(d.t)} +{Math.round(bucketSeconds / 60)}m
                  </div>
                  {d.probes === 0 ? (
                    <div>no probes</div>
                  ) : (
                    <>
                      <div>
                        <span className="text-success-text">{d.covered} covered</span> · <span className="text-danger-text">{d.missed} missed</span>
                      </div>
                      <div>uptime {fmtPct(d.rate)}</div>
                      <div className="text-violet">median spread {d.spread === null ? "—" : `${d.spread} bps`}</div>
                    </>
                  )}
                </TooltipBox>
              );
            }}
          />
          <Bar yAxisId="n" dataKey="covered" stackId="p" fill={color.success} isAnimationActive={false}>
            <LabelList dataKey="probes" content={EmptyMark} />
          </Bar>
          <Bar yAxisId="n" dataKey="missed" stackId="p" fill={color.danger} isAnimationActive={false} />
          {/* Not bridged across buckets without probes: no spread was measured there. */}
          <Line
            yAxisId="bps"
            dataKey="spread"
            stroke={color.violet}
            strokeWidth={2}
            dot={{ r: 2, fill: color.violet, stroke: color.violet }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export const PROBE_STRIP_LEGEND: LegendItem[] = [
  { label: "covered: at least one vault passed (short tick: not every vault)", mark: "fill", color: color.success },
  { label: "missed: no vault passed", mark: "fill", color: color.danger },
];

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

export const EPOCH_LEGEND: LegendItem[] = [
  { label: "covered share", mark: "fill", color: color.success },
  { label: "missed share", mark: "fill", color: color.danger },
  { label: "no probes (0)", mark: "empty" },
];

/**
 * Probe coverage per campaign epoch: one cell per epoch, filled bottom-up by the covered share and
 * labelled covered/probes. Epochs no probe reached are empty cells labelled 0.
 */
export function EpochGrid({ epochs }: { epochs: EpochUptime[] }) {
  const byCampaign = new Map<number, EpochUptime[]>();
  for (const e of epochs) byCampaign.set(e.campaignId, [...(byCampaign.get(e.campaignId) ?? []), e]);
  return (
    <div>
      <ChartLegend items={EPOCH_LEGEND} />
      <div className="mt-3 space-y-4">
        {[...byCampaign].map(([id, list]) => {
          const first = list[0];
          const last = list.at(-1);
          return (
            <div key={id}>
              <div className="num text-xs font-semibold">
                Campaign #{id}
                {first && last && (
                  <span className="font-normal text-muted">
                    {" "}
                    · {list.length} epochs · {utcWindow(first.start, last.end)}
                  </span>
                )}
              </div>
              <ol className="mt-1.5 flex flex-wrap gap-1.5">
                {list.map((e) => {
                  const share = e.probes ? e.covered / e.probes : 0;
                  return (
                    <li
                      key={e.epoch}
                      className="w-9 text-center"
                      title={`epoch ${e.epoch} · ${utcWindow(e.start, e.end)} · ${
                        e.probes ? `${e.covered} of ${e.probes} probes covered` : "no probes"
                      }`}
                    >
                      <div className="num text-2xs leading-4">e{e.epoch}</div>
                      <div className="relative h-9 overflow-hidden rounded-[4px] border-2 border-ink bg-paper">
                        {e.probes > 0 && (
                          <>
                            <div className="absolute inset-0 bg-danger" />
                            <div className="absolute inset-x-0 bottom-0 bg-success" style={{ height: `${share * 100}%` }} />
                          </>
                        )}
                      </div>
                      <div className="num text-2xs font-semibold leading-4">{e.probes ? `${e.covered}/${e.probes}` : "0"}</div>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>
    </div>
  );
}
