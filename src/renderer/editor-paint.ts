import {
  MargreteNoteSprites,
  NOTE_BAR_HEIGHT,
  airArrowHeight,
  airArrowLift,
  airDown,
  airLean,
  airSide,
} from './margrete-sprites';
import {
  AIR_NOTE_TYPES,
  HEIGHT_NOTE_TYPES,
  LANES,
  type Chart,
  type ChartEvent,
  type EventType,
  type Note,
  type NoteType,
} from '../core/model';
import { getGrid, getNotePlaybackPoints, tickToSeconds } from '../core/timing';
import { clamp, endLane, endTick, endWidth, formatTick, hasNodeKind, long } from '../core/editing';
import { getSlideUvSpans, slideUvProgress } from './slide-timing';
import { noteColor } from './editor-template';
import {
  AIR_HIDDEN_HEIGHT,
  airHeightMaximum,
  airHeightVisibility,
  laneLine,
  type EditorView,
  type LaneDivision,
  type Position,
} from './editor-view';
import type { InsertTarget } from './editor-hit';
import { getNativeBodyDrawOrder, getNativeDrawOrder } from './native-notes';

/** `#rrggbb` with an alpha in 0..1 as a CSS colour. */
function colorWithAlpha(color: string, alpha: number): string {
  const hex = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${hex}`;
}

export type AudioSamples = { data: Float32Array; sampleRate: number };
export type Waveform = { peaks: Float32Array; duration: number; offset: number; samples?: AudioSamples };

/** Everything one frame shows. The editor assembles it from its state; the painter only reads it. */
export interface PaintScene {
  /** The committed chart: tempo map, waveform timing and SLIDE texture spans come from it. */
  chart: Chart;
  /** What is drawn: the drag or shape preview when there is one, otherwise `chart`. */
  shown: Chart;
  selection: ReadonlySet<string>;
  /** A picked node is highlighted alone; the segment that ends on it is not. */
  pickedJoint?: string;
  cursor: number;
  /** Grid division per whole note; 0 means free placement. */
  snap: number;
  /** 横向分割: a lane line every this many lanes. */
  laneDivision: LaneDivision;
  hover?: Position;
  dragging: boolean;
  /** The rubber band of a box selection that has moved. */
  box?: { start: Position; current: Position };
  aligning: boolean;
  /** The node a click would insert in insert-node mode, at `tick`; `control` draws it as a control point. */
  insert?: { target: InsertTarget; tick: number; control: boolean };
  /** The note the current pen tool would place under the pointer. */
  placement?: Note;
  /** The segment a click would append in continue mode. */
  continuation?: Note;
  waveform: Waveform;
}

const EVENT_COLOR: Record<EventType, string> = {
  BPM: '#65cf69',
  METER: '#d4a46b',
  SCROLL: '#e2575f',
  NOTE_SPEED: '#b9b9b9',
  GROUP_SCROLL: '#e88bb0',
  SCROLL_ASSIGNMENT: '#a897d8',
  STOP: '#e2575f',
};
const EVENT_TAG: Record<EventType, string> = {
  BPM: 'BPM',
  METER: 'MET',
  SCROLL: 'SFL',
  NOTE_SPEED: 'DCM',
  GROUP_SCROLL: 'SLP',
  SCROLL_ASSIGNMENT: 'SLA',
  STOP: 'STP',
};
/** Game joint textures for ground long-note bodies, and their centre colours sampled from start (0) to end (1) as the fallback gradient. */
export const BODY_TEXTURE: Partial<Record<NoteType, string>> = { SLIDE: 'SlideJoint', HOLD: 'HoldJoint' };
const BODY_STOPS: Partial<Record<NoteType, [number, string][]>> = {
  SLIDE: [
    [0, '#8242be'],
    [0.06, '#7357c7'],
    [0.25, '#30b3ec'],
    [0.5, '#0ee2ff'],
    [0.75, '#49b9e8'],
    [0.94, '#bf68bb'],
    [1, '#dd53af'],
  ],
  HOLD: [
    [0, '#8641ba'],
    [0.06, '#9653a2'],
    [0.25, '#dba036'],
    [0.5, '#fec700'],
    [0.75, '#f5a632'],
    [0.94, '#e26496'],
    [1, '#dd53af'],
  ],
};
function eventText(event: ChartEvent): string {
  switch (event.type) {
    case 'BPM':
      return formatTick(event.value);
    case 'METER':
      return `${event.numerator ?? 4}/${event.denominator ?? 4}`;
    case 'SCROLL':
      return `×${formatTick(event.value)}`;
    case 'NOTE_SPEED':
      return `♪×${formatTick(event.value)}`;
    case 'GROUP_SCROLL':
      return `G${event.group ?? 0} ×${formatTick(event.value)}`;
    case 'SCROLL_ASSIGNMENT':
      return `→G${event.group ?? event.value}`;
    case 'STOP':
      return 'STOP';
  }
}

/**
 * Long-note bodies in the game's layer order: HOLD under SLIDE (both opaque here), then the translucent AIR strips,
 * AIR HOLD last. Unlike the game, every body stays under the nodes and heads so the ground notes remain readable.
 */
export function editorBodies(notes: readonly Note[]): Note[] {
  return notes
    .filter(long)
    .map(note => ({ note, order: getNativeBodyDrawOrder(note) }))
    .sort((a, b) => a.order - b.order)
    .map(({ note }) => note);
}
/** A node or head the editor draws over the long-note bodies. */
export type EditorMark = { note: Note; part: 'node' | 'head' };
/**
 * Nodes and heads in the game's draw order, so notes on the same spot overlap as in the game (an EX SLIDE head over a
 * TAP, a TAP over a SLIDE head or end node) whatever their record order. Equal ones keep the record order.
 */
export function editorMarks(notes: readonly Note[]): EditorMark[] {
  return [
    ...notes
      .filter(long)
      .map(note => ({ note, part: 'node' as const, order: getNativeDrawOrder(note, endWidth(note), true) })),
    ...notes.map(note => ({ note, part: 'head' as const, order: getNativeDrawOrder(note) })),
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ note, part }) => ({ note, part }));
}

/** Draws the editor canvas. */
export class EditorPainter {
  readonly noteSprites = new MargreteNoteSprites();
  /** Loaded HOLD / SLIDE joint textures; a missing one falls back to the gradient. */
  bodyTextures: Partial<Record<NoteType, HTMLImageElement>> = {};
  private scene!: PaintScene;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly view: EditorView,
  ) {}

  paint(scene: PaintScene): void {
    this.scene = scene;
    const view = this.view,
      ctx = this.context,
      w = view.canvasWidth,
      h = view.canvasHeight,
      bottom = view.trackBottom;
    const chart = scene.shown;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    const right = view.trackRight,
      lo = view.scroll,
      hi = view.scroll + bottom / view.zoom;
    ctx.fillStyle = '#080808';
    ctx.fillRect(view.rulerLeft, 0, view.rulerWidth, bottom);
    // Lightly alternate the groups of lanes (the four sensor banks, or the wider groups of the lane division) and draw
    // a lane line every `laneDivision` lanes.
    const lanes = scene.laneDivision,
      bank = Math.max(4, lanes);
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.left, 0, right - view.left, bottom);
    ctx.clip();
    for (let lane = Math.floor(view.viewStart); lane < Math.ceil(view.viewEnd); lane++) {
      const outside = lane < 0 || lane >= LANES,
        line = laneLine(lane, lanes);
      ctx.fillStyle = outside ? '#151015' : Math.floor(lane / bank) % 2 ? '#050505' : '#000000';
      ctx.fillRect(view.x(lane), 0, view.laneWidth, bottom);
      if (!line || (outside && view.laneWidth < 8 && lane % 4 !== 0)) continue;
      ctx.strokeStyle = line === 'edge' ? '#777777' : outside ? '#383038' : line === 'major' ? '#464646' : '#242424';
      ctx.lineWidth = line === 'edge' ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(view.x(lane) + 0.5, 0);
      ctx.lineTo(view.x(lane) + 0.5, bottom);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#464646';
    ctx.beginPath();
    ctx.moveTo(right + 0.5, 0);
    ctx.lineTo(right + 0.5, bottom);
    ctx.stroke();
    const division = scene.snap || 16;
    const grid = getGrid(chart, Math.max(0, lo), hi + chart.resolution, division);
    for (const line of grid) {
      const y = view.y(line.tick);
      if (y < -1 || y > bottom + 1) continue;
      if (!line.major && (view.zoom * chart.resolution) / division < 5) continue;
      ctx.strokeStyle = line.major ? '#606060' : line.beat === Math.floor(line.beat) ? '#353535' : '#1a1a1a';
      ctx.lineWidth = line.major ? 1.25 : 0.65;
      ctx.beginPath();
      ctx.moveTo(line.major ? view.airLeft : view.left, Math.round(y) + 0.5);
      ctx.lineTo(right, Math.round(y) + 0.5);
      ctx.stroke();
    }
    this.paintWaveform(ctx, lo, hi);
    this.paintAirHeights(ctx, chart, lo, hi);
    // A separate ruler gives measure names their own space, including at simultaneous BPM/MET events.
    let lastLabelY = Infinity;
    for (const line of grid) {
      if (!line.major) continue;
      const y = view.y(line.tick);
      if (y < 0 || y > bottom || lastLabelY - y < 23) continue;
      const top = clamp(y - 21, 0, Math.max(0, bottom - 21));
      ctx.fillStyle = '#151515';
      ctx.beginPath();
      ctx.rect(view.rulerLeft + 4, top, view.rulerWidth - 8, 20);
      ctx.fill();
      ctx.fillStyle = '#dddddd';
      ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(
        `第${String(line.measure + 1).padStart(3, '0')}小节`,
        view.rulerLeft + 7,
        top + 14,
        view.rulerWidth - 14,
      );
      if (lastLabelY - y >= 44 && y + 14 < bottom) {
        ctx.fillStyle = '#888888';
        ctx.font = '9px "Segoe UI", sans-serif';
        ctx.fillText(`${formatTick(line.tick)} tick`, view.rulerLeft + 8, y + 12, view.rulerWidth - 12);
      }
      lastLabelY = y;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.left, 0, right - view.left, bottom);
    ctx.clip();
    for (const event of chart.events) {
      if (event.type !== 'SCROLL_ASSIGNMENT' || !scene.selection.has(event.id)) continue;
      const y = view.y(event.tick),
        finish = view.y(event.tick + (event.duration ?? 0));
      ctx.fillStyle = '#c4b5fd14';
      ctx.strokeStyle = '#c4b5fd99';
      ctx.setLineDash([4, 4]);
      ctx.fillRect(view.x(event.lane ?? 0), finish, (event.width ?? 1) * view.laneWidth, y - finish);
      ctx.strokeRect(view.x(event.lane ?? 0), finish, (event.width ?? 1) * view.laneWidth, y - finish);
      ctx.setLineDash([]);
    }
    const visible = chart.notes.filter(
      note => endTick(note) >= lo - 20 / view.zoom && note.tick <= hi + 32 / view.zoom,
    );
    for (const note of editorBodies(visible)) this.paintNote(ctx, note, 'body');
    for (const { note, part } of editorMarks(visible)) this.paintNote(ctx, note, part);
    ctx.restore();
    this.paintEvents(ctx, chart);
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.left, 0, right - view.left, bottom);
    ctx.clip();
    if (scene.insert) this.paintInsertNode(ctx, scene.insert);
    if (scene.placement) {
      ctx.globalAlpha = 0.45;
      for (const part of ['body', 'node', 'head'] as const) this.paintNote(ctx, scene.placement, part, true);
      ctx.globalAlpha = 1;
    }
    if (scene.continuation) {
      ctx.globalAlpha = 0.45;
      for (const part of ['body', 'node', 'head'] as const) this.paintNote(ctx, scene.continuation, part);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (scene.aligning) this.paintAlignWaveform(ctx, lo);
    const cursorY = view.y(scene.cursor);
    if (cursorY >= 0 && cursorY <= bottom) {
      ctx.strokeStyle = '#d23838';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cursorY);
      ctx.lineTo(right + 8, cursorY);
      ctx.stroke();
      ctx.fillStyle = '#d23838';
      ctx.beginPath();
      ctx.moveTo(0, cursorY - 5);
      ctx.lineTo(7, cursorY);
      ctx.lineTo(0, cursorY + 5);
      ctx.fill();
    }
    if (scene.box) {
      const { start, current } = scene.box;
      ctx.fillStyle = '#86e7ff16';
      ctx.strokeStyle = '#86e7ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(start.x, start.y, current.x - start.x, current.y - start.y);
      ctx.strokeRect(start.x, start.y, current.x - start.x, current.y - start.y);
      ctx.setLineDash([]);
    }
    this.paintLaneNumbers(ctx);
  }

  /** Dedicated event gutter keeps timing edits separate from note hit targets. */
  private paintEvents(ctx: CanvasRenderingContext2D, chart: Chart): void {
    const view = this.view,
      right = view.trackRight,
      selection = this.scene.selection;
    const labelRoom = view.canvasWidth - right >= 90,
      labelRows = new Map<number, number>();
    for (const item of [...chart.events].sort((a, b) => a.tick - b.tick)) {
      const y = view.y(item.tick);
      if (y < -10 || y > view.trackBottom + 10) continue;
      ctx.fillStyle = selection.has(item.id) ? '#c4b5fd' : item.type === 'BPM' ? '#65cf69' : '#d4a46b';
      ctx.fillRect(view.eventLeft, y - 7, 30, 14);
      ctx.fillStyle = '#202020';
      ctx.font = 'bold 8px "Segoe UI", sans-serif';
      ctx.fillText(EVENT_TAG[item.type], view.eventLeft + 3, y + 3);
      ctx.strokeStyle = '#a897d852';
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(view.left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (labelRoom && item.type !== 'SCROLL_ASSIGNMENT') {
        // Margrete shows each event's value beside the chart; events sharing a tick line up in one row.
        const row = Math.round(y),
          text = eventText(item);
        ctx.font = '11px "Segoe UI", sans-serif';
        const x = labelRows.get(row) ?? right + 10,
          width = ctx.measureText(text).width;
        ctx.fillStyle = ctx.strokeStyle = selection.has(item.id) ? '#c4b5fd' : EVENT_COLOR[item.type];
        ctx.fillText(text, x, y - 3);
        ctx.beginPath();
        ctx.moveTo(x - 4, row + 0.5);
        ctx.lineTo(x + width + 4, row + 0.5);
        ctx.stroke();
        labelRows.set(row, x + width + 14);
      } else if (item.type === 'BPM') {
        ctx.fillStyle = '#101010ee';
        ctx.fillRect(view.left + 5, y - 19, 63, 14);
        ctx.fillStyle = '#65cf69';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText(`♩ ${formatTick(item.value)}`, view.left + 9, y - 8);
      }
    }
  }

  /** The node a click would insert: a bar for an ordinary node, a hollow diamond for a control point. */
  private paintInsertNode(ctx: CanvasRenderingContext2D, insert: NonNullable<PaintScene['insert']>): void {
    const view = this.view,
      y = view.y(insert.tick),
      x = view.x(insert.target.lane) + 1,
      width = insert.target.width * view.laneWidth - 2,
      color = noteColor(insert.target.note);
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = `${color}cc`;
    ctx.lineWidth = 1.5;
    if (insert.control) {
      const center = x + width / 2;
      ctx.beginPath();
      ctx.moveTo(center, y - 6);
      ctx.lineTo(center + 6, y);
      ctx.lineTo(center, y + 6);
      ctx.lineTo(center - 6, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y - NOTE_BAR_HEIGHT / 2, width, NOTE_BAR_HEIGHT);
      ctx.strokeRect(x, y - NOTE_BAR_HEIGHT / 2, width, NOTE_BAR_HEIGHT);
    }
  }

  private paintLaneNumbers(ctx: CanvasRenderingContext2D): void {
    const view = this.view,
      right = view.trackRight,
      h = view.canvasHeight;
    ctx.fillStyle = '#202020';
    ctx.fillRect(view.left - 1, view.trackBottom, right - view.left + 2, view.bottom);
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.left, view.trackBottom, right - view.left, view.bottom);
    ctx.clip();
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    const laneStride = view.laneWidth > 19 ? 1 : view.laneWidth > 7 ? 4 : 8;
    for (
      let lane = Math.ceil(view.viewStart / laneStride) * laneStride;
      lane < Math.ceil(view.viewEnd);
      lane += laneStride
    ) {
      ctx.fillStyle = lane < 0 || lane >= LANES ? '#a191b4' : lane % 4 === 0 ? '#cccccc' : '#888888';
      ctx.fillText(
        this.scene.chart.allowOutOfLane ? String(lane) : String(lane + 1).padStart(2, '0'),
        view.x(lane + 0.5),
        h - 11,
      );
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }

  private paintAirHeights(ctx: CanvasRenderingContext2D, chart: Chart, lo: number, hi: number): void {
    const view = this.view,
      selection = this.scene.selection,
      maximum = airHeightMaximum(chart),
      bottom = view.trackBottom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, view.rulerLeft - 2, bottom);
    ctx.clip();
    for (let index = 0; index <= 5; index++) {
      const x = view.airLeft + (index * view.airWidth) / 5;
      ctx.strokeStyle = index === 0 || index === 5 ? '#414141' : '#202020';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
    }
    // The game camera loses an AIR above this height everywhere on the track; beyond it the column is out of view.
    if (maximum >= AIR_HIDDEN_HEIGHT) {
      const limit = Math.round(view.airHeightX(AIR_HIDDEN_HEIGHT, maximum)) + 0.5;
      ctx.fillStyle = 'rgba(200, 80, 80, 0.08)';
      ctx.fillRect(limit, 0, view.airLeft + view.airWidth - limit, bottom);
      ctx.strokeStyle = '#8a4a4a';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(limit, 0);
      ctx.lineTo(limit, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#b06a6a';
      ctx.font = '9px "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('实机可见上限', limit - 3, 11);
      ctx.textAlign = 'left';
    }
    const notes = chart.notes.filter(
      note => HEIGHT_NOTE_TYPES.has(note.type) && endTick(note) >= lo && note.tick <= hi,
    );
    for (const note of notes) {
      ctx.strokeStyle = selection.has(note.id) ? '#eeeeee' : '#40d6c4';
      ctx.lineWidth = selection.has(note.id) ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(view.airHeightX(note.height ?? 1, maximum), view.y(note.tick));
      ctx.lineTo(view.airHeightX(note.endHeight ?? note.height ?? 1, maximum), view.y(endTick(note)));
      ctx.stroke();
    }
    // End joints are drawn after starts, so a following segment cannot cover a normal joint with a hollow square.
    for (const endpoint of ['height', 'endHeight'] as const)
      for (const note of notes) {
        const atEnd = endpoint === 'endHeight';
        const x = view.airHeightX(atEnd ? (note.endHeight ?? note.height ?? 1) : (note.height ?? 1), maximum);
        const y = view.y(atEnd ? endTick(note) : note.tick),
          normal = atEnd && note.attributes.visible !== false;
        ctx.lineWidth = 1;
        ctx.fillStyle = normal ? noteColor(note) : '#111111';
        ctx.strokeStyle = selection.has(note.id) ? '#ffffff' : '#acacac';
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.strokeRect(x - 3, y - 3, 6, 6);
      }
    ctx.restore();
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, bottom, view.rulerLeft - 2, view.bottom);
    ctx.fillStyle = '#bdbdbd';
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    for (const index of [0, 2, 5])
      ctx.fillText(formatTick((maximum * index) / 5), view.airLeft + (index * view.airWidth) / 5, bottom + 18);
    ctx.textAlign = 'left';
  }

  private paintWaveform(ctx: CanvasRenderingContext2D, lo: number, hi: number): void {
    const view = this.view,
      { peaks, duration, offset } = this.scene.waveform,
      mid = view.waveformLeft + 12,
      half = 12;
    ctx.fillStyle = '#000000';
    ctx.fillRect(view.waveformLeft, 0, 25, view.trackBottom);
    ctx.strokeStyle = '#303030';
    ctx.beginPath();
    ctx.moveTo(mid, 0);
    ctx.lineTo(mid, view.trackBottom);
    ctx.stroke();
    if (!peaks.length || !duration) return;
    ctx.strokeStyle = '#619ef2c0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Waveform bins are mapped through the actual tempo map, including BPM changes.
    for (let y = 0; y < view.trackBottom; y += 2) {
      const tick = lo + (view.trackBottom - y) / view.zoom;
      if (tick > hi + 1) continue;
      const seconds = tickToSeconds(this.scene.chart, tick) - offset;
      if (seconds < 0 || seconds > duration) continue;
      const index = Math.floor((seconds / duration) * peaks.length);
      const amplitude = Math.min(1, Math.abs(peaks[index] ?? 0));
      ctx.moveTo(mid - amplitude * half, y);
      ctx.lineTo(mid + amplitude * half, y);
    }
    ctx.stroke();
  }

  /** Alignment mode widens the waveform over the track and reads min/max straight from the samples under each pixel row. */
  private paintAlignWaveform(ctx: CanvasRenderingContext2D, lo: number): void {
    const view = this.view,
      { samples, offset } = this.scene.waveform;
    if (!samples) return;
    const left = view.waveformLeft,
      width = view.alignWidth,
      height = view.trackBottom,
      mid = left + width / 2,
      half = width / 2 - 5;
    ctx.fillStyle = '#000000f0';
    ctx.fillRect(left, 0, width, height);
    ctx.strokeStyle = '#303030';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mid + 0.5, 0);
    ctx.lineTo(mid + 0.5, height);
    ctx.stroke();
    const { data, sampleRate } = samples;
    const sampleAt = (y: number) =>
      (tickToSeconds(this.scene.chart, lo + (height - y) / view.zoom) - offset) * sampleRate;
    ctx.strokeStyle = '#8fc0ff';
    ctx.beginPath();
    let previous = sampleAt(height);
    for (let y = height - 1; y >= 0; y--) {
      const next = sampleAt(y),
        first = Math.max(0, Math.floor(previous)),
        last = Math.min(data.length, Math.max(Math.ceil(next), Math.floor(previous) + 1));
      previous = next;
      if (last <= first) continue;
      let low = 1,
        high = -1;
      for (let index = first, stride = Math.max(1, Math.floor((last - first) / 256)); index < last; index += stride) {
        const value = data[index];
        if (value < low) low = value;
        if (value > high) high = value;
      }
      ctx.moveTo(mid + clamp(low, -1, 1) * half, y + 0.5);
      ctx.lineTo(mid + clamp(high, -1, 1) * half + 1, y + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = '#619ef2';
    ctx.strokeRect(left + 0.5, 0.5, width - 1, height - 1);
    const hover = this.scene.hover;
    if (hover && !this.scene.dragging && view.inAlignWaveform(hover)) {
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(left, hover.y + 0.5);
      ctx.lineTo(left + width, hover.y + 0.5);
      ctx.stroke();
    }
  }

  /**
   * One part of a note: a long note's body, the node that ends a long segment, or the head.
   * `ghost` paints a placement preview: it is not in the chart, so its chain head cannot be looked up and is always drawn.
   */
  private paintNote(ctx: CanvasRenderingContext2D, note: Note, part: EditorMark['part'] | 'body', ghost = false): void {
    const view = this.view,
      { selection, pickedJoint } = this.scene;
    const x = view.x(note.lane) + 1,
      y = view.y(note.tick),
      width = note.width * view.laneWidth - 2;
    const finishX = view.x(endLane(note)) + 1,
      finishY = view.y(endTick(note)),
      finishWidth = endWidth(note) * view.laneWidth - 2;
    // A picked node is highlighted alone; the segment that ends on it is not.
    const color = noteColor(note),
      picked = selection.has(note.id),
      selected = picked && !(selection.size === 1 && pickedJoint === note.id),
      airborne = AIR_NOTE_TYPES.has(note.type);
    if (part === 'body') {
      if (!long(note)) return;
      // An AIR SLIDE / CRUSH fades with its height as the game camera loses it, but never past the point of being selectable.
      const fading = HEIGHT_NOTE_TYPES.has(note.type),
        startShown = fading ? 0.25 + 0.75 * airHeightVisibility(note.height ?? 1) : 1,
        endShown = fading ? 0.25 + 0.75 * airHeightVisibility(note.endHeight ?? note.height ?? 1) : 1;
      const shade = (alpha: number): string | CanvasGradient => {
        if (startShown === 1 && endShown === 1) return colorWithAlpha(color, alpha);
        const gradient = ctx.createLinearGradient(0, y, 0, finishY);
        gradient.addColorStop(0, colorWithAlpha(color, alpha * startShown));
        gradient.addColorStop(1, colorWithAlpha(color, alpha * endShown));
        return gradient;
      };
      ctx.fillStyle = shade(0x35 / 255);
      ctx.strokeStyle = shade(0x88 / 255);
      ctx.lineWidth = selected ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(finishX, finishY);
      ctx.lineTo(finishX + finishWidth, finishY);
      ctx.lineTo(x + width, y);
      ctx.closePath();
      // AIR bodies stay translucent so the ground notes under them remain visible.
      if (airborne) ctx.fill();
      else this.paintGroundBody(ctx, note, x, y, width, finishX, finishY, finishWidth);
      // Only the sides belong to the body; control joints must not draw horizontal separators.
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(finishX, finishY);
      ctx.moveTo(x + width, y);
      ctx.lineTo(finishX + finishWidth, finishY);
      ctx.stroke();
      if (note.type === 'AIR_CRUSH' && Number(note.attributes.interval ?? 24) > 0) {
        const interval = Math.max(1, Number(note.attributes.interval) || 24);
        const minimum = Math.max(1, Math.ceil(8 / (interval * view.zoom)));
        const count = Math.min(5000, Math.floor((note.duration ?? 0) / interval));
        ctx.strokeStyle = shade(0x9a / 255);
        ctx.lineWidth = 1;
        const first = Math.max(minimum, Math.floor((view.scroll - note.tick) / interval / minimum) * minimum);
        for (let index = first; index < count; index += minimum) {
          const fraction = (index * interval) / (note.duration ?? 1),
            cy = view.y(note.tick + index * interval);
          if (cy < 0) break;
          const cx = x + (finishX - x) * fraction,
            cw = width + (finishWidth - width) * fraction;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + cw, cy);
          ctx.stroke();
        }
      }
      if (airborne) {
        // AIR HOLD / AIR SLIDE read as one solid centre line, like Margrete; a CRUSH keeps a dashed guide in its own colour.
        const line = note.type !== 'AIR_CRUSH';
        if (!line) ctx.setLineDash([5, 5]);
        ctx.strokeStyle = shade(line ? 1 : 0xb0 / 255);
        ctx.lineWidth = line ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x + width / 2, y);
        ctx.lineTo(finishX + finishWidth / 2, finishY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }
    if (part === 'node') {
      if (!long(note)) return;
      const control = hasNodeKind(note) && note.attributes.visible === false;
      ctx.fillStyle = color;
      ctx.strokeStyle = picked ? '#fff' : color;
      ctx.lineWidth = picked ? 2 : 1.5;
      if (control) {
        const center = finishX + finishWidth / 2;
        if (picked) {
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(finishX, finishY);
          ctx.lineTo(finishX + finishWidth, finishY);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.moveTo(center, finishY - 6);
        ctx.lineTo(center + 6, finishY);
        ctx.lineTo(center, finishY + 6);
        ctx.lineTo(center - 6, finishY);
        ctx.closePath();
        ctx.stroke();
      } else if (!this.noteSprites.draw(ctx, note, true, finishX, finishY, finishWidth)) {
        ctx.fillRect(finishX, finishY - 3, finishWidth, 6);
        ctx.strokeStyle = picked ? '#fff' : '#cccccc';
        ctx.strokeRect(finishX, finishY - 3, finishWidth, 6);
      }
      if (picked) this.handle(ctx, finishX + finishWidth, finishY, color);
      return;
    }
    if (
      !ghost &&
      hasNodeKind(note) &&
      !getNotePlaybackPoints(this.scene.shown, note).some(point => point.position === 'head')
    ) {
      if (selected) this.handle(ctx, x + width, y, color);
      return;
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = selected ? '#ffffff' : '#eeeeee';
    ctx.lineWidth = selected ? 2 : 1;
    // An AIR, and the implied AIR that starts an AIR HOLD / AIR SLIDE chain, float above the ground note they belong to.
    const arrow = note.type === 'AIR' || note.type === 'AIR_HOLD' || note.type === 'AIR_SLIDE';
    if (arrow) {
      const direction = note.type === 'AIR' ? String(note.attributes.direction ?? 'IR') : 'IR',
        arrowY = y - airArrowLift(width),
        half = airArrowHeight(width) / 2;
      if (!this.noteSprites.drawArrow(ctx, direction, x, arrowY, width)) {
        const down = airDown(direction),
          tip = x + width / 2 + (airSide(direction) * airLean(width)) / 2,
          base = down ? arrowY - half : arrowY + half,
          point = down ? arrowY + half : arrowY - half;
        ctx.beginPath();
        ctx.moveTo(x, base);
        ctx.lineTo(tip, point);
        ctx.lineTo(x + width, base);
        ctx.lineTo(tip, (base + point) / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      if (selected) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(x - 1, arrowY - half - 1, width + 2, half * 2 + 2);
      }
    } else if (this.noteSprites.draw(ctx, note, false, x, y, width)) {
      if (selected) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(x - 1, y - 5, width + 2, 10);
      }
    } else {
      ctx.beginPath();
      ctx.roundRect(x, y - NOTE_BAR_HEIGHT / 2, Math.max(1, width), NOTE_BAR_HEIGHT, 1);
      ctx.fill();
      ctx.stroke();
      if (note.type === 'EXTAP' || note.attributes.ex) {
        ctx.fillStyle = '#fff9dc';
        ctx.fillRect(x + 2, y - 1.5, Math.max(1, width - 4), 3);
      }
      if (note.type === 'FLICK') {
        ctx.strokeStyle = '#143353';
        ctx.lineWidth = 1.5;
        for (let cx = x + 5; cx < x + width - 3; cx += 10) {
          ctx.beginPath();
          ctx.moveTo(cx - 2, y - 3);
          ctx.lineTo(cx + 2, y);
          ctx.lineTo(cx - 2, y + 3);
          ctx.stroke();
        }
      }
      if (note.type === 'DAMAGE') {
        ctx.strokeStyle = '#532741';
        ctx.lineWidth = 2;
        for (let cx = x + 4; cx < x + width - 4; cx += 10) {
          ctx.beginPath();
          ctx.moveTo(cx - 2, y - 3);
          ctx.lineTo(cx + 2, y + 3);
          ctx.moveTo(cx + 2, y - 3);
          ctx.lineTo(cx - 2, y + 3);
          ctx.stroke();
        }
      }
    }
    if (selected) this.handle(ctx, x + width, arrow ? y - airArrowLift(width) : y, color);
  }
  /**
   * HOLD / SLIDE body inside the current path. The joint texture runs from the start (bottom row) to the end (top row)
   * of each ordinary-node span, so control joints do not restart it; its rows stay horizontal like the time axis.
   */
  private paintGroundBody(
    ctx: CanvasRenderingContext2D,
    note: Note,
    x: number,
    y: number,
    width: number,
    finishX: number,
    finishY: number,
    finishWidth: number,
  ): void {
    const chart = this.scene.chart;
    const span = note.type === 'SLIDE' ? getSlideUvSpans(chart).get(note.id) : undefined,
      height = y - finishY;
    const from = span ? slideUvProgress(chart, span, note.tick) : 0,
      to = span ? slideUvProgress(chart, span, endTick(note)) : 1;
    if (height < 0.5 || to <= from) return;
    const image = this.bodyTextures[note.type];
    ctx.save();
    ctx.clip();
    if (!image) {
      // Same colours as the texture centre, placed on the line where progress 0 and 1 would fall.
      const at = (progress: number) => y - (height * (progress - from)) / (to - from),
        gradient = ctx.createLinearGradient(0, at(0), 0, at(1));
      for (const [progress, color] of BODY_STOPS[note.type] ?? []) gradient.addColorStop(progress, color);
      ctx.fillStyle = gradient;
      ctx.fill();
    } else if (Math.abs(finishWidth - width) < 0.5) {
      // Constant width: one affine map takes the texture rows onto the sheared body exactly.
      ctx.transform(width, 0, x - finishX, height, finishX, finishY);
      ctx.drawImage(
        image,
        0,
        image.naturalHeight * (1 - to),
        image.naturalWidth,
        image.naturalHeight * (to - from),
        0,
        0,
        1,
        1,
      );
    } else {
      // Changing width: rows one device pixel high, each stretched to the body's width there, so the texture's soft
      // sides follow the slanted edges. Rows sit on the pixel grid and neither overlap nor leave seams.
      const ratio = this.canvas.width / this.view.canvasWidth,
        rows = height * ratio,
        top = Math.round(finishY * ratio);
      const row = (t: number) => image.naturalHeight * (1 - to + (to - from) * t);
      for (let index = Math.max(0, -top); index < rows && (top + index) / ratio < this.view.canvasHeight; index++) {
        const t0 = index / rows,
          t1 = Math.min(1, (index + 1) / rows),
          middle = (t0 + t1) / 2;
        ctx.drawImage(
          image,
          0,
          row(t0),
          image.naturalWidth,
          row(t1) - row(t0),
          finishX + (x - finishX) * middle,
          (top + index) / ratio,
          finishWidth + (width - finishWidth) * middle,
          1 / ratio,
        );
      }
    }
    ctx.restore();
  }
  private handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.fillStyle = '#202020';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.strokeRect(x - 3, y - 3, 6, 6);
  }
}
