/** Game screen coordinates. Source measurements and limitations: docs/game-scene-reference.md. */
export const SCENE_WIDTH = 1920;
export const SCENE_HEIGHT = 1080;
/** Fitted from Sega's 600×338 gameplay image, not claimed to be engine camera settings. */
export const TRACK_REFERENCE = {
  centerX: 958.4, horizonY: -88.4, judgeY: 998.4, judgeWidth: 1168, topY: 176,
} as const;
export function projectTrackPoint(lane: number, distance: number, speed = 6, airHeight = 0): { x: number; y: number; scale: number } {
  // Travel-speed and AIR vertical units remain preview calibration, independent of the measured ground plane.
  const scale = 1 / Math.max(.65, 1 + distance * speed / 6 * 1.8);
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
