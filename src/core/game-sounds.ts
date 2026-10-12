export type GameHitSoundId = 'tap' | 'ex' | 'flick' | 'hold' | 'slide' | 'airUp' | 'airDown' | 'airHold' | 'airCrush';
export interface GameHitSoundLayer { path: string; gain: number; playbackRate: number }
/** At most `max` voices sharing `key` sound at once; a new voice stops the oldest. Keys name a cue or an ACF category. */
export interface GameHitSoundLimit { key: string; max: number }
export interface GameHitSound { cueName: string; layers: GameHitSoundLayer[]; limits?: GameHitSoundLimit[] }
export interface GameHitSounds {
  source: string;
  sounds: Partial<Record<GameHitSoundId, GameHitSound>>;
  warnings: string[];
}
