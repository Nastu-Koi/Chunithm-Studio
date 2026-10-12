import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, type Chart, type Note } from '../src/core/model';
import { getNativeAirBindings } from '../src/core/judgement';
import { validateChart } from '../src/core/validation';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { attachEditorAir, boundEditorParent, moveEditorSelection, mirrorEditorSelection, copyEditorSelection, selectionWithBoundAir, syncEditorAirBindings } from '../src/renderer/editor-operations';

const chartOf = (...notes: Note[]): Chart => ({ ...createChart(), notes });
const air = (type: 'AIR' | 'AIR_HOLD' | 'AIR_SLIDE' = 'AIR') => createNote(type, 999, 9, 1);
const get = (chart: Chart, id: string) => chart.notes.find(note => note.id === id)!;

test('AIR is read as an attachment of a ground tail; a record without a parent is a chart error', () => {
  const tap = createNote('TAP', 96, 4, 4), free = { ...createNote('AIR', 96, 5, 4), attributes: { parent: 'TAP' } };
  const orphaned = chartOf(tap, free);
  assert.deepEqual(getNativeAirBindings(orphaned).orphans.map(note => note.id), [free.id]);
  assert.ok(validateChart(orphaned).some(issue => issue.code === 'air-parent' && issue.severity === 'error' && issue.entityId === free.id));
  const bound = attachEditorAir(chartOf(tap), air(), tap.id)!;
  const placed = bound.notes.find(note => note.type === 'AIR')!;
  assert.deepEqual([placed.tick, placed.lane, placed.width, placed.attributes.parent], [96, 4, 4, 'TAP']);
  assert.equal(boundEditorParent(bound, placed.id)?.id, tap.id);
  assert.ok(!validateChart(bound).some(issue => issue.code === 'air-parent'));
  // One ground root takes one AIR head.
  assert.equal(attachEditorAir(bound, air(), tap.id), undefined);
  assert.equal(attachEditorAir(bound, air('AIR_HOLD'), tap.id), undefined);
});

test('AIR attaches to the tail of long ground notes with the family parent token and survives a C2S round trip', () => {
  const hold = { ...createNote('HOLD', 0, 2, 3), duration: 192, attributes: { ex: true } };
  const first = { ...createNote('SLIDE', 0, 8, 2), duration: 96, endLane: 10, endWidth: 3 };
  const second = { ...createNote('SLIDE', 96, 10, 3), duration: 96, endLane: 12, endWidth: 4, attributes: { parent: 'SLD' } };
  let chart = attachEditorAir(chartOf(hold, first, second), air('AIR_HOLD'), hold.id)!;
  // A mid-chain joint still accepts the AIR although the next segment already continues from it.
  chart = attachEditorAir(chart, air(), first.id)!;
  const onHold = chart.notes.find(note => note.type === 'AIR_HOLD')!, onSlide = chart.notes.find(note => note.type === 'AIR')!;
  assert.deepEqual([onHold.tick, onHold.lane, onHold.width, onHold.endLane, onHold.attributes.parent], [192, 2, 3, 2, 'HLD']);
  assert.deepEqual([onSlide.tick, onSlide.lane, onSlide.width, onSlide.attributes.parent], [96, 10, 3, 'SLD']);
  // The whole SLIDE root owns that one AIR.
  assert.equal(attachEditorAir(chart, air(), second.id), undefined);
  const native = parseC2S(serializeC2S(chart));
  assert.equal(getNativeAirBindings(native).orphans.length, 0);
  assert.equal(getNativeAirBindings(native).parentOf.size, 2);
});

test('a ground note and its AIR move, mirror, copy and delete as one unit', () => {
  const tap = createNote('TAP', 96, 4, 4), other = createNote('TAP', 96, 10, 2);
  let chart = attachEditorAir(chartOf(tap, other), air('AIR_HOLD'), tap.id)!;
  const head = chart.notes.find(note => note.type === 'AIR_HOLD')!;
  const tail: Note = { ...createNote('AIR_HOLD', head.tick + head.duration!, 4, 4), duration: 48, attributes: { parent: 'AHD' } };
  chart = { ...chart, notes: [...chart.notes, tail] };
  assert.deepEqual([...selectionWithBoundAir(chart, new Set([tap.id]))].sort(), [tap.id, head.id, tail.id].sort());
  assert.deepEqual([...selectionWithBoundAir(chart, new Set([head.id]), false)], [head.id]);
  for (const picked of [tap.id, head.id]) {
    const moved = moveEditorSelection(chart, new Set([picked]), 48, 2);
    assert.deepEqual([get(moved, tap.id).tick, get(moved, tap.id).lane], [144, 6]);
    assert.deepEqual([get(moved, head.id).tick, get(moved, head.id).lane, get(moved, head.id).endLane], [144, 6, 6]);
    assert.deepEqual([get(moved, tail.id).tick, get(moved, tail.id).lane], [tail.tick + 48, 6]);
    assert.equal(get(moved, other.id), other);
    assert.equal(getNativeAirBindings(moved).orphans.length, 0);
  }
  const mirrored = mirrorEditorSelection(chart, new Set([tap.id]));
  assert.deepEqual([get(mirrored, tap.id).lane, get(mirrored, head.id).lane, get(mirrored, tail.id).lane], [8, 8, 8]);
  assert.deepEqual(copyEditorSelection(chart, new Set([head.id]))!.notes.map(note => note.id), [tap.id, head.id, tail.id]);
});

test('edits to the parent re-seat the bound AIR; direct edits to the AIR position are undone', () => {
  const hold = { ...createNote('HOLD', 0, 2, 3), duration: 192 };
  const chart = attachEditorAir(chartOf(hold), air('AIR_SLIDE'), hold.id)!;
  const head = chart.notes.find(note => note.type === 'AIR_SLIDE')!;
  const edit = (change: (note: Note) => Note): Chart => syncEditorAirBindings(chart, { ...chart, notes: chart.notes.map(note => note.id === hold.id ? change(note) : note) });
  const longer = edit(note => ({ ...note, duration: 288 }));
  assert.deepEqual([get(longer, head.id).tick, get(longer, head.id).duration], [288, head.duration]);
  const wider = edit(note => ({ ...note, lane: 5, width: 6, endLane: 5, endWidth: 6 }));
  assert.deepEqual([get(wider, head.id).lane, get(wider, head.id).width, get(wider, head.id).endLane, get(wider, head.id).endWidth], [5, 6, 5, 3]);
  const retyped = edit(note => ({ ...note, type: 'TAP', duration: undefined, endLane: undefined, endWidth: undefined }));
  assert.deepEqual([get(retyped, head.id).tick, get(retyped, head.id).attributes.parent], [0, 'TAP']);
  assert.equal(getNativeAirBindings(retyped).orphans.length, 0);
  const dragged = syncEditorAirBindings(chart, { ...chart, notes: chart.notes.map(note => note.id === head.id ? { ...note, tick: 240, lane: 9 } : note) });
  assert.deepEqual([get(dragged, head.id).tick, get(dragged, head.id).lane], [192, 2]);
  // Nothing bound has moved: the chart object is returned untouched.
  const unrelated = { ...chart, notes: [...chart.notes, createNote('TAP', 480, 0, 2)] };
  assert.equal(syncEditorAirBindings(chart, unrelated), unrelated);
});
