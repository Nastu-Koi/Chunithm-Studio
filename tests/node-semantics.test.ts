import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseC2S, serializeC2S, getNativeNoteTag } from '../src/core/c2s';
import { createChart, createNote, type Note } from '../src/core/model';
import { getNotePlaybackPoints, tickToSeconds } from '../src/core/timing';
import { appendEditorNote, setEditorNodeKind, splitEditorNote, inferEditorParent } from '../src/renderer/editor';
import { getChartHits } from '../src/renderer/transport';
import { getPlayerPlaybackPoints } from '../src/renderer/playback-points';
import { buildJudgementTimeline } from '../src/core/judgement';

function segment(type: Note['type'], tick: number, duration: number, control = false) {
  const note = createNote(type, tick, 0, 2);
  note.duration = duration;
  note.attributes.visible = !control;
  return note;
}
const points = (chart: ReturnType<typeof createChart>, note: Note) =>
  getNotePlaybackPoints(chart, note).map(point => [point.position, point.tick, point.type, point.sound]);

test('all native connection variants survive untouched input and retain additional columns after type edits', () => {
  for (const row of [
    'SLD 0 0 0 2 96 0 2 SLD EXTRA',
    'SLC 0 0 0 2 96 0 2 SLD EXTRA',
    'SXD 0 0 0 2 96 0 2 SLD UP EXTRA',
    'SXC 0 0 0 2 96 0 2 SLD UP EXTRA',
    'AHD 0 0 0 2 TAP 96 DEF EXTRA',
    'AHX 0 0 0 2 TAP 96 DEF EXTRA',
    'ASD 0 0 0 2 TAP 1.0 96 0 2 1.0 DEF EXTRA',
    'ASC 0 0 0 2 TAP 1.0 96 0 2 1.0 DEF EXTRA',
  ]) {
    const text = `VERSION\t1.15.00\t1.15.00\r\nRESOLUTION\t384\r\n${row}\r\n`,
      chart = parseC2S(text);
    assert.equal(serializeC2S(chart), text);
    const note = chart.notes[0],
      other = setEditorNodeKind(chart, note.id, note.attributes.visible === false ? 'normal' : 'control');
    const output = serializeC2S(other),
      reread = parseC2S(output);
    assert.notEqual(getNativeNoteTag(reread.notes[0]), row.slice(0, 3));
    assert.match(output, /EXTRA\r\n/);
  }
});

test('SLC/SXC true heads remain visible/audible; joint flags act at their segment ends', () => {
  for (const ex of [false, true]) {
    const first = segment('SLIDE', 0, 96, true),
      second = segment('SLIDE', 96, 96),
      last = segment('SLIDE', 192, 96, true);
    first.attributes.ex = ex;
    second.attributes.ex = ex;
    last.attributes.ex = ex;
    const chart = { ...createChart(), notes: [first, second, last] };
    assert.deepEqual(points(chart, first), [['head', 0, 'SLIDE', true]]);
    assert.deepEqual(points(chart, second), [['end', 192, 'SLIDE', true]]);
    assert.deepEqual(points(chart, last), []);
    assert.deepEqual(
      getChartHits(chart).map(hit => hit.time),
      [0, tickToSeconds(chart, 192)],
    );
  }
});

test('AHD/AHX retain their sustain head but only AHD produces an end action', () => {
  const first = segment('AIR_HOLD', 0, 96, true),
    second = segment('AIR_HOLD', 96, 96);
  first.attributes.parent = 'TAP';
  second.attributes.parent = 'AHD';
  const chart = { ...createChart(), notes: [first, second] };
  assert.deepEqual(points(chart, first), [['head', 0, 'AIR', true]]);
  assert.deepEqual(points(chart, second), [['end', 192, 'AIR_HOLD', true]]);
  assert.deepEqual(
    getChartHits(chart).map(hit => [hit.time, hit.type]),
    [
      [0, 'AIR'],
      [tickToSeconds(chart, 192), 'AIR_HOLD'],
    ],
  );
});

test('ASD/ASC controls follow predecessor tags and emit only normal endpoint actions', () => {
  const first = segment('AIR_SLIDE', 0, 96, true),
    second = segment('AIR_SLIDE', 96, 96);
  first.attributes.parent = 'TAP';
  second.attributes.parent = 'ASC';
  const chart = { ...createChart(), notes: [first, second] };
  assert.deepEqual(points(chart, first), [['head', 0, 'AIR', true]]);
  assert.deepEqual(points(chart, second), [['end', 192, 'AIR_SLIDE', true]]);
  const updated = setEditorNodeKind(chart, first.id, 'normal');
  assert.equal(updated.notes[1].attributes.parent, 'ASD');
  assert.deepEqual(points(updated, updated.notes[1]), [['end', 192, 'AIR_SLIDE', true]]);
  assert.equal(chart.notes[1].attributes.parent, 'ASC');
});

test('a valid AHD chain has one implicit AIR head and one action at a repeated zero-length endpoint', () => {
  const hold = segment('AIR_HOLD', 0, 96),
    endpoint = segment('AIR_HOLD', 96, 0),
    tap = createNote('TAP', 0, 0, 2);
  hold.attributes.parent = 'TAP';
  endpoint.attributes.parent = 'AHD';
  const chart = { ...createChart(), notes: [tap, hold, endpoint] };
  const timeline = buildJudgementTimeline(chart);
  assert.notEqual(timeline.status, 'unsupported');
  assert.deepEqual(
    timeline.points.filter(p => p.kind === 'head' && p.category === 'AIR').map(p => p.noteId),
    [hold.id],
  );
  assert.deepEqual(
    getPlayerPlaybackPoints(chart, hold).map(p => [p.position, p.tick, p.type]),
    [
      ['head', 0, 'AIR'],
      ['end', 96, 'AIR_HOLD'],
    ],
  );
  assert.deepEqual(getPlayerPlaybackPoints(chart, endpoint), []);
  assert.deepEqual(
    getChartHits(chart).map(hit => hit.key),
    [`${tap.id}:head`, `${hold.id}:head`, `${hold.id}:end`],
  );
});

test('explicit AIR and AHD on independent coincident native parents retain both heads without duplicating either', () => {
  const tap = createNote('TAP', 0, 0, 2),
    otherTap = createNote('TAP', 0, 0, 2),
    air = createNote('AIR', 0, 0, 2);
  const hold = segment('AIR_HOLD', 0, 96),
    endpoint = segment('AIR_HOLD', 96, 0);
  air.attributes.parent = hold.attributes.parent = 'TAP';
  endpoint.attributes.parent = 'AHD';
  const chart = { ...createChart(), notes: [tap, otherTap, air, hold, endpoint] };
  const timeline = buildJudgementTimeline(chart);
  assert.notEqual(timeline.status, 'unsupported');
  assert.deepEqual(
    timeline.points.filter(p => p.kind === 'head' && p.category === 'AIR').map(p => p.noteId),
    [air.id, hold.id],
  );
  const visibleAirHeads = chart.notes
    .flatMap(note => getPlayerPlaybackPoints(chart, note))
    .filter(p => p.position === 'head' && p.type === 'AIR');
  assert.deepEqual(
    visibleAirHeads.map(p => p.noteId),
    [air.id, hold.id],
  );
  assert.deepEqual(
    getChartHits(chart)
      .filter(hit => hit.type === 'AIR')
      .map(hit => hit.key),
    [`${air.id}:head`, `${hold.id}:head`],
  );
  assert.deepEqual(
    getChartHits(chart)
      .filter(hit => hit.type === 'AIR_HOLD')
      .map(hit => hit.key),
    [`${hold.id}:end`],
  );
});

test('missing native parents are reported rather than letting explicit AIR erase an orphan AHD preview head', () => {
  // AIR occupies one native ground root's AIR slot. It is not an AHD parent,
  // and identical geometry alone cannot make the two records share a head.
  const air = createNote('AIR', 0, 0, 2),
    hold = segment('AIR_HOLD', 0, 96),
    endpoint = segment('AIR_HOLD', 96, 0);
  air.attributes.parent = hold.attributes.parent = 'TAP';
  endpoint.attributes.parent = 'AHD';
  for (const ground of [[], [createNote('TAP', 0, 0, 2)]]) {
    const chart = { ...createChart(), notes: [...ground, air, hold, endpoint] };
    const timeline = buildJudgementTimeline(chart);
    assert.equal(timeline.status, 'unsupported');
    assert.ok(timeline.diagnostics.some(message => message.includes('缺少匹配的原生父音符')));
    assert.deepEqual(
      getChartHits(chart)
        .filter(hit => hit.type === 'AIR')
        .map(hit => hit.key),
      [`${air.id}:head`, `${hold.id}:head`],
    );
    assert.deepEqual(
      getChartHits(chart)
        .filter(hit => hit.type === 'AIR_HOLD')
        .map(hit => hit.key),
      [`${hold.id}:end`],
    );
  }
});

for (const type of ['SLIDE', 'AIR_HOLD', 'AIR_SLIDE'] as const) {
  test(`${type}: inserting a control joint preserves the original normal end; append selects the new end only`, () => {
    const original = segment(type, 0, 192);
    original.attributes.parent = 'TAP';
    const chart = { ...createChart(), notes: [original] };
    const split = splitEditorNote(chart, original.id, 96, 'control');
    assert.deepEqual(
      split.notes.map(note => note.attributes.visible),
      [false, true],
    );
    assert.equal(split.notes[1].attributes.parent, type === 'AIR_SLIDE' ? 'ASC' : type === 'AIR_HOLD' ? 'AHD' : 'SLD');
    const appended = appendEditorNote(split, split.notes[1].id, 288, 0, 2, 'control');
    assert.deepEqual(
      appended.notes.map(note => note.attributes.visible),
      [false, true, false],
    );
    assert.equal(
      appended.notes[2].attributes.parent,
      type === 'AIR_SLIDE' ? 'ASD' : type === 'AIR_HOLD' ? 'AHD' : 'SLD',
    );
    const roundtrip = parseC2S(serializeC2S(appended));
    assert.deepEqual(roundtrip.notes.map(getNativeNoteTag), appended.notes.map(getNativeNoteTag));
    assert.equal(original.attributes.visible, true);
  });
}

test('node sounds retain their exact positions through a BPM change', () => {
  const first = segment('AIR_SLIDE', 0, 384),
    second = segment('AIR_SLIDE', 384, 384, true);
  second.attributes.parent = 'ASD';
  const chart = {
    ...createChart(),
    defaultBpm: 120,
    notes: [first, second],
    events: [{ id: 'bpm', type: 'BPM' as const, tick: 192, value: 240 }],
  };
  assert.deepEqual(
    getChartHits(chart).map(hit => [hit.time, hit.type]),
    [
      [0, 'AIR'],
      [1.5, 'AIR_SLIDE'],
    ],
  );
});

const nativePath = '/mnt/d/chunithm/data/A000/music/music0067/0067_04.c2s';
test(
  'read-only native examples retain exact tags and SLC starts are not lost',
  { skip: !existsSync(nativePath) },
  () => {
    const text = readFileSync(nativePath, 'utf8'),
      chart = parseC2S(text);
    assert.equal(serializeC2S(chart), text);
    const start = chart.notes.find(note => note.tick === 5 * 384 + 336 && note.lane === 0 && note.type === 'SLIDE')!;
    assert.equal(getNativeNoteTag(start), 'SLC');
    assert.ok(getNotePlaybackPoints(chart, start).some(point => point.position === 'head'));
    for (const note of chart.notes.filter(note => note.native?.tag === 'AHX'))
      assert.ok(!getNotePlaybackPoints(chart, note).some(point => point.position === 'end'));
  },
);

test('AIR attached to EX/control ground segments exports generic HLD/SLD parents', () => {
  for (const type of ['HOLD', 'SLIDE'] as const)
    for (const control of [false, true]) {
      const note = segment(type, 0, 96, control);
      note.attributes.ex = true;
      assert.equal(inferEditorParent({ ...createChart(), notes: [note] }, 96, 0, 2), type === 'HOLD' ? 'HLD' : 'SLD');
    }
});

test('editing one colored AIR SLIDE chain leaves the coincident other chain and both actions intact', () => {
  const a = segment('AIR_SLIDE', 0, 96, true),
    b = segment('AIR_SLIDE', 96, 96);
  const c = segment('AIR_SLIDE', 0, 96, true),
    d = segment('AIR_SLIDE', 96, 96);
  a.attributes.color = b.attributes.color = 'DEF';
  c.attributes.color = d.attributes.color = 'RED';
  b.attributes.parent = d.attributes.parent = 'ASC';
  const chart = { ...createChart(), notes: [a, b, c, d] };
  const updated = setEditorNodeKind(chart, a.id, 'normal');
  assert.equal(updated.notes[1].attributes.parent, 'ASD');
  assert.equal(updated.notes[3].attributes.parent, 'ASC');
  assert.ok(!getNotePlaybackPoints(updated, updated.notes[3]).some(point => point.position === 'head'));
  assert.equal(getChartHits(updated).filter(hit => hit.time === tickToSeconds(updated, 192)).length, 2);
});

test('zero-length normal endpoint after a control segment adds the previously absent action', () => {
  const first = segment('AIR_HOLD', 0, 96, true),
    endpoint = segment('AIR_HOLD', 96, 0);
  endpoint.attributes.parent = 'AHD';
  const chart = { ...createChart(), notes: [first, endpoint] };
  assert.deepEqual(points(chart, endpoint), [['end', 96, 'AIR_HOLD', true]]);
});

test('zero-length ASC height controls connect their following segment without creating another head', () => {
  const first = segment('AIR_SLIDE', 0, 96, true),
    control = segment('AIR_SLIDE', 96, 0, true),
    next = segment('AIR_SLIDE', 96, 96, true);
  first.height = first.endHeight = control.height = 1;
  control.endHeight = next.height = next.endHeight = 2;
  control.attributes.parent = next.attributes.parent = 'ASC';
  const chart = { ...createChart(), notes: [first, control, next] };
  assert.deepEqual(points(chart, control), []);
  assert.deepEqual(points(chart, next), []);
  assert.deepEqual(
    getChartHits(chart).map(hit => hit.time),
    [0],
  );
});
