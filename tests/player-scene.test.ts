import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSceneViewport, SCENE_WIDTH, SCENE_HEIGHT } from '../src/renderer/player-scene';

test('game screen keeps the native aspect ratio in wide and tall editor windows', () => {
  for (const [width, height] of [[1920, 1080], [1400, 640], [900, 900], [1200, 400]]) {
    const viewport = fitSceneViewport(width, height);
    assert.ok(Math.abs(viewport.width / viewport.height - 16 / 9) < 1e-12);
    assert.ok(viewport.x >= 0 && viewport.y >= 0);
    assert.equal(viewport.x * 2 + viewport.width, width);
    assert.equal(viewport.y * 2 + viewport.height, height);
    assert.equal(viewport.width, SCENE_WIDTH * viewport.scale);
    assert.equal(viewport.height, SCENE_HEIGHT * viewport.scale);
  }
});

test('a hidden player has a finite empty viewport', () => {
  assert.deepEqual(fitSceneViewport(0, 0), { x: 0, y: 0, width: 0, height: 0, scale: 0 });
});

test('judge line anchors and projected quarter lanes match the measured Sega screenshot', async () => {
  const { projectTrackPoint, scrollWorldUnit, TRACK_DEPTH, TRACK_REFERENCE } = await import('../src/renderer/player-scene');
  const left = projectTrackPoint(0, 0), right = projectTrackPoint(16, 0);
  assert.equal(left.x, 374.4); assert.equal(right.x, 1542.4);
  assert.equal(left.y, 998.4); assert.equal(right.y, 998.4);
  // Official 600×338 screenshot: interior quarter-lane x≈254.5 at y=140.
  const y = 140 * 3.2;
  const scale = (y - TRACK_REFERENCE.horizonY) / (TRACK_REFERENCE.judgeY - TRACK_REFERENCE.horizonY);
  const distance = (1 / scale - 1) * TRACK_DEPTH / scrollWorldUnit(6);
  const quarter = projectTrackPoint(4, distance);
  assert.ok(Math.abs(quarter.x / 3.2 - 254.5) < 1);
  assert.ok(Math.abs(quarter.y - y) < 1e-8);
});

test('track speed and FIELD WALL follow the game\'s play option tables', async () => {
  const { NOTE_SPEEDS, FIELD_WALL_HALF_WIDTH, FIELD_WALL_HEIGHT, nativeNoteSpeed, scrollWorldUnit, fieldWallDistance, scrollDistanceAt, projectTrackPoint, FIELD_WALL_Z, FIELD_FAR_Z, TRACK_REFERENCE } = await import('../src/renderer/player-scene');
  // PlayOptionSpeedTableRecord.bin: 1.00 to 15.00 by 0.25 at 0.8 × the label, then 16 to 19; its last row, SONIC, is not offered.
  assert.equal(NOTE_SPEEDS.length, 61);
  assert.deepEqual([NOTE_SPEEDS[0], NOTE_SPEEDS[1], NOTE_SPEEDS[20], NOTE_SPEEDS[56], NOTE_SPEEDS[57], NOTE_SPEEDS[60]], [1, 1.25, 6, 15, 16, 19]);
  const rounded = (speed: number) => Number(nativeNoteSpeed(speed).toFixed(9));
  assert.deepEqual([1, 1.25, 6, 10, 15, 16, 17, 18, 19].map(rounded), [.8, 1, 4.8, 8, 12, 14, 16, 18, 20]);
  // The note code at 0xb414f0 moves a note 1.5 × the table value every frame of 1/60 s.
  assert.ok(Math.abs(scrollWorldUnit(10) - 720) < 1e-9);
  // PlayOptionFieldWallPositionTableRecord.bin; the judgement line is at -65.
  assert.equal(FIELD_WALL_Z.length, 17);
  // The wall quad built at 0xd66560 spans the track and both side bands: 16 lanes of 4 units and 4 more on each side.
  assert.deepEqual([FIELD_WALL_HALF_WIDTH, FIELD_WALL_HEIGHT], [36, 54]);
  assert.ok(Math.abs(projectTrackPoint(17, fieldWallDistance(6, 8), 6).x - projectTrackPoint(8 + FIELD_WALL_HALF_WIDTH / 4, fieldWallDistance(6, 8), 6).x) < 1e-9);
  assert.deepEqual([FIELD_WALL_Z[0], FIELD_WALL_Z[1], FIELD_WALL_Z[11], FIELD_WALL_Z[12], FIELD_WALL_Z[15], FIELD_WALL_Z[16]], [-460, -437, -207, -179.4, -64.4, -55.2]);
  assert.ok(Math.abs(fieldWallDistance(10, 0) - 395 / 720) < 1e-12);
  assert.ok(Math.abs(fieldWallDistance(10, 8) - 211 / 720) < 1e-12);
  assert.ok(fieldWallDistance(10, 15) < 0 && fieldWallDistance(10, 16) < fieldWallDistance(10, 15));
  // Twice the speed halves the time a note is in view and leaves the wall where it stands on the screen.
  assert.ok(Math.abs(fieldWallDistance(5, 4) - 2 * fieldWallDistance(10, 4)) < 1e-12);
  assert.ok(Math.abs(projectTrackPoint(0, fieldWallDistance(5, 4), 5).y - projectTrackPoint(0, fieldWallDistance(10, 4), 10).y) < 1e-9);
  // Without a wall the far limit lies under the HUD, just short of the end of the track mesh.
  assert.ok(projectTrackPoint(0, fieldWallDistance(6, 0), 6).y < TRACK_REFERENCE.topY);
  assert.ok(scrollDistanceAt(FIELD_FAR_Z, 6) > fieldWallDistance(6, 0));
  assert.ok(projectTrackPoint(0, fieldWallDistance(6, 1), 6).y > TRACK_REFERENCE.topY, 'the first wall step shows below the HUD');
});
