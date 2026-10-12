export type GameHitSoundId = 'tap' | 'ex' | 'flick' | 'hold' | 'slide' | 'airUp' | 'airDown' | 'airHoldIn' | 'airHold' | 'airCrush';
/** Amplitude envelope in seconds; `sustain` is the level (0 to 1) the decay settles on. A stopped voice fades over `release`. */
export interface GameHitSoundEnvelope { attack: number; hold: number; decay: number; sustain: number; release: number }
/** `stopAfter`: the cue that starts this layer stops it again after this many seconds, leaving only the release. */
export interface GameHitSoundLayer { path: string; gain: number; playbackRate: number; envelope?: GameHitSoundEnvelope; stopAfter?: number }
/** At most `max` voices sharing `key` sound at once; a new voice stops the oldest. Keys name a cue or an ACF category. */
export interface GameHitSoundLimit { key: string; max: number }
export interface GameHitSound { cueName: string; layers: GameHitSoundLayer[]; limits?: GameHitSoundLimit[] }
export interface GameHitSounds {
  source: string;
  sounds: Partial<Record<GameHitSoundId, GameHitSound>>;
  warnings: string[];
}
