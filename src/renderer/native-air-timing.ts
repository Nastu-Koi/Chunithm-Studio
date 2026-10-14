import type { Chart, Note } from '../core/model';
import { getC2SEntityOrder } from '../core/c2s';
import { tickToSeconds } from '../core/timing';

export interface NativeAirSlideUvSpan {
  startTick: number;
  endTick: number;
  startSeconds: number;
  endSeconds: number;
  rootId: string;
  rootCenterLane: number;
}
const cache = new WeakMap<Chart, ReadonlyMap<string, NativeAirSlideUvSpan>>();
const endTick = (note: Note) => note.tick + (note.duration ?? 0);
const geometry = (note: Note, tail = false) =>
  [
    (tail ? endTick(note) : note.tick).toFixed(7),
    tail ? (note.endLane ?? note.lane) : note.lane,
    tail ? (note.endWidth ?? note.width) : note.width,
  ].join(':');
const groundFamilies: Partial<Record<Note['type'], string>> = {
  TAP: 'TAP',
  EXTAP: 'CHR',
  HOLD: 'HLD',
  SLIDE: 'SLD',
  FLICK: 'FLK',
  DAMAGE: 'MNE',
};
const parentFamilies: Record<string, string> = { HXD: 'HLD', SXD: 'SLD', SLC: 'SLD', SXC: 'SLD' };

/** Preserve the score reader's record order, ground-root priority and current-tail
 * consumption. Sorting ASD records by time alone merges overlapping branches.
 * The original AIR reader does not use a segment's color as a parent-match key. */
function airSlideChains(chart: Chart): Note[][] {
  const roots: { ground?: Note; air: Note[] }[] = [];
  const groundTails = new Map<string, number[]>(),
    airTails = new Map<string, number[]>();
  const insert = (map: Map<string, number[]>, key: string, index: number) => {
    const entries = map.get(key) ?? [],
      at = entries.findIndex(value => value > index);
    entries.splice(at < 0 ? entries.length : at, 0, index);
    map.set(key, entries);
  };
  const airKey = (note: Note, tail: boolean) =>
    `${note.type}:${geometry(note, tail)}` +
    (note.type === 'AIR_SLIDE'
      ? `:${tail ? (note.endHeight ?? note.height ?? 1) : (note.height ?? 1)}:${tail ? (note.attributes.visible === false ? 'ASC' : 'ASD') : note.attributes.parent}`
      : '');
  for (const entity of getC2SEntityOrder(chart).entities) {
    if (!('attributes' in entity)) continue;
    const note = entity,
      family = groundFamilies[note.type];
    if (family) {
      const candidates = groundTails.get(`${family}:${geometry(note)}`) ?? [];
      const match =
        note.type === 'SLIDE'
          ? candidates.findIndex(
              i => (roots[i].ground?.attributes.parent === 'NCL') === (note.attributes.parent === 'NCL'),
            )
          : -1;
      const index = match < 0 ? roots.push({ ground: note, air: [] }) - 1 : candidates.splice(match, 1)[0];
      insert(groundTails, `${family}:${geometry(note, true)}`, index);
    } else if (['AIR', 'AIR_HOLD', 'AIR_SLIDE'].includes(note.type)) {
      const parent = String(note.attributes.parent ?? 'TAP');
      const continuation =
        (note.type === 'AIR_HOLD' && ['AHD', 'AHX'].includes(parent)) ||
        (note.type === 'AIR_SLIDE' && ['ASD', 'ASC'].includes(parent));
      const candidates = continuation
        ? airTails.get(airKey(note, false))
        : groundTails.get(`${parentFamilies[parent] ?? parent}:${geometry(note)}`);
      const match = candidates?.findIndex(i => continuation || roots[i].air.length === 0) ?? -1;
      const index =
        match < 0 ? roots.push({ air: [] }) - 1 : continuation ? candidates!.splice(match, 1)[0] : candidates![match];
      roots[index].air.push(note);
      if (note.type !== 'AIR') insert(airTails, airKey(note, true), index);
    }
  }
  return roots.map(root => root.air).filter(chain => chain[0]?.type === 'AIR_SLIDE');
}

/** 0xc4b72c writes unscrolled node time into strip +0x14; 0xc27c3f..0xc27d12
 * interpolates V across control nodes until the next normal node. The separate
 * +0x8 array drives Z, so BPM affects the seconds ratio but scroll events do not. */
export function getNativeAirSlideUvSpans(chart: Chart): ReadonlyMap<string, NativeAirSlideUvSpan> {
  const cached = cache.get(chart);
  if (cached) return cached;
  const spans = new Map<string, NativeAirSlideUvSpan>();
  for (const chain of airSlideChains(chart)) {
    let first = 0;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].attributes.visible === false && i !== chain.length - 1) continue;
      const startTick = chain[first].tick,
        stopTick = endTick(chain[i]);
      const span: NativeAirSlideUvSpan = {
        startTick,
        endTick: stopTick,
        startSeconds: tickToSeconds(chart, startTick),
        endSeconds: tickToSeconds(chart, stopTick),
        rootId: chain[0].id,
        rootCenterLane: chain[0].lane + chain[0].width / 2,
      };
      for (let j = first; j <= i; j++) spans.set(chain[j].id, span);
      first = i + 1;
    }
  }
  cache.set(chart, spans);
  return spans;
}

export function nativeAirSlideVAtTick(chart: Chart, span: NativeAirSlideUvSpan, tick: number): number {
  const duration = Math.max(0.00001, span.endSeconds - span.startSeconds);
  return 1 - Math.max(0, Math.min(1, (tickToSeconds(chart, tick) - span.startSeconds) / duration));
}
