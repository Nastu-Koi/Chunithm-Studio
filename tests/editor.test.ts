import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, type Note } from '../src/core/model';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { mirrorEditorSelection, moveEditorSelection, parseEditorFraction, splitEditorNote, appendEditorNote, copyEditorSelection, flipEditorSelection, scaleEditorSelection, shapeEditorSlide, removeEditorJoint, mergeEditorExTaps, editorChain, attachEditorAir, boundEditorParent, setEditorEx } from '../src/renderer/editor';
import { getNoteScrollGroup } from '../src/core/timing';
import { getNativeAirBindings } from '../src/core/judgement';

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

test('SLIDE shapes replace one segment by a connected path that keeps the start width and the chain', () => {
  const chart = createChart();
  const slide = { ...createNote('SLIDE', 96, 0, 4), duration: 384, endLane: 8, endWidth: 2, attributes: { visible: true } }, tap = createNote('TAP', 0, 0, 4);
  const next = { ...createNote('SLIDE', 480, 8, 2), duration: 192, endLane: 8, endWidth: 2, attributes: { visible: true, parent: 'SLD' } };
  chart.notes = [tap, slide, next];
  const rows = (notes: Note[]) => notes.filter(note => note.type === 'SLIDE').map(note => [note.tick, note.duration, note.lane, note.endLane, note.width, note.endWidth]);
  // Curve: a quarter circle with one control node per lane on the arc, sideways first and straight at the end.
  // The original end keeps its node kind, and the next segment follows the new end.
  const curve = shapeEditorSlide(chart, slide.id, { shape: 'curve', length: 384, move: 4, count: 1, step: 96, kind: 'control' })!;
  assert.deepEqual(rows(curve.chart.notes), [[96, 12, 0, 1, 4, 4], [108, 39, 1, 2, 4, 4], [147, 79, 2, 3, 4, 4], [226, 254, 3, 4, 4, 4], [480, 192, 4, 8, 4, 2]]);
  assert.equal(curve.chart.notes[0], tap); assert.equal(curve.ids[0], slide.id); assert.equal(curve.ids.length, 4);
  const curved = curve.chart.notes.filter(note => curve.ids.includes(note.id));
  assert.deepEqual(curved.map(note => note.attributes.visible), [false, false, false, true]);
  assert.deepEqual(curved.slice(1).map(note => note.attributes.parent), ['SLD', 'SLD', 'SLD']);
  const path = (options: Partial<Parameters<typeof shapeEditorSlide>[2]>) => { const result = shapeEditorSlide(chart, slide.id, { shape: 'curve', length: 384, move: 4, count: 1, step: 96, kind: 'control', ...options })!;
    const made = result.chart.notes.filter(note => result.ids.includes(note.id)); return [[0, made[0].lane, made[0].width], ...made.map(note => [note.tick + note.duration! - 96, note.endLane, note.endWidth])]; };
  // Flipped: the same arc run backwards, straight first. Leftwards with a start lane and width of its own.
  assert.deepEqual(path({ flipV: true }), [[0, 0, 4], [254, 1, 4], [333, 2, 4], [372, 3, 4], [384, 4, 4]]);
  assert.deepEqual(path({ start: 10, width: 2, move: -2 }), [[0, 10, 2], [51, 9, 2], [384, 8, 2]]);
  // Out and back within the same length: a U lying on its side.
  assert.deepEqual(path({ move: 2, symmetryV: true }), [[0, 0, 4], [26, 1, 4], [192, 2, 4], [358, 1, 4], [384, 0, 4]]);
  // Mirrored about the middle of the lanes: every node spans from its left edge to the same edge on the right.
  assert.deepEqual(path({ start: 2, move: 2, symmetryH: true }), [[0, 2, 12], [51, 3, 10], [384, 4, 8]]);
  assert.deepEqual(path({ start: 2, move: 2, symmetryH: true, symmetryV: true }).map(row => row[2]), [12, 10, 8, 10, 12], 'both symmetries give an hourglass');
  // A new start takes the segment chained before it along.
  const before = { ...createNote('SLIDE', 0, 6, 4), duration: 96, endLane: 0, endWidth: 4, attributes: { visible: false } };
  const restarted = shapeEditorSlide({ ...chart, notes: [before, slide, next] }, slide.id, { shape: 'curve', length: 384, move: 2, start: 5, width: 3, count: 1, step: 96, kind: 'control' })!.chart.notes;
  assert.deepEqual([restarted[0].endLane, restarted[0].endWidth, restarted[1].lane, restarted[1].width], [5, 3, 5, 3]);
  // Zigzag: every tooth goes out to the far side and back, so the tail is level with the head for any count.
  const zigzag = shapeEditorSlide(chart, slide.id, { shape: 'zigzag', length: 192, move: 3, count: 2, step: 24, kind: 'normal' })!;
  assert.deepEqual(rows(zigzag.chart.notes).slice(0, 4), [[96, 48, 0, 3, 4, 4], [144, 48, 3, 0, 4, 4], [192, 48, 0, 3, 4, 4], [240, 48, 3, 0, 4, 4]]);
  assert.deepEqual(rows(zigzag.chart.notes)[4], [288, 384, 0, 8, 4, 2], 'the next segment starts at the new end and keeps its own end');
  assert.deepEqual(zigzag.chart.notes.filter(note => zigzag.ids.includes(note.id)).map(note => note.attributes.visible), [true, true, true, true]);
  const soft = shapeEditorSlide(chart, slide.id, { shape: 'zigzag', length: 192, move: 3, count: 2, step: 24, kind: 'control' })!;
  assert.deepEqual(soft.chart.notes.filter(note => soft.ids.includes(note.id)).map(note => note.attributes.visible), [false, false, false, true]);
  const odd = shapeEditorSlide(chart, slide.id, { shape: 'zigzag', length: 288, move: 3, count: 3, step: 24, kind: 'control' })!;
  assert.equal(odd.ids.length, 6);
  assert.deepEqual(rows(odd.chart.notes).slice(0, 6).map(row => [row[2], row[3]]), [[0, 3], [3, 0], [0, 3], [3, 0], [0, 3], [3, 0]], 'an odd count also ends on the start lane');
  // Wave: a zigzag about the start lane, out to one side, across to the other and back; corners take the node kind.
  const centred = { ...slide, lane: 6, endLane: 6 }, waveChart = { ...chart, notes: [tap, centred] };
  const wave = shapeEditorSlide(waveChart, slide.id, { shape: 'wave', length: 384, move: 4, count: 1, step: 96, kind: 'normal' })!;
  assert.deepEqual(rows(wave.chart.notes).map(row => [row[0], row[1], row[2], row[3]]), [[96, 96, 6, 10], [192, 192, 10, 2], [384, 96, 2, 6]]);
  assert.deepEqual(wave.chart.notes.filter(note => wave.ids.includes(note.id)).map(note => note.attributes.visible), [true, true, true]);
  const twice = shapeEditorSlide(waveChart, slide.id, { shape: 'wave', length: 384, move: -2, count: 2, step: 96, kind: 'control' })!;
  assert.deepEqual(rows(twice.chart.notes).map(row => [row[2], row[3]]), [[6, 4], [4, 8], [8, 4], [4, 8], [8, 6]]);
  // Both sides must fit: two lanes from the left edge leave a swing of two.
  const edge = shapeEditorSlide({ ...chart, notes: [{ ...slide, lane: 2, endLane: 2 }] }, slide.id, { shape: 'wave', length: 384, move: 5, count: 1, step: 96, kind: 'control' })!;
  assert.equal(edge.move, 2); assert.deepEqual(rows(edge.chart.notes).map(row => row[3]), [4, 0, 2]);
  // The far side is narrowed to stay on the lanes, and the length stops one step before the next segment's end.
  const narrowed = shapeEditorSlide(chart, slide.id, { shape: 'zigzag', length: 96, move: 20, count: 1, step: 24, kind: 'control' })!;
  assert.equal(narrowed.move, 12); assert.equal(Math.max(...narrowed.chart.notes.map(note => (note.endLane ?? note.lane) + (note.endWidth ?? note.width))), 16);
  assert.equal(shapeEditorSlide(chart, slide.id, { shape: 'curve', length: 9999, move: 4, count: 1, step: 96, kind: 'control' })!.length, 480);
  // AIR SLIDE heights follow the path linearly.
  const air = { ...createNote('AIR_SLIDE', 0, 2, 2), duration: 96, endLane: 6, height: 1, endHeight: 5 };
  const lifted = shapeEditorSlide({ ...chart, notes: [air] }, air.id, { shape: 'zigzag', length: 96, move: 4, count: 1, step: 24, kind: 'control' })!.chart.notes;
  assert.deepEqual(lifted.map(note => [note.height, note.endHeight]), [[1, 3], [3, 5]]);
  assert.equal(shapeEditorSlide(chart, tap.id, { shape: 'curve', length: 96, move: 4, count: 1, step: 24, kind: 'control' }), undefined);
  assert.equal(shapeEditorSlide(chart, slide.id, { shape: 'curve', length: 0, move: 4, count: 1, step: 24, kind: 'control' }), undefined);
});

test('shaping a bound AIR SLIDE head keeps one chain on its parent that still ends on the original node', () => {
  const chart = createChart(), tap = createNote('TAP', 0, 2, 4);
  const air = { ...createNote('AIR_SLIDE', 0, 2, 4), duration: 96, height: 1, endHeight: 5, attributes: { parent: 'TAP' } };
  const next = { ...createNote('AIR_SLIDE', 96, 2, 4), duration: 96, attributes: { parent: 'ASD' } };
  for (const shape of ['curve', 'zigzag', 'wave'] as const) for (const notes of [[tap, air], [tap, air, next]]) {
    const result = shapeEditorSlide({ ...chart, notes }, air.id, { shape, length: 96, move: 4, count: 1, step: 24, kind: 'control' })!;
    const { airOf, orphans } = getNativeAirBindings(result.chart), chain = airOf.get(tap.id)!;
    assert.deepEqual(orphans, []);
    assert.deepEqual(chain.map(note => note.id), [...result.ids, ...notes.slice(2).map(note => note.id)]);
    assert.ok(chain.every((note, index) => index === 0 || note.tick === chain[index - 1].tick + chain[index - 1].duration! && note.lane === chain[index - 1].endLane && note.height === chain[index - 1].endHeight));
    assert.deepEqual([chain[0].tick, chain[0].lane, chain[0].attributes.parent], [0, 2, 'TAP']);
    // The path's last node is the segment's own end: still a normal node, at the original time and height.
    const tail = result.chart.notes.find(note => note.id === result.ids.at(-1))!;
    assert.deepEqual([tail.tick + tail.duration!, tail.endHeight, tail.attributes.visible !== false], [96, 5, true]);
  }
});

test('EX is set on a whole HOLD or SLIDE chain and exports as HXD / SXD / SXC', () => {
  const chart = createChart();
  const head = { ...createNote('SLIDE', 0, 0, 4), duration: 96, endLane: 4, attributes: { visible: false } };
  const tail = { ...createNote('SLIDE', 96, 4, 4), duration: 96, endLane: 8, attributes: { visible: true, parent: 'SLD' } };
  const other = { ...createNote('SLIDE', 0, 12, 4), duration: 96, endLane: 12, attributes: { visible: true } }, hold = createNote('HOLD', 0, 8, 2), tap = createNote('TAP', 0, 10, 2);
  chart.notes = [head, tail, other, hold, tap];
  const ex = setEditorEx(chart, tail.id);
  assert.deepEqual(ex.notes.map(note => Boolean(note.attributes.ex)), [true, true, false, false, false]);
  const text = serializeC2S(setEditorEx(ex, hold.id));
  assert.match(text, /^SXC\t/m); assert.match(text, /^SXD\t/m); assert.match(text, /^HXD\t/m); assert.match(text, /^SLD\t/m);
  assert.deepEqual(setEditorEx(ex, head.id).notes.map(note => note.attributes.ex), [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(setEditorEx(ex, head.id, true).notes[1].attributes.ex, true);
  assert.equal(setEditorEx(chart, tap.id), chart);
});

test('removing a joint joins the two segments around it and keeps what hangs on the chain', () => {
  const chart = createChart();
  const a = { ...createNote('SLIDE', 0, 0, 4), duration: 96, endLane: 4, endWidth: 4, attributes: { visible: false } };
  const b = { ...createNote('SLIDE', 96, 4, 4), duration: 96, endLane: 2, endWidth: 2, attributes: { visible: true, parent: 'SLD' } };
  const c = { ...createNote('SLIDE', 192, 2, 2), duration: 96, endLane: 8, endWidth: 2, attributes: { visible: true, parent: 'SLD' } };
  chart.notes = [a, b, c];
  const bound = attachEditorAir(chart, { ...createNote('AIR', 0, 0, 1), attributes: { direction: 'IR', color: 'DEF' } }, c.id)!;
  const air = bound.notes.find(note => note.type === 'AIR')!;
  // The joint between a and b: a runs straight to b's end and takes b's node kind; c still follows.
  const joined = removeEditorJoint(bound, a.id);
  assert.deepEqual(joined.notes.filter(note => note.type === 'SLIDE').map(note => [note.id, note.tick, note.duration, note.lane, note.endLane, note.width, note.endWidth, note.attributes.visible]),
    [[a.id, 0, 192, 0, 2, 4, 2, true], [c.id, 192, 96, 2, 8, 2, 2, true]]);
  // The last joint: the AIR on the chain's tail stays bound to the joined segment.
  const tail = removeEditorJoint(bound, b.id);
  assert.deepEqual(tail.notes.filter(note => note.type === 'SLIDE').map(note => [note.id, note.duration, note.endLane]), [[a.id, 96, 4], [b.id, 192, 8]]);
  assert.equal(boundEditorParent(tail, air.id)?.id, b.id);
  // The end of a chain is no joint.
  assert.equal(removeEditorJoint(bound, c.id), bound);
  // Any segment names the whole long note, in order.
  for (const segment of [a, b, c]) assert.deepEqual(editorChain(bound, segment).map(note => note.id), [a.id, b.id, c.id]);
  assert.deepEqual(editorChain(bound, air), [air]);
  // AIR SLIDE: heights run through, and the segment after the joint names its new parent's tag.
  const up = { ...createNote('AIR_SLIDE', 0, 0, 2), duration: 96, endLane: 2, height: 1, endHeight: 3, attributes: { visible: false } };
  const on = { ...createNote('AIR_SLIDE', 96, 2, 2), duration: 96, endLane: 4, height: 3, endHeight: 5, attributes: { visible: true, parent: 'ASC' } };
  const last = { ...createNote('AIR_SLIDE', 192, 4, 2), duration: 96, endLane: 4, height: 5, endHeight: 5, attributes: { visible: true, parent: 'ASD' } };
  const lifted = removeEditorJoint({ ...chart, notes: [up, on, last] }, up.id).notes;
  assert.deepEqual(lifted.map(note => [note.duration, note.height, note.endHeight, note.attributes.visible, note.attributes.parent]), [[192, 1, 5, true, undefined], [96, 5, 5, true, 'ASD']]);
});

test('an ExTAP moved exactly onto a HOLD / SLIDE head becomes that long note\'s EX', () => {
  const chart = createChart();
  const head = { ...createNote('SLIDE', 96, 0, 4), duration: 96, endLane: 4, attributes: { visible: true } };
  const tail = { ...createNote('SLIDE', 192, 4, 4), duration: 96, endLane: 8, attributes: { visible: true, parent: 'SLD' } };
  const hold = { ...createNote('HOLD', 96, 8, 2), duration: 96 };
  const onHead = { ...createNote('EXTAP', 96, 0, 4), attributes: { effect: 'DW' } }, onHold = createNote('EXTAP', 96, 8, 2);
  const onJoint = createNote('EXTAP', 192, 4, 4), narrower = createNote('EXTAP', 96, 0, 3), untouched = createNote('EXTAP', 96, 8, 2);
  chart.notes = [head, tail, hold, onHead, onHold, onJoint, narrower, untouched];
  const result = mergeEditorExTaps(chart, new Set([onHead.id, onHold.id, onJoint.id, narrower.id]));
  assert.deepEqual(result.merged, [head.id, hold.id]);
  assert.deepEqual(result.chart.notes.map(note => note.id), [head.id, tail.id, hold.id, onJoint.id, narrower.id, untouched.id], 'only the selected ExTAPs that sit on a head are removed');
  assert.deepEqual(result.chart.notes.slice(0, 3).map(note => [note.attributes.ex, note.attributes.effect]), [[true, 'DW'], [true, 'DW'], [true, undefined]]);
  // An AIR bound to the ExTAP keeps it a note of its own.
  const carrier = createNote('EXTAP', 96, 8, 2), air = { ...createNote('AIR', 96, 8, 2), attributes: { direction: 'IR', color: 'DEF', parent: 'CHR' } };
  const bound = { ...chart, notes: [hold, carrier, air] };
  assert.equal(mergeEditorExTaps(bound, new Set([carrier.id])).chart, bound);
  assert.equal(mergeEditorExTaps(chart, new Set([tail.id])).chart, chart);
});
