import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBACK_RATES, clampPlaybackRate, stepPlaybackRate } from '../src/renderer/playback-rate';

test('the preset rates are the toolbar list in ascending order', () => {
  assert.deepEqual(PLAYBACK_RATES, [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
});

test('stepping moves to the nearest preset strictly above or below, from presets and from custom values alike', () => {
  assert.equal(stepPlaybackRate(1, 1), 1.25);
  assert.equal(stepPlaybackRate(1, -1), 0.75);
  assert.equal(stepPlaybackRate(0.63, 1), 0.75);
  assert.equal(stepPlaybackRate(0.63, -1), 0.5);
  assert.equal(stepPlaybackRate(0.1, -1), 0.1);
  assert.equal(stepPlaybackRate(2, 1), 2);
  assert.equal(stepPlaybackRate(0.05, -1), 0.05);
  assert.equal(stepPlaybackRate(3, 1), 3);
});

test('custom rates are clamped to the transport range and rounded to two decimals', () => {
  assert.equal(clampPlaybackRate(0.63), 0.63);
  assert.equal(clampPlaybackRate(0.004), 0.1);
  assert.equal(clampPlaybackRate(9), 2);
  assert.equal(clampPlaybackRate(0.6349), 0.63);
  assert.equal(clampPlaybackRate(Number.NaN), 1);
  assert.equal(clampPlaybackRate(Number.NaN, 0.5), 0.5);
});
