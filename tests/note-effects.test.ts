import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote } from '../src/core/model';
import { buildNoteEffectEvents, recentNoteEffects } from '../src/renderer/note-effects';
import { getPlayerCrushTickIndex, getPlayerCrushTopIndex } from '../src/renderer/player';
import { buildJudgementTimeline } from '../src/core/judgement';
import { AIR_LINE_HEIGHT } from '../src/renderer/native-notes';
import { clipNativeMeshZ } from '../src/renderer/clip-native-mesh';

test('native effect events retain one connected slide head, chain/end roles and deterministic seeks', () => {
  const chart = createChart();
  chart.notes = [createNote('SLIDE', 0, 0, 4), createNote('SLIDE', 96, 0, 4)];
  const events = buildNoteEffectEvents(chart);
  assert.deepEqual(
    events.map(e => e.kind),
    ['Slide', 'SlideChain', 'SlideEnd'],
  );
  assert.equal(recentNoteEffects(events, 0.6, 0.2)[0].kind, 'SlideChain');
  assert.deepEqual(recentNoteEffects(events, 0.6, 0.2), recentNoteEffects(events, 0.6, 0.2));
  assert.deepEqual(recentNoteEffects(events, -0.1, 2), []);
  assert.deepEqual(recentNoteEffects(events, 5, 2), []);
});

test('native CRUSH top occurs once across connected segments; effects retain all interval judgements at raw height 5', () => {
  const chart = createChart();
  const a = createNote('AIR_CRUSH', 0, 4, 4),
    b = createNote('AIR_CRUSH', 96, 4, 4),
    c = createNote('AIR_CRUSH', 192, 8, 4);
  chart.notes = [a, b, c];
  const timeline = buildJudgementTimeline(chart),
    ticks = getPlayerCrushTickIndex(timeline),
    tops = getPlayerCrushTopIndex(chart, ticks);
  assert.deepEqual(
    [...tops],
    [
      [a.id, 0],
      [c.id, 192],
    ],
  );
  const events = buildNoteEffectEvents(chart);
  assert.equal(events.length, timeline.points.filter(p => p.kind === 'crush').length);
  assert.ok(events.every(e => e.kind === 'AirLadder' && Math.abs(e.y - AIR_LINE_HEIGHT) < 0.00001));
});

test('source mesh clipping retains full-strip UVs and interpolates colors at adjacent segment cuts', () => {
  const mesh = {
    vertices: [
      {
        position: [-1, 0, 0] as [number, number, number],
        uv: [0, 0] as [number, number],
        color: [1, 0, 0, 0.2] as [number, number, number, number],
      },
      {
        position: [1, 0, 0] as [number, number, number],
        uv: [1, 0] as [number, number],
        color: [1, 0, 0, 0.2] as [number, number, number, number],
      },
      {
        position: [-1, 0, -4] as [number, number, number],
        uv: [0, 1] as [number, number],
        color: [0, 1, 0, 1] as [number, number, number, number],
      },
      {
        position: [1, 0, -4] as [number, number, number],
        uv: [1, 1] as [number, number],
        color: [0, 1, 0, 1] as [number, number, number, number],
      },
    ],
    indices: [0, 1, 2, 2, 1, 3],
  };
  const first = clipNativeMeshZ(mesh, -2, 0),
    second = clipNativeMeshZ(mesh, -4, -2);
  for (const part of [first, second]) {
    assert.ok(part.indices.length > 0);
    for (const vertex of part.vertices.filter(v => v.position[2] === -2)) {
      assert.equal(vertex.uv[1], 0.5);
      assert.equal(vertex.color[0], 0.5);
      assert.ok(Math.abs(vertex.color[3] - 0.6) < 1e-9);
    }
  }
  assert.ok(first.vertices.every(v => v.uv[1] <= 0.5));
  assert.ok(second.vertices.every(v => v.uv[1] >= 0.5));
});
