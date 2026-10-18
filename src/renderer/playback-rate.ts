/** The toolbar's preset playback rates, ascending; `transport.setRate` accepts anything in the same 0.1–2 range. */
export const PLAYBACK_RATES: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
export const MIN_PLAYBACK_RATE = PLAYBACK_RATES[0];
export const MAX_PLAYBACK_RATE = PLAYBACK_RATES[PLAYBACK_RATES.length - 1];

/** A typed-in rate kept inside the transport range and at two decimals; a non-number falls back. */
export function clampPlaybackRate(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, value)) * 100) / 100;
}

/** The next preset above (+1) or below (−1) the current rate, which may itself be a custom value; the ends stay put. */
export function stepPlaybackRate(rate: number, direction: 1 | -1): number {
  const candidates =
    direction > 0 ? PLAYBACK_RATES.filter(p => p > rate + 1e-9) : PLAYBACK_RATES.filter(p => p < rate - 1e-9);
  if (!candidates.length) return rate;
  return direction > 0 ? candidates[0] : candidates[candidates.length - 1];
}
