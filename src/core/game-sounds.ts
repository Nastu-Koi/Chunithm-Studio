export type GameHitSoundId = 'tap' | 'ex' | 'flick' | 'hold' | 'slide' | 'holdStart' | 'slideStart' | 'airUp' | 'airDown' | 'airHoldIn' | 'airHoldLoop' | 'airHold' | 'airCrush';
/** How a value moves from one point to the next: CRI's curve type (0 linear) and its strength, 0 to 2. */
export interface GameHitSoundCurve { type: number; strength: number }
/**
 * Progress (0 to 1) of a curve at the fraction `x` of its time, as the runtime in chusanApp.exe computes it (0x13a36ec):
 * 1 starts slowly, 2 starts fast, 3 is an S, 4 an S lying flat at its middle; the strength blends from linear (0)
 * through the plain shape (1) to a sharper one (2).
 */
export function curveShape(curve: GameHitSoundCurve | undefined, x: number): number {
  x = Math.max(0, Math.min(1, x));
  if (!curve) return x;
  const s = Math.max(0, Math.min(2, curve.strength));
  switch (curve.type) {
    case 1: return s <= 1 ? x * (s * x + 1 - s) : x * x * ((s - 1) * x * x + 2 - s);
    case 2: { const q = x * (2 - x); return s <= 1 ? x * (1 + s * (1 - x)) : q * (q + s * (1 - q)); }
    case 3: {
      if (s <= 1) return x * ((3 - 2 * x) * x * s + 1 - s);
      const half = (u: number) => u * u * ((8 - 6 * s) * (.5 - u) + 2);
      return x <= .5 ? half(x) : 1 - half(1 - x);
    }
    case 4: {
      if (s <= 1) return x <= .5 ? x * (1 + s - 2 * s * x) : x + s * (2 * x * x - 3 * x + 1);
      const m = 4 * x * (x - 1), part = m / 2 * (m - m * s - s);
      return x <= .5 ? part : 1 - part;
    }
    default: return x;
  }
}
/**
 * Amplitude envelope in seconds; `sustain` is the level (0 to 1) the decay settles on. A stopped voice fades over
 * `release`. Each timed stage is linear unless it names a curve.
 */
export interface GameHitSoundEnvelope { attack: number; hold: number; decay: number; sustain: number; release: number; attackCurve?: GameHitSoundCurve; decayCurve?: GameHitSoundCurve; releaseCurve?: GameHitSoundCurve }
/**
 * `stopAfter`: the cue that starts this layer stops it again after this many seconds, leaving only the release.
 * `loop`: the waveform repeats between these positions (seconds) until the note that started it ends.
 * `group`: layers started through the same other cue, which that cue's limits stop together.
 * `delay`: seconds between the start of the sound and the start of this layer.
 * `bandpass`: the two corner frequencies in Hz of the cue's band-pass filter, one second-order section.
 * `peaking`: a peaking equalizer; `gain` is the amplitude factor at its centre.
 * `swell`: volume factor over the seconds since the layer started, held after the last point; a point's curve shapes
 * the way to it from the point before.
 */
export interface GameHitSoundLayer {
  path: string; gain: number; playbackRate: number; envelope?: GameHitSoundEnvelope; stopAfter?: number; loop?: { start: number; end: number }; group?: number;
  delay?: number; bandpass?: { low: number; high: number }; peaking?: { frequency: number; q: number; gain: number };
  swell?: { time: number; level: number; curve?: GameHitSoundCurve }[];
}
/**
 * At most `max` voices sharing `key` sound at once; a new voice stops the oldest. Keys name a cue or an ACF category.
 * With `group`, the limit counts and stops only the layers of that group; without, the whole sound.
 */
export interface GameHitSoundLimit { key: string; max: number; group?: number }
/**
 * A cue started again within `window` seconds of its previous start takes the next step, and after the last one the
 * step `loopback`; any later start takes the first. A step delays the layers by `delay` seconds, give or take `spread`.
 * `group` as for a limit.
 */
export interface GameHitSoundCombo { key: string; window: number; loopback: number; steps: { delay: number; spread: number }[]; group?: number }
export interface GameHitSound { cueName: string; layers: GameHitSoundLayer[]; limits?: GameHitSoundLimit[]; combos?: GameHitSoundCombo[] }
export interface GameHitSounds {
  source: string;
  sounds: Partial<Record<GameHitSoundId, GameHitSound>>;
  warnings: string[];
}
