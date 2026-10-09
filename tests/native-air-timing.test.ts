import test from 'node:test';
import assert from 'node:assert/strict';
import { parseC2S } from '../src/core/c2s';
import { getNativeAirSlideUvSpans, nativeAirSlideVAtTick } from '../src/renderer/native-air-timing';

const chartOf = (...rows: string[]) => parseC2S(['VERSION 1.15.00 1.15.00', 'RESOLUTION 384',
  'BPM_DEF 120 120 120 120', ...rows].join('\n'));

test('multiple ASC controls share one ordinary endpoint span and ASD resets the next span', () => {
  const chart = chartOf('TAP 0 0 0 2', 'ASC 0 0 0 2 TAP 5 48 2 2 6 DEF',
    'ASC 0 48 2 2 ASC 6 48 4 2 7 DEF', 'ASD 0 96 4 2 ASC 7 96 6 2 5 DEF',
    'ASD 0 192 6 2 ASD 5 96 6 2 5 DEF');
  const [, a, b, c, d] = chart.notes, spans = getNativeAirSlideUvSpans(chart);
  assert.strictEqual(spans.get(a.id), spans.get(b.id)); assert.strictEqual(spans.get(a.id), spans.get(c.id));
  assert.equal(spans.get(a.id)!.startTick, 0); assert.equal(spans.get(a.id)!.endTick, 192);
  assert.equal(nativeAirSlideVAtTick(chart, spans.get(b.id)!, 48), .75);
  assert.equal(nativeAirSlideVAtTick(chart, spans.get(c.id)!, 96), .5);
  assert.equal(nativeAirSlideVAtTick(chart, spans.get(c.id)!, 192), 0);
  assert.equal(spans.get(d.id)!.startTick, 192); assert.equal(spans.get(d.id)!.endTick, 288);
  assert.equal(spans.get(d.id)!.rootCenterLane, 1);
});

test('AS UV phase uses musical seconds across BPM changes and ignores scroll distance', () => {
  const chart = chartOf('TAP 0 0 0 2', 'ASC 0 0 0 2 TAP 5 96 2 2 5 DEF',
    'BPM 0 96 240', 'SFL 0 0 192 -2', 'ASD 0 96 2 2 ASC 5 96 4 2 5 DEF');
  const first = chart.notes[1], span = getNativeAirSlideUvSpans(chart).get(first.id)!;
  assert.equal(span.startSeconds, 0); assert.equal(span.endSeconds, .75);
  assert.ok(Math.abs(nativeAirSlideVAtTick(chart, span, 96) - 1 / 3) < 1e-12);
  const stopped = { ...chart, events: chart.events.map(event => event.type === 'SCROLL' ? { ...event, value: 0 } : event) };
  const stoppedSpan = getNativeAirSlideUvSpans(stopped).get(first.id)!;
  assert.equal(nativeAirSlideVAtTick(stopped, stoppedSpan, 144), nativeAirSlideVAtTick(chart, span, 144));
});

test('native record order and ground-root priority select the current ASC tail, without a color-key split', () => {
  const chart = chartOf('TAP 0 0 0 2', 'TAP 0 0 4 2',
    'ASC 0 0 4 2 TAP 5 96 8 2 5 DEF', 'ASC 0 0 0 2 TAP 5 96 8 2 5 DEF',
    'ASD 0 96 8 2 ASC 5 96 8 2 5 PNK');
  const spans = getNativeAirSlideUvSpans(chart), [, , earlierAir, earlierGround, child] = chart.notes;
  assert.equal(spans.get(child.id)!.rootId, earlierGround.id);
  assert.equal(spans.get(earlierAir.id)!.endTick, 96);
  assert.equal(spans.get(earlierGround.id)!.endTick, 192);
  const wrongParent = { ...chart, notes: chart.notes.map(note => note === child ? { ...note, attributes: { ...note.attributes, parent: 'ASD' } } : note) };
  assert.equal(getNativeAirSlideUvSpans(wrongParent).get(child.id)!.rootId, child.id);
});

test('zero-duration controls remain finite, terminal ASC resolves, immutable changes invalidate the cache', () => {
  const chart = chartOf('TAP 0 0 0 2', 'ASC 0 0 0 2 TAP 5 0 0 2 5 DEF',
    'ASC 0 0 0 2 ASC 5 96 0 2 5 DEF');
  const spans = getNativeAirSlideUvSpans(chart), first = chart.notes[1];
  assert.strictEqual(spans, getNativeAirSlideUvSpans(chart));
  assert.equal(spans.get(first.id)!.endTick, 96);
  assert.equal(nativeAirSlideVAtTick(chart, spans.get(first.id)!, 0), 1);
  const updated = { ...chart, defaultBpm: 240 };
  assert.notStrictEqual(spans, getNativeAirSlideUvSpans(updated));
  assert.equal(getNativeAirSlideUvSpans(updated).get(first.id)!.endSeconds, .25);
  const zero = chartOf('ASD 0 0 0 2 TAP 5 0 0 2 5 DEF');
  assert.equal(nativeAirSlideVAtTick(zero, getNativeAirSlideUvSpans(zero).get(zero.notes[0].id)!, 0), 1);
});
