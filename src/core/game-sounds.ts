export type GameHitSoundId = 'tap' | 'ex' | 'flick' | 'hold' | 'slide' | 'airUp' | 'airDown' | 'airHold' | 'airCrush';
export interface GameHitSoundLayer { path: string; gain: number; playbackRate: number }
export interface GameHitSound { cueName: string; layers: GameHitSoundLayer[] }
export interface GameHitSounds {
  source: string;
  sounds: Partial<Record<GameHitSoundId, GameHitSound>>;
  warnings: string[];
}
