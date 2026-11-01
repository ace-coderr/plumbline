/**
 * When to say "the private node failed". One read that had to go to a public node is a blip; the alert waits for `needed` of them within
 * `windowMs`, and once it has fired the count starts again. Times are in milliseconds.
 */
export const FALLBACKS_NEEDED = 3;
export const FALLBACK_WINDOW_MS = 5 * 60_000;

export class FallbackWatch {
  private times: number[] = [];

  constructor(
    private readonly needed = FALLBACKS_NEEDED,
    private readonly windowMs = FALLBACK_WINDOW_MS,
  ) {}

  /** Notes one fallback. */
  record(nowMs: number): void {
    this.times.push(nowMs);
    if (this.times.length > 50) this.times.splice(0, this.times.length - 50);
  }

  /** True once, when enough fallbacks have happened within the window; then the count starts again. */
  reached(nowMs: number): boolean {
    this.times = this.times.filter((t) => nowMs - t <= this.windowMs);
    if (this.times.length < this.needed) return false;
    this.times = [];
    return true;
  }
}
