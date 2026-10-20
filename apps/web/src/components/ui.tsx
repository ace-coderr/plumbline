import { createContext, useContext } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { addressUrl, txUrl } from "@plumbline/shared";
import { short, toneText, type Tone } from "../lib/format";

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

// -----------------------------------------------------------------------------------------------
// Density: expressive pages persuade, dense pages are worked in. Same palette, different treatment.
// -----------------------------------------------------------------------------------------------

export type Density = "expressive" | "dense";
const DensityContext = createContext<Density>("expressive");
export const useDensity = () => useContext(DensityContext);

export function Page({ density, children }: { density: Density; children: ReactNode }) {
  return (
    <DensityContext.Provider value={density}>
      <div className={density === "dense" ? "space-y-4" : "space-y-8"}>{children}</div>
    </DensityContext.Provider>
  );
}

// -----------------------------------------------------------------------------------------------
// Surfaces
// -----------------------------------------------------------------------------------------------

export function Panel({
  title,
  right,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  const d = useDensity();
  const hasHead = title !== undefined || right !== undefined;
  return (
    <section className={cx("min-w-0 rounded-card border-2 border-ink bg-paper shadow-brut", className)}>
      {hasHead && (
        <header
          className={cx(
            "flex flex-wrap items-center justify-between gap-2 border-ink",
            d === "dense" ? "min-h-9 border-b px-3 py-1.5" : "border-b-2 px-5 py-3",
          )}
        >
          <h2 className={d === "dense" ? "label text-ink" : "font-display text-lg font-extrabold tracking-display"}>{title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">{right}</div>
        </header>
      )}
      <div className={pad ? (d === "dense" ? "p-3" : "p-5") : undefined}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "none",
  big = false,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  big?: boolean;
}) {
  const d = useDensity();
  const size = d === "dense" ? "text-lg leading-6" : big ? "text-[40px] leading-[44px]" : "text-[28px] leading-8";
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={cx("num mt-1 truncate font-semibold", size, tone === "none" ? "text-ink" : toneText[tone])}>{value}</div>
      {sub !== undefined && <div className="num mt-0.5 truncate text-2xs text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Row of stats, always six. Dense: 1px ink rules between cells (the ink gap shows through).
 * Expressive: one roomy card.
 */
export function StatRow({ children }: { children: ReactNode }) {
  const d = useDensity();
  return d === "dense" ? (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border-2 border-ink bg-ink shadow-brut sm:grid-cols-3 lg:grid-cols-6 [&>*]:bg-paper [&>*]:px-3 [&>*]:py-2.5">
      {children}
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6 rounded-card border-2 border-ink bg-paper px-5 py-5 shadow-brut sm:grid-cols-3 lg:grid-cols-6">
      {children}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Small parts
// -----------------------------------------------------------------------------------------------

export function Badge({ tone, children }: { tone: Tone | "highlight" | "violet"; children: ReactNode }) {
  const styles: Record<Tone | "highlight" | "violet", string> = {
    pass: "bg-success text-paper",
    warn: "bg-highlight text-ink",
    fail: "bg-danger text-paper",
    none: "bg-paper text-ink",
    highlight: "bg-highlight text-ink",
    violet: "bg-violet text-paper",
  };
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center whitespace-nowrap rounded-[6px] border-2 border-ink px-1.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide",
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Mandatory label on anything quoted in a demo asset. */
export function DemoTag() {
  return (
    <span title="Mintable demo token, not USDC. See README: Demo assets.">
      <Badge tone="highlight">demo asset</Badge>
    </span>
  );
}

export function Dot({ tone, live = false }: { tone: Tone; live?: boolean }) {
  const bg: Record<Tone, string> = { pass: "bg-success", warn: "bg-highlight", fail: "bg-danger", none: "bg-muted" };
  return <span className={cx("inline-block h-2 w-2 rounded-full border border-ink", bg[tone], live && "pulse")} />;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("max-w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  );
}

export function Th({ children, right = false, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  const d = useDensity();
  return (
    <th
      className={cx(
        "label whitespace-nowrap border-b border-ink text-ink",
        d === "dense" ? "h-7 px-3" : "h-10 px-5",
        right && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right = false,
  mono = false,
  className,
  colSpan,
}: {
  children?: ReactNode;
  right?: boolean;
  mono?: boolean;
  className?: string;
  colSpan?: number;
}) {
  const d = useDensity();
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "whitespace-nowrap border-b border-dotted border-ink",
        d === "dense" ? "h-7 px-3 text-xs" : "h-12 px-5 text-sm",
        right && "text-right",
        mono && "num",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Button({
  variant = "default",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const d = useDensity();
  const styles = {
    default: "bg-paper text-ink",
    primary: "bg-violet text-paper",
    ghost: "bg-bg text-ink",
    danger: "bg-danger text-paper",
  } as const;
  return (
    <button
      {...rest}
      className={cx(
        "press inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-card border-2 border-ink font-semibold disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-brut",
        d === "dense" ? "h-8 px-3 text-xs" : "h-11 px-5 text-sm",
        styles[variant],
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="label text-ink">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint !== undefined && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, suffix, ...rest }: InputHTMLAttributes<HTMLInputElement> & { suffix?: ReactNode }) {
  const d = useDensity();
  return (
    <div
      className={cx(
        "flex items-center rounded-[8px] border-2 border-ink bg-paper focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-violet",
        d === "dense" ? "h-8" : "h-11",
      )}
    >
      <input
        {...rest}
        className={cx("h-full w-full min-w-0 bg-transparent px-3 text-sm text-ink outline-none placeholder:text-muted", className)}
      />
      {suffix !== undefined && <span className="num shrink-0 px-3 text-xs font-semibold text-muted">{suffix}</span>}
    </div>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const d = useDensity();
  return (
    <select
      {...rest}
      className={cx(
        "w-full rounded-[8px] border-2 border-ink bg-paper px-2 text-sm text-ink outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-violet",
        d === "dense" ? "h-8" : "h-11",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-[8px] border-2 border-ink bg-paper">
      {options.map((o, i) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cx(
            "num h-7 px-2.5 text-xs font-semibold",
            i > 0 && "border-l-2 border-ink",
            o === value ? "bg-violet text-paper" : "text-ink hover:bg-highlight",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function TxLink({ hash, children }: { hash: string; children?: ReactNode }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="num link">
      {children ?? short(hash, 6)}
    </a>
  );
}

export function AddrLink({ address, n = 4 }: { address: string; n?: number }) {
  return (
    <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="num text-ink underline decoration-1 underline-offset-2 hover:text-violet" title={address}>
      {short(address, n)}
    </a>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-20 items-center justify-center px-4 py-6 text-center text-sm text-muted">{children}</div>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-1">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded-[4px] border border-ink bg-bg" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div className="num rounded-card border-2 border-ink bg-danger px-3 py-2 text-xs text-paper">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/** Page heading. Expressive pages get display type; dense pages a compact mono title. */
export function PageHeader({ title, sub, right, kicker }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; kicker?: ReactNode }) {
  const d = useDensity();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {kicker !== undefined && <div className="label mb-2 text-violet">{kicker}</div>}
        <h1
          className={
            d === "dense"
              ? "font-mono text-xl font-bold text-ink"
              : "display text-[40px] leading-[0.95] sm:text-[64px]"
          }
        >
          {title}
        </h1>
        {sub !== undefined && <p className={cx("mt-2 max-w-2xl text-muted", d === "dense" ? "text-xs" : "text-base leading-7")}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** The one decorative flourish a page may carry: a slightly rotated, stamped label. */
export function Stamp({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rotate-[-4deg] rounded-card border-2 border-ink bg-highlight px-3 py-1.5 font-display text-sm font-extrabold uppercase tracking-wide text-ink shadow-brut">
      {children}
    </span>
  );
}

/** Inline numeral in prose: monospace with tabular figures. */
export function N({ children }: { children: ReactNode }) {
  return <span className="num">{children}</span>;
}
