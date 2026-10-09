import test from 'node:test';
import assert from 'node:assert/strict';
import { parseC2S } from '../src/core/c2s';
import { buildJudgementTimeline } from '../src/core/judgement';
import { getPlayerPlaybackPoints } from '../src/renderer/playback-points';
import { getChartHits } from '../src/renderer/transport';

test('sound and visual heads follow native record order, including independent coincident chains', () => {
  const chart = parseC2S('VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 150\nSLD 0 96 0 2 96 0 2 SLD\nSLD 0 0 0 2 96 0 2 SLD\n');
  const heads = buildJudgementTimeline(chart).points.filter(p => p.kind === 'head');
  assert.equal(heads.length, 2);
  const visual = chart.notes.flatMap(note => getPlayerPlaybackPoints(chart, note)).filter(p => p.position === 'head');
  assert.deepEqual(new Set(visual.map(p => p.noteId)), new Set(heads.map(p => p.noteId)));
  assert.equal(getChartHits(chart).filter(p => p.key.endsWith(':head')).length, 2);
});

test('native parent families do not hide heads, and AIR replacement does not erase endpoint bars', () => {
  const chart = parseC2S('VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 150\nSLD 0 0 0 2 96 0 2 SLD\nSLD 0 96 0 2 96 0 2 NCL\nAIR 0 192 0 2 SLD\n');
  assert.equal(chart.notes.flatMap(n => getPlayerPlaybackPoints(chart, n)).filter(p => p.position === 'head').length, 3);
  const timeline = buildJudgementTimeline(chart);
  assert.ok(!timeline.diagnostics.some(message => message.includes('缺少匹配')));
  assert.ok(!timeline.points.some(p => p.category === 'SLD' && p.tick === 192));
  assert.ok(getPlayerPlaybackPoints(chart, chart.notes[1]).some(p => p.position === 'end' && p.tick === 192));
});
