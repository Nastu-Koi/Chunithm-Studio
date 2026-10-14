import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, type Chart, type Note } from '../src/core/model';
import { getScrollPosition } from '../src/core/timing';
import {
  getPlayerRibbonSegments,
  getPlayerPastRibbonSegments,
  getPlayerHeadTextureKey,
  getPlayerBodyTextureKey,
  getPlayerTextureRectangle,
  getPlayerCrushTickIndex,
  getPlayerCrushMarkerTicks,
} from '../src/renderer/player';
import { buildJudgementTimeline } from '../src/core/judgement';

function reversingChart(): { chart: Chart; note: Note } {
  const chart = createChart();
  const note = createNote('SLIDE', 3840, 0, 4);
  note.duration = 7680;
  note.endLane = 12;
  chart.notes = [note];
  chart.events = [{ id: 'reverse', type: 'SCROLL', tick: 3840, duration: 1920, value: -3 }];
  return { chart, note };
}

test('reversing ribbon remains visible when both endpoints are beyond the horizon', () => {
  const { chart, note } = reversingChart();
  assert.equal(getScrollPosition(chart, note.tick, 0, note), 20);
  assert.equal(getScrollPosition(chart, note.tick + note.duration!, 0, note), 20);
  const segments = getPlayerRibbonSegments(chart, note, 0);
  assert.ok(segments.length > 0);
  assert.ok(segments.some(segment => segment.endDistance < segment.startDistance));
  assert.ok(segments.some(segment => segment.endDistance > segment.startDistance));
  for (const segment of segments) {
    for (const distance of [segment.startDistance, segment.endDistance])
      assert.ok(distance >= -0.180001 && distance <= 12.000001);
    assert.ok(Math.abs(segment.endDistance - segment.startDistance) <= 0.750001);
  }
});

test('ribbon may enter the visible track even when both endpoints are behind the judge line', () => {
  const { chart, note } = reversingChart();
  chart.events = [
    { id: 'before', type: 'SCROLL', tick: 0, duration: 3840, value: -1 },
    { id: 'forward', type: 'SCROLL', tick: 3840, duration: 1920, value: 3 },
    { id: 'after', type: 'SCROLL', tick: 5760, duration: 5760, value: -1 },
  ];
  assert.equal(getScrollPosition(chart, note.tick, 0, note), -20);
  assert.equal(getScrollPosition(chart, note.tick + note.duration!, 0, note), -20);
  const segments = getPlayerRibbonSegments(chart, note, 0);
  assert.ok(segments.length > 0);
  assert.ok(segments.some(segment => segment.endDistance > 9.9));
});

test('grouped ribbon includes exact stop and BPM boundaries with distances matching the shared timeline', () => {
  const { chart, note } = reversingChart();
  chart.events = [
    { id: 'group', type: 'GROUP_SCROLL', tick: 3840, duration: 1920, value: -3, group: 2 },
    { id: 'assign', type: 'SCROLL_ASSIGNMENT', tick: 3840, duration: 7680, value: 2, group: 2, lane: 0, width: 4 },
    { id: 'bpm', type: 'BPM', tick: 4860, value: 180 },
    { id: 'stop', type: 'STOP', tick: 4800, duration: 192, value: 0 },
  ];
  const snapshot = JSON.stringify(chart);
  const segments = getPlayerRibbonSegments(chart, note, 0);
  for (const tick of [4800, 4860, 4992])
    assert.ok(
      segments.some(segment => Math.abs(segment.startTick - tick) < 1e-6 || Math.abs(segment.endTick - tick) < 1e-6),
      `missing motion boundary ${tick}`,
    );
  assert.ok(
    segments.some(
      segment => segment.endTick > segment.startTick && Math.abs(segment.startDistance - segment.endDistance) < 1e-10,
    ),
  );
  for (const segment of segments) {
    assert.ok(Math.abs(segment.startDistance - getScrollPosition(chart, segment.startTick, 0, note)) < 1e-8);
    assert.ok(Math.abs(segment.endDistance - getScrollPosition(chart, segment.endTick, 0, note)) < 1e-8);
  }
  assert.equal(JSON.stringify(chart), snapshot);
});

test('ribbon clipping discards elapsed portions and returns nothing after its end', () => {
  const { chart, note } = reversingChart();
  assert.ok(getPlayerRibbonSegments(chart, note, 5000).every(segment => segment.startTick >= 5000));
  assert.deepEqual(getPlayerRibbonSegments(chart, note, note.tick + note.duration!), []);
  assert.deepEqual(getPlayerRibbonSegments(chart, createNote('TAP', 0), 0), []);
  const terminal = createNote('AIR_HOLD', 96);
  terminal.duration = 0;
  assert.deepEqual(getPlayerRibbonSegments(chart, terminal, 0), []);
});

test('motion-boundary caches respect immutable chart edits', () => {
  const { chart, note } = reversingChart();
  const before = getPlayerRibbonSegments(chart, note, 0);
  const updated = {
    ...chart,
    events: [...chart.events, { id: 'new-tempo', type: 'BPM' as const, tick: 4701, value: 180 }],
  };
  const after = getPlayerRibbonSegments(updated, note, 0);
  assert.ok(after.some(segment => segment.startTick === 4701 || segment.endTick === 4701));
  assert.deepEqual(getPlayerRibbonSegments(chart, note, 0), before);
  assert.notDeepEqual(after, before);
});

test('original head mapping uses the exact supported width and keeps AIR mesh materials out of sprite drawing', () => {
  const families = {
    TAP: 'NotesTap',
    EXTAP: 'NotesChara',
    FLICK: 'NotesFlick',
    HOLD: 'NotesHold',
    SLIDE: 'NotesSlide',
    DAMAGE: 'NotesMine',
    AIR_HOLD: 'NotesAirHold_Tap',
  } as const;
  for (const [type, family] of Object.entries(families))
    for (let width = 1; width <= 16; width++)
      assert.equal(
        getPlayerHeadTextureKey(createNote(type as Note['type'], 0, 0, width)),
        `${family}_${String(width).padStart(2, '0')}`,
      );
  for (const type of ['AIR', 'AIR_SLIDE', 'AIR_CRUSH'] as const)
    assert.equal(getPlayerHeadTextureKey(createNote(type, 0, 0, 4)), undefined);
  for (const width of [0, 2.5, 17, 128])
    assert.equal(getPlayerHeadTextureKey(createNote('TAP', 0, 0, width)), undefined);
  const hold = createNote('HOLD', 0, 0, 4);
  hold.attributes.ex = true;
  assert.equal(getPlayerHeadTextureKey(hold), 'NotesChara_04');
  assert.equal(getPlayerHeadTextureKey(hold, 8), 'NotesChara_08', 'terminal head uses its actual endpoint width');
});

test('body mapping preserves resource colors and uses geometry for unsupported custom colors', () => {
  const hold = createNote('HOLD', 0),
    slide = createNote('SLIDE', 0),
    air = createNote('AIR_HOLD', 0),
    crush = createNote('AIR_CRUSH', 0);
  assert.equal(getPlayerBodyTextureKey(hold), 'HoldJoint');
  assert.equal(getPlayerBodyTextureKey(slide), 'SlideJoint');
  assert.equal(getPlayerBodyTextureKey(air), 'AirHoldLine');
  assert.equal(getPlayerBodyTextureKey(crush), 'AirLadderLine');
  air.attributes.color = 'PNK';
  assert.equal(getPlayerBodyTextureKey(air), 'AirHoldLine_P');
  for (const color of ['NON', 'BLK', 'VLT']) {
    air.attributes.color = color;
    assert.equal(getPlayerBodyTextureKey(air), undefined);
    assert.equal(getPlayerHeadTextureKey(air), undefined);
  }
});

test('UV rectangles crop source pixels and full EX/Mine images remain usable without a simple mesh rectangle', () => {
  const texture = { dataUrl: '', width: 32, height: 32, sourcePath: '', sourceName: '', sourceOffset: 0 };
  assert.deepEqual(getPlayerTextureRectangle(texture), { x: 0, y: 0, width: 32, height: 32 });
  assert.deepEqual(getPlayerTextureRectangle(texture, { u0: 0.125, v0: 0.25, u1: 0.875, v1: 0.75 }), {
    x: 4,
    y: 8,
    width: 24,
    height: 16,
  });
});

test('CRUSH markers follow the shared phase and never add bars at non-judgement shape joins', () => {
  const chart = createChart(),
    a = createNote('AIR_CRUSH', 0),
    b = createNote('AIR_CRUSH', 2),
    c = createNote('AIR_CRUSH', 5);
  a.duration = 2;
  b.duration = 3;
  c.duration = 7;
  for (const note of [a, b, c]) note.attributes.interval = 6;
  chart.notes = [a, b, c];
  const index = getPlayerCrushTickIndex(buildJudgementTimeline(chart));
  assert.deepEqual(index.get(a.id), [0]);
  assert.equal(index.has(b.id), false);
  assert.deepEqual(index.get(c.id), [6, 12]);
  const marks = chart.notes.flatMap(note =>
    getPlayerCrushMarkerTicks(index.get(note.id) ?? [], getPlayerRibbonSegments(chart, note, 0)),
  );
  assert.deepEqual(marks, [0, 6, 12]);
});

test('CRUSH marker joins draw once in the next shape, include a final endpoint and omit interval-zero decoration', () => {
  const chart = createChart(),
    a = createNote('AIR_CRUSH', 0),
    b = createNote('AIR_CRUSH', 6),
    decoration = createNote('AIR_CRUSH', 12);
  a.duration = b.duration = decoration.duration = 6;
  a.attributes.interval = b.attributes.interval = 6;
  decoration.attributes.interval = 0;
  chart.notes = [a, b, decoration];
  const index = getPlayerCrushTickIndex(buildJudgementTimeline(chart));
  assert.deepEqual(index.get(a.id), [0]);
  assert.deepEqual(index.get(b.id), [6, 12]);
  assert.equal(index.has(decoration.id), false);
  assert.deepEqual(
    getPlayerCrushMarkerTicks(index.get(b.id)!, [
      { startTick: 6, endTick: 9 },
      { startTick: 9, endTick: 12 },
    ]),
    [6, 12],
  );
  assert.deepEqual(getPlayerCrushMarkerTicks(index.get(b.id)!, [{ startTick: 12, endTick: 12 }]), [12]);
});

test('dense CRUSH marker selection uses binary range lookup and returns at most 512 original ticks', () => {
  let reads = 0;
  const ticks = new Proxy(
    Array.from({ length: 1000000 }, (_, index) => index * 3),
    {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const ranges = [
    { startTick: 2100000, endTick: 2400000 },
    { startTick: 2400000, endTick: 2700000 },
  ];
  const marks = getPlayerCrushMarkerTicks(ticks, ranges);
  assert.equal(marks.length, 512);
  assert.equal(new Set(marks).size, 512);
  assert.equal(marks[0], 2100000);
  assert.equal(marks.at(-1), 2700000);
  assert.ok(marks.every(tick => tick % 3 === 0));
  assert.ok(reads < 650, `expected binary lookups plus bounded selection, got ${reads} reads`);
  assert.equal(getPlayerCrushMarkerTicks(ticks, ranges, 5).length, 5);
  assert.deepEqual(getPlayerCrushMarkerTicks(ticks, ranges, 0), []);
});

test('the part of an AIR SLIDE behind the judgement line keeps its own shape', () => {
  const chart = createChart(),
    note = createNote('AIR_SLIDE', 384, 0, 4);
  note.duration = 768;
  note.endLane = 12;
  chart.notes = [note];
  const near = getScrollPosition(chart, 384, 768, note) * 0.75;
  assert.deepEqual(getPlayerPastRibbonSegments(chart, note, 384, near), [], 'nothing has passed at the head');
  const held = getPlayerPastRibbonSegments(chart, note, 768, near);
  assert.ok(held.length > 0);
  assert.ok(
    held[0].startTick > note.tick && held[0].startTick < 768,
    'the oldest part is clipped at the near limit, not at the current tick',
  );
  assert.ok(Math.abs(held[0].startDistance - near) < 1e-9);
  assert.equal(held.at(-1)!.endTick, 768);
  assert.ok(Math.abs(held.at(-1)!.endDistance) < 1e-12);
  for (const segment of held) {
    assert.ok(segment.startTick < segment.endTick && segment.endTick <= 768);
    assert.ok(Math.abs(segment.startDistance - getScrollPosition(chart, segment.startTick, 768, note)) < 1e-9);
    assert.ok(Math.abs(segment.endDistance - getScrollPosition(chart, segment.endTick, 768, note)) < 1e-9);
  }
  const end = note.tick + note.duration!,
    justEnded = getPlayerPastRibbonSegments(chart, note, end + 96, near);
  assert.ok(
    justEnded.length > 0 && justEnded.at(-1)!.endTick === end && justEnded.at(-1)!.endDistance < 0,
    'an ended note still scrolls out',
  );
  assert.deepEqual(getPlayerPastRibbonSegments(chart, note, end + 768, near), []);
  assert.deepEqual(getPlayerPastRibbonSegments(chart, createNote('AIR', 0), 96, near), []);
});

test('reversed scrolling does not bring elapsed AIR SLIDE parts back in front of the judgement line', () => {
  const { chart, note } = reversingChart();
  for (const tick of [4000, 4800, 5700, 7000])
    for (const segment of getPlayerPastRibbonSegments(chart, note, tick, -5))
      assert.ok(segment.startDistance <= 1e-12 && segment.endDistance <= 1e-12 && segment.endTick <= tick);
});
