import { LANES, makeId, type Chart, type ChartEvent, type Note, type NoteType } from '../core/model';
import { getNoteScrollGroup } from '../core/timing';
import { noteNativeKind } from '../core/validation';
import { getNativeNoteTag } from '../core/c2s';
import { getNativeAirBindings, getNativeSlideChains, nativeParentFamily } from '../core/judgement';

/** Pure chart transformations behind the editor. Every function returns a new Chart and never mutates its input. */
export type Clipboard = { notes: Note[]; events: ChartEvent[]; firstTick: number };
export const LONG = new Set<NoteType>(['HOLD', 'SLIDE', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH']);
export const AIR = new Set<NoteType>(['AIR', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH']);
export const CHAIN = new Set<NoteType>(['SLIDE', 'AIR_SLIDE', 'AIR_CRUSH']);
export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export const endLane = (note: Note) => note.endLane ?? note.lane;
export const endWidth = (note: Note) => note.endWidth ?? note.width;
export const endTick = (note: Note) => note.tick + (note.duration ?? 0);
export const sameTick = (a: number, b: number) => Math.abs(a - b) < 1e-6;
export const formatTick = (value: number) => Number(value.toFixed(6)).toString();
export const long = (note: Note) => LONG.has(note.type);
export const copyNote = (note: Note): Note => ({ ...note, attributes: { ...note.attributes } });
export type EditorNodeKind = 'normal' | 'control';
export const hasNodeKind = (note: Note) => ['SLIDE', 'AIR_HOLD', 'AIR_SLIDE'].includes(note.type);
const continuationParent = (note: Note): string =>
  note.type === 'AIR_SLIDE'
    ? getNativeNoteTag(note)
    : (({ SLIDE: 'SLD', AIR_HOLD: 'AHD' } as Partial<Record<NoteType, string>>)[note.type] ??
      String(note.attributes.parent ?? 'TAP'));
/** The joint belongs to this segment's end; AIR SLIDE children reference its exact tag. */
export function setEditorNodeKind(chart: Chart, id: string, kind: EditorNodeKind): Chart {
  const note = chart.notes.find(item => item.id === id);
  if (!note || !hasNodeKind(note)) return chart;
  const next = { ...note, attributes: { ...note.attributes, visible: kind === 'normal' } };
  return {
    ...chart,
    notes: chart.notes.map(item =>
      item.id === id
        ? next
        : note.type === 'AIR_SLIDE' &&
            item.type === 'AIR_SLIDE' &&
            item.attributes.parent === getNativeNoteTag(note) &&
            sameTick(item.tick, endTick(note)) &&
            item.lane === endLane(note) &&
            item.width === endWidth(note) &&
            String(item.attributes.color ?? 'DEF') === String(note.attributes.color ?? 'DEF') &&
            (item.height ?? 1) === (note.endHeight ?? note.height ?? 1)
          ? { ...item, attributes: { ...item.attributes, parent: getNativeNoteTag(next) } }
          : item,
    ),
  };
}
const laneLimits = (chart: Chart, width: number) =>
  chart.allowOutOfLane ? { min: -64, max: 64 } : { min: 0, max: Math.max(0, LANES - width) };
export const limitLane = (chart: Chart, lane: number, width: number) => {
  const limits = laneLimits(chart, width);
  return clamp(lane, limits.min, limits.max);
};
export const limitWidth = (chart: Chart, width: number, lane: number) =>
  clamp(width, 1, chart.allowOutOfLane ? 128 : Math.max(1, LANES - lane));
/** Native AIR parent tokens identify the ground family even for EX/control variants. */
const groundParentToken = (parent: Note): string =>
  parent.type === 'HOLD' ? 'HLD' : parent.type === 'SLIDE' ? 'SLD' : noteNativeKind(parent);
export function inferEditorParent(chart: Chart, tick: number, lane: number, width: number): string {
  const parent = chart.notes
    .filter(
      note =>
        sameTick(endTick(note), tick) && endLane(note) === lane && endWidth(note) === width && !AIR.has(note.type),
    )
    .at(-1);
  return parent ? groundParentToken(parent) : 'TAP';
}
/** The ground note an AIR head is bound to; continuation segments and unbound records have none. */
export function boundEditorParent(chart: Chart, id: string): Note | undefined {
  const { parentOf, airOf } = getNativeAirBindings(chart),
    parent = parentOf.get(id);
  return parent && airOf.get(parent.id)![0].id === id ? parent : undefined;
}
/** A ground note and the AIR on its tail are one native root: picking the ground note takes its AIR chain,
 * and picking the AIR head takes the ground note unless only the downward direction is wanted (deleting).
 */
export function selectionWithBoundAir(chart: Chart, ids: Set<string>, withParents = true): Set<string> {
  const { airOf } = getNativeAirBindings(chart),
    selected = new Set(ids);
  if (!airOf.size) return selected;
  if (withParents)
    for (const id of ids) {
      const parent = boundEditorParent(chart, id);
      if (parent) selected.add(parent.id);
    }
  for (const id of [...selected]) for (const air of airOf.get(id) ?? []) selected.add(air.id);
  return selected;
}
/** Put a new AIR head on a ground note's tail. Undefined when that root cannot take it, as ScoreReader would find no parent. */
export function attachEditorAir(chart: Chart, air: Note, parentId: string): Chart | undefined {
  const index = chart.notes.findIndex(note => note.id === parentId),
    parent = chart.notes[index];
  if (!parent || AIR.has(parent.type) || !['AIR', 'AIR_HOLD', 'AIR_SLIDE'].includes(air.type)) return undefined;
  const lane = endLane(parent),
    width = endWidth(parent);
  const note: Note = {
    ...air,
    tick: endTick(parent),
    lane,
    width,
    ...(long(air) ? { endLane: lane, endWidth: width } : {}),
    attributes: { ...air.attributes, parent: groundParentToken(parent) },
  };
  // Records are read in tick order: right behind the parent keeps the AIR ahead of a SLIDE segment continuing from the same joint.
  for (const at of [index + 1, 0]) {
    const notes = [...chart.notes];
    notes.splice(at, 0, note);
    const result = { ...chart, notes };
    // Taking the slot from an AIR already bound there would only orphan that one instead.
    const bound = getNativeAirBindings(result);
    if (
      bound.parentOf.get(note.id)?.id === parentId &&
      bound.orphans.length <= getNativeAirBindings(chart).orphans.length
    )
      return result;
  }
  return undefined;
}
/** After an edit, re-seat every AIR bound in `before` on its parent's tail: same time, lane, width and parent type. */
export function syncEditorAirBindings(before: Chart, after: Chart): Chart {
  const { airOf } = getNativeAirBindings(before);
  if (!airOf.size || before === after) return after;
  const current = new Map(after.notes.map(note => [note.id, note])),
    moved = new Map<string, Note>();
  for (const [groundId, chain] of airOf) {
    const ground = current.get(groundId),
      head = current.get(chain[0].id);
    if (!ground || !head || AIR.has(ground.type) || !AIR.has(head.type)) continue;
    const tick = endTick(ground),
      lane = endLane(ground),
      width = endWidth(ground),
      parent = groundParentToken(ground);
    const retoken = nativeParentFamily(head.attributes.parent ?? 'TAP') !== parent;
    if (head.tick === tick && head.lane === lane && head.width === width && !retoken) continue;
    const dt = tick - head.tick,
      dl = lane - head.lane;
    for (const item of chain) {
      const air = current.get(item.id);
      if (!air) continue;
      const first = air === head,
        next: Note = { ...air, tick: first ? tick : air.tick + dt };
      if (first && retoken) next.attributes = { ...air.attributes, parent };
      if (first || air.type === 'AIR_HOLD') {
        next.lane = lane;
        next.width = width;
      } else next.lane = limitLane(after, air.lane + dl, air.width);
      if (air.type === 'AIR_HOLD') {
        next.endLane = lane;
        next.endWidth = width;
      } else if (air.endLane !== undefined) next.endLane = limitLane(after, air.endLane + dl, endWidth(air));
      moved.set(air.id, next);
    }
  }
  return moved.size ? { ...after, notes: after.notes.map(note => moved.get(note.id) ?? note) } : after;
}
/** Move an AIR-height joint and keep its directly connected segment aligned. */
export function setEditorAirHeight(chart: Chart, id: string, endpoint: 'height' | 'endHeight', height: number): Chart {
  const note = chart.notes.find(item => item.id === id);
  if (!note || !['AIR_SLIDE', 'AIR_CRUSH'].includes(note.type) || !Number.isFinite(height) || height < 0) return chart;
  const atEnd = endpoint === 'endHeight',
    tick = atEnd ? endTick(note) : note.tick;
  const lane = atEnd ? endLane(note) : note.lane,
    width = atEnd ? endWidth(note) : note.width;
  const oldHeight = atEnd ? (note.endHeight ?? note.height ?? 1) : (note.height ?? 1);
  return {
    ...chart,
    notes: chart.notes.map(item => {
      if (item.id === id)
        return { ...item, ...(atEnd ? {} : { endHeight: item.endHeight ?? item.height ?? 1 }), [endpoint]: height };
      if (item.type !== note.type || String(item.attributes.color ?? 'DEF') !== String(note.attributes.color ?? 'DEF'))
        return item;
      if (
        atEnd &&
        sameTick(item.tick, tick) &&
        item.lane === lane &&
        item.width === width &&
        (item.height ?? 1) === oldHeight &&
        (item.type !== 'AIR_SLIDE' || item.attributes.parent === getNativeNoteTag(note))
      )
        return { ...item, height, endHeight: item.endHeight ?? item.height ?? 1 };
      if (
        !atEnd &&
        sameTick(endTick(item), tick) &&
        endLane(item) === lane &&
        endWidth(item) === width &&
        (item.endHeight ?? item.height ?? 1) === oldHeight &&
        (item.type !== 'AIR_SLIDE' || note.attributes.parent === getNativeNoteTag(item))
      )
        return { ...item, endHeight: height };
      return item;
    }),
  };
}
export function parseEditorFraction(value: string): number | undefined {
  const fraction = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\/\s*(\d+(?:\.\d*)?|\.\d+)$/);
  const result = fraction ? Number(fraction[1]) / Number(fraction[2]) : value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
}
export function selectionWithAssignments(chart: Chart, ids: Set<string>): Set<string> {
  const selected = new Set(ids);
  const notes = chart.notes.filter(note => ids.has(note.id));
  for (const event of chart.events)
    if (
      event.type === 'SCROLL_ASSIGNMENT' &&
      notes.some(note => sameTick(note.tick, event.tick) && note.lane === event.lane && note.width === event.width)
    )
      selected.add(event.id);
  return selected;
}
export function alignAssignments(chart: Chart, previous: Note, next: Note): Chart['events'] {
  return chart.events.map(event =>
    event.type === 'SCROLL_ASSIGNMENT' &&
    sameTick(event.tick, previous.tick) &&
    event.lane === previous.lane &&
    event.width === previous.width
      ? {
          ...event,
          tick: next.tick,
          lane: next.lane,
          width: next.width,
          ...(event.duration === previous.duration ? { duration: next.duration ?? 0 } : {}),
        }
      : event,
  );
}

/** Move a mixed selection as one block, retaining its relative spacing at the edges. */
export function moveEditorSelection(chart: Chart, ids: Set<string>, ticks: number, lanes: number): Chart {
  ids = selectionWithAssignments(chart, selectionWithBoundAir(chart, ids));
  const notes = chart.notes.filter(note => ids.has(note.id));
  const events = chart.events.filter(event => ids.has(event.id));
  const minTick = Math.min(...notes.map(note => note.tick), ...events.map(event => event.tick));
  let minDelta = -minTick,
    maxDelta = Infinity;
  const connections: { neighbor: Note; selected: Note; side: 'before' | 'after' }[] = [];
  for (const note of notes)
    if (CHAIN.has(note.type))
      for (const neighbor of chart.notes) {
        if (ids.has(neighbor.id) || neighbor.type !== note.type) continue;
        if (
          sameTick(endTick(neighbor), note.tick) &&
          endLane(neighbor) === note.lane &&
          endWidth(neighbor) === note.width
        ) {
          connections.push({ neighbor, selected: note, side: 'before' });
          minDelta = Math.max(minDelta, neighbor.tick - note.tick + 1e-7);
        }
        if (
          sameTick(neighbor.tick, endTick(note)) &&
          neighbor.lane === endLane(note) &&
          neighbor.width === endWidth(note)
        ) {
          connections.push({ neighbor, selected: note, side: 'after' });
          maxDelta = Math.min(maxDelta, endTick(neighbor) - endTick(note) - 1e-7);
        }
      }
  const dt = clamp(ticks, minDelta, maxDelta);
  const assignments = events.filter(event => event.type === 'SCROLL_ASSIGNMENT');
  const minLane = Math.min(
    ...notes.flatMap(note => [note.lane, endLane(note)]),
    ...assignments.map(event => event.lane ?? 0),
  );
  const maxLane = Math.max(
    ...notes.flatMap(note => [note.lane + note.width, endLane(note) + endWidth(note)]),
    ...assignments.map(event => (event.lane ?? 0) + (event.width ?? 1)),
  );
  const maxStartLane = Math.max(
    ...notes.flatMap(note => [note.lane, endLane(note)]),
    ...assignments.map(event => event.lane ?? 0),
  );
  const lower = chart.allowOutOfLane ? -64 - minLane : -minLane;
  const upper = chart.allowOutOfLane ? 64 - maxStartLane : LANES - maxLane;
  const dl =
    lanes === 0 || lower > upper ? 0 : notes.length || assignments.length ? clamp(Math.round(lanes), lower, upper) : 0;
  const nextNotes = chart.notes.map(note => {
    if (ids.has(note.id))
      return {
        ...note,
        tick: note.tick + dt,
        lane: note.lane + dl,
        ...(note.endLane !== undefined ? { endLane: note.endLane + dl } : {}),
      };
    const connected = connections.filter(connection => connection.neighbor.id === note.id);
    if (!connected.length) return note;
    const next = { ...note };
    let last = endTick(note);
    for (const connection of connected) {
      if (connection.side === 'before') {
        last = connection.selected.tick + dt;
        next.endLane = connection.selected.lane + dl;
        next.endWidth = connection.selected.width;
      } else {
        next.tick = endTick(connection.selected) + dt;
        next.lane = endLane(connection.selected) + dl;
        next.width = endWidth(connection.selected);
      }
    }
    next.duration = Math.max(1e-7, last - next.tick);
    return next;
  });
  let nextEvents = chart.events.map(event =>
    ids.has(event.id)
      ? {
          ...event,
          tick: event.tick + dt,
          ...(event.type === 'SCROLL_ASSIGNMENT' ? { lane: (event.lane ?? 0) + dl } : {}),
        }
      : event,
  );
  for (const connection of connections) {
    const next = nextNotes.find(note => note.id === connection.neighbor.id)!;
    nextEvents = alignAssignments({ ...chart, events: nextEvents }, connection.neighbor, next);
  }
  return { ...chart, notes: nextNotes, events: nextEvents };
}

export function mirrorEditorSelection(chart: Chart, ids: Set<string>): Chart {
  ids = selectionWithAssignments(chart, selectionWithBoundAir(chart, ids));
  return {
    ...chart,
    events: chart.events.map(event =>
      ids.has(event.id) && event.type === 'SCROLL_ASSIGNMENT'
        ? { ...event, lane: LANES - (event.lane ?? 0) - (event.width ?? 1) }
        : event,
    ),
    notes: chart.notes.map(note => {
      if (!ids.has(note.id)) return note;
      const direction = String(note.attributes.direction ?? '');
      const mirrors: Record<string, string> = {
        UL: 'UR',
        UR: 'UL',
        DL: 'DR',
        DR: 'DL',
        LEFT: 'RIGHT',
        RIGHT: 'LEFT',
        L: 'R',
        R: 'L',
      };
      const effects: Record<string, string> = { LS: 'RS', RS: 'LS', LC: 'RC', RC: 'LC' };
      return {
        ...note,
        lane: LANES - note.lane - note.width,
        ...(note.endLane !== undefined ? { endLane: LANES - note.endLane - endWidth(note) } : {}),
        attributes: {
          ...note.attributes,
          ...(mirrors[direction] ? { direction: mirrors[direction] } : {}),
          ...(effects[String(note.attributes.effect)] ? { effect: effects[String(note.attributes.effect)] } : {}),
        },
      };
    }),
  };
}

/** Reverse the selected notes in time inside their own span; a long note swaps its two ends. */
export function flipEditorSelection(chart: Chart, ids: Set<string>): Chart {
  const notes = chart.notes.filter(note => ids.has(note.id));
  if (!notes.length) return chart;
  const first = Math.min(...notes.map(note => note.tick)),
    last = Math.max(...notes.map(endTick));
  // A joint's node kind is stored on the segment ending there, so reversal hands it to the segment that followed.
  const previous = (note: Note) =>
    notes.find(
      item =>
        item.id !== note.id &&
        item.type === note.type &&
        sameTick(endTick(item), note.tick) &&
        endLane(item) === note.lane &&
        endWidth(item) === note.width,
    );
  const flipped = new Map<string, Note>();
  let events = chart.events;
  for (const note of notes) {
    const next: Note = { ...copyNote(note), tick: first + last - endTick(note) };
    if (long(note)) {
      next.lane = endLane(note);
      next.width = endWidth(note);
      if (note.endLane !== undefined || note.endWidth !== undefined) {
        next.endLane = note.lane;
        next.endWidth = note.width;
      }
      if (note.height !== undefined) {
        next.height = note.endHeight ?? note.height;
        next.endHeight = note.height;
      }
      if (hasNodeKind(note)) {
        const kind = previous(note)?.attributes.visible;
        if (kind === undefined) delete next.attributes.visible;
        else next.attributes.visible = kind;
      }
    }
    flipped.set(note.id, next);
    events = alignAssignments({ ...chart, events }, note, next);
  }
  return { ...chart, events, notes: chart.notes.map(note => flipped.get(note.id) ?? note) };
}

export type SlideShape = 'zigzag' | 'wave' | 'curve';
export interface SlideShapeOptions {
  shape: SlideShape;
  /** Length of the generated path in ticks. */
  length: number;
  /** Signed lane distance: the far side of a zigzag, the first swing of a wave to either side of its start, the far end of a curve's arc. */
  move: number;
  /** Zigzag: number of teeth, each out to the far side and back. Wave: number of full swings to both sides. Unused by a curve. */
  count: number;
  /** Curve only: lane and width the path starts from; the segment's own when absent or when its start is bound. */
  start?: number;
  width?: number;
  /** Curve only: the arc runs out and back again within the length. */
  symmetryV?: boolean;
  /** Curve only: every node spans from its edge to the same edge mirrored about the middle of the lanes. */
  symmetryH?: boolean;
  /** Curve only: the arc leaves straight ahead and ends sideways instead of the reverse. */
  flipV?: boolean;
  /** Shortest length left to the segment that follows the path, normally the quantize step. */
  step: number;
  /** Node kind of the zigzag and wave corners; curve nodes are always control points. */
  kind: EditorNodeKind;
}
export interface SlideShapeResult {
  chart: Chart;
  ids: string[];
  /** `move` after fitting the lanes. */ move: number;
  /** `length` after fitting the next segment. */ length: number;
}
/**
 * Nodes of a quarter circle that moves `reach` lanes sideways over the time 0 to 1, as `[time, lanes moved]`: one node
 * per lane, each exactly on the arc, so the straight pieces between them are its chords. Nodes less than `gap` apart
 * are left out.
 */
function arcNodes(reach: number, gap: number): [number, number][] {
  const nodes: [number, number][] = [[0, 0]];
  for (let lane = 1; lane < reach; lane++) {
    const at = 1 - Math.sqrt(1 - (lane / reach) ** 2);
    if (at - nodes.at(-1)![0] >= gap - 1e-9 && 1 - at >= gap - 1e-9) nodes.push([at, lane]);
  }
  nodes.push([1, reach]);
  return nodes;
}
/**
 * Replace one SLIDE / AIR SLIDE segment by a preset path, after Margrete's zigzag, meandering and curve generators.
 * A zigzag or wave starts and ends on the segment's start lane and keeps its width; a curve may also name its start lane and width.
 * The segments chained before and after it are re-attached to the new ends.
 */
export function shapeEditorSlide(chart: Chart, id: string, options: SlideShapeOptions): SlideShapeResult | undefined {
  const note = chart.notes.find(item => item.id === id);
  if (!note || (note.type !== 'SLIDE' && note.type !== 'AIR_SLIDE') || !(options.step > 0) || !(options.length > 0))
    return undefined;
  const outgoing = chart.notes.filter(
    item =>
      item.id !== id &&
      item.type === note.type &&
      sameTick(item.tick, endTick(note)) &&
      item.lane === endLane(note) &&
      item.width === endWidth(note),
  );
  // The next segment keeps its own end, so the path must stop before it.
  const length = Math.min(options.length, ...outgoing.map(item => endTick(item) - options.step - note.tick));
  if (!(length > 0)) return undefined;
  // An AIR SLIDE head sits on its ground parent's tail and cannot start anywhere else.
  const free = options.shape === 'curve' && !boundEditorParent(chart, id);
  const width =
    free && Number.isFinite(options.width)
      ? clamp(Math.round(options.width!), 1, chart.allowOutOfLane ? 128 : LANES)
      : note.width;
  const limits = laneLimits(chart, width),
    start =
      free && Number.isFinite(options.start) ? clamp(Math.round(options.start!), limits.min, limits.max) : note.lane;
  // A wave swings to both sides of the start, so its reach must fit on each of them.
  const wanted = Math.round(options.move),
    move =
      options.shape === 'wave'
        ? Math.sign(wanted) * Math.min(Math.abs(wanted), start - limits.min, limits.max - start)
        : clamp(wanted, limits.min - start, limits.max - start);
  const points: { at: number; lane: number; width: number; corner: boolean }[] = [
    { at: 0, lane: start, width, corner: false },
  ];
  if (options.shape === 'zigzag') {
    const pieces = clamp(Math.round(options.count), 1, 128) * 2;
    for (let index = 1; index <= pieces; index++)
      points.push({ at: index / pieces, lane: start + (index % 2 ? move : 0), width, corner: true });
  } else if (options.shape === 'wave') {
    const quarters = clamp(Math.round(options.count), 1, 64) * 4;
    for (let index = 1; index <= quarters; index++)
      points.push({ at: index / quarters, lane: start + move * [0, 1, 0, -1][index % 4], width, corner: true });
    // The crossings of the start lane lie on the straight line between two corners and add nothing to the path.
    for (let index = points.length - 2; index > 0; index--) if (index % 2 === 0) points.splice(index, 1);
  } else {
    const reach = Math.abs(move),
      halves = options.symmetryV ? 2 : 1;
    let nodes = arcNodes(reach, Math.max(1 / 60, halves / length));
    if (options.flipV) nodes = nodes.map(([at, lanes]): [number, number] => [1 - at, reach - lanes]).reverse();
    if (options.symmetryV)
      nodes = [
        ...nodes,
        ...nodes
          .slice(0, -1)
          .reverse()
          .map(([at, lanes]): [number, number] => [2 - at, lanes]),
      ];
    points.length = 0;
    for (const [at, lanes] of nodes) {
      let lane = start + Math.sign(move) * lanes,
        span = width;
      if (options.symmetryH) {
        // Margrete's rule: an edge right of the middle is taken as the right edge and mirrored to the left first.
        if (lane >= LANES / 2 - 1) lane = LANES - lane - Math.max(span, 2);
        span = clamp(
          Math.max(LANES - lane * 2, Math.min(lane + span, LANES / 2) - lane),
          1,
          chart.allowOutOfLane ? 128 : LANES,
        );
      }
      points.push({ at: at / halves, lane, width: span, corner: false });
    }
  }
  // Whole ticks stay whole, so a generated path remains exportable; nodes that land on the same tick collapse.
  const whole = Number.isInteger(note.tick) && Number.isInteger(length),
    offset = (at: number) => (whole ? Math.round(length * at) : length * at);
  for (let index = points.length - 2; index >= 0; index--)
    if (offset(points[index].at) >= offset(points[index + 1].at)) points.splice(index || 1, 1);
  if (points.length < 2) return undefined;
  const height = note.height,
    endHeight = note.endHeight ?? note.height;
  const segments: Note[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index],
      to = points[index + 1],
      last = index + 2 === points.length;
    // Only the original end keeps its node kind; corners follow the caller, curve nodes are control points.
    const segment: Note = {
      ...copyNote(note),
      id: index ? makeId('note') : note.id,
      tick: note.tick + offset(from.at),
      lane: from.lane,
      width: from.width,
      duration: offset(to.at) - offset(from.at),
      endLane: to.lane,
      endWidth: to.width,
      ...(height !== undefined
        ? { height: height + (endHeight! - height) * from.at, endHeight: height + (endHeight! - height) * to.at }
        : {}),
      attributes: {
        ...note.attributes,
        ...(last ? {} : { visible: to.corner && options.kind === 'normal' }),
        ...(index ? { parent: continuationParent(segments[index - 1]) } : {}),
      },
    };
    if (index) delete segment.native;
    segments.push(segment);
  }
  const head = segments[0],
    tail = segments.at(-1)!,
    outgoingIds = new Set(outgoing.map(item => item.id));
  const moved = head.lane !== note.lane || head.width !== note.width;
  const incomingIds = new Set(
    moved
      ? chart.notes
          .filter(
            item =>
              item.id !== id &&
              item.type === note.type &&
              sameTick(endTick(item), note.tick) &&
              endLane(item) === note.lane &&
              endWidth(item) === note.width,
          )
          .map(item => item.id)
      : [],
  );
  const notes = chart.notes.flatMap(item =>
    item.id === id
      ? segments
      : outgoingIds.has(item.id)
        ? [
            {
              ...item,
              tick: endTick(tail),
              duration: endTick(item) - endTick(tail),
              lane: endLane(tail),
              width: endWidth(tail),
              attributes: { ...item.attributes, parent: continuationParent(tail) },
            },
          ]
        : incomingIds.has(item.id)
          ? [{ ...item, endLane: head.lane, endWidth: head.width }]
          : [item],
  );
  // An AIR bound to a SLIDE segment's tail now belongs to the tail of the path. An AIR SLIDE is itself the bound AIR:
  // its head keeps the segment's id and stays on the parent.
  const before =
    note.type === 'SLIDE'
      ? { ...chart, notes: chart.notes.map(item => (item.id === id ? { ...item, id: tail.id } : item)) }
      : chart;
  return {
    chart: syncEditorAirBindings(before, {
      ...chart,
      notes,
      events: moved ? alignAssignments(chart, note, { ...head, duration: note.duration }) : chart.events,
    }),
    ids: segments.map(item => item.id),
    move,
    length,
  };
}

/** EX belongs to the whole ground long note: the game writes HXD for a HOLD and SXD / SXC on every segment of a SLIDE. */
export function setEditorEx(chart: Chart, id: string, ex?: boolean): Chart {
  const note = chart.notes.find(item => item.id === id);
  if (!note || (note.type !== 'HOLD' && note.type !== 'SLIDE')) return chart;
  const chain =
    note.type === 'SLIDE'
      ? (getNativeSlideChains(chart).find(items => items.some(item => item.id === id)) ?? [note])
      : [note];
  const ids = new Set(chain.map(item => item.id)),
    value = ex ?? !chain[0].attributes.ex;
  return {
    ...chart,
    notes: chart.notes.map(item => {
      if (!ids.has(item.id)) return item;
      const attributes = { ...item.attributes };
      if (value) attributes.ex = true;
      else {
        delete attributes.ex;
        delete attributes.effect;
      }
      return { ...item, attributes };
    }),
  };
}

/**
 * An ExTAP lying exactly on the head of a HOLD / SLIDE (same tick, lane and width) becomes that long note's EX and is
 * removed, as if it had been placed there. Only the ExTAPs in `ids` are considered; one carrying an AIR stays, because
 * the AIR is bound to it.
 */
export function mergeEditorExTaps(chart: Chart, ids: Set<string>): { chart: Chart; merged: string[] } {
  const merged: string[] = [];
  for (const id of ids) {
    const tap = chart.notes.find(note => note.id === id);
    if (
      !tap ||
      tap.type !== 'EXTAP' ||
      chart.notes.some(note => AIR.has(note.type) && boundEditorParent(chart, note.id)?.id === id)
    )
      continue;
    const chains = getNativeSlideChains(chart);
    const head = chart.notes.find(
      note =>
        (note.type === 'HOLD' || note.type === 'SLIDE') &&
        sameTick(note.tick, tap.tick) &&
        note.lane === tap.lane &&
        note.width === tap.width &&
        (note.type === 'HOLD' ||
          (chains.find(items => items.some(item => item.id === note.id)) ?? [note])[0].id === note.id),
    );
    if (!head) continue;
    const ex = setEditorEx({ ...chart, notes: chart.notes.filter(note => note.id !== id) }, head.id, true),
      effect = tap.attributes.effect;
    chart =
      effect === undefined
        ? ex
        : {
            ...ex,
            notes: ex.notes.map(note =>
              note.attributes.ex && !chart.notes.find(item => item.id === note.id)?.attributes.ex
                ? { ...note, attributes: { ...note.attributes, effect } }
                : note,
            ),
          };
    merged.push(head.id);
  }
  return { chart, merged };
}

/** The segment that continues from this segment's end: same type, time, lane, width and, in the air, height. */
export function nextEditorSegment(chart: Chart, note: Note): Note | undefined {
  if (!long(note) || note.type === 'HOLD') return undefined;
  return chart.notes.find(
    item =>
      item.id !== note.id &&
      item.type === note.type &&
      sameTick(item.tick, endTick(note)) &&
      item.lane === endLane(note) &&
      item.width === endWidth(note) &&
      (item.height === undefined || item.height === (note.endHeight ?? note.height)),
  );
}
/** Every segment of the long note this segment belongs to, in order. */
export function editorChain(chart: Chart, note: Note): Note[] {
  const chain = [note],
    seen = new Set([note.id]);
  for (let next = nextEditorSegment(chart, note); next && !seen.has(next.id); next = nextEditorSegment(chart, next)) {
    chain.push(next);
    seen.add(next.id);
  }
  if (!long(note) || note.type === 'HOLD') return chain;
  for (;;) {
    const head = chain[0],
      previous = chart.notes.find(
        item =>
          !seen.has(item.id) &&
          item.type === head.type &&
          sameTick(endTick(item), head.tick) &&
          endLane(item) === head.lane &&
          endWidth(item) === head.width &&
          (head.height === undefined || head.height === (item.endHeight ?? item.height)),
      );
    if (!previous) return chain;
    chain.unshift(previous);
    seen.add(previous.id);
  }
}
/** Remove the joint at this segment's end: the segment runs straight on to the end of the one that followed and takes its node kind. */
export function removeEditorJoint(chart: Chart, id: string): Chart {
  const note = chart.notes.find(item => item.id === id),
    next = note && nextEditorSegment(chart, note);
  if (!note || !next) return chart;
  const merged: Note = {
    ...copyNote(note),
    duration: endTick(next) - note.tick,
    endLane: endLane(next),
    endWidth: endWidth(next),
    ...(note.height !== undefined ? { endHeight: next.endHeight ?? next.height } : {}),
  };
  if (next.attributes.visible === undefined) delete merged.attributes.visible;
  else merged.attributes.visible = next.attributes.visible;
  const after = nextEditorSegment(chart, next);
  return {
    ...chart,
    notes: chart.notes.flatMap(item =>
      item.id === next.id
        ? []
        : item.id === id
          ? [merged]
          : item.id === after?.id
            ? [{ ...item, attributes: { ...item.attributes, parent: continuationParent(merged) } }]
            : [item],
    ),
  };
}

export function splitEditorNote(chart: Chart, id: string, tick: number, kind?: EditorNodeKind): Chart {
  const note = chart.notes.find(item => item.id === id);
  if (!note || !long(note) || tick <= note.tick || tick >= endTick(note)) return chart;
  const fraction = (tick - note.tick) / note.duration!;
  const width = clamp(
    Math.round(note.width + (endWidth(note) - note.width) * fraction),
    1,
    chart.allowOutOfLane ? 128 : LANES,
  );
  const lane = limitLane(chart, Math.round(note.lane + (endLane(note) - note.lane) * fraction), width);
  const height = (note.height ?? 1) + ((note.endHeight ?? note.height ?? 1) - (note.height ?? 1)) * fraction;
  const first: Note = {
    ...copyNote(note),
    duration: tick - note.tick,
    endLane: lane,
    endWidth: width,
    ...(note.height !== undefined ? { endHeight: height } : {}),
    attributes: { ...note.attributes, ...(kind && hasNodeKind(note) ? { visible: kind === 'normal' } : {}) },
  };
  const second: Note = {
    ...copyNote(note),
    id: makeId('note'),
    tick,
    lane,
    width,
    duration: endTick(note) - tick,
    ...(note.height !== undefined ? { height } : {}),
    attributes: { ...note.attributes, parent: continuationParent(first) },
  };
  delete second.native;
  return { ...chart, notes: chart.notes.flatMap(item => (item.id === id ? [first, second] : [item])) };
}

/** Follow the same exact head and segment connections as the native SLA assignment. */
function assignmentCovers(chart: Chart, event: ChartEvent, target: Note): boolean {
  if (event.type !== 'SCROLL_ASSIGNMENT') return false;
  const end = event.tick + (event.duration ?? 1);
  const heads = chart.notes.filter(
    note =>
      sameTick(note.tick, event.tick) &&
      note.lane === event.lane &&
      note.width === event.width &&
      endTick(note) <= end + 1e-8,
  );
  const pending = [...heads],
    seen = new Set<string>();
  while (pending.length) {
    const note = pending.pop()!;
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    if (note.id === target.id) return true;
    if (
      !note.duration ||
      !['SLIDE', 'AIR_SLIDE', 'AIR_CRUSH', 'AIR_HOLD'].includes(note.type) ||
      endTick(note) >= end - 1e-8
    )
      continue;
    pending.push(
      ...chart.notes.filter(
        next =>
          next.type === note.type &&
          sameTick(next.tick, endTick(note)) &&
          next.lane === endLane(note) &&
          next.width === endWidth(note) &&
          endTick(next) <= end + 1e-8,
      ),
    );
  }
  return false;
}

export function appendEditorNote(
  chart: Chart,
  id: string,
  tick: number,
  lane: number,
  width: number,
  kind?: EditorNodeKind,
): Chart {
  const previous = chart.notes.find(note => note.id === id);
  if (!previous || !long(previous) || tick <= endTick(previous)) return chart;
  const fixed = previous.type === 'HOLD' || previous.type === 'AIR_HOLD';
  const next: Note = {
    ...copyNote(previous),
    id: makeId('note'),
    tick: endTick(previous),
    lane: endLane(previous),
    width: endWidth(previous),
    duration: tick - endTick(previous),
    endLane: fixed ? endLane(previous) : limitLane(chart, lane, width),
    endWidth: fixed ? endWidth(previous) : width,
    ...(previous.height !== undefined ? { height: previous.endHeight ?? previous.height } : {}),
    attributes: {
      ...previous.attributes,
      parent: continuationParent(previous),
      ...(kind && hasNodeKind(previous) ? { visible: kind === 'normal' } : {}),
    },
  };
  delete next.native;
  const group = getNoteScrollGroup(chart, previous);
  const events = chart.events.map(event =>
    (event.group ?? event.value) === group &&
    assignmentCovers(chart, event, previous) &&
    event.tick + (event.duration ?? 1) < tick
      ? { ...event, duration: tick - event.tick }
      : event,
  );
  const result = { ...chart, notes: [...chart.notes, next], events };
  if (getNoteScrollGroup(result, next) !== group)
    result.events = [
      ...events,
      {
        id: makeId('event'),
        type: 'SCROLL_ASSIGNMENT',
        tick: next.tick,
        lane: next.lane,
        width: next.width,
        duration: Math.max(1, next.duration ?? 1),
        group,
        value: group,
      },
    ];
  return result;
}

/** Copy the requested notes, supplying only missing native group assignments for detached segments. */
export function copyEditorSelection(chart: Chart, selected: Set<string>): Clipboard | undefined {
  const ids = selectionWithAssignments(chart, selectionWithBoundAir(chart, selected));
  const notes = chart.notes.filter(note => ids.has(note.id)).map(copyNote);
  const events = chart.events.filter(event => ids.has(event.id)).map(event => ({ ...event }));
  if (!notes.length && !events.length) return undefined;
  for (const note of notes) {
    const group = getNoteScrollGroup(chart, note);
    if (getNoteScrollGroup({ ...chart, notes, events }, note) === group) continue;
    events.push({
      id: makeId('event'),
      type: 'SCROLL_ASSIGNMENT',
      tick: note.tick,
      lane: note.lane,
      width: note.width,
      duration: Math.max(1, note.duration ?? 1),
      group,
      value: group,
    });
  }
  return { notes, events, firstTick: Math.min(...notes.map(note => note.tick), ...events.map(event => event.tick)) };
}
