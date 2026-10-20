import { airArrowHeight, airArrowLift } from './margrete-sprites';
import { AIR_NOTE_TYPES, HEIGHT_NOTE_TYPES, LANES, type Chart, type Note } from '../core/model';
import { getNotePlaybackPoints } from '../core/timing';
import {
  clamp,
  editorChain,
  endLane,
  endTick,
  endWidth,
  hasNodeKind,
  limitLane,
  long,
  nextEditorSegment,
} from '../core/editing';
import { airHeightMaximum, type EditorView, type Position } from './editor-view';
import { getNativeDrawOrder } from './native-notes';

export type DragKind =
  'move' | 'end' | 'width' | 'widthLeft' | 'endWidth' | 'height' | 'endHeight' | 'box' | 'draw' | 'seek' | 'pan';
/** A note or event under the pointer and the part of it that was hit. */
export type Hit = { id: string; kind: DragKind };
/** The chained long note whose body is under the pointer, and the node a click there would insert. */
export type InsertTarget = { note: Note; lane: number; width: number };

/** Everything under the pointer, topmost first. `selectedFirst` puts the selection on top, so a click keeps hold of it. */
export function hitsAt(
  view: EditorView,
  chart: Chart,
  selection: ReadonlySet<string>,
  position: Position,
  selectedFirst = true,
): Hit[] {
  const found: Hit[] = [];
  if (position.x > view.trackRight) return found;
  const order = (notes: Note[]) =>
    (selectedFirst
      ? [...notes].sort((a, b) => Number(selection.has(a.id)) - Number(selection.has(b.id)))
      : [...notes]
    ).reverse();
  if (position.x < view.left) {
    if (position.x <= view.airLeft + view.airWidth + 5) {
      const maximum = airHeightMaximum(chart);
      for (const note of order(chart.notes)) {
        if (!HEIGHT_NOTE_TYPES.has(note.type)) continue;
        for (const endpoint of ['endHeight', 'height'] as const) {
          const height = endpoint === 'height' ? (note.height ?? 1) : (note.endHeight ?? note.height ?? 1);
          const tick = endpoint === 'height' ? note.tick : endTick(note);
          if (Math.abs(position.x - view.airHeightX(height, maximum)) < 7 && Math.abs(position.y - view.y(tick)) < 8) {
            found.push({ id: note.id, kind: endpoint });
            break;
          }
        }
      }
      if (found.length) return found;
    }
    const events = [...chart.events].sort((a, b) => a.tick - b.tick);
    for (const item of events)
      if (
        Math.abs(view.y(item.tick) - position.y) < 9 &&
        position.x >= view.eventLeft &&
        position.x < view.eventLeft + 30
      )
        found.push({ id: item.id, kind: 'move' });
    return found;
  }
  // A joint is the end of the segment before it; the segment after it is picked by its body only.
  const joints = new Set(chart.notes.map(note => nextEditorSegment(chart, note)?.id));
  // What is drawn on top is picked first: nodes and heads in the game's draw order (`editorMarks`), over every body.
  const drawOrder = new Map<Hit, number>();
  const push = (note: Note, kind: DragKind, part: 'node' | 'head' | 'body') => {
    const hit = { id: note.id, kind };
    found.push(hit);
    drawOrder.set(
      hit,
      part === 'body' ? -1 : getNativeDrawOrder(note, part === 'node' ? endWidth(note) : note.width, part === 'node'),
    );
  };
  for (const note of order(chart.notes)) {
    const startY = view.y(note.tick),
      finishY = view.y(endTick(note));
    const startX = view.x(note.lane),
      finishX = view.x(endLane(note));
    if (
      long(note) &&
      Math.abs(position.y - finishY) < 9 &&
      position.x >= finishX - 4 &&
      position.x <= finishX + endWidth(note) * view.laneWidth + 4
    ) {
      push(note, Math.abs(position.x - (finishX + endWidth(note) * view.laneWidth)) < 7 ? 'endWidth' : 'end', 'node');
      continue;
    }
    const span = note.width * view.laneWidth;
    // An AIR is picked by its lifted arrow, which leaves the ground note under it free to click.
    if (
      note.type === 'AIR'
        ? Math.abs(position.y - (startY - airArrowLift(span - 2))) <= airArrowHeight(span - 2) / 2 + 2 &&
          position.x >= startX - 3 &&
          position.x <= startX + span + 3
        : !joints.has(note.id) &&
          Math.abs(position.y - startY) < 10 &&
          position.x >= startX - 3 &&
          position.x <= startX + span + 3
    ) {
      push(
        note,
        Math.abs(position.x - (startX + span)) < 7
          ? 'width'
          : span > 24 && Math.abs(position.x - startX) < 5
            ? 'widthLeft'
            : 'move',
        'head',
      );
      continue;
    }
    if (long(note) && position.y < startY && position.y > finishY) {
      const t = (startY - position.y) / (startY - finishY);
      const left = startX + (finishX - startX) * t;
      const width = (note.width + (endWidth(note) - note.width) * t) * view.laneWidth;
      if (position.x >= left && position.x <= left + width) push(note, 'move', 'body');
    }
  }
  const selected = (hit: Hit) => Number(selectedFirst && selection.has(hit.id));
  return found.sort((a, b) => selected(b) - selected(a) || drawOrder.get(b)! - drawOrder.get(a)!);
}

/** The chained long note whose body is under the pointer, and the node a click would insert. HOLD has no inner nodes. */
export function insertTargetAt(view: EditorView, chart: Chart, point: Position): InsertTarget | undefined {
  for (let index = chart.notes.length - 1; index >= 0; index--) {
    const note = chart.notes[index];
    if (!long(note) || note.type === 'HOLD' || !(point.tick > note.tick && point.tick < endTick(note))) continue;
    const startY = view.y(note.tick),
      finishY = view.y(endTick(note));
    if (point.y > startY + 4 || point.y < finishY - 4) continue;
    const along = clamp((startY - point.y) / (startY - finishY), 0, 1);
    const left = view.x(note.lane) + (view.x(endLane(note)) - view.x(note.lane)) * along,
      span = (note.width + (endWidth(note) - note.width) * along) * view.laneWidth;
    if (point.x < left - 3 || point.x > left + span + 3) continue;
    const fraction = (point.tick - note.tick) / note.duration!;
    const width = clamp(
      Math.round(note.width + (endWidth(note) - note.width) * fraction),
      1,
      chart.allowOutOfLane ? 128 : LANES,
    );
    return {
      note,
      width,
      lane: limitLane(chart, Math.round(note.lane + (endLane(note) - note.lane) * fraction), width),
    };
  }
  return undefined;
}

/** A HOLD, or the first segment of a SLIDE, whose head bar is under the pointer. */
export function groundHeadAt(view: EditorView, chart: Chart, point: Position): Note | undefined {
  return chart.notes.findLast(
    note =>
      (note.type === 'HOLD' || note.type === 'SLIDE') &&
      Math.abs(point.y - view.y(note.tick)) < 10 &&
      point.x >= view.x(note.lane) - 3 &&
      point.x <= view.x(note.lane + note.width) + 3 &&
      getNotePlaybackPoints(chart, note).some(item => item.position === 'head'),
  );
}

/** The ground note whose tail is nearest the pointer, within `reach` ticks. */
export function groundTailAt(chart: Chart, point: Position, reach: number): Note | undefined {
  return chart.notes
    .filter(
      note =>
        !AIR_NOTE_TYPES.has(note.type) &&
        Math.abs(endTick(note) - point.tick) <= reach &&
        point.lane >= endLane(note) &&
        point.lane < endLane(note) + endWidth(note),
    )
    .sort((a, b) => Math.abs(endTick(a) - point.tick) - Math.abs(endTick(b) - point.tick))[0];
}

/** A SLIDE / AIR chain's first segment when the pointer is on its head node rather than its body. */
export function isChainHeadPick(view: EditorView, chart: Chart, id: string, kind: DragKind, point: Position): boolean {
  const note = chart.notes.find(item => item.id === id);
  return Boolean(
    note &&
    hasNodeKind(note) &&
    kind !== 'end' &&
    kind !== 'endWidth' &&
    Math.abs(point.y - view.y(note.tick)) < 10 &&
    editorChain(chart, note)[0].id === id,
  );
}
