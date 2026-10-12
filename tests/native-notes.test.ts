import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNote } from '../src/core/model';
import { getNativeHeadModel, nativeAirBaseHeight, nativeScrollWorldUnit, AIR_HEIGHT_STEP, projectNativeNotePoint, projectNativeScrollPoint } from '../src/renderer/native-notes';
import { projectTrackPoint } from '../src/renderer/player-scene';

test('every standard note family and AIR direction selects an actual copied model, across all 16 widths', async () => {
  const { textures } = JSON.parse(await readFile(new URL('../assets/game/manifest.json', import.meta.url), 'utf8'));
  for (const type of ['TAP', 'EXTAP', 'HOLD', 'SLIDE', 'FLICK', 'DAMAGE', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH'] as const) {
    for (let width = 1; width <= 16; width++) {
      const model = getNativeHeadModel(createNote(type, 0, 0, width))!;
      assert.ok(textures.models[model.key].meshes.length > 0, `${type} width ${width}`);
    }
  }
  for (const direction of ['IR', 'UL', 'UR', 'DW', 'DL', 'DR']) for (let width = 1; width <= 16; width++) {
    const note = createNote('AIR', 0, 0, width); note.attributes.direction = direction;
    const model = getNativeHeadModel(note)!;
    assert.ok(textures.models[model.key].meshes.length >= 2);
    assert.equal(model.mirror, ['UL', 'DL'].includes(direction) ? -1 : 1);
  }
  for (const type of ['HOLD', 'SLIDE'] as const) for (let width = 1; width <= 16; width++) {
    const model = getNativeHeadModel(createNote(type, 0, 0, width), width, true)!;
    assert.ok(model.key.endsWith('_point')); assert.ok(textures.models[model.key].meshes.length > 0);
  }
});

test('normal AIR adds no invented elevation, while original source geometry retains height and depth', () => {
  assert.equal(nativeAirBaseHeight(1), 0); assert.equal(nativeAirBaseHeight(2), AIR_HEIGHT_STEP);
  const base = projectTrackPoint(8, .5), origin = projectNativeNotePoint(8, .5, [0, 0, 0]);
  assert.ok(Math.abs(base.x - origin.x) < 1e-10 && Math.abs(base.y - origin.y) < 1e-10);
  assert.ok(projectNativeNotePoint(8, .5, [0, 15.574, 0]).y < origin.y);
  const left = projectNativeNotePoint(8, .5, [-5.5, 15, -5]), right = projectNativeNotePoint(8, .5, [5.5, 15, -5]);
  assert.ok(Math.abs(left.x + right.x - 2 * base.x) < 1e-9);
  assert.notEqual(projectNativeNotePoint(8, .5, [5.5, 15, 0]).x, right.x);
});

test('a held AIR HOLD line leaves the bottom of the screen at every height and speed', () => {
  for (const speed of [1, 6, 12]) for (const height of [1, 5, 9]) {
    const y = nativeAirBaseHeight(height) + 15.574, near = -110 / nativeScrollWorldUnit(speed);
    assert.ok(projectNativeScrollPoint(8, near, [0, y, 0], speed).y > 1080, `speed ${speed} height ${height}`);
    // The old anchor-only projection stalled at the track's near clamp, in the middle of the screen for high lines.
    if (height === 9) assert.ok(projectNativeNotePoint(8, near, [0, y, 0], speed).y < 1080);
    const at = projectNativeScrollPoint(8, 0, [0, y, 0], speed), behind = projectNativeScrollPoint(8, -1e-6, [0, y, 0], speed);
    assert.ok(Math.abs(at.y - behind.y) < .01 && Math.abs(at.x - behind.x) < .01);
  }
});

test('the scroll projection joins the track anchor at the judgement line and keeps moving behind it', () => {
  const anchor = projectTrackPoint(3, 0), joined = projectNativeScrollPoint(3, 0, [0, 0, 0]);
  assert.ok(Math.abs(anchor.x - joined.x) < 1e-6 && Math.abs(anchor.y - joined.y) < 1e-6 && Math.abs(anchor.scale - joined.scale!) < 1e-9);
  const near = -110 / nativeScrollWorldUnit(6), ground = projectNativeScrollPoint(3, near, [0, 0, 0]);
  // Canvas 2D fallback: AIR height .8 in the track's own units still leaves the screen.
  assert.ok(ground.y - .8 * 1080 * .15 * ground.scale! > 1080);
  assert.equal(projectTrackPoint(3, near).y, projectTrackPoint(3, -.3).y);
});
