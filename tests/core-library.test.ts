import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanLibrary } from '../src/backend/library';
import { parseC2S, serializeC2S, validateChart } from '../src/core';

const gameRoot = process.env.CHUNI_GAME_ROOT;
test('optional entire enabled game library: exact C2S preservation and complete decoding', { skip: !gameRoot }, async context => {
  const library = await scanLibrary(gameRoot!);
  assert.ok(library.length > 0);
  const failures: string[] = [];
  const tags = new Map<string, number>();
  let parsed = 0;
  for (const entry of library) {
    try {
      const original = await readFile(entry.chartPath, 'utf8');
      const chart = parseC2S(original);
      if (serializeC2S(chart) !== original) failures.push(`${entry.key}: round trip differs`);
      for (const unknown of chart.unknownRecords) tags.set(unknown.tag, (tags.get(unknown.tag) ?? 0) + 1);
      if (chart.unknownRecords.length) failures.push(`${entry.key}: unknown ${[...new Set(chart.unknownRecords.map(row => row.tag))].join(',')}`);
      const errors = validateChart(chart).filter(issue => issue.severity === 'error');
      if (errors.length) failures.push(`${entry.key}: ${[...new Set(errors.map(issue => issue.code))].join(',')}`);
      parsed += 1;
    } catch (error) { failures.push(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  context.diagnostic(JSON.stringify({ enabledCharts: library.length, parsed, failureCount: failures.length, unknownTags: Object.fromEntries(tags) }));
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} failures (showing at most 20)`);
});
