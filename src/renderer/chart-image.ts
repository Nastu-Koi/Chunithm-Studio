import type { Chart, Note, Project } from '../core/model';
import type { GameTextures } from '../core/game-assets';
import { buildJudgementTimeline } from '../core/judgement';
import { endLane, endTick, endWidth, hasNodeKind } from '../core/editing';
import {
  CHART_IMAGE_MARGIN,
  chartImageLaneX,
  chartImageLocate,
  chartImageSlice,
  layoutChartImage,
  type ChartImageColumn,
  type ChartImageLayout,
  type ChartImageOptions,
} from '../core/chart-image';
import { getNativeBodyDrawOrder, getNativeDrawOrder, getNativeHeadModel } from './native-notes';
import { getNativeAirCrushLineV, getNativeAirSlideTextures } from './native-air-geometry';

/**
 * Draws the top-down chart image in the manner of the sdvx.in chart pages: a header with the cover and song facts, then
 * the measures in columns (layout from `src/core/chart-image.ts`). Notes are drawn with the game's own textures from the
 * resource copy, chosen as the player chooses them (`getNativeHeadModel`); the image needs the copy to be loaded.
 */
export interface ChartImageHeader {
  cover?: CanvasImageSource | null;
}
export interface ChartImageResult {
  canvas: HTMLCanvasElement;
  /** Notes drawn without a texture because the copy lacks their model, by model key. */
  missing: string[];
}
export const CHART_IMAGE_HEADER_HEIGHT = 140;
const HEADER_HEIGHT = CHART_IMAGE_HEADER_HEIGHT;
const MIN_WIDTH = 720;
const BOTTOM = 16;
const FONT = '"Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
/** Page chrome colours: black ground, grey borders and beat lines, as on the sdvx.in pages. */
const PAGE = {
  background: '#000000',
  border: '#555555',
  beat: '#222222',
  lane: 'rgba(255, 255, 255, 0.10)',
  bank: 'rgba(255, 255, 255, 0.18)',
  number: '#b4b4b4',
};
/** A ground note's bar: the native quad is 10.09 deep for a 15.68-wide 4-lane note, kept between 6 and 12 pixels. */
const NOTE_DEPTH = 10.09 / 15.68;
const MIN_BAR = 6,
  MAX_BAR = 12;
/** The AIR arrow texture: its coloured bar fills the top of the 256-pixel image; the rest is the white trail. */
const AIR_BAR_V = 0.36;
const AIR_HEIGHT = 9,
  AIR_GAP = 2;
/** A long note's body is drawn at full brightness for a twelfth note from the start of its chain, then dimmed. */
const BRIGHT_DIVISION = 12;
const BODY_DIM = 0.4;

type ImageMap = Map<string, HTMLImageElement>;

/** Something the image draws over the bodies: a ground head or end node, an AIR arrow, an AIR action ring or a CRUSH rung. */
export interface ChartImageMark {
  note: Note;
  kind: 'head' | 'end' | 'air' | 'ring' | 'rung';
  tick: number;
  lane: number;
  width: number;
  /** End node model; for a CRUSH rung, the wider top model of the first one. */
  endpoint: boolean;
}
/**
 * Long notes whose bodies the image draws, in the game's layer order (HOLD under SLIDE, the AIR strips above them,
 * AIR HOLD last); equal ones go by time. Every body stays under the marks, unlike the game, so ground notes stay readable.
 */
export function chartImageBodies(chart: Chart): Note[] {
  return [...chart.notes]
    .filter(note => ['HOLD', 'SLIDE', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH'].includes(note.type))
    .sort((a, b) => getNativeBodyDrawOrder(a) - getNativeBodyDrawOrder(b) || a.tick - b.tick);
}
/** A segment that starts where another of its kind ends continues that chain: no head of its own. */
function continued(chart: Chart, note: Note): boolean {
  return chart.notes.some(
    other =>
      other !== note &&
      other.type === note.type &&
      Math.abs(endTick(other) - note.tick) < 1e-6 &&
      endLane(other) === note.lane &&
      endWidth(other) === note.width,
  );
}
/**
 * Every mark in the game's draw order (`getNativeDrawOrder`), so notes on the same spot overlap as in the game: an EX
 * SLIDE head over a TAP, a TAP over a SLIDE head or end node, the AIR family above them. Equal ones go by time.
 */
export function chartImageMarks(chart: Chart): ChartImageMark[] {
  const marks: (ChartImageMark & { order: number })[] = [];
  const add = (note: Note, kind: ChartImageMark['kind'], tick: number, lane: number, width: number, endpoint = false) =>
    marks.push({
      note,
      kind,
      tick,
      lane,
      width,
      endpoint,
      order:
        kind === 'air'
          ? getNativeDrawOrder({ ...note, type: 'AIR' }, width)
          : getNativeDrawOrder(note, width, endpoint || kind === 'ring'),
    });
  for (const note of [...chart.notes].sort((a, b) => a.tick - b.tick)) {
    const node = note.duration && (!hasNodeKind(note) || note.attributes.visible !== false);
    switch (note.type) {
      case 'TAP':
      case 'EXTAP':
      case 'FLICK':
      case 'DAMAGE':
        add(note, 'head', note.tick, note.lane, note.width);
        break;
      case 'HOLD':
        add(note, 'head', note.tick, note.lane, note.width);
        if (note.duration) add(note, 'end', endTick(note), note.lane, note.width, true);
        break;
      case 'SLIDE':
        if (!continued(chart, note)) add(note, 'head', note.tick, note.lane, note.width);
        if (node) add(note, 'end', endTick(note), endLane(note), endWidth(note), true);
        break;
      case 'AIR':
        add(note, 'air', note.tick, note.lane, note.width);
        break;
      case 'AIR_HOLD':
      case 'AIR_SLIDE':
        if (!continued(chart, note)) add(note, 'air', note.tick, note.lane, note.width);
        if (node) add(note, 'ring', endTick(note), endLane(note), endWidth(note));
        break;
      case 'AIR_CRUSH': {
        const interval = Number(note.attributes.interval ?? 0),
          duration = note.duration ?? 0;
        if (!(interval > 0) || !duration) break;
        for (
          let tick = note.tick, count = 0;
          tick <= note.tick + duration + 1e-9 && count < 5000;
          tick += interval, count++
        ) {
          const { lane, width } = laneAt(note, (tick - note.tick) / duration);
          add(note, 'rung', tick, lane, width, count === 0);
        }
        break;
      }
    }
  }
  return marks.sort((a, b) => a.order - b.order).map(({ order: _order, ...mark }) => mark);
}

function laneAt(note: Note, fraction: number): { lane: number; width: number } {
  return {
    lane: note.lane + (endLane(note) - note.lane) * fraction,
    width: note.width + (endWidth(note) - note.width) * fraction,
  };
}
/** Texture keys the image needs, so they can be loaded before drawing. */
function textureKeys(chart: Chart): { models: Set<string>; textures: Set<string> } {
  const models = new Set<string>(),
    textures = new Set<string>(['HoldJoint', 'SlideJoint', 'AirHoldLine', 'AirHoldJoint', 'AirLadderLine']);
  for (const note of chart.notes) {
    const head = getNativeHeadModel(note);
    if (head) models.add(head.key);
    if (note.duration && note.duration > 0) {
      const end = getNativeHeadModel(note, endWidth(note), true);
      if (end) models.add(end.key);
      if (note.type === 'AIR_HOLD' || note.type === 'AIR_SLIDE') {
        models.add(
          `NotesAirHold_Ring_${String(Math.max(1, Math.min(16, Math.round(endWidth(note))))).padStart(2, '0')}`,
        );
        const air = getNativeAirSlideTextures(note.attributes.color);
        textures.add(air.joint);
        textures.add(air.line);
      }
    }
  }
  return { models, textures };
}
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
/** Loads every needed model and texture image from the resource copy; keys without an image are left out. */
async function loadTextures(chart: Chart, textures: GameTextures): Promise<ImageMap> {
  const needed = textureKeys(chart);
  const entries: [string, string][] = [];
  for (const key of needed.models) {
    const url = textures.models[key]?.images[0]?.dataUrl;
    if (url) entries.push([key, url]);
  }
  for (const key of needed.textures) {
    const url = textures.textures[key]?.dataUrl;
    if (url) entries.push([`texture:${key}`, url]);
  }
  const byUrl = new Map<string, Promise<HTMLImageElement | null>>();
  const images: ImageMap = new Map();
  await Promise.all(
    entries.map(async ([key, url]) => {
      if (!byUrl.has(url)) byUrl.set(url, loadImage(url));
      const image = await byUrl.get(url)!;
      if (image) images.set(key, image);
    }),
  );
  return images;
}

export class ChartImagePainter {
  readonly missing = new Set<string>();
  constructor(
    private readonly chart: Chart,
    private readonly layout: ChartImageLayout,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly top: number,
    private readonly images: ImageMap,
  ) {}
  private x(column: ChartImageColumn, lane: number): number {
    return chartImageLaneX(this.layout, column, lane);
  }
  private locate(tick: number) {
    const at = chartImageLocate(this.chart, this.layout, tick);
    return at && { column: at.column, y: at.y + this.top };
  }
  private pieces(note: Note) {
    return chartImageSlice(this.chart, this.layout, note.tick, endTick(note)).map(piece => ({
      ...piece,
      yStart: piece.yStart + this.top,
      yEnd: piece.yEnd + this.top,
    }));
  }
  /** The start tick of the chain a segment belongs to: back through the segments it continues. */
  private chainStart(note: Note): number {
    let current = note;
    for (let guard = 0; guard < 10000; guard++) {
      const previous = this.chart.notes.find(
        other =>
          other !== current &&
          other.type === current.type &&
          Math.abs(endTick(other) - current.tick) < 1e-6 &&
          endLane(other) === current.lane &&
          endWidth(other) === current.width,
      );
      if (!previous) break;
      current = previous;
    }
    return current.tick;
  }
  /** Body pieces with their brightness: full for a twelfth note from the chain start, dimmed after that. */
  private bodyPieces(note: Note): (ReturnType<ChartImagePainter['pieces']>[number] & { alpha: number })[] {
    const duration = note.duration ?? 0;
    const boundary = this.chainStart(note) + this.chart.resolution / BRIGHT_DIVISION;
    const out: (ReturnType<ChartImagePainter['pieces']>[number] & { alpha: number })[] = [];
    for (const piece of this.pieces(note)) {
      const tickStart = note.tick + duration * piece.startFraction,
        tickEnd = note.tick + duration * piece.endFraction;
      if (boundary <= tickStart + 1e-6) out.push({ ...piece, alpha: BODY_DIM });
      else if (boundary >= tickEnd - 1e-6) out.push({ ...piece, alpha: 1 });
      else {
        const at = this.locate(boundary),
          fraction = (boundary - note.tick) / duration;
        if (!at) {
          out.push({ ...piece, alpha: 1 });
          continue;
        }
        out.push({ ...piece, yEnd: at.y, endFraction: fraction, alpha: 1 });
        out.push({ ...piece, yStart: at.y, startFraction: fraction, alpha: BODY_DIM });
      }
    }
    return out;
  }
  private texture(key: string): HTMLImageElement | undefined {
    return this.images.get(`texture:${key}`);
  }
  private model(key: string): HTMLImageElement | undefined {
    const image = this.images.get(key);
    if (!image) this.missing.add(key);
    return image;
  }

  background(): void {
    const { ctx, layout } = this;
    for (const column of layout.columns) {
      const left = this.x(column, 0),
        right = this.x(column, 16),
        y0 = column.y + this.top + CHART_IMAGE_MARGIN,
        y1 = column.y + this.top + layout.columnHeight - CHART_IMAGE_MARGIN;
      for (let lane = 1; lane < 16; lane++) {
        ctx.fillStyle = lane % 4 ? PAGE.lane : PAGE.bank;
        ctx.fillRect(this.x(column, lane), y0, 1, y1 - y0);
      }
      ctx.fillStyle = PAGE.beat;
      for (const band of column.bands)
        for (const y of band.beatLines) ctx.fillRect(left, Math.round(y), right - left, 1);
      ctx.fillStyle = PAGE.border;
      ctx.fillRect(left - 1, column.y + this.top, 1, layout.columnHeight);
      ctx.fillRect(right, column.y + this.top, 1, layout.columnHeight);
    }
  }
  /** Measure lines and numbers; drawn before the notes so a note on a measure start stays whole. */
  bars(): void {
    const { ctx } = this;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    for (const column of this.layout.columns) {
      const left = this.x(column, 0),
        right = this.x(column, 16);
      for (const band of column.bands) {
        ctx.fillStyle = PAGE.border;
        ctx.fillRect(left - 1, Math.round(band.bottom + this.top), right - left + 2, 1);
        if (band === column.bands[column.bands.length - 1])
          ctx.fillRect(left - 1, Math.round(band.top + this.top), right - left + 2, 1);
        ctx.fillStyle = PAGE.number;
        ctx.fillText(String(band.measure), left - 5, band.bottom + this.top - 3);
      }
    }
  }
  notes(): void {
    // Bodies first, then everything on them, both in the game's layer order.
    for (const note of chartImageBodies(this.chart))
      if (note.type === 'HOLD' || note.type === 'SLIDE') this.groundBody(note);
      else if (note.type === 'AIR_CRUSH') this.crush(note);
      else this.airBody(note);
    for (const mark of chartImageMarks(this.chart))
      if (mark.kind === 'air') this.air(mark.note, mark.tick, mark.lane, mark.width);
      else if (mark.kind === 'ring') this.ring(mark.note);
      else this.head(mark.note, mark.tick, mark.lane, mark.width, mark.endpoint);
  }
  private barHeight(x0: number, x1: number): number {
    return Math.max(MIN_BAR, Math.min(MAX_BAR, (x1 - x0) * NOTE_DEPTH));
  }
  /** A ground note's quad seen from above, the texture stretched to the lane span. */
  private head(note: Note, tick: number, lane: number, width: number, endpoint: boolean): void {
    const at = this.locate(tick);
    const model = getNativeHeadModel(note, width, endpoint);
    if (!at || !model) return;
    const image = this.model(model.key);
    if (!image) return;
    const x0 = this.x(at.column, lane),
      x1 = this.x(at.column, lane + width),
      height = this.barHeight(x0, x1);
    this.ctx.drawImage(image, x0, Math.round(at.y) - height / 2, x1 - x0, height);
  }
  /** The AIR texture's coloured bar, floating above the note it belongs to; a tilted AIR leans its bar sideways. */
  private air(note: Note, tick: number, lane: number, width: number): void {
    const at = this.locate(tick);
    const model = getNativeHeadModel({ ...note, type: 'AIR' }, width);
    if (!at || !model) return;
    const image = this.model(model.key);
    if (!image) return;
    const direction = String(note.attributes.direction ?? 'IR');
    const lean = direction.endsWith('L') ? -1 : direction.endsWith('R') && direction !== 'IR' ? 1 : 0;
    const x0 = this.x(at.column, lane),
      x1 = this.x(at.column, lane + width),
      shift = lean * Math.min(6, (x1 - x0) / 4);
    const bottom = Math.round(at.y) - this.barHeight(x0, x1) / 2 - AIR_GAP;
    this.ctx.drawImage(
      image,
      0,
      0,
      image.naturalWidth,
      image.naturalHeight * AIR_BAR_V,
      x0 + shift,
      bottom - AIR_HEIGHT,
      x1 - x0,
      AIR_HEIGHT,
    );
  }
  /** The action ring at the end of an AIR HOLD / AIR SLIDE node. */
  private ring(note: Note): void {
    const at = this.locate(endTick(note));
    if (!at) return;
    const width = endWidth(note),
      key = `NotesAirHold_Ring_${String(Math.max(1, Math.min(16, Math.round(width)))).padStart(2, '0')}`;
    const image = this.model(key);
    if (!image) return;
    const x0 = this.x(at.column, endLane(note)),
      x1 = this.x(at.column, endLane(note) + width),
      height = Math.max(4, Math.min(8, (x1 - x0) * 0.25));
    this.ctx.drawImage(image, x0, Math.round(at.y) - height / 2, x1 - x0, height);
  }
  /** Stretches a texture over the quad between two lane spans, one strip per pixel row when the width changes. */
  private quad(
    image: HTMLImageElement,
    column: ChartImageColumn,
    a: { lane: number; width: number },
    b: { lane: number; width: number },
    yStart: number,
    yEnd: number,
    v0: number,
    v1: number,
    inset = 0,
    alpha = 1,
  ): void {
    const { ctx } = this;
    const height = yStart - yEnd;
    if (height < 0.5) return;
    const xa = this.x(column, a.lane) + inset,
      wa = this.x(column, a.lane + a.width) - inset - xa,
      xb = this.x(column, b.lane) + inset,
      wb = this.x(column, b.lane + b.width) - inset - xb;
    const sy = image.naturalHeight * v0,
      sh = image.naturalHeight * (v1 - v0);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (Math.abs(wa - wb) < 0.5) {
      ctx.transform(wa, 0, xa - xb, height, xb, yEnd);
      ctx.drawImage(image, 0, sy, image.naturalWidth, sh, 0, 0, 1, 1);
    } else {
      const rows = Math.ceil(height);
      for (let index = 0; index < rows; index++) {
        const t0 = index / height,
          t1 = Math.min(1, (index + 1) / height),
          middle = (t0 + t1) / 2;
        ctx.drawImage(
          image,
          0,
          sy + sh * (1 - t1),
          image.naturalWidth,
          sh * (t1 - t0),
          xb + (xa - xb) * middle,
          yEnd + index,
          wb + (wa - wb) * middle,
          1,
        );
      }
    }
    ctx.restore();
  }
  /** HOLD / SLIDE body: the joint texture runs from the start (its bottom row) to the end (its top row). */
  private groundBody(note: Note): void {
    const image = this.texture(note.type === 'HOLD' ? 'HoldJoint' : 'SlideJoint');
    if (!image || !note.duration) return;
    for (const piece of this.bodyPieces(note))
      this.quad(
        image,
        piece.column,
        laneAt(note, piece.startFraction),
        laneAt(note, piece.endFraction),
        piece.yStart,
        piece.yEnd,
        1 - piece.endFraction,
        1 - piece.startFraction,
        1,
        piece.alpha,
      );
  }
  /** AIR HOLD / AIR SLIDE: the translucent roof over the lane span and the line up the middle. */
  private airBody(note: Note): void {
    const keys = getNativeAirSlideTextures(note.attributes.color);
    const roof = this.texture(note.type === 'AIR_HOLD' ? 'AirHoldJoint' : keys.joint) ?? this.texture('AirHoldJoint'),
      line = this.texture(note.type === 'AIR_HOLD' ? 'AirHoldLine' : keys.line) ?? this.texture('AirHoldLine');
    if (!note.duration) return;
    for (const piece of this.bodyPieces(note)) {
      const a = laneAt(note, piece.startFraction),
        b = laneAt(note, piece.endFraction);
      if (roof) this.quad(roof, piece.column, a, b, piece.yStart, piece.yEnd, 0, 1, 1, 0.55 * piece.alpha);
      if (line) {
        const lineWidth = Math.max(3, Math.min(6, (this.x(piece.column, 1) - this.x(piece.column, 0)) * 0.8));
        const centre = (p: { lane: number; width: number }) => ({ lane: p.lane + p.width / 2 - 0.5, width: 1 });
        const ca = centre(a),
          cb = centre(b);
        const inset = (this.x(piece.column, 1) - this.x(piece.column, 0) - lineWidth) / 2;
        this.quad(line, piece.column, ca, cb, piece.yStart, piece.yEnd, 0, 1, inset, piece.alpha);
      }
    }
  }
  /**
   * AIR CRUSH: the ladder line along the centre in the colour row the game picks from the line atlas (NON draws no
   * line). Its rungs, one at each judgement interval, are marks (`chartImageMarks`).
   */
  private crush(note: Note): void {
    const line = this.texture('AirLadderLine'),
      v = getNativeAirCrushLineV(note.attributes.color);
    if (!note.duration) return;
    for (const piece of this.bodyPieces(note)) {
      const a = laneAt(note, piece.startFraction),
        b = laneAt(note, piece.endFraction);
      if (line && v !== undefined) {
        const centre = (p: { lane: number; width: number }) => ({ lane: p.lane + p.width / 2 - 0.5, width: 1 });
        const inset = (this.x(piece.column, 1) - this.x(piece.column, 0) - 3) / 2,
          row = 0.5 / line.naturalHeight;
        this.quad(
          line,
          piece.column,
          centre(a),
          centre(b),
          piece.yStart,
          piece.yEnd,
          v - row,
          v + row,
          inset,
          piece.alpha,
        );
      }
    }
  }
}

function difficultyLabel(project: Project): string {
  const { difficulty, level } = project.metadata;
  return difficulty === 'WORLD’S END'
    ? `WORLD’S END ${project.exportSettings.weTag ? `${project.exportSettings.weTag} ` : ''}${level}`.trim()
    : `${difficulty} ${level}`.trim();
}
function bpmLabel(chart: Chart): string {
  const values = [
    chart.defaultBpm,
    ...chart.events.filter(event => event.type === 'BPM').map(event => event.value),
  ].filter(value => Number.isFinite(value) && value > 0);
  if (!values.length) return '';
  const min = Math.min(...values),
    max = Math.max(...values);
  const text = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, ''));
  return min === max ? text(min) : `${text(min)}–${text(max)}`;
}

/** The whole image on a fresh canvas: header, then the chart drawn with the game's textures. */
export async function renderChartImage(
  project: Project,
  textures: GameTextures,
  header: ChartImageHeader = {},
  options: ChartImageOptions = {},
): Promise<ChartImageResult> {
  const chart = project.chart;
  const images = await loadTextures(chart, textures);
  const layout = layoutChartImage(chart, options);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(MIN_WIDTH, layout.width);
  canvas.height = HEADER_HEIGHT + layout.height + BOTTOM;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = PAGE.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let textLeft = 24;
  if (header.cover) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 100, 100, 6);
    ctx.clip();
    ctx.drawImage(header.cover, 20, 20, 100, 100);
    ctx.restore();
    textLeft = 140;
  }
  const meta = project.metadata;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText(meta.title || '未命名', textLeft, 48);
  ctx.fillStyle = '#c8c8c8';
  ctx.font = `14px ${FONT}`;
  ctx.fillText(meta.artist, textLeft, 72);
  const chain = buildJudgementTimeline(chart).total;
  const facts = [
    difficultyLabel(project),
    bpmLabel(chart) ? `BPM ${bpmLabel(chart)}` : '',
    `CHAIN ${chain}`,
    meta.designer ? `NOTES DESIGNER / ${meta.designer}` : '',
  ].filter(Boolean);
  ctx.fillStyle = '#e6e6e6';
  ctx.font = `13px ${FONT}`;
  ctx.fillText(facts.join('    '), textLeft, 100);
  ctx.fillStyle = PAGE.border;
  ctx.fillRect(20, HEADER_HEIGHT - 12, canvas.width - 40, 1);
  const painter = new ChartImagePainter(chart, layout, ctx, HEADER_HEIGHT, images);
  painter.background();
  painter.bars();
  painter.notes();
  return { canvas, missing: [...painter.missing].sort() };
}

/** PNG bytes of a rendered image. */
export function chartImagePng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('图片编码失败'));
        return;
      }
      blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}
