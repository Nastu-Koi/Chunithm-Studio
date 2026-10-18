import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, type Chart } from '../src/core/model';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { getNotePlaybackPoints } from '../src/core/timing';
import { setEditorAirHeight } from '../src/core/editing';
import { AIR_HIDDEN_HEIGHT, airHeightMaximum, airHeightVisibility } from '../src/renderer/editor-view';

function connectedSlides(): Chart {
  const first = { ...createNote('AIR_SLIDE', 96, 2, 3), id: 'first', duration: 96, height: 1, endHeight: 2 };
  first.attributes = { ...first.attributes, visible: false, parent: 'TAP', color: 'DEF' };
  const second = { ...createNote('AIR_SLIDE', 192, 2, 3), id: 'second', duration: 96, height: 2, endHeight: 3 };
  second.attributes = { ...second.attributes, visible: true, parent: 'ASC', color: 'DEF' };
  return { ...createChart(), notes: [first, second] };
}

test('AIR height dragging updates both sides of the connected joint without changing node type or timing', () => {
  const chart = connectedSlides(),
    before = JSON.stringify(chart);
  const points = chart.notes.map(note => getNotePlaybackPoints(chart, note));
  const edited = setEditorAirHeight(chart, 'first', 'endHeight', 2.4);
  assert.equal(edited.notes[0].endHeight, 2.4);
  assert.equal(edited.notes[1].height, 2.4);
  assert.equal(edited.notes[0].height, 1);
  assert.equal(edited.notes[1].endHeight, 3);
  assert.equal(edited.notes[0].attributes.visible, false);
  assert.equal(edited.notes[1].attributes.parent, 'ASC');
  assert.deepEqual(
    edited.notes.map(note => getNotePlaybackPoints(edited, note)),
    points,
  );
  assert.equal(JSON.stringify(chart), before);
  const restored = parseC2S(serializeC2S(edited));
  assert.equal(restored.notes[0].endHeight, 2.4);
  assert.equal(restored.notes[1].height, 2.4);
  assert.equal(restored.notes[0].attributes.visible, false);
});

test('dragging a starting height aligns the previous endpoint but leaves separate chains alone', () => {
  const chart = connectedSlides();
  chart.notes.push({ ...chart.notes[0], id: 'red', attributes: { ...chart.notes[0].attributes, color: 'RED' } });
  chart.notes.push({ ...chart.notes[0], id: 'normal', attributes: { ...chart.notes[0].attributes, visible: true } });
  const edited = setEditorAirHeight(chart, 'second', 'height', 4.1);
  assert.equal(edited.notes[0].endHeight, 4.1);
  assert.equal(edited.notes[1].height, 4.1);
  assert.equal(edited.notes[2].endHeight, 2);
  assert.equal(edited.notes[3].endHeight, 2);
});

test('moving an AIR start with an implicit ending height preserves that ending', () => {
  const chart = connectedSlides();
  delete chart.notes[0].endHeight;
  const edited = setEditorAirHeight(chart, 'first', 'height', 3);
  assert.equal(edited.notes[0].height, 3);
  assert.equal(edited.notes[0].endHeight, 1);
  assert.equal(edited.notes[1].height, 2);
  delete chart.notes[1].endHeight;
  chart.notes[0].endHeight = 2;
  const joined = setEditorAirHeight(chart, 'first', 'endHeight', 4);
  assert.equal(joined.notes[1].height, 4);
  assert.equal(joined.notes[1].endHeight, 2);
});

test('AIR CRUSH connected height editing retains interval and accepts heights beyond the initial view range', () => {
  const first = { ...createNote('AIR_CRUSH', 0, 0, 4), id: 'first', duration: 96, height: 1, endHeight: 2 };
  const second = { ...createNote('AIR_CRUSH', 96, 0, 4), id: 'second', duration: 96, height: 2, endHeight: 4 };
  first.attributes.interval = 12;
  const chart = { ...createChart(), notes: [first, second] };
  const edited = setEditorAirHeight(chart, 'first', 'endHeight', 8);
  assert.equal(edited.notes[0].endHeight, 8);
  assert.equal(edited.notes[1].height, 8);
  assert.equal(edited.notes[0].attributes.interval, 12);
  assert.equal(edited.notes[1].endHeight, 4);
});

test('unsupported notes and invalid AIR height edits leave the chart untouched', () => {
  const chart = connectedSlides();
  chart.notes.push({ ...createNote('AIR_HOLD', 0), id: 'hold' });
  assert.equal(setEditorAirHeight(chart, 'missing', 'height', 1), chart);
  assert.equal(setEditorAirHeight(chart, 'hold', 'height', 1), chart);
  for (const height of [NaN, Infinity, -1]) assert.equal(setEditorAirHeight(chart, 'first', 'height', height), chart);
});

test('the editor fades AIR by height the way the game camera loses it: full to 5, gone at 15, never negative', () => {
  assert.equal(airHeightVisibility(1), 1);
  assert.equal(airHeightVisibility(5), 1);
  assert.equal(airHeightVisibility(10), 0.5);
  assert.equal(airHeightVisibility(15), 0);
  assert.equal(airHeightVisibility(99), 0);
  assert.equal(AIR_HIDDEN_HEIGHT, 15);
});

test('the AIR-height column reaches the visible limit once any AIR rises above the normal plane', () => {
  const chart = createChart();
  assert.equal(airHeightMaximum(chart), 5);
  chart.notes = [{ ...createNote('AIR_SLIDE', 0, 0, 4), duration: 96, height: 5, endHeight: 5 }];
  assert.equal(airHeightMaximum(chart), 5);
  chart.notes = [{ ...createNote('AIR_SLIDE', 0, 0, 4), duration: 96, height: 5, endHeight: 6.2 }];
  assert.equal(airHeightMaximum(chart), 15);
  chart.notes = [{ ...createNote('AIR_CRUSH', 0, 0, 4), duration: 96, height: 20, endHeight: 20 }];
  assert.equal(airHeightMaximum(chart), 20);
});
