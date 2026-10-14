import {
  createChart,
  type Chart,
  type Note,
  type NoteType,
  type ChartEvent,
  type NativeRecord,
  type SourceRecord,
} from './model';
import { analyzeC2SQuantization, quantizeChartForC2S, C2SQuantizationRequiredError } from './quantization';

const noteKinds: Record<string, NoteType> = {
  TAP: 'TAP',
  CHR: 'EXTAP',
  FLK: 'FLICK',
  MNE: 'DAMAGE',
  HLD: 'HOLD',
  HXD: 'HOLD',
  SLD: 'SLIDE',
  SLC: 'SLIDE',
  SXD: 'SLIDE',
  SXC: 'SLIDE',
  AIR: 'AIR',
  AUL: 'AIR',
  AUR: 'AIR',
  ADW: 'AIR',
  ADL: 'AIR',
  ADR: 'AIR',
  AHD: 'AIR_HOLD',
  AHX: 'AIR_HOLD',
  ASD: 'AIR_SLIDE',
  ASC: 'AIR_SLIDE',
  ALD: 'AIR_CRUSH',
};
const eventKinds: Record<string, ChartEvent['type']> = {
  BPM: 'BPM',
  MET: 'METER',
  SFL: 'SCROLL',
  DCM: 'NOTE_SPEED',
  SLP: 'GROUP_SCROLL',
  SLA: 'SCROLL_ASSIGNMENT',
  STP: 'STOP',
};
function isNote(item: Note | ChartEvent): item is Note {
  return 'attributes' in item;
}
const headers = new Set([
  'VERSION',
  'MUSIC',
  'SEQUENCEID',
  'DIFFICULT',
  'LEVEL',
  'CREATOR',
  'BPM_DEF',
  'MET_DEF',
  'RESOLUTION',
  'CLK_DEF',
  'PROGJUDGE_BPM',
  'PROGJUDGE_AER',
  'TUTORIAL',
  'CLK',
]);
function snapshot(value: Note | ChartEvent): Record<string, unknown> {
  const { native: _native, ...rest } = value;
  return JSON.parse(JSON.stringify(rest));
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** Actual record order used by the native reader after serialization. Fractional
 * project coordinates remain untouched here; export quantization is separate.
 */
export function getC2SEntityOrder(
  chart: Chart,
  extraEvents: ChartEvent[] = [],
): { changed: boolean; entities: (Note | ChartEvent)[] } {
  const source = chart.source;
  const changed =
    !source ||
    chart.resolution !== source.originalResolution ||
    chart.defaultBpm !== source.originalDefaultBpm ||
    source.records.filter(row => row.kind === 'note').length !== chart.notes.length ||
    source.records.filter(row => row.kind === 'event').length !== chart.events.length ||
    chart.notes.some(note => !note.native || !same(snapshot(note), note.native.original)) ||
    chart.events.some(event => !event.native || !same(snapshot(event), event.native.original));
  const notes = new Map(chart.notes.map(note => [note.id, note]));
  const events = new Map([...chart.events, ...extraEvents].map(event => [event.id, event]));
  const all = [...events.values(), ...notes.values()];
  if (changed || !source) return { changed, entities: all.sort((a, b) => a.tick - b.tick) };
  const entities = source.records.flatMap(row => {
    const entity =
      row.kind === 'note' ? notes.get(row.entityId!) : row.kind === 'event' ? events.get(row.entityId!) : undefined;
    return entity ? [entity] : [];
  });
  const existing = new Set(entities.map(entity => entity.id));
  entities.push(...all.filter(entity => !existing.has(entity.id)).sort((a, b) => a.tick - b.tick));
  return { changed, entities };
}
function native(record: SourceRecord, columns: string[], item: Note | ChartEvent): NativeRecord {
  return { recordId: record.id, tag: record.tag, columns, raw: record.raw, original: snapshot(item) };
}

/** Decodes known native fields; keeps every source line, newline, extra column and unknown tag. */
export function parseC2S(input: string): Chart {
  const bom = input.startsWith('\ufeff');
  const text = bom ? input.slice(1) : input;
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const records: SourceRecord[] = lines.map((line, index) => {
    const ending = line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
    const raw = ending ? line.slice(0, -ending.length) : line;
    return {
      id: `line-${index}`,
      kind: raw.trim() ? 'unknown' : 'blank',
      tag: raw.trim().split(/\s+/)[0] ?? '',
      raw,
      ending,
    };
  });
  const chart = createChart();
  for (const row of records) {
    const a = row.raw.trim().split(/\s+/);
    if (row.tag === 'VERSION') chart.version = a[1] ?? chart.version;
    if (row.tag === 'RESOLUTION' && Number(a[1]) > 0) chart.resolution = Number(a[1]);
    if (row.tag === 'BPM_DEF' && Number(a[1]) > 0) chart.defaultBpm = Number(a[1]);
  }
  for (const row of records) {
    if (row.kind === 'blank') continue;
    const a = row.raw.trim().split(/\s+/);
    const num = (index: number, fallback = 0) => (a[index] === undefined ? fallback : Number(a[index]));
    const tick = num(1) * chart.resolution + num(2);
    const type = noteKinds[row.tag];
    const eventType = eventKinds[row.tag];
    if (type && a.length >= 5 && [tick, num(3), num(4)].every(Number.isFinite)) {
      const note: Note = { id: `note-${row.id}`, type, tick, lane: num(3), width: num(4), attributes: {} };
      if (type === 'EXTAP') note.attributes.effect = a[5] ?? 'UP';
      if (type === 'FLICK' && a[5]) note.attributes.direction = a[5];
      if (type === 'HOLD') {
        note.duration = num(5);
        note.attributes.ex = row.tag === 'HXD';
        if (row.tag === 'HXD') note.attributes.effect = a[6] ?? 'UP';
      }
      if (type === 'SLIDE') {
        note.duration = num(5);
        note.endLane = num(6, note.lane);
        note.endWidth = num(7, note.width);
        note.attributes.parent = a[8] ?? 'SLD';
        note.attributes.visible = row.tag.endsWith('D');
        note.attributes.ex = row.tag[1] === 'X';
        if (note.attributes.ex) note.attributes.effect = a[9] ?? 'UP';
      }
      if (type === 'AIR') {
        note.attributes.direction = row.tag.slice(1);
        note.attributes.parent = a[5] ?? 'TAP';
        if (a[6]) note.attributes.color = a[6];
      }
      if (type === 'AIR_HOLD') {
        note.attributes.parent = a[5] ?? 'TAP';
        note.duration = num(6);
        note.attributes.color = a[7] ?? 'DEF';
        note.attributes.visible = row.tag === 'AHD';
      }
      if (type === 'AIR_SLIDE') {
        note.attributes.parent = a[5] ?? 'TAP';
        note.height = num(6, 1);
        note.duration = num(7);
        note.endLane = num(8, note.lane);
        note.endWidth = num(9, note.width);
        note.endHeight = num(10, 1);
        note.attributes.color = a[11] ?? 'DEF';
        note.attributes.visible = row.tag === 'ASD';
      }
      if (type === 'AIR_CRUSH') {
        note.attributes.interval = num(5, 24);
        note.height = num(6, 1);
        note.duration = num(7);
        note.endLane = num(8, note.lane);
        note.endWidth = num(9, note.width);
        note.endHeight = num(10, 1);
        note.attributes.color = a[11] ?? 'DEF';
        if (a[12]) note.attributes.effect = a[12];
      }
      if (Object.values(note).some(value => typeof value === 'number' && !Number.isFinite(value))) {
        chart.unknownRecords.push(row);
        continue;
      }
      note.native = native(row, a, note);
      row.kind = 'note';
      row.entityId = note.id;
      chart.notes.push(note);
    } else if (eventType && a.length >= 4 && Number.isFinite(tick)) {
      const event: ChartEvent = { id: `event-${row.id}`, type: eventType, tick, value: num(3) };
      if (eventType === 'METER') {
        // Native MET uses denominator, numerator. It changes bar lines, not the tick clock.
        event.denominator = num(3, 4);
        event.numerator = num(4, 4);
        event.value = event.numerator === 0 || event.denominator === 0 ? 0 : event.numerator / event.denominator;
      } else if (eventType === 'STOP') {
        event.duration = num(3);
        event.value = 0;
      } else if (eventType === 'SCROLL_ASSIGNMENT') {
        event.lane = num(3);
        event.width = num(4);
        event.duration = num(5);
        event.group = num(6);
        event.value = event.group;
      } else if (eventType !== 'BPM') {
        event.duration = num(3);
        event.value = num(4, 1);
        if (eventType === 'GROUP_SCROLL') event.group = num(5);
      }
      if (!Number.isFinite(event.value)) {
        chart.unknownRecords.push(row);
        continue;
      }
      event.native = native(row, a, event);
      row.kind = 'event';
      row.entityId = event.id;
      chart.events.push(event);
    } else if (headers.has(row.tag) || row.tag.startsWith('T_')) {
      row.kind = 'header';
      chart.headerRecords.push(row);
    } else {
      chart.unknownRecords.push(row);
    }
  }
  if (
    chart.notes.some(
      note =>
        note.lane < 0 ||
        note.lane + note.width > 16 ||
        (note.endLane ?? note.lane) < 0 ||
        (note.endLane ?? note.lane) + (note.endWidth ?? note.width) > 16,
    )
  )
    chart.allowOutOfLane = true;
  chart.source = {
    records,
    bom,
    newline: records.find(row => row.ending)?.ending ?? '\r\n',
    originalVersion: chart.version,
    originalResolution: chart.resolution,
    originalDefaultBpm: chart.defaultBpm,
  };
  return chart;
}

/** Native tags encode the segment END joint; they do not hide a chain head. */
/** The chart designer from the CREATOR header record; undefined when the chart has none. */
export function c2sCreator(chart: Chart): string | undefined {
  return chart.headerRecords
    .find(record => record.tag === 'CREATOR')
    ?.raw.split('\t')
    .slice(1)
    .join(' ')
    .trim();
}
export function getNativeNoteTag(note: Note): string {
  const a = note.attributes;
  switch (note.type) {
    case 'TAP':
      return 'TAP';
    case 'EXTAP':
      return 'CHR';
    case 'FLICK':
      return 'FLK';
    case 'DAMAGE':
      return 'MNE';
    case 'HOLD':
      return a.ex ? 'HXD' : 'HLD';
    case 'SLIDE':
      return `S${a.ex ? 'X' : 'L'}${a.visible === false ? 'C' : 'D'}`;
    case 'AIR':
      return `A${a.direction ?? 'IR'}`;
    case 'AIR_HOLD':
      return a.visible === false ? 'AHX' : 'AHD';
    case 'AIR_SLIDE':
      return a.visible === false ? 'ASC' : 'ASD';
    case 'AIR_CRUSH':
      return 'ALD';
  }
}
function noteColumns(note: Note, resolution: number): string[] {
  const a = note.attributes;
  const row: unknown[] = [
    getNativeNoteTag(note),
    Math.floor(note.tick / resolution),
    note.tick % resolution,
    note.lane,
    note.width,
  ];
  switch (note.type) {
    case 'EXTAP':
      row.push(a.effect ?? 'UP');
      break;
    case 'FLICK':
      if (a.direction !== undefined) row.push(a.direction);
      break;
    case 'HOLD':
      row.push(note.duration ?? resolution / 4);
      if (a.ex) row.push(a.effect ?? 'UP');
      break;
    case 'SLIDE':
      row.push(
        note.duration ?? resolution / 4,
        note.endLane ?? note.lane,
        note.endWidth ?? note.width,
        a.parent ?? 'SLD',
      );
      if (a.ex) row.push(a.effect ?? 'UP');
      break;
    case 'AIR':
      row.push(a.parent ?? 'TAP');
      if (a.color !== undefined || !note.native) row.push(a.color ?? 'DEF');
      break;
    case 'AIR_HOLD':
      row.push(a.parent ?? 'TAP', note.duration ?? resolution / 4, a.color ?? 'DEF');
      break;
    case 'AIR_SLIDE':
      row.push(
        a.parent ?? 'TAP',
        note.height ?? 1,
        note.duration ?? resolution / 4,
        note.endLane ?? note.lane,
        note.endWidth ?? note.width,
        note.endHeight ?? note.height ?? 1,
        a.color ?? 'DEF',
      );
      break;
    case 'AIR_CRUSH':
      row.push(
        a.interval ?? 24,
        note.height ?? 1,
        note.duration ?? resolution / 4,
        note.endLane ?? note.lane,
        note.endWidth ?? note.width,
        note.endHeight ?? note.height ?? 1,
        a.color ?? 'DEF',
      );
      if (a.effect !== undefined || !note.native) row.push(a.effect ?? 'DEF');
      break;
  }
  return row.map(String);
}
function eventColumns(event: ChartEvent, resolution: number): string[] {
  const tag = {
    BPM: 'BPM',
    METER: 'MET',
    SCROLL: 'SFL',
    NOTE_SPEED: 'DCM',
    GROUP_SCROLL: 'SLP',
    SCROLL_ASSIGNMENT: 'SLA',
    STOP: 'STP',
  }[event.type];
  const row: unknown[] = [tag, Math.floor(event.tick / resolution), event.tick % resolution];
  if (event.type === 'METER') row.push(event.denominator ?? 4, event.numerator ?? 4);
  else if (event.type === 'BPM') row.push(event.value);
  else if (event.type === 'STOP') row.push(event.duration ?? resolution);
  else if (event.type === 'SCROLL_ASSIGNMENT')
    row.push(event.lane ?? 0, event.width ?? 1, event.duration ?? 1, event.group ?? event.value);
  else {
    row.push(event.duration ?? resolution, event.value.toFixed(6));
    if (event.type === 'GROUP_SCROLL') row.push(event.group ?? 0);
  }
  return row.map(String);
}
/** Replace tokens only where decoded values changed, leaving original whitespace and extra columns intact. */
function mergeNative(
  item: Note | ChartEvent,
  columns: string[],
  resolution: number,
  originalResolution: number,
): string {
  const old = item.native;
  if (!old) return columns.join('\t');
  if (same(snapshot(item), old.original) && resolution === originalResolution) return old.raw;
  const original = old.original as unknown as Note | ChartEvent;
  const oldComputed = isNote(original)
    ? noteColumns(original, originalResolution)
    : eventColumns(original, originalResolution);
  const tagChanged = columns[0] !== old.tag;
  if (tagChanged) return [...columns, ...old.columns.slice(oldComputed.length)].join('\t');
  const replacements = new Map<number, string>();
  columns.forEach((value, index) => {
    if (value !== oldComputed[index]) replacements.set(index, value);
  });
  let index = 0;
  let line = old.raw.replace(/\S+/g, token => {
    const current = index++;
    return replacements.get(current) ?? token;
  });
  for (let i = old.columns.length; i < columns.length; i += 1) line += `\t${columns[i]}`;
  return line;
}
export interface C2SWriteOptions {
  designer?: string;
  difficulty?: number;
  omitStaleStatistics?: boolean;
  quantization?: 'nearest' | 'reject';
}
export function serializeC2S(chart: Chart, options: C2SWriteOptions = {}): string {
  const report = analyzeC2SQuantization(chart);
  if (report.required) {
    if (options.quantization !== 'nearest') throw new C2SQuantizationRequiredError(report);
    chart = quantizeChartForC2S(chart);
  }
  const source = chart.source;
  const originalResolution = source?.originalResolution ?? chart.resolution;
  const newline = source?.newline ?? '\r\n';
  const requiresGroupedFormat =
    chart.events.some(
      event => (event.type === 'GROUP_SCROLL' || event.type === 'SCROLL_ASSIGNMENT') && !event.native,
    ) || chart.notes.some(note => note.attributes.speedGroup !== undefined);
  const versionParts = chart.version.split('.').map(Number);
  const effectiveVersion =
    requiresGroupedFormat && ((versionParts[0] ?? 0) < 1 || (versionParts[0] === 1 && (versionParts[1] ?? 0) < 15))
      ? '1.15.00'
      : chart.version;
  const notes = new Map(chart.notes.map(note => [note.id, note]));
  const implicitAssignments: ChartEvent[] = [];
  for (const note of chart.notes) {
    const group = note.attributes.speedGroup;
    if (!Number.isInteger(group) || Number(group) < 0) continue;
    const exists = chart.events.some(
      event =>
        event.type === 'SCROLL_ASSIGNMENT' &&
        event.tick === note.tick &&
        event.lane === note.lane &&
        event.width === note.width &&
        (event.group ?? event.value) === Number(group) &&
        (event.duration ?? 1) >= (note.duration ?? 0),
    );
    if (!exists)
      implicitAssignments.push({
        id: `assignment-${note.id}`,
        type: 'SCROLL_ASSIGNMENT',
        tick: note.tick,
        lane: note.lane,
        width: note.width,
        duration: Math.max(1, note.duration ?? 1),
        group: Number(group),
        value: Number(group),
      });
  }
  const events = new Map([...chart.events, ...implicitAssignments].map(event => [event.id, event]));
  const { changed, entities: orderedEntities } = getC2SEntityOrder(chart, implicitAssignments);
  const emitted = new Set<string>();
  const rows: string[] = [];
  const writeHeader = (row: SourceRecord): string => {
    if (row.tag === 'VERSION' && effectiveVersion !== source?.originalVersion)
      return `VERSION\t${effectiveVersion}\t${effectiveVersion}`;
    if (row.tag === 'RESOLUTION' && chart.resolution !== originalResolution) return `RESOLUTION\t${chart.resolution}`;
    if (row.tag === 'BPM_DEF' && chart.defaultBpm !== source?.originalDefaultBpm)
      return `BPM_DEF\t${Array(4).fill(chart.defaultBpm.toFixed(3)).join('\t')}`;
    if (row.tag === 'CREATOR' && options.designer !== undefined)
      return `CREATOR\t${options.designer.replace(/[\r\n\t]/g, ' ')}`;
    if (row.tag === 'DIFFICULT' && options.difficulty !== undefined)
      return `DIFFICULT\t${options.difficulty.toString().padStart(2, '0')}`;
    return row.raw;
  };
  if (source) {
    const chronological = orderedEntities;
    const finalEntityRow = source.records.reduce(
      (last, row, index) => (row.kind === 'note' || row.kind === 'event' ? index : last),
      -1,
    );
    let cursor = 0;
    for (let index = 0; index < source.records.length; index += 1) {
      const row = source.records[index];
      if (row.kind === 'note' || row.kind === 'event') {
        // Unedited input is byte-exact. After chart edits, refill known-record slots
        // in stable chronological order; unknown/header lines retain their raw text.
        const selected = changed
          ? chronological[cursor++]
          : row.kind === 'note'
            ? notes.get(row.entityId!)
            : events.get(row.entityId!);
        const toWrite = selected ? [selected] : [];
        if (changed && index === finalEntityRow) toWrite.push(...chronological.slice(cursor));
        for (const [itemIndex, item] of toWrite.entries()) {
          const columns = isNote(item) ? noteColumns(item, chart.resolution) : eventColumns(item, chart.resolution);
          const ending =
            index === source.records.length - 1 && itemIndex === toWrite.length - 1
              ? row.ending
              : row.ending || newline;
          rows.push(mergeNative(item, columns, chart.resolution, originalResolution) + ending);
          emitted.add(item.id);
        }
      } else {
        if (changed && options.omitStaleStatistics !== false && row.tag.startsWith('T_')) continue;
        rows.push(writeHeader(row) + row.ending);
      }
    }
  } else {
    const header = [
      `VERSION\t${effectiveVersion}\t${effectiveVersion}`,
      'MUSIC\t0',
      'SEQUENCEID\t0',
      `DIFFICULT\t${(options.difficulty ?? 3).toString().padStart(2, '0')}`,
      'LEVEL\t0.0',
      `CREATOR\t${(options.designer ?? '').replace(/[\r\n\t]/g, ' ')}`,
      `BPM_DEF\t${Array(4).fill(chart.defaultBpm.toFixed(3)).join('\t')}`,
      'MET_DEF\t4\t4',
      `RESOLUTION\t${chart.resolution}`,
      `CLK_DEF\t${chart.resolution}`,
      'PROGJUDGE_BPM\t240.000',
      'PROGJUDGE_AER\t0.999',
      'TUTORIAL\t0',
      '',
    ];
    rows.push(header.join(newline) + newline);
    if (!chart.events.some(event => event.type === 'BPM' && event.tick === 0))
      rows.push(`BPM\t0\t0\t${chart.defaultBpm.toFixed(3)}${newline}`);
    if (!chart.events.some(event => event.type === 'METER' && event.tick === 0)) rows.push(`MET\t0\t0\t4\t4${newline}`);
    for (const row of chart.unknownRecords) rows.push(row.raw + (row.ending || newline));
  }
  const added = orderedEntities.filter(item => !emitted.has(item.id));
  if (added.length && rows.length && !/[\r\n]$/.test(rows.at(-1)!)) rows.push(newline);
  for (const item of added)
    rows.push(
      (isNote(item) ? noteColumns(item, chart.resolution) : eventColumns(item, chart.resolution)).join('\t') + newline,
    );
  return (source?.bom ? '\ufeff' : '') + rows.join('');
}
export const writeC2S = serializeC2S;
export const parseC2s = parseC2S;
export const serializeC2s = serializeC2S;
