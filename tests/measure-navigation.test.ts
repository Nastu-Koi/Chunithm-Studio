import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, type Chart, type ChartEvent } from '../src/core/model';
import {
  getMeasureLines,
  getMeasureStartTick,
  getMeasureNumberAtTick,
  MAX_MEASURE_NUMBER,
  tickToSeconds,
  secondsToTick,
} from '../src/core/timing';

const meter = (tick: number, numerator: number, denominator: number): ChartEvent => ({
  id: `meter-${tick}`,
  type: 'METER',
  tick,
  numerator,
  denominator,
  value: numerator,
});
function atMeter(numerator: number, denominator: number): Chart {
  return { ...createChart(), events: [meter(0, numerator, denominator)] };
}

test('4/4 measure navigation is 1-based and bounded at 200000 visible measures', () => {
  const chart = createChart();
  assert.equal(getMeasureStartTick(chart, 1), 0);
  assert.equal(getMeasureStartTick(chart, 4), 1152);
  assert.equal(getMeasureNumberAtTick(chart, 383.999), 1);
  assert.equal(getMeasureNumberAtTick(chart, 384), 2);
  const last = 384 * (MAX_MEASURE_NUMBER - 1);
  assert.equal(getMeasureStartTick(chart, 200000), last);
  assert.equal(getMeasureNumberAtTick(chart, last + 383), 200000);
  assert.equal(getMeasureNumberAtTick(chart, last + 384), null);
  assert.deepEqual(getMeasureLines(chart, last, last + 384), [
    { tick: last, measure: 199999, numerator: 4, denominator: 4 },
  ]);
});

test('3/4 and 7/8 count their actual measure spans rather than fixed native clock bars', () => {
  for (const [numerator, denominator, span] of [
    [3, 4, 288],
    [7, 8, 336],
  ]) {
    const chart = atMeter(numerator, denominator);
    assert.deepEqual(
      [1, 2, 3, 4].map(number => getMeasureStartTick(chart, number)),
      [0, span, span * 2, span * 3],
    );
    assert.equal(getMeasureNumberAtTick(chart, span * 2 - 0.01), 2);
    assert.equal(getMeasureNumberAtTick(chart, span * 2), 3);
    assert.deepEqual(
      getMeasureLines(chart, 0, span * 3).map(line => [line.tick, line.measure + 1]),
      [
        [0, 1],
        [span, 2],
        [span * 2, 3],
        [span * 3, 4],
      ],
    );
  }
});

test('segmented BPM affects seconds but never changes measure numbering', () => {
  const plain = atMeter(7, 8);
  const changing = {
    ...plain,
    events: [
      ...plain.events,
      { id: 'bpm1', type: 'BPM' as const, tick: 96, value: 150 },
      { id: 'bpm2', type: 'BPM' as const, tick: 500, value: 90 },
    ],
  };
  assert.notEqual(tickToSeconds(changing, 672), tickToSeconds(plain, 672));
  for (const tick of [0, 95, 96, 335, 336, 500, 672, 900])
    assert.equal(getMeasureNumberAtTick(changing, tick), getMeasureNumberAtTick(plain, tick));
  assert.deepEqual(getMeasureLines(changing, 0, 1000), getMeasureLines(plain, 0, 1000));
});

test('a mid-measure meter change truncates the old measure and starts the next number immediately', () => {
  const chart = { ...createChart(), events: [meter(500, 3, 4), meter(1100, 7, 8)] };
  const expected = [
    [0, 1],
    [384, 2],
    [500, 3],
    [788, 4],
    [1076, 5],
    [1100, 6],
    [1436, 7],
  ];
  assert.deepEqual(
    getMeasureLines(chart, 0, 1436).map(line => [line.tick, line.measure + 1]),
    expected,
  );
  for (const [tick, number] of expected) {
    assert.equal(getMeasureStartTick(chart, number), tick);
    assert.equal(getMeasureNumberAtTick(chart, tick), number);
    if (tick) assert.equal(getMeasureNumberAtTick(chart, tick - 0.01), number - 1);
  }
});

test('MET zero hides numbers, preserves the next visible number, and can recover on a fractional tick', () => {
  const chart = {
    ...createChart(),
    events: [meter(500, 0, 4), meter(800.5, 3, 4), meter(1100, 4, 0), meter(1500, 7, 8)],
  };
  const expected = [
    [0, 1],
    [384, 2],
    [800.5, 3],
    [1088.5, 4],
    [1500, 5],
    [1836, 6],
  ];
  assert.deepEqual(
    getMeasureLines(chart, 0, 1836).map(line => [line.tick, line.measure + 1]),
    expected,
  );
  for (const tick of [500, 600, 800.49, 1100, 1499]) assert.equal(getMeasureNumberAtTick(chart, tick), null);
  for (const [tick, number] of expected) assert.equal(getMeasureStartTick(chart, number), tick);
  assert.equal(getMeasureNumberAtTick(chart, 800.5), 3);
  assert.equal(getMeasureNumberAtTick(chart, 1500), 5);
  const last = getMeasureStartTick(chart, MAX_MEASURE_NUMBER)!;
  assert.equal(
    getMeasureNumberAtTick(chart, last),
    MAX_MEASURE_NUMBER,
    'Hidden intervals do not reduce the supported measure count.',
  );
});

test('initial or permanent hidden meter never invents 4/4 measures', () => {
  const hidden = atMeter(0, 4);
  assert.equal(getMeasureStartTick(hidden, 1), null);
  assert.equal(getMeasureNumberAtTick(hidden, 0), null);
  assert.deepEqual(getMeasureLines(hidden, 0, 10000), []);
  const resumed = { ...hidden, events: [...hidden.events, meter(500, 3, 4)] };
  assert.equal(getMeasureStartTick(resumed, 1), 500);
  assert.equal(getMeasureNumberAtTick(resumed, 499), null);
  assert.equal(getMeasureNumberAtTick(resumed, 500), 1);
  const stopped = { ...createChart(), events: [meter(384, 0, 4)] };
  assert.equal(getMeasureStartTick(stopped, 1), 0);
  assert.equal(getMeasureStartTick(stopped, 2), null);
});

test('same-tick meter changes use the last event and immutable edits invalidate the cached index', () => {
  const original = createChart();
  assert.equal(getMeasureStartTick(original, 2), 384);
  const changed = { ...original, events: [meter(0, 3, 4), meter(0, 7, 8)] };
  assert.equal(getMeasureStartTick(changed, 2), 336);
  assert.equal(getMeasureStartTick(original, 2), 384);
  assert.equal(getMeasureNumberAtTick(changed, 336), 2);
});

test('fractional spans round-trip at exact boundaries without classifying nearby earlier ticks as the next measure', () => {
  const chart = atMeter(1, 7);
  for (const number of [2, 4, 7, 15, 1000, 100000, MAX_MEASURE_NUMBER]) {
    const tick = getMeasureStartTick(chart, number)!;
    assert.equal(getMeasureNumberAtTick(chart, tick), number);
    assert.equal(getMeasureNumberAtTick(chart, tick - 0.000001), number - 1);
    assert.equal(getMeasureLines(chart, tick, tick)[0]?.measure, number - 1);
  }
});

test('measure boundaries survive the audio-clock seconds round-trip at 150 and 137 BPM', () => {
  for (const [bpm, number] of [
    [150, 8],
    [150, 15],
    [137, 12],
    [137, 14],
  ]) {
    const chart = createChart(bpm),
      tick = getMeasureStartTick(chart, number)!;
    const fromAudio = secondsToTick(chart, tickToSeconds(chart, tick));
    assert.equal(getMeasureNumberAtTick(chart, fromAudio), number);
    assert.equal(
      getMeasureNumberAtTick(chart, tick - 0.000001),
      number - 1,
      'A real earlier tick must stay in its previous measure.',
    );
  }
  const chart = {
    ...createChart(),
    events: [{ id: 'tempo', type: 'BPM' as const, tick: 500, value: 150 }, meter(700, 7, 8)],
  };
  const tick = getMeasureStartTick(chart, 9)!;
  assert.equal(tick, 2716);
  assert.equal(getMeasureNumberAtTick(chart, secondsToTick(chart, tickToSeconds(chart, tick))), 9);
  assert.equal(getMeasureNumberAtTick(chart, tick - 0.000001), 8);
});

test('audio-clock rounding at hidden MET boundaries preserves hide and resume semantics', () => {
  const chart = { ...createChart(150), events: [meter(2688, 0, 4), meter(5376, 3, 4)] };
  const roundTrip = (tick: number): number => secondsToTick(chart, tickToSeconds(chart, tick));
  assert.equal(getMeasureNumberAtTick(chart, roundTrip(2688)), null);
  assert.equal(getMeasureNumberAtTick(chart, 2688 - 0.000001), 7);
  assert.equal(getMeasureStartTick(chart, 8), 5376);
  assert.equal(getMeasureNumberAtTick(chart, roundTrip(5376)), 8);
  assert.equal(getMeasureNumberAtTick(chart, 5376 - 0.000001), null);
});

test('invalid input has a null result instead of a guessed measure', () => {
  const chart = createChart();
  for (const number of [0, -1, 1.5, NaN, Infinity, MAX_MEASURE_NUMBER + 1])
    assert.equal(getMeasureStartTick(chart, number), null);
  for (const tick of [-1, NaN, Infinity, -Infinity]) assert.equal(getMeasureNumberAtTick(chart, tick), null);
  assert.equal(getMeasureStartTick({ ...chart, resolution: 0 }, 1), null);
  assert.equal(getMeasureNumberAtTick({ ...chart, resolution: NaN }, 0), null);
});
