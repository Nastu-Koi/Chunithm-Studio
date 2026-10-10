import type { Chart, ChartEvent, Note, TimelineSegment, MeasureLine } from './model';
const timelines = new WeakMap<Chart, TimelineSegment[]>();
const sortedEvents = new WeakMap<Chart, ChartEvent[]>();
function eventsFor(chart: Chart): ChartEvent[] {
  let events = sortedEvents.get(chart);
  if (!events) { events = [...chart.events].sort((a, b) => a.tick - b.tick); sortedEvents.set(chart, events); }
  return events;
}
/** Charts are immutable values. Return a new Chart after any change to invalidate cached timing. */
export function getTimeline(chart: Chart): TimelineSegment[] {
  const cached = timelines.get(chart); if (cached) return cached;
  let bpm = chart.defaultBpm > 0 ? chart.defaultBpm : 120;
  const output: TimelineSegment[] = [{ tick: 0, seconds: 0, bpm }];
  for (const event of eventsFor(chart)) {
    if (event.type !== 'BPM' || !(event.value > 0) || event.tick < 0) continue;
    const last = output[output.length - 1];
    const seconds = last.seconds + (event.tick - last.tick) * 240 / (chart.resolution * last.bpm);
    bpm = event.value;
    if (event.tick === last.tick) last.bpm = bpm;
    else output.push({ tick: event.tick, seconds, bpm });
  }
  timelines.set(chart, output); return output;
}
function floorIndex<T>(items: T[], value: number, get: (item: T) => number): number {
  let lo = 0; let hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (get(items[mid]) <= value) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo - 1);
}
export function tickToSeconds(chart: Chart, tick: number): number {
  const segments = getTimeline(chart);
  const segment = segments[floorIndex(segments, tick, item => item.tick)];
  return segment.seconds + (tick - segment.tick) * 240 / (chart.resolution * segment.bpm);
}
export function secondsToTick(chart: Chart, seconds: number): number {
  const segments = getTimeline(chart);
  const segment = segments[floorIndex(segments, seconds, item => item.seconds)];
  return segment.tick + (seconds - segment.seconds) * chart.resolution * segment.bpm / 240;
}
const endTicks = new WeakMap<Chart, number>();
export function getChartEndTick(chart: Chart): number {
  const cached = endTicks.get(chart); if (cached !== undefined) return cached;
  const end = chart.events.reduce((end, event) => Math.max(end, event.tick), chart.notes.reduce((end, note) => Math.max(end, note.tick + Math.max(0, note.duration ?? 0)), chart.resolution));
  endTicks.set(chart, end); return end;
}
export function chartDuration(chart: Chart): number { return tickToSeconds(chart, getChartEndTick(chart)); }
export const getChartDuration = chartDuration;
export function bpmAtTick(chart: Chart, tick: number): number {
  const timeline = getTimeline(chart); return timeline[floorIndex(timeline, tick, item => item.tick)].bpm;
}
export function snapTick(chart: Chart, tick: number, division = 16): number {
  const step = chart.resolution / Math.max(1, division);
  return Math.max(0, Math.round(tick / step) * step);
}
export function meterAtTick(chart: Chart, tick: number): { numerator: number; denominator: number } {
  const header = chart.headerRecords.find(row => row.tag === 'MET_DEF')?.raw.trim().split(/\s+/);
  let result = { numerator: header && Number.isFinite(Number(header[2])) ? Number(header[2]) : 4, denominator: Number(header?.[1]) || 4 };
  for (const event of eventsFor(chart)) {
    if (event.tick > tick) break;
    if (event.type === 'METER' && (event.numerator ?? -1) >= 0 && (event.denominator ?? -1) >= 0) result = { numerator: event.denominator === 0 ? 0 : event.numerator!, denominator: event.denominator! || 4 };
  }
  return result;
}
/** Visible measure numbers are 1-based. Hidden MET intervals consume no numbers. */
export const MAX_MEASURE_NUMBER = 200000;
interface MeasureSegment {
  tick: number;
  endTick: number;
  firstMeasure: number;
  count: number;
  span: number;
  numerator: number;
  denominator: number;
}
const measureIndexes = new WeakMap<Chart, MeasureSegment[]>();
/** Correct quotient rounding using the actual stored boundary, without a fuzzy tick tolerance. */
function measureOffsetAt(tick: number, start: number, span: number): number {
  let index = Math.floor((tick - start) / span);
  if (start + (index + 1) * span <= tick) index += 1;
  else if (start + index * span > tick) index -= 1;
  return index;
}
function measureSegments(chart: Chart): MeasureSegment[] {
  const cached = measureIndexes.get(chart); if (cached) return cached;
  const output: MeasureSegment[] = [];
  measureIndexes.set(chart, output);
  if (!Number.isFinite(chart.resolution) || chart.resolution <= 0) return output;
  const changes = eventsFor(chart).filter(event => event.type === 'METER' && Number.isFinite(event.tick) && event.tick >= 0);
  const boundaries = [...new Set([0, ...changes.map(event => event.tick)])];
  let firstMeasure = 1;
  for (let index = 0; index < boundaries.length && firstMeasure <= MAX_MEASURE_NUMBER; index++) {
    const tick = boundaries[index], nextTick = boundaries[index + 1] ?? Infinity;
    const { numerator, denominator } = meterAtTick(chart, tick);
    // A zero numerator or denominator is a native hidden-line interval, not 4/4.
    if (!(numerator > 0) || !(denominator > 0) || !Number.isFinite(numerator) || !Number.isFinite(denominator)) continue;
    const span = chart.resolution * numerator / denominator;
    if (!Number.isFinite(span) || span <= 0) continue;
    // A meter change starts a new visible measure even when it truncates the old one.
    const offset = Number.isFinite(nextTick) ? measureOffsetAt(nextTick, tick, span) : Infinity;
    const naturalCount = offset + (tick + offset * span < nextTick ? 1 : 0);
    const count = Math.min(MAX_MEASURE_NUMBER - firstMeasure + 1, naturalCount);
    const endTick = Math.min(nextTick, tick + count * span);
    output.push({ tick, endTick, firstMeasure, count, span, numerator, denominator });
    firstMeasure += count;
  }
  return output;
}

/**
 * Locate a visible, 1-based measure using the same numbering as getMeasureLines.
 * Returns null for invalid/out-of-range numbers or numbers after a permanent MET 0.
 * A hidden interval has no implied measures; numbering resumes when visible lines resume.
 */
export function getMeasureStartTick(chart: Chart, measureNumber: number): number | null {
  if (!Number.isInteger(measureNumber) || measureNumber < 1 || measureNumber > MAX_MEASURE_NUMBER) return null;
  const segments = measureSegments(chart);
  const segment = segments[floorIndex(segments, measureNumber, item => item.firstMeasure)];
  if (!segment || measureNumber >= segment.firstMeasure + segment.count) return null;
  return segment.tick + (measureNumber - segment.firstMeasure) * segment.span;
}

/** Seconds/ticks arithmetic can land a few representable values before an exact bar. */
function snapMeasureBoundary(segments: MeasureSegment[], tick: number): number {
  const index = floorIndex(segments, tick, item => item.tick), segment = segments[index];
  if (!segment) return tick;
  const nearest = Math.round((tick - segment.tick) / segment.span);
  const candidates = [segment.tick, segment.endTick, segments[index + 1]?.tick];
  if (nearest >= 0 && nearest < segment.count) candidates.push(segment.tick + nearest * segment.span);
  let snapped = tick, bestDistance = Infinity;
  for (const boundary of candidates) {
    if (boundary === undefined || !Number.isFinite(boundary)) continue;
    const distance = Math.abs(tick - boundary);
    const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(tick), Math.abs(boundary));
    if (distance <= tolerance && distance < bestDistance) { snapped = boundary; bestDistance = distance; }
  }
  return snapped;
}

/** Cached O(log MET events) lookup. Hidden intervals and invalid ticks return null. */
export function getMeasureNumberAtTick(chart: Chart, tick: number): number | null {
  if (!Number.isFinite(tick) || tick < 0) return null;
  const segments = measureSegments(chart);
  tick = snapMeasureBoundary(segments, tick);
  const segment = segments[floorIndex(segments, tick, item => item.tick)];
  if (!segment || tick < segment.tick || tick >= segment.endTick) return null;
  const index = measureOffsetAt(tick, segment.tick, segment.span);
  return index < segment.count ? segment.firstMeasure + index : null;
}

export function getMeasureLines(chart: Chart, startTick: number, endTick: number): MeasureLine[] {
  if (Number.isNaN(startTick) || Number.isNaN(endTick)) return [];
  const output: MeasureLine[] = [];
  const limit = Math.max(0, endTick);
  for (const segment of measureSegments(chart)) {
    if (segment.tick > limit) break;
    const before = measureOffsetAt(startTick, segment.tick, segment.span);
    const first = Math.max(0, before + (segment.tick + before * segment.span < startTick ? 1 : 0));
    const last = Math.min(segment.count - 1, measureOffsetAt(limit, segment.tick, segment.span));
    for (let index = first; index <= last; index++) output.push({ tick: segment.tick + index * segment.span,
      measure: segment.firstMeasure + index - 1, numerator: segment.numerator, denominator: segment.denominator });
  }
  return output;
}
export interface GridLine { tick: number; major: boolean; measure: number; beat: number }
export function getGrid(chart: Chart, startTick: number, endTick: number, division = 16): GridLine[] {
  const step = chart.resolution / Math.max(1, division);
  const measures = getMeasureLines(chart, 0, endTick);
  const ticks = new Set<number>(measures.filter(item => item.tick >= startTick).map(item => item.tick));
  for (let index = Math.ceil(Math.max(0, startTick) / step); index * step <= endTick && ticks.size < 100000; index += 1) ticks.add(index * step);
  return [...ticks].sort((a, b) => a - b).map(tick => {
    const measure = measures[floorIndex(measures, tick, item => item.tick)] ?? { tick: 0, measure: 0, denominator: 4 };
    return { tick, major: meterAtTick(chart, tick).numerator > 0 && Math.abs(tick - measure.tick) < 0.001, measure: measure.measure, beat: (tick - measure.tick) / (chart.resolution / measure.denominator) };
  });
}
function activeValue(chart: Chart, type: 'SCROLL' | 'NOTE_SPEED', tick: number, group = 0): number {
  let value = 1;
  for (const event of eventsFor(chart)) {
    if (event.tick > tick) break;
    if (type === 'SCROLL' && event.type === 'STOP' && tick < event.tick + (event.duration ?? chart.resolution)) return 0;
    const matches = type === 'NOTE_SPEED' ? event.type === 'NOTE_SPEED' : (event.type === 'SCROLL' && group === 0) || (event.type === 'GROUP_SCROLL' && (event.group ?? 0) === group);
    if (!matches) continue;
    const duration = event.duration ?? chart.resolution;
    if (tick >= event.tick + duration) continue;
    value = event.value;
  }
  return value;
}
export function scrollAtTick(chart: Chart, tick: number, group = 0): number { return activeValue(chart, 'SCROLL', tick, group); }
const noteSpeeds = new WeakMap<Chart, Map<number, number>>();
export function noteSpeedAtTick(chart: Chart, tick: number): number {
  let values = noteSpeeds.get(chart); if (!values) { values = new Map(); noteSpeeds.set(chart, values); }
  const cached = values.get(tick); if (cached !== undefined) return cached;
  const speed = activeValue(chart, 'NOTE_SPEED', tick); values.set(tick, speed); return speed;
}
interface MotionSegment { tick: number; distance: number; seconds: number; speed: number }
const motion = new WeakMap<Chart, Map<number, MotionSegment[]>>();
function motionSegments(chart: Chart, group: number): MotionSegment[] {
  let groups = motion.get(chart);
  if (!groups) { groups = new Map(); motion.set(chart, groups); }
  const cached = groups.get(group); if (cached) return cached;
  const boundaries = new Set<number>([0]);
  for (const event of eventsFor(chart)) {
    if (!(event.type === 'STOP' || (event.type === 'SCROLL' && group === 0) || (event.type === 'GROUP_SCROLL' && (event.group ?? 0) === group))) continue;
    boundaries.add(event.tick);
    boundaries.add(event.tick + (event.duration ?? chart.resolution));
  }
  const ordered = [...boundaries].filter(tick => tick >= 0).sort((a, b) => a - b);
  const result: MotionSegment[] = [];
  for (const tick of ordered) {
    const seconds = tickToSeconds(chart, tick);
    const last = result[result.length - 1];
    const distance = last ? last.distance + (seconds - last.seconds) * last.speed : 0;
    result.push({ tick, seconds, distance, speed: scrollAtTick(chart, tick, group) });
  }
  groups.set(group, result); return result;
}
export function scrollCoordinate(chart: Chart, tick: number, group = 0): number {
  const segments = motionSegments(chart, group);
  const item = segments[floorIndex(segments, tick, segment => segment.tick)];
  return item.distance + (tickToSeconds(chart, tick) - item.seconds) * item.speed;
}
const assignedGroups = new WeakMap<Chart, Map<string, number>>();
function noteGroups(chart: Chart): Map<string, number> {
  const cached = assignedGroups.get(chart); if (cached) return cached;
  const result = new Map<string, number>();
  const startingAt = new Map<string, Note[]>();
  const key = (tick: number, lane: number, width: number) => `${Math.round(tick * 1e8) / 1e8}:${lane}:${width}`;
  for (const note of chart.notes) {
    const k = key(note.tick, note.lane, note.width);
    const notes = startingAt.get(k) ?? []; notes.push(note); startingAt.set(k, notes);
  }
  for (const assignment of eventsFor(chart).filter(event => event.type === 'SCROLL_ASSIGNMENT')) {
    const group = assignment.group ?? assignment.value;
    const end = assignment.tick + (assignment.duration ?? 1);
    const heads = startingAt.get(key(assignment.tick, assignment.lane ?? 0, assignment.width ?? 1)) ?? [];
    for (const head of heads) {
      if (head.tick + (head.duration ?? 0) > end + 1e-8) continue;
      const pending = [head]; const seen = new Set<string>();
      while (pending.length) {
        const note = pending.pop()!;
        if (seen.has(note.id)) continue; seen.add(note.id); result.set(note.id, group);
        if (!note.duration || !['SLIDE', 'AIR_SLIDE', 'AIR_CRUSH', 'AIR_HOLD'].includes(note.type)) continue;
        const nextTick = note.tick + note.duration;
        if (nextTick >= end - 1e-8) continue;
        const successors = startingAt.get(key(nextTick, note.endLane ?? note.lane, note.endWidth ?? note.width)) ?? [];
        for (const next of successors) if (next.type === head.type && next.tick + (next.duration ?? 0) <= end + 1e-8) pending.push(next);
      }
    }
  }
  for (const note of chart.notes) if (Number.isInteger(note.attributes.speedGroup) && Number(note.attributes.speedGroup) >= 0) result.set(note.id, Number(note.attributes.speedGroup));
  assignedGroups.set(chart, result); return result;
}
export function getNoteScrollGroup(chart: Chart, note: Note): number { return noteGroups(chart).get(note.id) ?? 0; }
/** Signed travel distance in seconds at scroll speed 1. Negative values support reverse scrolling.
 * Pass the same native note for every sample along a long-note body so its assigned group is retained.
 */
export function getScrollPosition(chart: Chart, noteTick: number, currentTick: number, note?: Note): number {
  const group = note ? getNoteScrollGroup(chart, note) : 0;
  return (scrollCoordinate(chart, noteTick, group) - scrollCoordinate(chart, currentTick, group)) * noteSpeedAtTick(chart, note?.tick ?? noteTick);
}

/** Reads quarter-beat positions, including fractions such as "4/7". Returns undefined for invalid input. */
export function parseBeatPosition(chart: Chart, text: string): number | undefined {
  const parts = text.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*\/\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?$/);
  if (!parts) return undefined;
  const numerator = Number(parts[1]); const denominator = parts[2] === undefined ? 1 : Number(parts[2]);
  const tick = numerator / denominator * chart.resolution / 4;
  return Number.isFinite(tick) ? tick : undefined;
}
/** Formats a tick as a reduced number of quarter beats, preserving common tuplets. */
export function formatBeatPosition(chart: Chart, tick: number, maxDenominator = 10000): string {
  const beats = tick * 4 / chart.resolution;
  if (!Number.isFinite(beats)) return String(beats);
  const limit = Math.max(1, Math.min(100000, Math.floor(maxDenominator)));
  for (let denominator = 1; denominator <= limit; denominator += 1) {
    const numerator = Math.round(beats * denominator);
    if (Math.abs(beats - numerator / denominator) < 1e-10) return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
  }
  return String(Number(beats.toPrecision(12)));
}

export interface NotePlaybackPoint {
  noteId: string;
  position: 'head' | 'end';
  tick: number;
  lane: number;
  width: number;
  height?: number;
  type: Note['type'];
  direction?: string;
  sound: boolean;
}
const playbackPoints = new WeakMap<Chart, Map<string, NotePlaybackPoint[]>>();
const nodeKey = (type: string, tick: number, lane: number, width: number) => `${type}:${tick.toFixed(7)}:${lane}:${width}`;
/** Native D/C/X joint flags belong to the END of the segment. See docs/node-semantics.md. */
export function getNotePlaybackPoints(chart: Chart, target: Note): readonly NotePlaybackPoint[] {
  let cache = playbackPoints.get(chart);
  if (!cache) {
    cache = new Map(); playbackPoints.set(chart, cache);
    const ends = new Map<string, Note[]>(), explicitAir = new Set<string>();
    for (const note of chart.notes) {
      if (note.duration !== undefined && note.duration >= 0) {
        const key = nodeKey(note.type, note.tick + note.duration, note.endLane ?? note.lane, note.endWidth ?? note.width);
        const items = ends.get(key) ?? []; items.push(note); ends.set(key, items);
      }
      if (note.type === 'AIR') explicitAir.add(nodeKey('AIR', note.tick, note.lane, note.width));
    }
    for (const note of chart.notes) {
      const points: NotePlaybackPoint[] = []; cache.set(note.id, points);
      const endTick = note.tick + (note.duration ?? 0), endLane = note.endLane ?? note.lane, endWidth = note.endWidth ?? note.width;
      const family = ['SLIDE', 'AIR_HOLD', 'AIR_SLIDE'].includes(note.type);
      const parent = String(note.attributes.parent ?? 'TAP');
      const predecessor = family && (ends.get(nodeKey(note.type, note.tick, note.lane, note.width)) ?? []).some(previous => {
        if (previous.id === note.id) return false;
        if (note.type === 'SLIDE') return true;
        if (String(previous.attributes.color ?? 'DEF') !== String(note.attributes.color ?? 'DEF')) return false;
        if (note.type === 'AIR_HOLD') return parent === 'AHD'; // AHX uses the AHD family as parent, too.
        return parent === (previous.attributes.visible === false ? 'ASC' : 'ASD') && (note.height ?? 1) === (previous.endHeight ?? previous.height ?? 1);
      });
      if (!predecessor) {
        const airSustain = note.type === 'AIR_HOLD' || note.type === 'AIR_SLIDE';
        // Native T_NUM_AIR includes sustain chain heads. An explicit AIR owns the same head when supplied.
        if (!airSustain || !explicitAir.has(nodeKey('AIR', note.tick, note.lane, note.width))) points.push({
          noteId: note.id, position: 'head', tick: note.tick, lane: note.lane, width: note.width,
          type: airSustain ? 'AIR' : note.type, height: airSustain ? .48 : note.height,
          direction: airSustain ? 'IR' : String(note.attributes.direction ?? ''), sound: note.type !== 'DAMAGE',
        });
      }
      if (note.duration !== undefined && (note.duration > 0 || family) && (!family || note.attributes.visible !== false)) {
        // Only suppress a zero-length terminal repeating its actual normal predecessor.
        // Independent/colored overlapping chains must retain their own endpoint actions.
        const redundantTerminal = note.duration === 0 && predecessor && (ends.get(nodeKey(note.type, endTick, endLane, endWidth)) ?? []).some(previous =>
          previous.id !== note.id && (previous.duration ?? 0) > 0 && previous.attributes.visible !== false && String(previous.attributes.color ?? 'DEF') === String(note.attributes.color ?? 'DEF') && (previous.endHeight ?? previous.height) === (note.endHeight ?? note.height));
        if (!redundantTerminal) {
          points.push({ noteId: note.id, position: 'end', tick: endTick, lane: endLane, width: endWidth,
            type: note.type, height: note.endHeight ?? note.height, sound: family });
        }
      }
    }
  }
  return cache.get(target.id) ?? [];
}
