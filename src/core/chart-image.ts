import type { Chart } from './model';
import { bpmAtTick, getBeatLines, getChartEndTick, getMeasureLines } from './timing';

/**
 * Layout of the top-down chart image, after the sdvx.in chart pages: columns of measures read bottom-to-top, columns
 * left-to-right, a fixed number of columns per row. Pixels follow time: a beat at the page BPM is `pixelsPerBeat` tall and
 * a faster or slower measure is drawn proportionally shorter or taller, so one pixel is the same length of music
 * everywhere. Pure geometry; drawing is the renderer's job.
 */
export interface ChartImageOptions {
  /** Height of one quarter-note beat at the page BPM. sdvx.in draws 96. */
  pixelsPerBeat?: number;
  /** Beats (at the page BPM) one column holds: 16 is four 4/4 measures. */
  beatsPerColumn?: number;
  /** Columns side by side before the layout wraps to a new row. */
  columnsPerRow?: number;
}
/** One measure drawn in a column. `top` / `bottom` are image y coordinates, bottom being the measure's start. */
export interface ChartImageBand {
  /** Page measure number: 0 is the leading empty measure, 1 the first full one, as on sdvx.in and in native MEASURE. */
  measure: number;
  tick: number;
  endTick: number;
  top: number;
  bottom: number;
  /** Image y of each beat line inside the measure, excluding its own start. */
  beatLines: number[];
}
export interface ChartImageColumn {
  index: number;
  row: number;
  /** Position within the row. */
  slot: number;
  /** Image x of the column's left edge and y of its top edge. */
  x: number;
  y: number;
  bands: ChartImageBand[];
}
export interface ChartImageLayout {
  pixelsPerBeat: number;
  pageBpm: number;
  columnWidth: number;
  columnHeight: number;
  /** Lane area inside the column, offset from the column's left edge. */
  innerLeft: number;
  innerWidth: number;
  width: number;
  height: number;
  rows: number;
  columns: ChartImageColumn[];
  firstMeasure: number;
  lastMeasure: number;
}
/** A piece of a time span inside one column, in image coordinates; `startFraction`…`endFraction` locate it within the whole span. */
export interface ChartImagePiece {
  column: ChartImageColumn;
  /** Image y of the piece's start (later in time is higher up, so `yEnd <= yStart`). */
  yStart: number;
  yEnd: number;
  startFraction: number;
  endFraction: number;
}

/** sdvx.in column geometry: a 98-pixel lane area in a 200-pixel column, 24 pixels above and below the measures. */
export const CHART_IMAGE_COLUMN_WIDTH = 200;
export const CHART_IMAGE_INNER_WIDTH = 98;
export const CHART_IMAGE_INNER_LEFT = 51;
export const CHART_IMAGE_MARGIN = 24;
const DEFAULTS = { pixelsPerBeat: 96, beatsPerColumn: 16, columnsPerRow: 8 };

/** Pixels between two ticks: each stretch of music at one BPM is `pixelsPerBeat × pageBpm ÷ bpm` per quarter note. */
export function chartImagePixelsBetween(
  chart: Chart,
  fromTick: number,
  toTick: number,
  pixelsPerBeat: number,
  pageBpm: number,
): number {
  if (!(toTick > fromTick)) return 0;
  const ticksPerBeat = chart.resolution / 4;
  const changes = chart.events
    .filter(event => event.type === 'BPM' && event.tick > fromTick && event.tick < toTick && event.value > 0)
    .sort((a, b) => a.tick - b.tick);
  let pixels = 0,
    tick = fromTick,
    bpm = bpmAtTick(chart, fromTick);
  for (const change of changes) {
    pixels += ((change.tick - tick) / ticksPerBeat) * pixelsPerBeat * (pageBpm / bpm);
    tick = change.tick;
    bpm = change.value;
  }
  return pixels + ((toTick - tick) / ticksPerBeat) * pixelsPerBeat * (pageBpm / bpm);
}

export function layoutChartImage(chart: Chart, options: ChartImageOptions = {}): ChartImageLayout {
  const pixelsPerBeat = options.pixelsPerBeat ?? DEFAULTS.pixelsPerBeat,
    beatsPerColumn = options.beatsPerColumn ?? DEFAULTS.beatsPerColumn,
    columnsPerRow = Math.max(1, Math.floor(options.columnsPerRow ?? DEFAULTS.columnsPerRow));
  const endTick = Math.max(getChartEndTick(chart), chart.resolution);
  const lines = getMeasureLines(chart, 0, endTick);
  // The leading measure only appears when something is in it; the last one holds the end of the last note.
  const firstTick = chart.notes.reduce((first, note) => Math.min(first, note.tick), Infinity);
  let first = lines.findIndex(line => line.tick > firstTick) - 1;
  if (first < 0) first = Number.isFinite(firstTick) ? lines.length - 1 : Math.min(1, lines.length - 1);
  const measures = lines.slice(Math.max(0, first));
  const pageBpm = bpmAtTick(chart, measures[0]?.tick ?? 0) || chart.defaultBpm || 120;
  const heights = measures.map(line => {
    const next =
      lines[lines.indexOf(line) + 1]?.tick ?? line.tick + (chart.resolution * line.numerator) / line.denominator;
    return { line, endTick: next, height: chartImagePixelsBetween(chart, line.tick, next, pixelsPerBeat, pageBpm) };
  });
  // Whole measures per column up to the column's beats; a longer measure stands alone and stretches every column.
  const limit = beatsPerColumn * pixelsPerBeat;
  const groups: (typeof heights)[] = [];
  let current: typeof heights = [],
    used = 0;
  for (const item of heights) {
    if (current.length && used + item.height > limit + 1e-6) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += item.height;
  }
  if (current.length) groups.push(current);
  const tallest = groups.reduce(
    (max, group) =>
      Math.max(
        max,
        group.reduce((sum, item) => sum + item.height, 0),
      ),
    0,
  );
  const columnHeight = Math.ceil(Math.max(limit, tallest)) + 2 * CHART_IMAGE_MARGIN;
  const rows = Math.max(1, Math.ceil(groups.length / columnsPerRow));
  const columns: ChartImageColumn[] = groups.map((group, index) => {
    const row = Math.floor(index / columnsPerRow),
      slot = index % columnsPerRow,
      x = slot * CHART_IMAGE_COLUMN_WIDTH,
      y = row * columnHeight;
    let bottom = y + columnHeight - CHART_IMAGE_MARGIN;
    const bands: ChartImageBand[] = group.map(item => {
      const top = bottom - item.height;
      const beatLines = getBeatLines(chart, item.line.tick, item.endTick)
        .filter(beat => !beat.downbeat)
        .map(beat => bottom - chartImagePixelsBetween(chart, item.line.tick, beat.tick, pixelsPerBeat, pageBpm));
      const band = { measure: item.line.measure, tick: item.line.tick, endTick: item.endTick, top, bottom, beatLines };
      bottom = top;
      return band;
    });
    return { index, row, slot, x, y, bands };
  });
  return {
    pixelsPerBeat,
    pageBpm,
    columnWidth: CHART_IMAGE_COLUMN_WIDTH,
    columnHeight,
    innerLeft: CHART_IMAGE_INNER_LEFT,
    innerWidth: CHART_IMAGE_INNER_WIDTH,
    width: Math.min(groups.length, columnsPerRow) * CHART_IMAGE_COLUMN_WIDTH,
    height: rows * columnHeight,
    rows,
    columns,
    firstMeasure: measures[0]?.measure ?? 0,
    lastMeasure: measures[measures.length - 1]?.measure ?? 0,
  };
}

/** Image x of a lane edge inside a column: sdvx.in splits the 98 pixels into 16 lanes at round(n × 98 ÷ 16). */
export function chartImageLaneX(layout: ChartImageLayout, column: ChartImageColumn, lane: number): number {
  return column.x + layout.innerLeft + Math.round((lane * layout.innerWidth) / 16);
}

/** The column and image y of a tick; ticks after the last measure continue above it in the last column. */
export function chartImageLocate(
  chart: Chart,
  layout: ChartImageLayout,
  tick: number,
): { column: ChartImageColumn; band: ChartImageBand; y: number } | undefined {
  const firstColumn = layout.columns[0],
    lastColumn = layout.columns[layout.columns.length - 1];
  if (!firstColumn || !lastColumn) return undefined;
  let found: { column: ChartImageColumn; band: ChartImageBand } | undefined;
  for (const column of layout.columns)
    for (const band of column.bands) if (tick >= band.tick && tick < band.endTick) found = { column, band };
  // Before the first measure: below it in the first column. After the last: above it in the last column.
  if (!found && tick < firstColumn.bands[0].tick) found = { column: firstColumn, band: firstColumn.bands[0] };
  if (!found) found = { column: lastColumn, band: lastColumn.bands[lastColumn.bands.length - 1] };
  const { column, band } = found;
  const y =
    tick < band.tick
      ? band.bottom + chartImagePixelsBetween(chart, tick, band.tick, layout.pixelsPerBeat, layout.pageBpm)
      : band.bottom - chartImagePixelsBetween(chart, band.tick, tick, layout.pixelsPerBeat, layout.pageBpm);
  return { column, band, y };
}

/** A time span cut at column boundaries, so a long note is drawn as one piece per column it crosses. */
export function chartImageSlice(
  chart: Chart,
  layout: ChartImageLayout,
  startTick: number,
  endTick: number,
): ChartImagePiece[] {
  const pieces: ChartImagePiece[] = [];
  const total = endTick - startTick;
  const start = chartImageLocate(chart, layout, startTick);
  if (!start) return pieces;
  if (!(total > 0)) {
    pieces.push({ column: start.column, yStart: start.y, yEnd: start.y, startFraction: 0, endFraction: 1 });
    return pieces;
  }
  let tick = startTick;
  while (tick < endTick - 1e-9) {
    const at = chartImageLocate(chart, layout, tick);
    if (!at) break;
    const columnEnd = at.column.bands[at.column.bands.length - 1].endTick;
    const last = at.column.index === layout.columns.length - 1;
    const pieceEnd = last ? endTick : Math.min(endTick, columnEnd);
    const to = chartImageLocate(chart, layout, pieceEnd);
    const yEnd = pieceEnd >= columnEnd && !last ? at.column.bands[at.column.bands.length - 1].top : (to?.y ?? at.y);
    pieces.push({
      column: at.column,
      yStart: at.y,
      yEnd,
      startFraction: (tick - startTick) / total,
      endFraction: (pieceEnd - startTick) / total,
    });
    if (pieceEnd <= tick) break;
    tick = pieceEnd;
  }
  return pieces;
}
