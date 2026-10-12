import { NOTE_TYPES, type Chart, type Note } from './model';
import { getC2SEntityOrder } from './c2s';
import { bpmAtTick } from './timing';

export const JUDGEMENT_CATEGORIES = ['TAP', 'HLD', 'SLD', 'AIR', 'FLK'] as const;
export type JudgementCategory = typeof JUDGEMENT_CATEGORIES[number];
export type JudgementCounts = Record<JudgementCategory, number>;
export interface JudgementPoint {
  tick: number;
  noteId: string;
  category: JudgementCategory;
  kind: 'head' | 'sustain' | 'end' | 'crush' | 'avoid';
}
export interface JudgementTimeline {
  points: JudgementPoint[];
  total: number;
  counts: JudgementCounts;
  /** native: supported rules and no detected mismatch; estimated: unresolved rules/counts; unsupported: invalid/unknown data. */
  status: 'native' | 'estimated' | 'unsupported';
  diagnostics: string[];
  header: {
    available: boolean;
    matches: boolean | null;
    expected: Partial<JudgementCounts> & { ALL?: number };
    differences: { category: JudgementCategory | 'ALL'; expected: number; actual: number }[];
    /** Headers of edited charts are stale references, never the scoring denominator. */
    sourceUnchanged: boolean;
  };
}
export interface AutoScore { combo: number; score: number; total: number }
const cache = new WeakMap<Chart, JudgementTimeline>();
export const MAX_JUDGEMENT_POINTS = 250000;
const end = (n: Note) => n.tick + (n.duration ?? 0);
const nodeKey = (tick: number, lane: number, width: number) => `${tick.toFixed(7)}:${lane}:${width}`;
const counts = (): JudgementCounts => ({ TAP: 0, HLD: 0, SLD: 0, AIR: 0, FLK: 0 });
function headerValue(chart: Chart, tag: string): number | undefined {
  const row = chart.headerRecords.find(row => row.tag === tag);
  const value = row && Number(row.raw.trim().split(/\s+/)[1]);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}
/** airParent is the ground note whose tail was current when the AIR head was read. */
interface NativeRoot { ground: Note[]; air: Note[]; airParent?: Note }
const groundFamily = (note: Note): string | undefined => ({ TAP: 'TAP', EXTAP: 'CHR', HOLD: 'HLD', SLIDE: 'SLD', FLICK: 'FLK', DAMAGE: 'MNE' } as Partial<Record<Note['type'], string>>)[note.type];
export const nativeParentFamily = (parent: unknown): string => ({ HXD: 'HLD', SXD: 'SLD', SLC: 'SLD', SXC: 'SLD' } as Record<string, string>)[String(parent)] ?? String(parent);
/** ScoreReader consumes records sequentially and searches GROUND roots in creation
 * order, including when an AIR continuation is attached much later. Only current
 * tails are candidates. An index preserves root order without scanning all roots.
 */
function readNativeRoots(notes: Note[]): { roots: NativeRoot[]; orphanCount: number } {
  const roots: NativeRoot[] = [], groundTails = new Map<string, number[]>(), airTails = new Map<string, number[]>();
  const geometry = (note: Note, tail = false): string => nodeKey(tail ? end(note) : note.tick, tail ? note.endLane ?? note.lane : note.lane, tail ? note.endWidth ?? note.width : note.width);
  const airKey = (note: Note, tail: boolean): string => `${note.type}:${geometry(note, tail)}` + (note.type === 'AIR_SLIDE' ? `:${tail ? note.endHeight ?? note.height ?? 1 : note.height ?? 1}:${tail ? note.attributes.visible === false ? 'ASC' : 'ASD' : note.attributes.parent}` : '');
  const insert = (map: Map<string, number[]>, key: string, index: number): void => {
    const candidates = map.get(key) ?? [], before = candidates.findIndex(i => i > index);
    candidates.splice(before < 0 ? candidates.length : before, 0, index); map.set(key, candidates);
  };
  let orphanCount = 0;
  for (const note of notes) {
    const family = groundFamily(note);
    if (family) {
      const candidates = groundTails.get(`${family}:${geometry(note)}`) ?? [];
      // Column 8 is a two-value SLD/NCL enum; other spellings default to SLD.
      const match = note.type === 'SLIDE' ? candidates.findIndex(i => (roots[i].ground[0].attributes.parent === 'NCL') === (note.attributes.parent === 'NCL')) : -1;
      let index: number;
      if (match < 0) { index = roots.length; roots.push({ ground: [], air: [] }); }
      else index = candidates.splice(match, 1)[0];
      roots[index].ground.push(note);
      insert(groundTails, `${family}:${geometry(note, true)}`, index);
    } else if (['AIR', 'AIR_HOLD', 'AIR_SLIDE'].includes(note.type)) {
      const parent = String(note.attributes.parent ?? 'TAP');
      const continuation = note.type === 'AIR_HOLD' && ['AHD', 'AHX'].includes(parent) || note.type === 'AIR_SLIDE' && ['ASD', 'ASC'].includes(parent);
      const candidates = continuation ? airTails.get(airKey(note, false)) : groundTails.get(`${nativeParentFamily(parent)}:${geometry(note)}`);
      const match = candidates?.findIndex(i => continuation || !roots[i].air.length) ?? -1;
      let index: number;
      if (match < 0) {
        // Retain a useful preview for malformed/orphan authoring entities, but
        // expose the missing native parent instead of asserting compatibility.
        index = roots.length; roots.push({ ground: [], air: [] }); orphanCount++;
      } else index = continuation ? candidates!.splice(match, 1)[0] : candidates![match];
      if (match >= 0 && !continuation) roots[index].airParent = roots[index].ground.at(-1);
      roots[index].air.push(note);
      if (note.type !== 'AIR') insert(airTails, airKey(note, true), index);
    }
  }
  return { roots, orphanCount };
}
export interface NativeAirBindings {
  /** AIR / AIR-HOLD / AIR-SLIDE record id → the ground note whose tail carries its root. */
  parentOf: ReadonlyMap<string, Note>;
  /** Ground note id → the AIR records of its root in read order, head first. */
  airOf: ReadonlyMap<string, readonly Note[]>;
  /** First record of every AIR chain ScoreReader rejects with `pParent == NULL`. */
  orphans: readonly Note[];
}
const bindings = new WeakMap<Chart, NativeAirBindings>();
/** ScoreReader stores AIR as an attachment of a ground root, never as a free note:
 * the head must match a root's parent type, current tail time, lane and width, and
 * a root takes one AIR head. A record without such a parent fails the whole read.
 */
export function getNativeAirBindings(chart: Chart): NativeAirBindings {
  const old = bindings.get(chart); if (old) return old;
  const notes = getC2SEntityOrder(chart).entities.filter((entity): entity is Note => 'attributes' in entity);
  const parentOf = new Map<string, Note>(), airOf = new Map<string, Note[]>(), orphans: Note[] = [];
  for (const root of readNativeRoots(notes).roots) {
    if (!root.air.length) continue;
    if (!root.airParent) { orphans.push(root.air[0]); continue; }
    airOf.set(root.airParent.id, root.air);
    for (const air of root.air) parentOf.set(air.id, root.airParent);
  }
  const result = { parentOf, airOf, orphans };
  bindings.set(chart, result); return result;
}
/** FIFO consumption prevents a single preceding segment from silently merging independent paths. */
/** The same consumed-tail chains used by scoring, exposed for continuous SLIDE visuals. */
export function getNativeSlideChains(chart: Chart): readonly (readonly Note[])[] {
  const notes = getC2SEntityOrder(chart).entities.filter((entity): entity is Note => 'attributes' in entity);
  return readNativeRoots(notes).roots.filter(root => root.ground[0]?.type === 'SLIDE').map(root => root.ground);
}

function chains(chart: Chart, type: Note['type']): Note[][] {
  const result: Note[][] = [], ends = new Map<string, number[]>();
  const key = (n: Note, atEnd: boolean): string => nodeKey(atEnd ? end(n) : n.tick, atEnd ? n.endLane ?? n.lane : n.lane, atEnd ? n.endWidth ?? n.width : n.width)
    + (['AIR_SLIDE', 'AIR_HOLD', 'AIR_CRUSH'].includes(type) ? `:${n.attributes.color ?? 'DEF'}` : '')
    + (['AIR_SLIDE', 'AIR_CRUSH'].includes(type) ? `:${atEnd ? n.endHeight ?? n.height ?? 1 : n.height ?? 1}` : '')
    + (type === 'AIR_CRUSH' ? `:${n.attributes.interval ?? 24}` : '');
  for (const note of chart.notes.filter(n => n.type === type).sort((a, b) => a.tick - b.tick)) {
    const candidates = ends.get(key(note, false));
    const match = candidates?.findIndex(i => type === 'SLIDE' || type === 'AIR_CRUSH' || type === 'AIR_HOLD' && note.attributes.parent === 'AHD' || type === 'AIR_SLIDE' && note.attributes.parent === (result[i].at(-1)!.attributes.visible === false ? 'ASC' : 'ASD')) ?? -1;
    let index: number;
    if (match >= 0) index = candidates!.splice(match, 1)[0];
    else { index = result.length; result.push([]); }
    result[index].push(note);
    const nextKey = key(note, true), waiting = ends.get(nextKey) ?? [];
    waiting.push(index); ends.set(nextKey, waiting);
  }
  return result;
}
function sourceUnchanged(chart: Chart): boolean {
  if (getC2SEntityOrder(chart).changed || chart.version !== chart.source!.originalVersion) return false;
  return JSON.stringify(chart.headerRecords.map(row => [row.tag, row.raw])) === JSON.stringify(chart.source!.records.filter(row => row.kind === 'header').map(row => [row.tag, row.raw]));
}
/** Builds from chart entities only; native statistics are compared afterwards, never used as input counts. */
export function buildJudgementTimeline(chart: Chart): JudgementTimeline {
  const old = cache.get(chart); if (old) return old;
  const points: JudgementPoint[] = [], diagnostics: string[] = [];
  let unsupported = chart.unknownRecords.length > 0;
  if (unsupported) diagnostics.push('谱面包含未识别记录，无法确认完整判定。');
  const threshold = headerValue(chart, 'PROGJUDGE_BPM') ?? 240;
  const aer = headerValue(chart, 'PROGJUDGE_AER') ?? .999;
  if (!(threshold > 0) || aer !== .999) diagnostics.push('无效 PROGJUDGE_BPM 或非默认 PROGJUDGE_AER 尚未验证。');
  const tutorial = !!headerValue(chart, 'TUTORIAL');
  const validTimebase = Number.isFinite(chart.resolution) && chart.resolution > 0
    && Number.isFinite(chart.defaultBpm) && chart.defaultBpm > 0 && threshold > 0
    && chart.events.filter(event => event.type === 'BPM').every(event => Number.isFinite(event.tick) && event.tick >= 0 && Number.isFinite(event.value) && event.value > 0);
  if (!validTimebase) { unsupported = true; diagnostics.push('BPM、分辨率或 PROGJUDGE_BPM 无效；没有生成判定时间表。'); }
  let invalidNotes = 0;
  const validNotes = getC2SEntityOrder(chart).entities.filter((entity): entity is Note => 'attributes' in entity).filter(note => {
    const valid = NOTE_TYPES.includes(note.type) && Number.isFinite(note.tick) && note.tick >= 0
      && Number.isFinite(note.duration ?? 0) && (note.duration ?? 0) >= 0 && Number.isFinite(end(note))
      && [note.lane, note.width, note.endLane ?? note.lane, note.endWidth ?? note.width, note.height ?? 1, note.endHeight ?? note.height ?? 1].every(Number.isFinite)
      && (note.type !== 'AIR_CRUSH' || Number.isFinite(Number(note.attributes.interval ?? 24)) && Number(note.attributes.interval ?? 24) >= 0);
    if (!valid) invalidNotes++;
    return valid;
  });
  if (invalidNotes) { unsupported = true; diagnostics.push(`${invalidNotes} 个音符的时间、长度、几何坐标或 CRUSH 间隔无效，已跳过。`); }
  const workingChart = { ...chart, notes: validTimebase ? validNotes : [] };
  const intervalAt = (tick: number): number => {
    const bpm = bpmAtTick(chart, tick);
    // Each power-of-two BPM band changes the native continuation interval.
    // Non-default thresholds are present in official WORLD’S END charts.
    return Math.max(1, Math.floor(Math.min(chart.resolution, chart.resolution / 4 * 2 ** Math.floor(Math.log2(bpm / (threshold > 0 ? threshold : 240))))));
  };
  const limit = (): void => {
    unsupported = true;
    if (!diagnostics.includes('判定数量超出 250000 上限；当前时间表被截断，不能用于完整计分。')) diagnostics.push('判定数量超出 250000 上限；当前时间表被截断，不能用于完整计分。');
  };
  const add = (note: Note, tick: number, category: JudgementCategory, kind: JudgementPoint['kind']): void => {
    if (!Number.isFinite(tick) || tick < 0) { unsupported = true; return; }
    if (points.length >= MAX_JUDGEMENT_POINTS) { limit(); return; }
    points.push({ tick, noteId: note.id, category, kind });
  };
  // Re-sample BPM at each native continuation step. Integrating BPM density is
  // not equivalent when a judgement step straddles a tempo change.
  const progression = (start: number, stop: number): number[] => {
    const ticks: number[] = []; let tick = start;
    while (tick < stop) {
      const next = tick + intervalAt(tick);
      if (!(next > tick) || !Number.isFinite(next)) { unsupported = true; diagnostics.push('持续判定间隔无效。'); break; }
      ticks.push(next); tick = next;
      if (ticks.length > MAX_JUDGEMENT_POINTS - points.length + 3) { limit(); break; }
    }
    return ticks;
  };
  const sustain = (note: Note, start: number, stop: number, category: JudgementCategory, trimExact: number, trimOverflow: number, normalEnd = false): void => {
    const ticks = progression(start, stop), trim = (ticks.at(-1) ?? stop) > stop + 1e-8 ? trimOverflow : trimExact;
    const count = Math.max(0, ticks.length - trim);
    for (let i = 0; i < count; i++) add(note, Math.min(stop, ticks[i]), category, normalEnd && i === count - 1 ? 'end' : 'sustain');
  };
  const { roots, orphanCount } = readNativeRoots(workingChart.notes);
  if (orphanCount) { unsupported = true; diagnostics.push(`${orphanCount} 个 AIR 记录在读取时缺少匹配的原生父音符；仅保留独立预览。`); }
  const attachedIds = new Set(roots.filter(root => root.ground.length && root.air.length).map(root => root.ground.at(-1)!.id));
  for (const note of workingChart.notes) {
    if (note.type === 'TAP' || note.type === 'EXTAP' || note.type === 'DAMAGE') add(note, note.tick, 'TAP', note.type === 'DAMAGE' ? 'avoid' : 'head');
    else if (note.type === 'FLICK') add(note, note.tick, 'FLK', 'head');
    else if (note.type === 'AIR') add(note, note.tick, 'AIR', 'head');
    else if (note.type === 'HOLD') {
      add(note, note.tick, 'TAP', 'head');
      const replace = attachedIds.has(note.id);
      if (!tutorial || !replace) sustain(note, note.tick, end(note), 'HLD', replace ? 1 : 0, replace ? 2 : 0);
    }
  }
  for (const chain of chains(workingChart, 'AIR_CRUSH')) {
    const first = chain[0], step = Number(first.attributes.interval ?? 24), length = end(chain.at(-1)!) - first.tick;
    if (step > 0 && Number.isFinite(step)) {
      const count = Math.floor(length / step + 1e-8) + 1;
      const remaining = MAX_JUDGEMENT_POINTS - points.length;
      let segmentIndex = 0;
      for (let i = 0; i < Math.min(count, remaining); i++) {
        const tick = first.tick + i * step;
        // A shared boundary belongs to the following shape segment.
        while (segmentIndex < chain.length - 1 && chain[segmentIndex + 1].tick <= tick) segmentIndex++;
        add(chain[segmentIndex], tick, 'AIR', 'crush');
      }
      if (count > remaining) limit();
    }
  }
  for (const root of roots.filter(root => root.ground[0]?.type === 'SLIDE')) {
    const chain = root.ground;
    const first = chain[0]; let start = first.tick;
    add(first, first.tick, 'TAP', 'head');
    const pointStart = points.length;
    // The native tutorial branch disables the entire ground continuation vector
    // for a root with AIR/AIR-HOLD/AIR-SLIDE attached, while keeping its head.
    if (tutorial && root.air.length) continue;
    for (let i = 0; i < chain.length; i++) {
      const segment = chain[i];
      if (segment.attributes.visible === false && i < chain.length - 1) continue;
      const replace = root.air[0]?.tick === end(segment);
      const normal = segment.attributes.visible !== false;
      sustain(segment, start, end(segment), 'SLD', replace ? 1 : 0, replace ? 2 : normal ? 0 : 1, !replace && normal);
      start = end(segment);
    }
    // An AIR release window can reach back across preceding normal joints.
    // Keep the chain head: the cancellation applies only to SLD judgements.
    const airTicks = root.air.length ? [root.air[0].tick] : [];
    if (airTicks.length) {
      let write = pointStart;
      for (let read = pointStart; read < points.length; read++) {
        const point = points[read];
        if (!airTicks.some(tick => point.tick <= tick + 1e-8 && point.tick + intervalAt(point.tick) > tick + 1e-8)) points[write++] = point;
      }
      points.length = write;
    }
  }
  for (const root of roots.filter(root => ['AIR_HOLD', 'AIR_SLIDE'].includes(root.air[0]?.type))) {
    const chain = root.air;
    const first = chain[0]; let start = first.tick;
    add(first, first.tick, 'AIR', 'head');
    for (let i = 0; i < chain.length; i++) {
      const segment = chain[i], normal = segment.attributes.visible !== false;
      if (!normal && i < chain.length - 1) continue;
      sustain(segment, start, end(segment), 'AIR', 2, normal ? 2 : 3);
      if (normal) add(segment, end(segment), 'AIR', 'end');
      start = end(segment);
    }
  }
  if (tutorial) {
    // ScoreReader's tutorial freeze check uses strict interval boundaries and
    // only the two continuation vectors. Heads and CRUSH are separate.
    const freezes = chart.events.filter(e => e.type === 'SCROLL' && e.value === 0 && (e.duration ?? 0) > 0);
    if (freezes.length) {
      let write = 0;
      for (const point of points) {
        const frozen = (point.kind === 'sustain' || point.kind === 'end') && freezes.some(e => e.tick < point.tick && point.tick < e.tick + e.duration!);
        if (!frozen) points[write++] = point;
      }
      points.length = write;
    }
  }
  if (chart.notes.some(n => n.duration !== undefined)) diagnostics.push('持续判定的时间位置和特殊节点规则正在核查；当前结果仅为估计。');
  points.sort((a, b) => a.tick - b.tick);
  const actual = counts(); for (const point of points) actual[point.category]++;
  const expected: JudgementTimeline['header']['expected'] = {};
  for (const category of [...JUDGEMENT_CATEGORIES, 'ALL'] as const) {
    const value = headerValue(chart, `T_JUDGE_${category}`); if (value !== undefined) expected[category] = value;
  }
  const unchanged = sourceUnchanged(chart), differences: JudgementTimeline['header']['differences'] = [];
  for (const category of [...JUDGEMENT_CATEGORIES, 'ALL'] as const) if (expected[category] !== undefined && expected[category] !== (category === 'ALL' ? points.length : actual[category])) differences.push({ category, expected: expected[category]!, actual: category === 'ALL' ? points.length : actual[category] });
  const available = Object.keys(expected).length > 0;
  if (available && !unchanged) diagnostics.push('原谱统计已过期：工程有改动，旧统计不参与计分。');
  if (available && unchanged && differences.length) diagnostics.push(`原谱统计不符：${differences.map(d => `${d.category} ${d.actual}/${d.expected}`).join('，')}。`);
  const result: JudgementTimeline = { points, total: points.length, counts: actual, status: unsupported ? 'unsupported' : diagnostics.length ? 'estimated' : 'native', diagnostics, header: { available, matches: available && unchanged ? differences.length === 0 : null, expected, differences, sourceUnchanged: unchanged } };
  cache.set(chart, result); return result;
}
/** Binary-search the immutable timeline; seeking backwards or starting mid-song needs no mutable combo state. */
export function getAutoScoreAtTick(timeline: JudgementTimeline, tick: number): AutoScore {
  let low = 0, high = timeline.points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (timeline.points[middle].tick <= tick) low = middle + 1; else high = middle; }
  return { combo: low, score: timeline.total ? Math.floor(1010000 * low / timeline.total) : 0, total: timeline.total };
}
