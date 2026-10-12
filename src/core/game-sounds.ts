export type GameHitSoundId = 'tap' | 'ex' | 'flick' | 'hold' | 'slide' | 'holdStart' | 'slideStart' | 'airUp' | 'airDown' | 'airHoldIn' | 'airHoldLoop' | 'airHold' | 'airCrush';
/** Amplitude envelope in seconds; `sustain` is the level (0 to 1) the decay settles on. A stopped voice fades over `release`. */
export interface GameHitSoundEnvelope { attack: number; hold: number; decay: number; sustain: number; release: number }
/**
 * `stopAfter`: the cue that starts this layer stops it again after this many seconds, leaving only the release.
 * `loop`: the waveform repeats between these positions (seconds) until the note that started it ends.
 * `group`: layers started through the same other cue, which that cue's limits stop together.
 * `delay`: seconds between the start of the sound and the start of this layer.
 * `lowpass`, `highpass`: cutoff frequencies in Hz of the cue's band-pass filter.
 * `swell`: volume factor over the seconds since the layer started, linear between points and held after the last.
 */
export interface GameHitSoundLayer {
  path: string; gain: number; playbackRate: number; envelope?: GameHitSoundEnvelope; stopAfter?: number; loop?: { start: number; end: number }; group?: number;
  delay?: number; lowpass?: number; highpass?: number; swell?: { time: number; level: number }[];
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
