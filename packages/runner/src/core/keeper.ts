/**
 * Keeper decisions, pure. A probe gate stays open for about a second, so the keeper polls it hard and
 * sends the moment it opens; these say which campaigns are worth polling and which epochs are due.
 */
export interface Track {
  id: number;
  startTime: number;
  numEpochs: number;
  epochLength: number;
  minProbeInterval: number;
  settledEpochs: number;
  lastProbeAt: number;
}

export const endOfTrack = (t: Track): number => t.startTime + t.numEpochs * t.epochLength;

/** Campaigns whose gate can be open: running, and past the minimum interval since the last probe. */
export function pollable(tracks: Track[], nowSec: number, quietUntilMs: Record<number, number>, nowMs: number): Track[] {
  return tracks.filter(
    (t) =>
      t.startTime <= nowSec &&
      nowSec < endOfTrack(t) &&
      nowSec >= t.lastProbeAt + t.minProbeInterval - 1 &&
      nowMs >= (quietUntilMs[t.id] ?? 0),
  );
}

/** The first campaign with a finished epoch nobody has settled, or null. */
export function settleDue(tracks: Track[], nowSec: number): Track | null {
  for (const t of tracks) {
    if (t.settledEpochs >= t.numEpochs) continue;
    if (nowSec >= t.startTime + (t.settledEpochs + 1) * t.epochLength + 1) return t;
  }
  return null;
}
