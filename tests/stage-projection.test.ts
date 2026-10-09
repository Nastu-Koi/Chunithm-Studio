import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageView, clipStageDepth, stageWorldToAffine } from '../src/renderer/stage-projection';
import { transformStagePoint } from '../src/core/stage-animation';

test('AFNC column-major world matrices retain rotation and translation in the skinning renderer', () => {
  const native = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 2, 3, -10, 1];
  assert.deepEqual(transformStagePoint(stageWorldToAffine(native), [4, 5, 6]), [-3, 7, -4]);
  assert.throws(() => stageWorldToAffine([1, 2]));
});

test('scene camera projects symmetry and depth without model-dependent screen fitting', () => {
  const view = createStageView({ eye: [0, 0, 0], target: [0, 0, -1], verticalFov: 90, near: 1, far: 100 }, 200, 100);
  assert.deepEqual(view.project(view.toView([0, 0, -5])), { x: 100, y: 50 });
  const left = view.project(view.toView([-1, 0, -1])), right = view.project(view.toView([1, 0, -1]));
  assert.ok(Math.abs(left.x - 50) < 1e-10 && Math.abs(right.x - 150) < 1e-10);
  assert.ok(Math.abs(view.project(view.toView([1, 0, -2])).x - 125) < 1e-10);
});

test('camera-plane crossing is clipped before projection and fully hidden polygons are removed', () => {
  const cut = clipStageDepth([[-1, 0, -1], [1, 0, 3], [0, 1, 3]], 1, 10);
  assert.equal(cut.length, 4); assert.ok(cut.every(p => p[2] >= 1 && p.every(Number.isFinite)));
  assert.deepEqual(clipStageDepth([[0, 0, -5], [1, 0, -2], [0, 1, 0]], 1, 10), []);
  assert.deepEqual(clipStageDepth([[0, 0, 15], [1, 0, 20], [0, 1, 30]], 1, 10), []);
});
