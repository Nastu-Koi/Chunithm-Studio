export type GameHitSoundId = 'tap' | 'ex' | 'flick' | 'hold' | 'slide' | 'holdStart' | 'slideStart' | 'airUp' | 'airDown' | 'airHoldIn' | 'airHoldLoop' | 'airHold' | 'airCrush';
/** Amplitude envelope in seconds; `sustain` is the level (0 to 1) the decay settles on. A stopped voice fades over `release`. */
export interface GameHitSoundEnvelope { attack: number; hold: number; decay: number; sustain: number; release: number }
/**
 * `stopAfter`: the cue that starts this layer stops it again after this many seconds, leaving only the release.
 * `loop`: the waveform repeats between these positions (seconds) until the note that started it ends.
 * `group`: layers started through the same other cue, which that cue's limits stop together.
 */
export interface GameHitSoundLayer { path: string; gain: number; playbackRate: number; envelope?: GameHitSoundEnvelope; stopAfter?: number; loop?: { start: number; end: number }; group?: number }
/**
 * At most `max` voices sharing `key` sound at once; a new voice stops the oldest. Keys name a cue or an ACF category.
 * With `group`, the limit counts and stops only the layers of that group; without, the whole sound.
 */
export interface GameHitSoundLimit { key: string; max: number; group?: number }
export interface GameHitSound { cueName: string; layers: GameHitSoundLayer[]; limits?: GameHitSoundLimit[] }
export interface GameHitSounds {
  source: string;
  sounds: Partial<Record<GameHitSoundId, GameHitSound>>;
  warnings: string[];
}
