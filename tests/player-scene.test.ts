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
  const { projectTrackPoint, TRACK_REFERENCE } = await import('../src/renderer/player-scene');
  const left = projectTrackPoint(0, 0), right = projectTrackPoint(16, 0);
  assert.equal(left.x, 374.4); assert.equal(right.x, 1542.4);
  assert.equal(left.y, 998.4); assert.equal(right.y, 998.4);
  // Official 600×338 screenshot: interior quarter-lane x≈254.5 at y=140.
  const y = 140 * 3.2;
  const scale = (y - TRACK_REFERENCE.horizonY) / (TRACK_REFERENCE.judgeY - TRACK_REFERENCE.horizonY);
  const distance = (1 / scale - 1) / 1.8;
  const quarter = projectTrackPoint(4, distance);
  assert.ok(Math.abs(quarter.x / 3.2 - 254.5) < 1);
  assert.ok(Math.abs(quarter.y - y) < 1e-8);
});
