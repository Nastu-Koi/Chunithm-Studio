import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createChart, createNote, type Chart, type Note } from '../src/core/model';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { buildJudgementTimeline, getAutoScoreAtTick } from '../src/core/judgement';

function segment(type: Note['type'], tick: number, duration: number, normal = true): Note {
  const note = createNote(type, tick, 0, 2);
  note.duration = duration; note.attributes.visible = normal;
  return note;
}
function chart(...notes: Note[]): Chart { return { ...createChart(), defaultBpm: 150, notes }; }

test('short notes and successful DAMAGE avoidance contribute independently, including simultaneous notes', () => {
  const timeline = buildJudgementTimeline(chart(createNote('TAP', 0, 0, 2), createNote('EXTAP', 96, 2, 2), createNote('FLICK', 96, 4, 2), createNote('AIR', 192, 0, 2), createNote('DAMAGE', 288, 0, 2)));
  assert.deepEqual(timeline.counts, { TAP: 3, HLD: 0, SLD: 0, AIR: 1, FLK: 1 });
  assert.equal(timeline.points.at(-1)?.kind, 'avoid');
  assert.deepEqual(getAutoScoreAtTick(timeline, -1), { combo: 0, score: 0, total: 5 });
  assert.deepEqual(getAutoScoreAtTick(timeline, 96), { combo: 3, score: 606000, total: 5 });
  assert.deepEqual(getAutoScoreAtTick(timeline, Infinity), { combo: 5, score: 1010000, total: 5 });
  assert.equal(getAutoScoreAtTick(timeline, 0).combo, 1, 'backwards seeking is stateless');
});

test('HOLD tails with an attached AIR replace the release window, including fractional final intervals', () => {
  const hold = segment('HOLD', 0, 72), air = createNote('AIR', 72, 0, 2); air.attributes.parent = 'HLD';
  assert.equal(buildJudgementTimeline(chart(hold)).counts.HLD, 2);
  assert.equal(buildJudgementTimeline(chart(hold, air)).counts.HLD, 0);
  const longer = { ...hold, duration: 192 };
  const later = { ...air, tick: 192 };
  assert.equal(buildJudgementTimeline(chart(longer, later)).counts.HLD, 3);
});

test('one AIR can consume only one coincident ground tail', () => {
  const one = segment('HOLD', 0, 192), two = segment('HOLD', 0, 192), air = createNote('AIR', 192, 0, 2); air.attributes.parent = 'HLD';
  assert.equal(buildJudgementTimeline(chart(one, two, air)).counts.HLD, 7);
});

test('SLIDE control points keep a continuous section; normal points restart its continuation grid', () => {
  const first = segment('SLIDE', 0, 72, false), second = segment('SLIDE', 72, 72);
  assert.deepEqual(buildJudgementTimeline(chart(first, second)).counts, { TAP: 1, HLD: 0, SLD: 3, AIR: 0, FLK: 0 });
  first.attributes.visible = true;
  assert.equal(buildJudgementTimeline(chart(first, second)).counts.SLD, 4);
});

test('AIR-HOLD normal ends have actions; controls have no action and truncate fractional sustain windows', () => {
  const normal = segment('AIR_HOLD', 0, 141); normal.attributes.parent = 'TAP';
  const control = { ...normal, attributes: { ...normal.attributes, visible: false } };
  assert.equal(buildJudgementTimeline(chart(normal)).counts.AIR, 3);
  assert.equal(buildJudgementTimeline(chart(control)).counts.AIR, 1);
  const leading = segment('AIR_HOLD', 0, 72, false), trailing = segment('AIR_HOLD', 72, 120); trailing.attributes.parent = 'AHD';
  assert.equal(buildJudgementTimeline(chart(leading, trailing)).counts.AIR, 4);
});

test('AIR-SLIDE ASC/ASD parent matching preserves independent chains and endpoint actions', () => {
  const first = segment('AIR_SLIDE', 0, 72, false), next = segment('AIR_SLIDE', 72, 120); next.attributes.parent = 'ASC';
  const linked = buildJudgementTimeline(chart(first, next));
  assert.equal(linked.points.filter(p => p.kind === 'head').length, 1);
  assert.equal(linked.counts.AIR, 4);
  next.attributes.parent = 'ASD';
  assert.equal(buildJudgementTimeline(chart(first, next)).points.filter(p => p.kind === 'head').length, 2);
});

test('AIR-CRUSH counts explicit intervals including endpoints and ignores visual-only interval zero', () => {
  const crush = segment('AIR_CRUSH', 0, 40); crush.attributes.interval = 20;
  assert.deepEqual(buildJudgementTimeline(chart(crush)).points.map(p => p.tick), [0, 20, 40]);
  crush.attributes.interval = 0;
  assert.equal(buildJudgementTimeline(chart(crush)).total, 0);
});

test('PROGJUDGE_BPM supports the native power-of-two continuation bands', () => {
  for (const [bpm, threshold, expected] of [[114, 240, 16], [150, 240, 8], [243, 240, 4], [243, 480, 8], [122, 1200, 64], [150, 7.5, 1]]) {
    const c = chart(segment('HOLD', 0, 384)); c.defaultBpm = bpm;
    c.headerRecords.push({ id: 'prog', kind: 'header', tag: 'PROGJUDGE_BPM', raw: `PROGJUDGE_BPM\t${threshold}`, ending: '\n' });
    assert.equal(buildJudgementTimeline(c).counts.HLD, expected, `${bpm}/${threshold}`);
  }
});

test('statistics are a comparison only, never a denominator or substitute for edited notes', () => {
  const c = parseC2S('VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 150\nT_JUDGE_TAP 99\nT_JUDGE_ALL 99\nTAP 0 0 0 2\n');
  const timeline = buildJudgementTimeline(c);
  assert.equal(timeline.total, 1); assert.equal(timeline.header.matches, false);
  assert.equal(timeline.status, 'estimated');
  assert.equal(buildJudgementTimeline(c), timeline, 'immutable chart timeline is cached');
  const edited = { ...c, notes: [...c.notes, createNote('TAP', 96, 2, 2)] };
  assert.equal(buildJudgementTimeline(edited).total, 2);
  assert.equal(buildJudgementTimeline(edited).header.matches, null);
});

test('unknown records and nondefault AER are visibly downgraded', () => {
  const unknown = parseC2S('VERSION 1.15.00 1.15.00\nNEW_UNKNOWN 0 0 1\nTAP 0 0 0 2\n');
  assert.equal(buildJudgementTimeline(unknown).status, 'unsupported');
  const parameter = parseC2S('VERSION 1.15.00 1.15.00\nPROGJUDGE_AER 0.5\nTAP 0 0 0 2\n');
  assert.equal(buildJudgementTimeline(parameter).status, 'estimated');
});

// Native music remains outside the repository. Missing installations skip these read-only checks.
for (const [id, difficulty] of [['0003', '00'], ['0003', '03'], ['0051', '00'], ['0103', '00'], ['2892', '03'], ['0063', '04']] as const) {
  const file = `/mnt/d/chunithm/data/A000/music/music${id}/${id}_${difficulty}.c2s`;
  test(`native ${id}_${difficulty}: independent counts agree with all original categories`, { skip: !existsSync(file) }, () => {
    const timeline = buildJudgementTimeline(parseC2S(readFileSync(file, 'utf8')));
    assert.equal(timeline.header.matches, true, JSON.stringify(timeline.header.differences));
    assert.equal(getAutoScoreAtTick(timeline, Infinity).score, 1010000);
    if (id === '2892') assert.deepEqual(timeline.counts, { TAP: 1471, HLD: 94, SLD: 153, AIR: 301, FLK: 36 });
  });
}

test('AIR-CRUSH continuation segments share one interval phase rather than restarting each shape segment', () => {
  const a = segment('AIR_CRUSH', 0, 2), b = segment('AIR_CRUSH', 2, 3), c = segment('AIR_CRUSH', 5, 7);
  for (const note of [a, b, c]) note.attributes.interval = 6;
  const points = buildJudgementTimeline(chart(a, b, c)).points;
  assert.deepEqual(points.map(p => p.tick), [0, 6, 12]);
  assert.deepEqual(points.map(p => p.noteId), [a.id, c.id, c.id]);
  c.attributes.interval = 7;
  assert.deepEqual(buildJudgementTimeline(chart(a, b, c)).points.map(p => p.tick), [0, 5, 12]);
});

test('continuation intervals read the BPM at each step and cap very high tempos', () => {
  const c = chart(segment('HOLD', 0, 192)); c.defaultBpm = 150;
  c.events.push({ id: 'bpm', type: 'BPM', tick: 96, value: 90 });
  assert.deepEqual(buildJudgementTimeline(c).points.filter(p => p.category === 'HLD').map(p => p.tick), [48, 96, 120, 144, 168, 192]);
  const veryFast = chart(segment('HOLD', 0, 876)); veryFast.defaultBpm = 9700;
  assert.deepEqual(buildJudgementTimeline(veryFast).points.filter(p => p.category === 'HLD').map(p => p.tick), [384, 768, 876]);
});

test('a shared global judgement budget bounds multiple enormous WORLD’S END runs', () => {
  const a = segment('AIR_CRUSH', 0, 200000), b = segment('AIR_CRUSH', 0, 200000);
  a.attributes.interval = b.attributes.interval = 1; b.lane = 4;
  const timeline = buildJudgementTimeline(chart(a, b));
  assert.equal(timeline.total, 250000);
  assert.equal(timeline.status, 'unsupported');
  assert.ok(timeline.diagnostics.some(d => d.includes('截断')));
});

for (const relative of ['bin/option/A300/music/music2211/2211_03.c2s', 'data/A000/music/music2343/2343_03.c2s', 'data/A000/music/music2185/2185_01.c2s', 'bin/option/A300/music/music8054/8054_04.c2s', 'bin/option/A300/music/music8073/8073_04.c2s', 'bin/option/A300/music/music8067/8067_04.c2s', 'data/A000/music/music0203/0203_04.c2s', 'bin/option/A300/music/music8217/8217_05.c2s', 'bin/option/A300/music/music8218/8218_05.c2s', 'bin/option/A300/music/music8260/8260_05.c2s']) {
  const file = `/mnt/d/chunithm/${relative}`;
  test(`native extreme BPM / PROG / CRUSH ${relative}: all statistics agree`, { skip: !existsSync(file) }, () => {
    const timeline = buildJudgementTimeline(parseC2S(readFileSync(file, 'utf8')));
    assert.equal(timeline.header.matches, true, JSON.stringify(timeline.header.differences));
  });
}


test('invalid imported time ranges and CRUSH intervals are rejected before progression allocation', () => {
  for (const duration of [-96, NaN, Infinity]) {
    const timeline = buildJudgementTimeline(chart(segment('HOLD', 0, duration)));
    assert.equal(timeline.status, 'unsupported'); assert.equal(timeline.total, 0);
  }
  const negative = segment('HOLD', -100000000, 100000000);
  const timeline = buildJudgementTimeline(chart(...Array.from({ length: 20 }, (_, index) => ({ ...negative, id: `invalid-${index}` }))));
  assert.equal(timeline.total, 0); assert.match(timeline.diagnostics.join(' '), /20 个音符/);
  for (const interval of [-1, NaN, Infinity]) {
    const crush = segment('AIR_CRUSH', 0, 1000); crush.attributes.interval = interval;
    assert.equal(buildJudgementTimeline(chart(crush)).status, 'unsupported');
    assert.equal(buildJudgementTimeline(chart(crush)).total, 0);
  }
});

test('invalid BPM or resolution creates no spurious points; fractional valid ticks remain valid', () => {
  for (const value of [0, -1, NaN, Infinity]) {
    assert.equal(buildJudgementTimeline({ ...chart(segment('HOLD', 0, 384)), resolution: value }).total, 0);
    const timeline = buildJudgementTimeline({ ...chart(segment('HOLD', 0, 384)), defaultBpm: value });
    assert.equal(timeline.status, 'unsupported'); assert.equal(timeline.total, 0);
    const changed = chart(segment('HOLD', 0, 384)); changed.events = [{ id: 'bad', type: 'BPM', tick: 96, value }];
    assert.equal(buildJudgementTimeline(changed).total, 0);
  }
  const fraction = buildJudgementTimeline(chart(segment('HOLD', 384 / 7, 384 / 7)));
  assert.notEqual(fraction.status, 'unsupported'); assert.equal(fraction.points[0].tick, 384 / 7);
});


test('a representable positive sub-tick HOLD duration retains its tail judgement', () => {
  for (const duration of [1e-7, 1e-8, 1e-9, Number.EPSILON]) {
    const note = segment('HOLD', 1 / 7, duration), timeline = buildJudgementTimeline(chart(note));
    assert.equal(timeline.counts.HLD, 1);
    assert.equal(timeline.points.at(-1)?.tick, note.tick + duration);
  }
});


test('native sequential AIR binding sees current SLIDE tails, not earlier segments already extended', () => {
  const a = segment('SLIDE', 0, 192, false);
  const b = segment('SLIDE', 156, 12), c = segment('SLIDE', 168, 12), d = segment('SLIDE', 180, 12);
  const continuation = segment('SLIDE', 192, 48), air = createNote('AIR', 192, 0, 2);
  air.attributes.parent = 'SLD';
  const timeline = buildJudgementTimeline(chart(a, b, c, d, continuation, air));
  assert.equal(timeline.counts.SLD, 5);
  assert.deepEqual(timeline.points.filter(p => p.category === 'SLD').map(p => p.noteId), Array(5).fill(continuation.id));
});

test('SLIDE continuation selects the earliest created root, independent of when endpoints arrived', () => {
  const a = segment('SLIDE', 0, 60, false), b = segment('SLIDE', 12, 168);
  const aNext = segment('SLIDE', 60, 120, false), tail = segment('SLIDE', 180, 48);
  const timeline = buildJudgementTimeline(chart(a, b, aNext, tail));
  assert.equal(timeline.counts.TAP, 2); assert.equal(timeline.counts.SLD, 9);
  assert.equal(timeline.points.filter(p => p.noteId === tail.id && p.category === 'SLD').length, 5);
});

test('native SLIDE parent families remain separate even at coincident endpoints', () => {
  const first = segment('SLIDE', 0, 96), second = segment('SLIDE', 96, 96);
  first.attributes.parent = 'SLD'; second.attributes.parent = 'NCL';
  assert.equal(buildJudgementTimeline(chart(first, second)).counts.TAP, 2);
});


test('reader ordering follows original records until entities change, then follows exported chronological order', () => {
  const original = parseC2S('VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 150\nSLD 0 96 0 2 96 0 2 SLD\nSLD 0 0 0 2 96 0 2 SLD\n');
  const reordered = { ...original, notes: [...original.notes].reverse() };
  assert.equal(buildJudgementTimeline(original).counts.TAP, 2);
  assert.equal(buildJudgementTimeline(reordered).counts.TAP, 2);
  const edited = { ...original, notes: original.notes.map((n, i) => i ? n : { ...n, duration: 192 }) };
  const timeline = buildJudgementTimeline(edited);
  assert.equal(timeline.counts.TAP, 1);
  assert.deepEqual(timeline.counts, buildJudgementTimeline(parseC2S(serializeC2S(edited))).counts);
});

function asTutorial(c: Chart): Chart {
  return { ...c, headerRecords: [...c.headerRecords, { id: 'tutorial', kind: 'header', tag: 'TUTORIAL', raw: 'TUTORIAL 1', ending: '\n' }] };
}

test('tutorial AIR-attached ground roots retain heads but disable their entire continuation vector', () => {
  const hold = segment('HOLD', 0, 192), slide = segment('SLIDE', 384, 192);
  const holdAir = createNote('AIR', 192, 0, 2); holdAir.attributes.parent = 'HLD';
  const slideAir = createNote('AIR', 576, 0, 2); slideAir.attributes.parent = 'SLD';
  const base = chart(hold, holdAir, slide, slideAir);
  assert.deepEqual(buildJudgementTimeline(base).counts, { TAP: 2, HLD: 3, SLD: 3, AIR: 2, FLK: 0 });
  assert.deepEqual(buildJudgementTimeline(asTutorial(base)).counts, { TAP: 2, HLD: 0, SLD: 0, AIR: 2, FLK: 0 });
});

test('tutorial SFL zero suppresses sustained/action points strictly inside the freeze but retains boundaries and heads', () => {
  const hold = segment('HOLD', 0, 192), air = segment('AIR_HOLD', 0, 192);
  const crush = segment('AIR_CRUSH', 48, 96); crush.attributes.interval = 48;
  const base = chart(hold, air, createNote('TAP', 96, 4, 2), createNote('AIR', 96, 4, 2), crush);
  base.events = [{ id: 'freeze', type: 'SCROLL', tick: 48, duration: 96, value: 0 }];
  const timeline = buildJudgementTimeline(asTutorial(base));
  assert.deepEqual(timeline.points.filter(p => p.category === 'HLD').map(p => p.tick), [48, 144, 192]);
  assert.deepEqual(timeline.points.filter(p => p.noteId === air.id).map(p => p.tick), [0, 48, 192]);
  assert.equal(timeline.points.filter(p => p.tick === 96 && p.kind === 'head').length, 2);
  assert.deepEqual(timeline.points.filter(p => p.kind === 'crush').map(p => p.tick), [48, 96, 144]);
  assert.equal(buildJudgementTimeline(base).counts.HLD, 4, 'ordinary charts do not gain tutorial freeze rules');
});


test('SLIDE column 8 is the native SLD/NCL enum: an SXD spelling falls back to SLD', () => {
  const first = segment('SLIDE', 0, 96), second = segment('SLIDE', 96, 96);
  first.attributes.parent = 'SLD'; second.attributes.parent = 'SXD';
  assert.equal(buildJudgementTimeline(chart(first, second)).counts.TAP, 1);
});
