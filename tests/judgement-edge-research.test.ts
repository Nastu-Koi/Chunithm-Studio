import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseC2S } from '../src/core/c2s';
import { buildJudgementTimeline } from '../src/core/judgement';

const header = 'VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 150\n';

test('AIR continuation chooses the older ground root even when that AIR head starts later', () => {
  const slide = 'SLD 0 0 0 2 1 4 2 SLD';
  const tap = 'TAP 0 0 4 2';
  const air = [
    'ASC 0 0 4 2 TAP 5 96 4 2 5 DEF',
    'ASC 0 1 4 2 SLD 5 95 4 2 5 DEF',
    'ASC 0 96 4 2 ASC 5 96 2 2 1 DEF',
    'ASC 0 96 4 2 ASC 5 100 6 2 9 DEF',
  ];
  const ordered = parseC2S(header + [slide, tap, ...air].join('\n'));
  const timeline = buildJudgementTimeline(ordered);
  assert.equal(timeline.counts.AIR, 5);
  const longTail = ordered.notes.find(n => n.tick === 96 && n.duration === 96)!;
  assert.deepEqual(timeline.points.filter(p => p.noteId === longTail.id).map(p => p.tick), [49]);
  const tapFirst = parseC2S(header + [tap, slide, ...air].join('\n'));
  assert.equal(buildJudgementTimeline(tapFirst).counts.AIR, 6, 'native root creation order is meaningful; no header totals are supplied');
});

test('AIR continuation preserves ground root order after unequal paths rejoin a shared endpoint', () => {
  const c = parseC2S(header + [
    'TAP 0 0 0 2',
    'TAP 0 0 4 2',
    'ASD 0 0 0 2 TAP 5 49 8 2 5 DEF',
    'ASC 0 0 4 2 TAP 5 96 8 2 5 DEF',
    'ASC 0 49 8 2 ASD 5 47 8 2 5 DEF',
    'ASC 0 96 8 2 ASC 5 96 2 2 1 DEF',
    'ASC 0 96 8 2 ASC 5 100 6 2 9 DEF',
  ].join('\n'));
  const timeline = buildJudgementTimeline(c);
  assert.equal(timeline.counts.AIR, 5);
  const longTail = c.notes.find(n => n.tick === 96 && n.duration === 96)!;
  assert.equal(timeline.points.filter(p => p.noteId === longTail.id).length, 0, 'a terminal control section of 143 ticks has no enabled continuation point');
});

for (const [id, difficulty] of [['0050', '00'], ['2033', '03'], ['2652', '02']] as const) {
  const root = process.env.CHUNI_GAME_ROOT ?? '/mnt/d/chunithm';
  const file = `${root}/data/A000/music/music${id}/${id}_${difficulty}.c2s`;
  test(`native edge ${id}_${difficulty} agrees without total-dependent compensation`, { skip: !existsSync(file) }, () => {
    const chart = parseC2S(readFileSync(file, 'utf8'));
    const timeline = buildJudgementTimeline(chart);
    assert.equal(timeline.header.matches, true, JSON.stringify(timeline.header.differences));
    const noStatistics = { ...chart, headerRecords: chart.headerRecords.filter(r => !r.tag.startsWith('T_')) };
    assert.deepEqual(buildJudgementTimeline(noStatistics).counts, timeline.counts);
  });
}
