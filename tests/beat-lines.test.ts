import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, makeId } from '../src/core/model';
import { getBeatLines } from '../src/core/timing';

test('beat lines follow the meter: one per denominator, downbeat at each measure start', () => {
  const chart = createChart(120);
  assert.deepEqual(getBeatLines(chart, 0, 384), [0, 96, 192, 288].map(tick => ({ tick, downbeat: tick === 0 })));
  // The range is half-open and may start inside a measure.
  assert.deepEqual(getBeatLines(chart, 97, 480).map(line => [line.tick, line.downbeat]), [[192, false], [288, false], [384, true]]);
  assert.deepEqual(getBeatLines(chart, 96, 96), []);
  // 6/8 from the second measure: eighth-note beats, six per measure.
  const compound = { ...createChart(120), events: [{ id: makeId('event'), type: 'METER' as const, tick: 384, value: 0, numerator: 6, denominator: 8 }] };
  const lines = getBeatLines(compound, 288, 384 + 288 + 48);
  assert.deepEqual(lines.map(line => line.tick), [288, 384, 432, 480, 528, 576, 624, 672]);
  assert.deepEqual(lines.filter(line => line.downbeat).map(line => line.tick), [384, 672]);
});
