/** Read-only game corpus audit. Writes only aggregate numbers and paths, never native chart contents. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { scanLibrary } from '../src/backend/library';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { buildJudgementTimeline, JUDGEMENT_CATEGORIES } from '../src/core/judgement';
const argument = (name: string): string | undefined => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const gameRoot = process.env.CHUNI_GAME_ROOT ?? argument('game-root') ?? '/mnt/d/chunithm';
const output = argument('output') ?? 'out/native-judgement-audit.json';
const paths = argument('paths');
const verifyRoundTrip = argument('verify-roundtrip') === 'true';
let roundTripChecked = 0, roundTripMatched = 0;
const library: { key: string; chartPath: string; difficulty: string }[] = paths
  ? JSON.parse(await readFile(paths, 'utf8')).map((e: { key: string; path: string; difficulty: string }) => ({ ...e, chartPath: e.path }))
  : await scanLibrary(gameRoot);
const limit = Number(argument('limit') ?? library.length);
const matched = Object.fromEntries([...JUDGEMENT_CATEGORIES, 'ALL'].map(k => [k, 0]));
const compared = { ...matched }, statuses: Record<string, number> = {}, parameters: Record<string, Record<string, number>> = {};
const failures: unknown[] = [], mismatches: unknown[] = [];
let allMatches = 0, withoutStatistics = 0, processed = 0;
for (const entry of library.slice(0, limit)) {
  try {
    const text = await readFile(entry.chartPath, 'utf8'), chart = parseC2S(text), timeline = buildJudgementTimeline(chart);
    if (verifyRoundTrip) {
      roundTripChecked++;
      if (serializeC2S(chart) === text) roundTripMatched++;
      else failures.push({ key: entry.key, path: entry.chartPath, error: 'C2S byte-exact round trip differs' });
    }
    processed++;
    statuses[timeline.status] = (statuses[timeline.status] ?? 0) + 1;
    const stats = Object.fromEntries(chart.headerRecords.filter(r => /^T_|^PROGJUDGE|^TUTORIAL/.test(r.tag)).map(r => [r.tag, Number(r.raw.trim().split(/\s+/)[1])]));
    for (const name of ['PROGJUDGE_BPM', 'PROGJUDGE_AER', 'TUTORIAL']) { const value = String(stats[name]); const map = parameters[name] ??= {}; map[value] = (map[value] ?? 0) + 1; }
    if (!timeline.header.available) { withoutStatistics++; continue; }
    if (timeline.header.matches) allMatches++;
    for (const k of [...JUDGEMENT_CATEGORIES, 'ALL'] as const) if (timeline.header.expected[k] !== undefined) {
      compared[k]++; if (timeline.header.expected[k] === (k === 'ALL' ? timeline.total : timeline.counts[k])) matched[k]++;
    }
    if (timeline.header.differences.length) mismatches.push({ key: entry.key, path: entry.chartPath, difficulty: entry.difficulty, version: chart.version, bpm: chart.defaultBpm, bpmEvents: chart.events.filter(e => e.type === 'BPM').length, noteTypes: chart.notes.reduce((r, n) => { r[n.type] = (r[n.type] ?? 0) + 1; return r; }, {} as Record<string, number>), differences: timeline.header.differences, parameters: Object.fromEntries(['PROGJUDGE_BPM', 'PROGJUDGE_AER', 'TUTORIAL'].map(k => [k, stats[k]])) });
  } catch (error) { failures.push({ key: entry.key, path: entry.chartPath, error: error instanceof Error ? error.message : String(error) }); }
}
const report = { generatedAt: new Date().toISOString(), gameRoot, enabledCharts: library.length, processed, allMatches, withoutStatistics, matched, compared, statuses, parameters, roundTrip: { checked: roundTripChecked, matched: roundTripMatched }, mismatches, failures };
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, mismatches: mismatches.slice(0, 8) }, null, 2));
if (failures.length) process.exitCode = 1;
