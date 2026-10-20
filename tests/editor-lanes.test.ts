import test from 'node:test';
import assert from 'node:assert/strict';
import { LANE_DIVISIONS, laneLine } from '../src/renderer/editor-view';

test('the lane division draws a line every 1, 2, 4, 8 or 16 lanes, and always the two track edges', () => {
  assert.deepEqual(LANE_DIVISIONS, [1, 2, 4, 8, 16]);
  const lines = (division: number) =>
    Array.from({ length: 17 }, (_, lane) => lane).filter(lane => laneLine(lane, division) !== undefined);
  assert.deepEqual(
    lines(1),
    Array.from({ length: 17 }, (_, lane) => lane),
  );
  assert.deepEqual(lines(2), [0, 2, 4, 6, 8, 10, 12, 14, 16]);
  assert.deepEqual(lines(4), [0, 4, 8, 12, 16]);
  assert.deepEqual(lines(8), [0, 8, 16]);
  assert.deepEqual(lines(16), [0, 16]);
  // Every fourth line stays brighter, as with one line per lane.
  assert.deepEqual(
    [0, 1, 2, 4, 16].map(lane => laneLine(lane, 1)),
    ['edge', 'minor', 'minor', 'major', 'edge'],
  );
  assert.equal(laneLine(4, 4), 'major');
  // Lanes outside the track (WORLD’S END visuals) follow the same spacing.
  assert.equal(laneLine(-4, 4), 'major');
  assert.equal(laneLine(-2, 4), undefined);
  assert.equal(laneLine(20, 8), undefined);
  assert.equal(laneLine(24, 8), 'major');
});
