import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote } from '../src/core/model';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { mirrorEditorSelection, moveEditorSelection, parseEditorFraction, splitEditorNote, appendEditorNote, copyEditorSelection, flipEditorSelection, scaleEditorSelection, curveEditorSlide } from '../src/renderer/editor';
import { getNoteScrollGroup } from '../src/core/timing';

test('moving a mixed selection clamps the whole group without changing spacing or source records', () => {
  const chart = createChart();
  const left = createNote('SLIDE', 24, 1, 2);
  left.endLane = 4;
  const right = createNote('TAP', 72, 13, 2);
  chart.notes = [left, right];
  chart.events = [{ id: 'tempo', type: 'BPM', tick: 12, value: 150 }];
  const snapshot = JSON.stringify(chart);
  const result = moveEditorSelection(chart, new Set([left.id, right.id, 'tempo']), -96, 8);
  assert.equal(result.notes[0].tick, 12);
  assert.equal(result.notes[1].tick, 60);
  assert.equal(result.events[0].tick, 0);
  assert.equal(result.notes[0].lane, 2);
  assert.equal(result.notes[0].endLane, 5);
  assert.equal(result.notes[1].lane, 14);
  assert.equal(JSON.stringify(chart), snapshot);
  assert.notEqual(result, chart);
});

test('mirroring preserves variable-width slide geometry and reflects directional AIR', () => {
  const chart = createChart();
  const slide = createNote('AIR_SLIDE', 96, 1, 3);
  slide.endLane = 7; slide.endWidth = 4;
  const air = createNote('AIR', 96, 1, 3);
  air.attributes.direction = 'UL';
  chart.notes = [slide, air];
  const ids = new Set(chart.notes.map(note => note.id));
  const mirrored = mirrorEditorSelection(chart, ids);
  assert.equal(mirrored.notes[0].lane, 12);
  assert.equal(mirrored.notes[0].endLane, 5);
  assert.equal(mirrored.notes[1].attributes.direction, 'UR');
  assert.deepEqual(mirrorEditorSelection(mirrored, ids), chart);
});

test('inserted AIR SLIDE node produces two contiguous native segments and preserves outer endpoints', () => {
  const chart = createChart();
  const note = createNote('AIR_SLIDE', 96, 2, 2);
  note.duration = 192; note.endLane = 10; note.endWidth = 4; note.height = 1; note.endHeight = 3;
  note.attributes.parent = 'TAP';
  chart.notes = [note];
  const split = splitEditorNote(chart, note.id, 192);
  assert.equal(split.notes.length, 2);
  const [first, second] = split.notes;
  assert.equal(first.tick + first.duration!, second.tick);
  assert.equal(first.endLane, second.lane);
  assert.equal(first.endWidth, second.width);
  assert.equal(first.endHeight, second.height);
  assert.equal(second.tick + second.duration!, 288);
  assert.equal(second.endLane, 10);
  assert.equal(second.endHeight, 3);
  assert.equal(second.attributes.parent, 'ASD');
  assert.equal(chart.notes.length, 1);
  const restored = parseC2S(serializeC2S(split));
  assert.equal(restored.notes.length, 2);
  assert.equal(restored.notes[1].tick, restored.notes[0].tick + restored.notes[0].duration!);
  assert.equal(restored.notes[1].height, 2);
});

test('inserting a node outside a long note or into a tap leaves the chart untouched', () => {
  const chart = createChart();
  const hold = createNote('HOLD', 96);
  const tap = createNote('TAP', 96);
  chart.notes = [hold, tap];
  assert.equal(splitEditorNote(chart, hold.id, 96), chart);
  assert.equal(splitEditorNote(chart, hold.id, 192), chart);
  assert.equal(splitEditorNote(chart, tap.id, 120), chart);
});

test('WORLD’S END scroll assignments move and mirror with their matched notes', () => {
  const chart = createChart();
  const note = createNote('SLIDE', 96, 2, 3);
  chart.notes = [note];
  chart.events = [{ id: 'assign', type: 'SCROLL_ASSIGNMENT', tick: 96, duration: 96, lane: 2, width: 3, group: 1, value: 1 }];
  // Selecting only the musical note must carry its native scroll assignment.
  const ids = new Set([note.id]);
  const moved = moveEditorSelection(chart, ids, 24, 2);
  assert.equal(moved.events[0].lane, moved.notes[0].lane);
  assert.equal(moved.events[0].tick, moved.notes[0].tick);
  const mirrored = mirrorEditorSelection(moved, ids);
  assert.equal(mirrored.events[0].lane, mirrored.notes[0].lane);
  assert.equal(mirrored.events[0].group, 1);
});

test('seventh-note editing preserves fractional positions and musical duration input', () => {
  const chart = createChart();
  const note = createNote('SLIDE', chart.resolution / 7);
  note.duration = chart.resolution * 3 / 7;
  chart.notes = [note];
  const moved = moveEditorSelection(chart, new Set([note.id]), chart.resolution / 7, 1);
  assert.equal(moved.notes[0].tick, chart.resolution * 2 / 7);
  const split = splitEditorNote(chart, note.id, chart.resolution * 2 / 7);
  assert.ok(Math.abs(split.notes[0].duration! - chart.resolution / 7) < 1e-10);
  assert.ok(Math.abs(split.notes[1].tick + split.notes[1].duration! - chart.resolution * 4 / 7) < 1e-10);
  assert.equal(parseEditorFraction('1 / 7'), 1 / 7);
  assert.equal(parseEditorFraction('3/16'), 3 / 16);
  assert.equal(parseEditorFraction('0.5'), .5);
  assert.equal(parseEditorFraction('1/0'), undefined);
  assert.equal(parseEditorFraction('1+1'), undefined);
});

test('moving one segment keeps the adjacent editable nodes connected', () => {
  const chart = createChart();
  const first = createNote('SLIDE', 48, 0, 2);
  first.duration = 96; first.endLane = 4;
  const second = createNote('SLIDE', 144, 4, 2);
  second.duration = 96; second.endLane = 8;
  chart.notes = [first, second];
  const moved = moveEditorSelection(chart, new Set([first.id]), 24, 1);
  assert.equal(moved.notes[0].tick + moved.notes[0].duration!, moved.notes[1].tick);
  assert.equal(moved.notes[0].endLane, moved.notes[1].lane);
  assert.equal(moved.notes[1].tick + moved.notes[1].duration!, 240);
  assert.equal(second.tick, 144);
});

test('imported offstage visuals retain their geometry during time-only edits', () => {
  const chart = createChart(); chart.allowOutOfLane = true;
  const tap = createNote('TAP', 96, -16, 32);
  const slide = createNote('SLIDE', 192, 31, 20); slide.endLane = -5; slide.endWidth = 40;
  chart.notes = [tap, slide];
  const ids = new Set(chart.notes.map(note => note.id));
  const moved = moveEditorSelection(chart, ids, 384 / 7, 0);
  assert.equal(moved.notes[0].lane, -16); assert.equal(moved.notes[0].width, 32);
  assert.equal(moved.notes[1].lane, 31); assert.equal(moved.notes[1].endLane, -5); assert.equal(moved.notes[1].endWidth, 40);
  const split = splitEditorNote(chart, slide.id, 240);
  assert.equal(split.notes[1].endWidth, 30); assert.equal(split.notes[2].width, 30);
  const disabled = moveEditorSelection({ ...chart, allowOutOfLane: false }, ids, 24, 0);
  assert.equal(disabled.notes[0].lane, -16); assert.equal(disabled.notes[1].lane, 31);
});

test('offstage horizontal movement clamps native start coordinates, independent of width', () => {
  const chart = createChart(); chart.allowOutOfLane = true;
  const wide = createNote('TAP', 0, 63, 128); chart.notes = [wide];
  const moved = moveEditorSelection(chart, new Set([wide.id]), 0, 8);
  assert.equal(moved.notes[0].lane, 64); assert.equal(moved.notes[0].width, 128);
});

test('AIR-HOLD split and continuation associate new native segments with AHD, including a zero-length endpoint', () => {
  const chart = createChart();
  const tap = createNote('TAP', 0, 0, 2), hold = createNote('AIR_HOLD', 0, 0, 2);
  hold.duration = 192; hold.attributes.parent = 'TAP'; chart.notes = [tap, hold];
  const split = splitEditorNote(chart, hold.id, 96);
  assert.equal(split.notes[1].attributes.parent, 'TAP'); assert.equal(split.notes[2].attributes.parent, 'AHD');
  const appended = appendEditorNote(split, split.notes[2].id, 288, 4, 4);
  assert.equal(appended.notes.at(-1)!.attributes.parent, 'AHD');
  assert.equal(appended.notes.at(-1)!.lane, 0); assert.equal(appended.notes.at(-1)!.width, 2);
  const native = parseC2S(serializeC2S(appended));
  assert.deepEqual(native.notes.filter(n => n.type === 'AIR_HOLD').map(n => n.attributes.parent), ['TAP', 'AHD', 'AHD']);
  const endpoint = { ...hold, tick: 192, duration: 0, attributes: { parent: 'AHD' } };
  const fromEndpoint = appendEditorNote({ ...chart, notes: [endpoint] }, endpoint.id, 288, 0, 2);
  assert.equal(fromEndpoint.notes[1].attributes.parent, 'AHD'); assert.equal(fromEndpoint.notes[1].tick, 192);
  assert.equal(chart.notes.length, 2); assert.equal(chart.notes[1].duration, 192);
});

test('continuing a grouped slide extends its original SLA across the new tail only', () => {
  const chart = createChart();
  const first = createNote('SLIDE', 0, 0, 2), second = createNote('SLIDE', 96, 4, 2);
  first.endLane = 4; second.endLane = 8; chart.notes = [first, second];
  chart.events = [
    { id: 'speed', type: 'GROUP_SCROLL', tick: 0, duration: 768, group: 1, value: 2 },
    { id: 'chain', type: 'SCROLL_ASSIGNMENT', tick: 0, duration: 192, lane: 0, width: 2, group: 1, value: 1 },
    { id: 'unrelated', type: 'SCROLL_ASSIGNMENT', tick: 0, duration: 96, lane: 12, width: 2, group: 1, value: 1 },
  ];
  const continued = appendEditorNote(chart, second.id, 288, 10, 2);
  assert.equal(continued.events.find(event => event.id === 'chain')!.duration, 288);
  assert.equal(continued.events.find(event => event.id === 'unrelated')!.duration, 96);
  assert.deepEqual(continued.notes.map(note => getNoteScrollGroup(continued, note)), [1, 1, 1]);
  const native = parseC2S(serializeC2S(continued));
  assert.deepEqual(native.notes.map(note => getNoteScrollGroup(native, note)), [1, 1, 1]);
  assert.equal(chart.events[1].duration, 192);
});

test('copying a grouped middle segment keeps its effective group without copying unselected notes', () => {
  const chart = createChart();
  const first = createNote('SLIDE', 0, 0, 2), second = createNote('SLIDE', 96, 4, 2);
  first.endLane = 4; second.endLane = 8; chart.notes = [first, second];
  chart.events = [{ id: 'chain', type: 'SCROLL_ASSIGNMENT', tick: 0, duration: 192, lane: 0, width: 2, group: 3, value: 3 }];
  const copied = copyEditorSelection(chart, new Set([second.id]))!;
  assert.equal(copied.notes.length, 1); assert.equal(copied.events.length, 1); assert.equal(copied.firstTick, 96);
  const pasted = { ...chart, notes: copied.notes.map(n => ({ ...n, tick: n.tick + 384 })), events: copied.events.map(e => ({ ...e, tick: e.tick + 384 })) };
  assert.equal(getNoteScrollGroup(pasted, pasted.notes[0]), 3);
  const native = parseC2S(serializeC2S(pasted)); assert.equal(getNoteScrollGroup(native, native.notes[0]), 3);
  assert.equal(chart.events.length, 1); assert.equal(chart.events[0].duration, 192);
});

test('front-back flip reverses notes inside the selection span and keeps the node kind of a chain joint at that joint', () => {
  const chart = createChart();
  const early = createNote('TAP', 0, 0, 2), late = createNote('TAP', 96, 4, 2), untouched = createNote('TAP', 480, 0, 4);
  const first = { ...createNote('SLIDE', 0, 8, 2), duration: 48, endLane: 10, endWidth: 3, attributes: { visible: false } };
  const second = { ...createNote('SLIDE', 48, 10, 3), duration: 96, endLane: 12, endWidth: 4, attributes: { visible: true } };
  const air = { ...createNote('AIR_SLIDE', 0, 0, 2), duration: 144, endLane: 2, height: 1, endHeight: 4 };
  chart.notes = [early, late, untouched, first, second, air];
  const flipped = flipEditorSelection(chart, new Set([early.id, late.id, first.id, second.id, air.id]));
  const get = (id: string) => flipped.notes.find(note => note.id === id)!;
  // The span is 0…144: point notes mirror about its middle, the unselected note stays.
  assert.equal(get(early.id).tick, 144); assert.equal(get(late.id).tick, 48); assert.equal(get(untouched.id), untouched);
  // The later segment now comes first, runs the other way and ends on the same control joint.
  assert.deepEqual([get(second.id).tick, get(second.id).lane, get(second.id).width, get(second.id).endLane, get(second.id).endWidth, get(second.id).attributes.visible], [0, 12, 4, 10, 3, false]);
  assert.deepEqual([get(first.id).tick, get(first.id).lane, get(first.id).width, get(first.id).endLane, get(first.id).endWidth, get(first.id).attributes.visible], [96, 10, 3, 8, 2, undefined]);
  assert.deepEqual([get(air.id).tick, get(air.id).lane, get(air.id).endLane, get(air.id).height, get(air.id).endHeight], [0, 2, 0, 4, 1]);
  assert.equal(flipEditorSelection(chart, new Set()), chart);
  // Flipping twice restores every position.
  const twice = flipEditorSelection(flipped, new Set([early.id, late.id, first.id, second.id, air.id]));
  for (const note of chart.notes) assert.deepEqual([get(note.id).duration, twice.notes.find(item => item.id === note.id)!.tick, twice.notes.find(item => item.id === note.id)!.lane], [note.duration, note.tick, note.lane]);
});

test('time scaling keeps the first selected tick and scales intervals, durations and selected events', () => {
  const chart = createChart();
  const a = createNote('TAP', 96, 0, 2), b = createNote('TAP', 144, 2, 2), hold = { ...createNote('HOLD', 192, 4, 2), duration: 96 }, outside = createNote('TAP', 24, 0, 2);
  chart.notes = [outside, a, b, hold];
  chart.events = [{ id: 'bpm', type: 'BPM', tick: 192, value: 180 }, { id: 'scroll', type: 'SCROLL', tick: 288, value: 2, duration: 96 }];
  const half = scaleEditorSelection(chart, new Set([a.id, b.id, hold.id, 'scroll']), 1 / 2);
  assert.deepEqual(half.notes.map(note => [note.tick, note.duration]), [[24, undefined], [96, undefined], [120, undefined], [144, 48]]);
  assert.deepEqual(half.events.map(event => [event.tick, event.duration]), [[192, undefined], [192, 48]]);
  // Seven notes written as eighths become an exact 7-in-the-space-of-6 group.
  const tuplet = createChart(); tuplet.notes = Array.from({ length: 7 }, (_, index) => createNote('TAP', 384 + index * 48, 0, 2));
  const scaled = scaleEditorSelection(tuplet, new Set(tuplet.notes.map(note => note.id)), 6 / 7);
  assert.ok(scaled.notes.every((note, index) => Math.abs(note.tick - (384 + index * 288 / 7)) < 1e-9));
  for (const factor of [0, -1, Number.NaN, Infinity]) assert.equal(scaleEditorSelection(chart, new Set([a.id]), factor), chart);
});

test('curved SLIDE replaces one straight segment by connected control segments on an ease-in-out path', () => {
  const chart = createChart();
  const slide = { ...createNote('SLIDE', 96, 0, 4), duration: 384, endLane: 8, endWidth: 2, attributes: { visible: true } }, tap = createNote('TAP', 0, 0, 4);
  chart.notes = [tap, slide];
  const curved = curveEditorSlide(chart, slide.id, 96), segments = curved.notes.filter(note => note.type === 'SLIDE');
  assert.equal(segments.length, 4); assert.equal(segments[0].id, slide.id); assert.equal(curved.notes[0], tap);
  assert.deepEqual(segments.map(note => [note.tick, note.duration, note.lane, note.endLane, note.width, note.endWidth]), [[96, 96, 0, 1, 4, 4], [192, 96, 1, 4, 4, 3], [288, 96, 4, 7, 3, 2], [384, 96, 7, 8, 2, 2]]);
  // Inserted joints are control points; the original end keeps its own node kind.
  assert.deepEqual(segments.map(note => note.attributes.visible), [false, false, false, true]);
  assert.deepEqual(segments.slice(1).map(note => note.attributes.parent), ['SLD', 'SLD', 'SLD']);
  const air = { ...createNote('AIR_SLIDE', 0, 2, 2), duration: 96, endLane: 6, height: 1, endHeight: 5 }; chart.notes.push(air);
  const lifted = curveEditorSlide(chart, air.id, 48).notes.filter(note => note.type === 'AIR_SLIDE');
  assert.deepEqual(lifted.map(note => [note.height, note.endHeight]), [[1, 3], [3, 5]]);
  // Nothing to curve: no sideways change, fewer than two steps, or another note type.
  assert.equal(curveEditorSlide({ ...chart, notes: [{ ...slide, endLane: 0, endWidth: 4 }] }, slide.id, 96).notes.length, 1);
  assert.equal(curveEditorSlide(chart, slide.id, 384), chart); assert.equal(curveEditorSlide(chart, tap.id, 24), chart);
});
