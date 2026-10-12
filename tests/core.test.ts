import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createChart, createNote, parseC2S, serializeC2S, tickToSeconds, secondsToTick, getGrid, getScrollPosition, validateChart, moveNotes, mirrorNotes, cloneNotes, snapTick, parseBeatPosition, formatBeatPosition, analyzeC2SQuantization, quantizeChartForC2S, C2SQuantizationRequiredError } from '../src/core/index';

const fixture = '\ufeffVERSION\t1.15.00\t1.15.00\r\nRESOLUTION\t384\r\nBPM_DEF\t120.000\t120.000\t120.000\t120.000\r\nCREATOR\tテスト 名\r\nMET_DEF\t4\t4\r\n\r\nBPM\t0\t0\t120.000\r\nBPM\t2\t0\t240.000\r\nMET\t2\t0\t8\t6\r\nTAP  0\t96  4\t2  EXTRA\r\nHXD\t0\t192\t0\t4\t384\tUP\r\nSLC\t1\t0\t2\t4\t96\t10\t2\tSLD\tEXTRA\r\nAIR\t0\t96\t4\t2\tTAP\tDEF\r\nAHX\t0\t96\t4\t2\tTAP\t192\tGRN\r\nASD\t1\t0\t2\t4\tSLD\t1.0\t96\t10\t2\t5.0\tDEF\r\nALD\t2\t0\t0\t4\t24\t5.0\t192\t8\t2\t1.0\tNON\tDEF\r\nMNE\t2\t96\t0\t16\r\nSFL\t1\t0\t192\t0.000000\r\nSFL\t1\t192\t192\t-1.000000\r\nDCM\t2\t0\t192\t2.000000\r\nX_FUTURE\t42\tunchanged\r\nT_NOTE_ALL\t8';

test('C2S round trip preserves BOM, mixed whitespace, final newline, unknown tags and extra columns exactly', () => {
  const chart = parseC2S(fixture);
  assert.equal(chart.notes.length, 8);
  assert.equal(chart.events.length, 6);
  assert.equal(serializeC2S(chart), fixture);
  assert.equal(chart.notes.find(note => note.type === 'AIR_CRUSH')?.attributes.color, 'NON');
});
test('editing one note only changes its affected token, while retaining native extra columns', () => {
  const chart = parseC2S(fixture);
  const note = chart.notes[0];
  const edited = { ...chart, notes: chart.notes.map(n => n.id === note.id ? { ...n, lane: 6 } : n) };
  const output = serializeC2S(edited);
  assert.ok(output.includes('TAP  0\t96  6\t2  EXTRA\r\n'));
  assert.ok(output.includes('X_FUTURE\t42\tunchanged\r\n'));
  assert.ok(!output.includes('T_NOTE_ALL'));
  assert.ok(output.includes('ASD\t1\t0\t2\t4\tSLD\t1.0\t96\t10\t2\t5.0\tDEF'));
});
test('native clock remains 384 ticks per four beats across a 6/8 display meter change', () => {
  const chart = parseC2S(fixture);
  assert.equal(tickToSeconds(chart, 384), 2);
  assert.equal(tickToSeconds(chart, 768), 4);
  assert.equal(tickToSeconds(chart, 1152), 5);
  for (const tick of [-96, 0, 333, 768, 888, 12345]) assert.ok(Math.abs(secondsToTick(chart, tickToSeconds(chart, tick)) - tick) < 1e-8);
  const grid = getGrid(chart, 768, 1400, 16);
  assert.ok(grid.some(line => line.tick === 1056 && line.major));
  assert.ok(grid.some(line => line.tick === 1344 && line.major));
});
test('scroll stops and negative motion change visual travel but never stop the audio clock', () => {
  const chart = createChart(120);
  chart.events = [
    { id: 'stop', type: 'SCROLL', tick: 0, duration: 384, value: 0 },
    { id: 'reverse', type: 'SCROLL', tick: 384, duration: 384, value: -1 },
  ];
  assert.equal(getScrollPosition(chart, 384, 0), 0);
  assert.equal(getScrollPosition(chart, 768, 384), -2);
  assert.equal(getScrollPosition(chart, 1152, 768), 2);
  assert.equal(tickToSeconds(chart, 768), 4);
});
test('all standard native note variants survive independent construction and reparse', () => {
  const chart = createChart();
  chart.notes = ['TAP', 'EXTAP', 'FLICK', 'HOLD', 'SLIDE', 'AIR', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH', 'DAMAGE'].map((type, index) => createNote(type as Parameters<typeof createNote>[0], index * 96, 2, 4));
  chart.notes[3].attributes.ex = true;
  chart.notes[4].attributes.visible = false;
  // The game only reads AIR records bound to a ground tail: seat them on the TAP, EXTAP and FLICK.
  for (const [index, parent] of [[5, 'TAP'], [6, 'CHR'], [7, 'FLK']] as const) { chart.notes[index].tick = (index - 5) * 96; chart.notes[index].attributes.parent = parent; }
  const again = parseC2S(serializeC2S(chart));
  assert.deepEqual(again.notes.map(note => note.type), [...chart.notes].sort((a, b) => a.tick - b.tick).map(note => note.type));
  assert.equal(again.notes.find(note => note.type === 'HOLD')!.native?.tag, 'HXD');
  assert.equal(again.notes.find(note => note.type === 'SLIDE')!.native?.tag, 'SLC');
  assert.deepEqual(validateChart(again).filter(issue => issue.severity === 'error'), []);
});
test('group movement keeps relative spacing and bounds; mirror transforms both slide ends and AIR direction', () => {
  const chart = createChart();
  const slide = { ...createNote('SLIDE', 96, 2, 4), endLane: 12, endWidth: 4 };
  const air = { ...createNote('AIR', 192, 2, 4), attributes: { direction: 'UL' } };
  chart.notes = [slide, air];
  const moved = moveNotes(chart, [slide.id, air.id], -1000, 4);
  assert.equal(moved.notes[0].tick, 0); assert.equal(moved.notes[1].tick, 96); assert.equal(moved.notes[0].lane, 2);
  const mirrored = mirrorNotes(chart, [slide.id, air.id]);
  assert.equal(mirrored.notes[0].lane, 10); assert.equal(mirrored.notes[0].endLane, 0); assert.equal(mirrored.notes[1].attributes.direction, 'UR');
  const copied = cloneNotes(chart, [slide.id], 384);
  assert.equal(copied.notes.length, 3); assert.notEqual(copied.notes[2].id, slide.id); assert.equal(copied.notes[2].tick, 480);
});
test('malformed known records are preserved rather than silently dropped', () => {
  const text = 'TAP\t0\t0\tbad\t2\nHLD\t0\t0\t0\t4\tNaN\nX_CUSTOM\t1';
  const chart = parseC2S(text); assert.equal(chart.notes.length, 0); assert.equal(chart.unknownRecords.length, 3); assert.equal(serializeC2S(chart), text);
});
test('zero DCM is rejected independently of valid SFL stops', () => {
  const chart = createChart(); chart.events = [{ id: 'a', type: 'NOTE_SPEED', tick: 0, duration: 384, value: 0 }, { id: 'b', type: 'SCROLL', tick: 0, duration: 384, value: 0 }];
  assert.deepEqual(validateChart(chart).map(issue => issue.code), ['zero-note-speed']);
});

const nativeRoot = process.env.CHUNI_NATIVE_FIXTURES;
test('optional read-only installed corpus: byte-identical unedited native chart round trips', { skip: !nativeRoot || !existsSync(nativeRoot) }, () => {
  function collect(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? collect(join(dir, entry.name)) : entry.name.endsWith('.c2s') ? [join(dir, entry.name)] : []); }
  const files = collect(nativeRoot!); assert.ok(files.length > 0);
  for (const file of files) {
    const input = readFileSync(file, 'utf8'); const chart = parseC2S(input);
    assert.equal(serializeC2S(chart), input, file);
    assert.equal(chart.unknownRecords.length, 0, `Unknown native records in ${file}`);
    assert.deepEqual(validateChart(chart).filter(issue => issue.severity === 'error'), [], file);
  }
});

test('SLP/SLA edit and preview assign a distinct scroll timeline to the whole native slide chain', () => {
  const text = 'VERSION\t1.15.00\t1.15.00\nBPM_DEF\t120\t120\t120\t120\nSLP\t0\t0\t768\t-1.000000\t2\nSLP\t0\t0\t768\t1.000000\t0\nSLC\t1\t0\t0\t4\t96\t4\t4\tSLD\nSLD\t1\t96\t4\t4\t96\t8\t4\tSLD\nSLA\t1\t0\t0\t4\t192\t2\nTAP\t1\t96\t0\t2';
  const chart = parseC2S(text);
  assert.equal(chart.unknownRecords.length, 0);
  assert.equal(serializeC2S(chart), text);
  assert.equal(getScrollPosition(chart, 384, 0, chart.notes[0]), -2);
  assert.equal(getScrollPosition(chart, 480, 0, chart.notes[1]), -2.5);
  assert.equal(getScrollPosition(chart, 480, 0, chart.notes[2]), 2.5);
  const updated = { ...chart, events: chart.events.map(e => e.type === 'GROUP_SCROLL' && e.group === 2 ? { ...e, value: 0 } : e) };
  assert.equal(getScrollPosition(updated, 480, 0, chart.notes[1]), 0);
  assert.ok(serializeC2S(updated).includes('SLP\t0\t0\t768\t0.000000\t2'));
});

test('official edge forms allow hidden meter and zero-length invisible AIR control segments', () => {
  const chart = parseC2S('BPM_DEF\t120\t120\t120\t120\nMET\t0\t0\t4\t0\nTAP\t1\t0\t0\t4\nASC\t1\t0\t0\t4\tTAP\t5.0\t0\t0\t4\t5.0\tDEF');
  assert.deepEqual(validateChart(chart).filter(x => x.severity === 'error'), []);
  assert.ok(getGrid(chart, 0, 768).length > 0);
});

test('legacy STP is editable and preserved, with an explicit unverified-preview diagnostic', () => {
  const text = 'BPM_DEF\t120\t120\t120\t120\nSTP\t1\t0\t192\nTAP\t2\t0\t0\t4\n';
  const chart = parseC2S(text);
  assert.equal(chart.events[0].type, 'STOP');
  assert.equal(serializeC2S(chart), text);
  assert.equal(getScrollPosition(chart, 576, 384), 0);
  assert.equal(tickToSeconds(chart, 576), 3);
  assert.ok(validateChart(chart).some(issue => issue.code === 'legacy-stop-preview' && issue.severity === 'warning'));
  const changed = { ...chart, events: chart.events.map(event => ({ ...event, duration: 96 })) };
  assert.ok(serializeC2S(changed).includes('STP\t1\t0\t96'));
});

test('moving a grouped note preserves its preview group and exports an updated native assignment', () => {
  const chart = parseC2S('BPM_DEF\t120\t120\t120\t120\nSLP\t0\t0\t1536\t-1.000000\t1\nTAP\t1\t0\t0\t4\nSLA\t1\t0\t0\t4\t1\t1');
  const changed = moveNotes(chart, [chart.notes[0].id], 384, 4);
  assert.equal(getScrollPosition(changed, 768, 0, changed.notes[0]), -4);
  const output = serializeC2S(changed); assert.ok(output.includes('SLA\t2\t0\t4\t4\t1\t1'));
  const again = parseC2S(output); assert.equal(getScrollPosition(again, 768, 0, again.notes[0]), -4);
});

test('adding grouped speed to an older chart raises the output format version', () => {
  const chart = parseC2S('VERSION\t1.08.00\t1.08.00\nBPM_DEF\t120\t120\t120\t120\n');
  chart.events = [{ id: 'new', type: 'GROUP_SCROLL', tick: 0, duration: 384, value: -1, group: 1 }];
  assert.ok(serializeC2S(chart).startsWith('VERSION\t1.15.00\t1.15.00'));
});


test('native 0/0 MET sentinel hides lines and survives a byte-exact round trip', () => {
  const text = 'BPM_DEF\t120\t120\t120\t120\nMET\t0\t0\t0\t0\nTAP\t1\t0\t0\t4';
  const chart = parseC2S(text);
  assert.equal(chart.unknownRecords.length, 0);
  assert.equal(serializeC2S(chart), text);
  assert.deepEqual(validateChart(chart).filter(x => x.severity === 'error'), []);
  assert.equal(getGrid(chart, 0, 768).filter(line => line.major).length, 0);
});

test('seven-way grid and quarter-beat fractions remain precise inside the project', () => {
  const chart = createChart();
  const step = chart.resolution / 7;
  assert.equal(snapTick(chart, 50, 7), step);
  assert.equal(snapTick(chart, 14, 28), step / 4);
  const grid = getGrid(chart, 0, chart.resolution, 7);
  for (let i = 0; i <= 7; i += 1) assert.ok(grid.some(line => Math.abs(line.tick - i * step) < 1e-10));
  assert.equal(parseBeatPosition(chart, '4/7'), step);
  assert.equal(formatBeatPosition(chart, step), '4/7');
  assert.equal(parseBeatPosition(chart, '1/0'), undefined);
  chart.notes = [{ ...createNote('HOLD', step), duration: step }];
  const validation = validateChart(chart);
  assert.deepEqual(validation.filter(item => item.severity === 'error'), []);
  assert.ok(validation.some(item => item.code === 'native-quantization'));
  assert.equal(moveNotes(chart, [chart.notes[0].id], step, 0).notes[0].tick, step * 2);
});

test('fractional tempo boundaries invert through audio time and long notes span both changes', () => {
  const chart = createChart(120); const step = chart.resolution / 7;
  chart.events = [{ id: 'b1', type: 'BPM', tick: step, value: 180 }, { id: 'b2', type: 'BPM', tick: step * 4, value: 90 }];
  chart.notes = [{ ...createNote('SLIDE', step / 2), duration: step * 6 }];
  assert.ok(Math.abs(tickToSeconds(chart, step) - 2 / 7) < 1e-12);
  assert.ok(Math.abs(tickToSeconds(chart, step * 4) - 6 / 7) < 1e-12);
  assert.ok(Math.abs(tickToSeconds(chart, step * 7) - 2) < 1e-12);
  for (const tick of [0, step / 2, step, step * 2, step * 4, step * 6.5, 1000]) {
    assert.ok(Math.abs(secondsToTick(chart, tickToSeconds(chart, tick)) - tick) < 1e-9);
  }
  const note = chart.notes[0];
  assert.ok(Math.abs(getScrollPosition(chart, note.tick + note.duration!, note.tick, note) - (tickToSeconds(chart, note.tick + note.duration!) - tickToSeconds(chart, note.tick))) < 1e-12);
});

test('native export requires explicit quantization and reports downstream BPM timing drift', () => {
  const chart = createChart(120); const step = chart.resolution / 7;
  chart.events = [{ id: 'tempo', type: 'BPM', tick: step, value: 240 }];
  chart.notes = [{ ...createNote('HOLD', step), duration: step * 3 }, createNote('TAP', 768)];
  const original = JSON.stringify(chart);
  const report = analyzeC2SQuantization(chart);
  assert.equal(report.required, true);
  assert.equal(report.roundedEntityCount, 2);
  const unchangedTickNote = report.entries.find(item => item.entityId === chart.notes[1].id)!;
  assert.equal(unchangedTickNote.fields.length, 0);
  assert.ok(unchangedTickNote.maxErrorMs > 0);
  assert.throws(() => serializeC2S(chart), C2SQuantizationRequiredError);
  const native = quantizeChartForC2S(chart);
  assert.equal(native.notes[0].tick, 55);
  assert.equal(native.notes[0].duration, 164);
  const output = serializeC2S(chart, { quantization: 'nearest' });
  const reparsed = parseC2S(output);
  assert.ok([...reparsed.notes, ...reparsed.events].every(item => Number.isInteger(item.tick)));
  for (const entry of report.entries) {
    const source = [...chart.notes, ...chart.events].find(item => item.id === entry.entityId)!;
    const rounded = [...native.notes, ...native.events].find(item => item.id === entry.entityId)!;
    assert.ok(Math.abs(entry.startErrorMs - (tickToSeconds(native, rounded.tick) - tickToSeconds(chart, source.tick)) * 1000) < 1e-10);
  }
  assert.equal(JSON.stringify(chart), original);
  assert.equal(analyzeC2SQuantization(native).required, false);
});

test('native quantization preserves shared long-note endpoints and reports one-tick minimum durations', () => {
  const chart = createChart(); const step = chart.resolution / 7;
  chart.notes = [
    { ...createNote('SLIDE', step), duration: step, endLane: 4 },
    { ...createNote('SLIDE', step * 2, 4), duration: step },
    { ...createNote('HOLD', 1.1), duration: 0.1 },
  ];
  const native = quantizeChartForC2S(chart);
  assert.equal(native.notes[0].tick + native.notes[0].duration!, native.notes[1].tick);
  assert.equal(native.notes[2].duration, 1);
  assert.ok(analyzeC2SQuantization(chart).entries.find(item => item.entityId === chart.notes[2].id)?.minimumDurationApplied);
});

test('edited native output sorts known records chronologically while retaining unknown text and extra columns', () => {
  const original = 'VERSION\t1.15.00\t1.15.00\r\nBPM_DEF\t120\t120\t120\t120\r\nBPM\t0\t0\t120.000\r\nTAP  4\t0  0\t4  EXTRA\r\n# retained anchor\r\nTAP\t3\t0\t8\t4\r\nX_FUTURE\tkept';
  const chart = parseC2S(original);
  assert.equal(serializeC2S(chart), original);
  const changed = { ...chart, notes: [...chart.notes, createNote('TAP', 48)], events: [...chart.events, { id: 'early-bpm', type: 'BPM' as const, tick: 24, value: 180 }] };
  const text = serializeC2S(changed);
  assert.ok(text.includes('TAP  4\t0  0\t4  EXTRA'));
  assert.ok(text.includes('# retained anchor\r\n'));
  assert.ok(text.endsWith('X_FUTURE\tkept'));
  const knownTicks = text.split(/\r?\n/).filter(line => /^(BPM|TAP)\s/.test(line)).map(line => { const a = line.trim().split(/\s+/); return Number(a[1]) * 384 + Number(a[2]); });
  assert.deepEqual(knownTicks, [0, 24, 48, 1152, 1536]);
  const reparsed = parseC2S(text);
  assert.equal(reparsed.notes.length, 3);
  assert.equal(reparsed.events.length, 2);
});

test('implicit grouped assignments take their chronological position in edited native output', () => {
  const chart = parseC2S('BPM\t0\t0\t120\nTAP\t2\t0\t0\t4\nTAP\t4\t0\t0\t4');
  const moved = moveNotes(chart, [chart.notes[0].id], -384, 0);
  moved.notes[0] = { ...moved.notes[0], attributes: { speedGroup: 2 } };
  const text = serializeC2S(moved);
  const ticks = text.split(/\r?\n/).filter(line => /^(BPM|TAP|SLA)\s/.test(line)).map(line => { const a = line.split(/\s+/); return Number(a[1]) * 384 + Number(a[2]); });
  assert.deepEqual(ticks, [0, 384, 384, 1536]);
});

test('seventh-note scroll assignments retain linked segments across floating-point endpoints', () => {
  const chart = createChart(); const step = 384 / 7;
  chart.notes = [{ ...createNote('SLIDE', step, 0, 4), duration: step * 6, endLane: 4 }, { ...createNote('SLIDE', 384, 4, 4), duration: step }];
  chart.events = [{ id: 'group', type: 'GROUP_SCROLL', tick: 0, duration: 1000, value: -1, group: 1 }, { id: 'assignment', type: 'SCROLL_ASSIGNMENT', tick: step, duration: 384, value: 1, group: 1, lane: 0, width: 4 }];
  assert.ok(getScrollPosition(chart, 384, 0, chart.notes[1]) < 0);
});

test('native end-of-song zero-denominator meter and zero-length AIR-HOLD endpoints remain editable', () => {
  const text = 'BPM\t0\t0\t120\nMET\t3\t0\t0\t4\nTAP\t1\t0\t0\t8\nAHD\t1\t0\t0\t8\tTAP\t384\tDEF\nAHD\t2\t0\t0\t8\tAHD\t0\tDEF';
  const chart = parseC2S(text);
  assert.equal(chart.unknownRecords.length, 0);
  assert.deepEqual(validateChart(chart).filter(item => item.severity === 'error'), []);
  assert.equal(serializeC2S(chart), text);
  assert.equal(getGrid(chart, 1152, 1536).filter(line => line.major).length, 0);
});

test('intentional native offstage geometry is preserved without weakening new-note bounds', () => {
  const text = 'BPM\t0\t0\t120\nSXC\t1\t0\t4\t8\t1\t-16\t1\tSLD\tBS\nFLK\t2\t0\t-1\t7\tL';
  const chart = parseC2S(text);
  assert.deepEqual(validateChart(chart).filter(item => item.severity === 'error'), []);
  assert.ok(validateChart(chart).some(item => item.code === 'out-of-lane-visuals'));
  assert.equal(serializeC2S(chart), text);
  const moved = moveNotes(chart, [chart.notes[1].id], 96, 0);
  assert.equal(moved.notes[1].lane, -1);
  assert.equal(moved.notes[1].tick, 864);
  const fresh = createChart(); fresh.notes = [createNote('TAP', 0, -1, 4)];
  assert.ok(validateChart(fresh).some(item => item.code === 'lane' && item.severity === 'error'));
  fresh.allowOutOfLane = true;
  assert.deepEqual(validateChart(fresh).filter(item => item.severity === 'error'), []);
  assert.equal(parseC2S(serializeC2S(fresh)).allowOutOfLane, true);
  assert.equal(moveNotes(fresh, [fresh.notes[0].id], 0, -100).notes[0].lane, -64);
});

test('fractional AIR-CRUSH spacing reports accumulated judgement timing error and count changes', () => {
  const chart = createChart();
  chart.notes = [{ ...createNote('AIR_CRUSH', 0), duration: 384, attributes: { interval: 384 / 7 } }];
  const entry = analyzeC2SQuantization(chart).entries[0];
  assert.ok(Math.abs(entry.intervalErrorMs! - (330 - 384 * 6 / 7) * 1000 / 192) < 1e-9);
  assert.equal(entry.judgementCountChanged, true);
  assert.ok(entry.maxErrorMs > 4);
});
