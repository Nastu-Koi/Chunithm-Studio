import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, type Chart, type ChartEvent, type Note } from '../src/core/model';
import {
  attachEditorAir,
  copyEditorSelection,
  editEditorEventProperty,
  editEditorNoteProperty,
  editorLaneBase,
  pasteEditorClipboard,
  type PropertyEdit,
} from '../src/core/editing';

const chartOf = (notes: Note[], events: ChartEvent[] = []): Chart => ({ ...createChart(), notes, events });
const applied = (edit: PropertyEdit): Chart => {
  assert.ok(edit && 'chart' in edit, `expected an applied edit, got ${JSON.stringify(edit)}`);
  return edit.chart;
};
const event = (type: ChartEvent['type'], extra: Partial<ChartEvent> = {}): ChartEvent => ({
  id: `event-${type}`,
  type,
  tick: 0,
  value: 1,
  ...extra,
});

test('note fields: lanes are shown from 1, fractions are whole notes, invalid numbers are ignored', () => {
  const tap = createNote('TAP', 0, 4, 2);
  const chart = chartOf([tap]);
  assert.equal(editorLaneBase(chart), 1);
  assert.equal(editorLaneBase({ ...chart, allowOutOfLane: true }), 0);
  assert.equal(applied(editEditorNoteProperty(chart, tap.id, 'lane', '6')).notes[0].lane, 5);
  assert.equal(applied(editEditorNoteProperty(chart, tap.id, 'lane', '99')).notes[0].lane, 14);
  assert.equal(applied(editEditorNoteProperty(chart, tap.id, 'positionFraction', '1/7')).notes[0].tick, 384 / 7);
  assert.equal(applied(editEditorNoteProperty(chart, tap.id, 'tick', '-5')).notes[0].tick, 0);
  assert.deepEqual(editEditorNoteProperty(chart, tap.id, 'positionFraction', 'x'), { rejected: 'fraction' });
  assert.equal(editEditorNoteProperty(chart, tap.id, 'width', 'abc'), undefined);
  assert.equal(editEditorNoteProperty(chart, 'missing', 'lane', '1'), undefined);
});

test('changing the type fills or drops long-note fields; HOLD keeps both ends on one lane', () => {
  const tap = createNote('TAP', 0, 4, 2);
  const slide = applied(editEditorNoteProperty(chartOf([tap]), tap.id, 'type', 'AIR_SLIDE')).notes[0];
  assert.deepEqual([slide.duration, slide.endLane, slide.endWidth, slide.height, slide.endHeight], [96, 4, 2, 1, 1]);
  const back = applied(editEditorNoteProperty(chartOf([slide]), slide.id, 'type', 'TAP')).notes[0];
  assert.deepEqual([back.duration, back.endLane, back.endWidth], [undefined, undefined, undefined]);
  const hold = { ...createNote('HOLD', 0, 4, 2), duration: 96 };
  const moved = applied(editEditorNoteProperty(chartOf([hold]), hold.id, 'lane', '9')).notes[0];
  assert.deepEqual([moved.lane, moved.endLane, moved.endWidth], [8, 8, 2]);
});

test('a node position sets the length of the segment before it; long-end edits are reshapes', () => {
  const slide = { ...createNote('SLIDE', 96, 0, 4), duration: 96, endLane: 0, endWidth: 4 };
  const chart = chartOf([slide]);
  const edit = editEditorNoteProperty(chart, slide.id, 'nodePositionFraction', '1/2');
  assert.ok(edit && 'chart' in edit && edit.reshaped);
  assert.equal(edit.chart.notes[0].duration, 192 - 96);
  assert.equal(applied(editEditorNoteProperty(chart, slide.id, 'nodeTick', '384')).notes[0].duration, 288);
  assert.deepEqual(editEditorNoteProperty(chart, slide.id, 'nodeTick', '-1'), { rejected: 'node-position' });
  assert.equal(applied(editEditorNoteProperty(chart, slide.id, 'endLane', '5')).notes[0].endLane, 4);
});

test('a bound AIR follows its parent and refuses position edits; interval and HOLD EX are attributes', () => {
  const tap = createNote('TAP', 96, 4, 4);
  const chart = attachEditorAir(chartOf([tap]), createNote('AIR', 0, 0, 1), tap.id)!;
  const air = chart.notes.find(note => note.type === 'AIR')!;
  for (const property of ['tick', 'lane', 'width'])
    assert.deepEqual(editEditorNoteProperty(chart, air.id, property, '2'), { rejected: 'bound-air' });
  const crush = { ...createNote('AIR_CRUSH', 0, 0, 4), duration: 96 };
  const interval = applied(editEditorNoteProperty(chartOf([crush]), crush.id, 'attr.interval', '-3')).notes[0];
  assert.equal(interval.attributes.interval, 0);
  const hold = { ...createNote('HOLD', 0, 0, 4), duration: 96 };
  const ex = applied(editEditorNoteProperty(chartOf([hold]), hold.id, 'attr.ex', true)).notes[0];
  assert.equal(ex.attributes.ex, true);
  assert.equal(
    applied(editEditorNoteProperty(chartOf([ex]), hold.id, 'attr.ex', false)).notes[0].attributes.ex,
    undefined,
  );
});

test('event fields: BPM floor, NOTE_SPEED cannot be 0, meter value and assignment group follow their fields', () => {
  const bpm = event('BPM', { value: 120 });
  assert.equal(applied(editEditorEventProperty(chartOf([], [bpm]), bpm.id, 'value', '0')).events[0].value, 1);
  const speed = event('NOTE_SPEED');
  assert.deepEqual(editEditorEventProperty(chartOf([], [speed]), speed.id, 'value', '0'), {
    rejected: 'zero-note-speed',
  });
  const meter = event('METER', { numerator: 4, denominator: 4 });
  const three = applied(editEditorEventProperty(chartOf([], [meter]), meter.id, 'numerator', '3')).events[0];
  assert.equal(three.value, 3 / 4);
  const hidden = applied(editEditorEventProperty(chartOf([], [meter]), meter.id, 'denominator', '0')).events[0];
  assert.equal(hidden.value, 0);
  const assignment = event('SCROLL_ASSIGNMENT', { lane: 0, width: 4, group: 1 });
  const regrouped = applied(editEditorEventProperty(chartOf([], [assignment]), assignment.id, 'group', '2.6'))
    .events[0];
  assert.deepEqual([regrouped.group, regrouped.value], [3, 3]);
  assert.equal(
    applied(editEditorEventProperty(chartOf([], [assignment]), assignment.id, 'lane', '3')).events[0].lane,
    2,
  );
  assert.equal(
    applied(editEditorEventProperty(chartOf([], [bpm]), bpm.id, 'durationFraction', '1/4')).events[0].duration,
    96,
  );
});

test('paste lands the clipboard on the cursor with new ids and no native records, optionally mirrored', () => {
  const tap = {
    ...createNote('TAP', 96, 0, 4),
    native: { recordId: 'r', tag: 'TAP', columns: [], raw: '', original: {} },
  };
  const chart = chartOf([tap]);
  const clipboard = copyEditorSelection(chart, new Set([tap.id]))!;
  const pasted = pasteEditorClipboard(chart, clipboard, 384);
  assert.equal(pasted.chart.notes.length, 2);
  const copy = pasted.chart.notes[1];
  assert.ok(pasted.ids.has(copy.id) && copy.id !== tap.id);
  assert.deepEqual([copy.tick, copy.lane, copy.native], [384, 0, undefined]);
  const mirrored = pasteEditorClipboard(chart, clipboard, 384, true);
  assert.equal(mirrored.chart.notes[1].lane, 12);
  assert.equal(mirrored.chart.notes[0].lane, 0);
});
