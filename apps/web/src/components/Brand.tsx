/** The plumb bob: a line from above and the weight that keeps it true. Colours come from tokens. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <line x1="16" y1="1.5" x2="16" y2="12.5" className="stroke-ink" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M11.5 12.5 h9 l3.6 7 L16 30 L7.9 19.5 Z" className="fill-violet stroke-ink" strokeWidth="2" strokeLinejoin="round" />
      <path d="M11.5 12.5 h9 l3.6 7 H7.9 Z" className="fill-highlight stroke-ink" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** `compact` drops the word on very narrow screens so the header bar still fits a wallet button. */
export function Wordmark({ size = 22, compact = false }: { size?: number; compact?: boolean }) {
  return (
    <span className="inline-flex select-none items-center gap-2">
      <Mark size={size} />
      <span className={`font-display font-extrabold tracking-display text-ink${compact ? " max-[374px]:hidden" : ""}`} style={{ fontSize: size * 0.95 }}>
        plumbline
      </span>
    </span>
  );
}
