/** Game screen coordinates. Source measurements and limitations: docs/game-scene-reference.md. */
export const SCENE_WIDTH = 1920;
export const SCENE_HEIGHT = 1080;
/** Fitted from Sega's 600×338 gameplay image, not claimed to be engine camera settings. */
export const TRACK_REFERENCE = {
  centerX: 958.4, horizonY: -88.4, judgeY: 998.4, judgeWidth: 1168, topY: 176,
} as const;
/**
 * 轨道流速 as the game's play option table gives it (PlayOptionSpeedTableRecord): what the player picks, 1.00 to 15.00
 * in steps of 0.25, then 16 to 19. The table's last row, SONIC, is left out.
 */
export const NOTE_SPEEDS: readonly number[] = [...Array.from({ length: 57 }, (_, index) => 1 + index / 4), 16, 17, 18, 19];
/** The table's value for a picked speed, which is what the note code multiplies by; speeds between two rows are interpolated. */
export function nativeNoteSpeed(speed: number): number {
  if (speed <= 15) return Math.max(.1, speed * .8);
  // 16 to 19 are 14, 16, 18 and 20: two a step, starting from the 12 of 15.00.
  return 12 + (Math.min(19, speed) - 15) * 2;
}
/** Track units a note travels per second of scroll distance: the game moves it 1.5 × the table value every 1/60 s. */
export function scrollWorldUnit(speed = 6): number { return 90 * nativeNoteSpeed(speed); }
/** Source Z of the judgement line and of the 17 FIELD WALL positions (PlayOptionFieldWallPositionTableRecord), 0 to 16. */
export const JUDGE_LINE_Z = -65;
export const FIELD_WALL_Z: readonly number[] = [-460, -437, -414, -391, -368, -345, -322, -299, -276, -253, -230, -207, -179.4, -151.8, -110.4, -64.4, -55.2];
/** Far end of the track mesh, which runs over source Z -470 to 0. */
export const FIELD_FAR_Z = -470;
/** Preview adaptation, not a game value: the far end of the track darkens to black from this source Z, by this much at
 * FIELD_FAR_Z, so the notes field texture's own spot pattern does not pile up into blotches under perspective. */
export const FIELD_FADE_START_Z = -180;
export const FIELD_FADE_ALPHA = .85;
export function fieldFadeAlpha(z: number): number {
  return FIELD_FADE_ALPHA * Math.max(0, Math.min(1, (FIELD_FADE_START_Z - z) / (FIELD_FADE_START_Z - FIELD_FAR_Z)));
}
/** Scroll distance in seconds from the judgement line to a source Z; negative on the near side of the line. */
export function scrollDistanceAt(z: number, speed: number): number { return (JUDGE_LINE_Z - z) / scrollWorldUnit(speed); }
/** The FIELD WALL is an upright quad of this half width and height in source units (0xd66560), as wide as the track with its side bands. */
export const FIELD_WALL_HALF_WIDTH = 36;
export const FIELD_WALL_HEIGHT = 54;
/** Scroll distance at which the FIELD WALL stands: nothing on the ground beyond it is seen. */
export function fieldWallDistance(speed: number, wall = 0): number { return scrollDistanceAt(FIELD_WALL_Z[Math.max(0, Math.min(16, Math.round(wall)))], speed); }
const focal = SCENE_HEIGHT / 2 / Math.tan(27.5 * Math.PI / 360), cameraLength = Math.hypot(54, 190.5);
/** Track units along the lanes over which a point's depth from the camera doubles, taken at the judgement line. */
export const TRACK_DEPTH = focal / (TRACK_REFERENCE.judgeWidth / 64) / (190.5 / cameraLength);
export function projectTrackPoint(lane: number, distance: number, speed = 6, airHeight = 0): { x: number; y: number; scale: number } {
  // The AIR vertical unit remains preview calibration, independent of the measured ground plane.
  const scale = 1 / Math.max(.65, 1 + distance * scrollWorldUnit(speed) / TRACK_DEPTH);
  return {
    x: TRACK_REFERENCE.centerX + (lane / 16 - .5) * TRACK_REFERENCE.judgeWidth * scale,
    y: TRACK_REFERENCE.horizonY + (TRACK_REFERENCE.judgeY - TRACK_REFERENCE.horizonY) * scale - airHeight * SCENE_HEIGHT * .15 * scale,
    scale,
  };
}
export interface SceneViewport { x: number; y: number; width: number; height: number; scale: number }
/** Fit without stretching: editor chrome and arbitrary window ratios cannot deform the track. */
export function fitSceneViewport(width: number, height: number): SceneViewport {
  const scale = Math.max(0, Math.min(width / SCENE_WIDTH, height / SCENE_HEIGHT));
  const sceneWidth = SCENE_WIDTH * scale, sceneHeight = SCENE_HEIGHT * scale;
  return { x: (width - sceneWidth) / 2, y: (height - sceneHeight) / 2, width: sceneWidth, height: sceneHeight, scale };
}
