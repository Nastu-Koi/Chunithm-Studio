import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote } from '../src/core/model';
import {
  CHART_IMAGE_COLUMN_WIDTH,
  CHART_IMAGE_MARGIN,
  chartImageLaneX,
  chartImageLocate,
  chartImagePixelsBetween,
  chartImageSlice,
  layoutChartImage,
} from '../src/core/chart-image';

function chartWithNotes(ticks: number[]) {
  const chart = createChart();
  chart.notes = ticks.map(tick => createNote('TAP', tick, 0, 4));
  return chart;
}

test('four 4/4 measures fill one 16-beat column, read bottom to top, numbered from page measure 1', () => {
  const chart = chartWithNotes([384, 384 * 5 + 192]);
  const layout = layoutChartImage(chart);
  assert.equal(layout.pixelsPerBeat, 96);
  assert.equal(layout.columnHeight, 16 * 96 + 2 * CHART_IMAGE_MARGIN);
  assert.equal(layout.columns.length, 2);
  assert.equal(layout.width, 2 * CHART_IMAGE_COLUMN_WIDTH);
  assert.equal(layout.height, layout.columnHeight);
  assert.deepEqual(
    layout.columns[0].bands.map(band => band.measure),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    layout.columns[1].bands.map(band => band.measure),
    [5],
  );
  const [first, second] = layout.columns[0].bands;
  assert.equal(first.bottom, layout.columnHeight - CHART_IMAGE_MARGIN);
  assert.equal(first.top, first.bottom - 384);
  assert.equal(second.bottom, first.top);
  assert.deepEqual(
    first.beatLines.map(y => first.bottom - y),
    [96, 192, 288],
  );
  assert.equal(layout.firstMeasure, 1);
  assert.equal(layout.lastMeasure, 5);
});

test('a note in the leading measure brings page measure 0 into the image', () => {
  const layout = layoutChartImage(chartWithNotes([96]));
  assert.equal(layout.columns[0].bands[0].measure, 0);
  assert.equal(layout.firstMeasure, 0);
});

test('a faster measure is shorter and a slower one taller, keeping one pixel the same length of music', () => {
  const chart = chartWithNotes([384, 384 * 3]);
  chart.events = [
    { id: 'a', type: 'BPM', tick: 0, value: 120 },
    { id: 'b', type: 'BPM', tick: 384 * 2, value: 240 },
    { id: 'c', type: 'BPM', tick: 384 * 3, value: 60 },
  ];
  const layout = layoutChartImage(chart);
  assert.equal(layout.pageBpm, 120);
  const [m1, m2, m3] = layout.columns[0].bands;
  assert.equal(m1.bottom - m1.top, 384);
  assert.equal(m2.bottom - m2.top, 192);
  assert.equal(m3.bottom - m3.top, 768);
  // A change in the middle of a measure splits its spacing.
  chart.events.push({ id: 'd', type: 'BPM', tick: 384 * 4 + 192, value: 120 });
  assert.equal(chartImagePixelsBetween(chart, 384 * 4, 384 * 5, 96, 120), 384 + 192);
});

test('a 6/4 measure is taller than a 4/4 one and a measure longer than a column stands alone, stretching every column', () => {
  const chart = chartWithNotes([384, 384 * 8]);
  chart.events = [{ id: 'met', type: 'METER', tick: 384 * 4, value: 0, numerator: 20, denominator: 4 }];
  const layout = layoutChartImage(chart);
  const long = layout.columns.flatMap(column => column.bands).find(band => band.tick === 384 * 4)!;
  assert.equal(long.bottom - long.top, 20 * 96);
  assert.equal(layout.columnHeight, 20 * 96 + 2 * CHART_IMAGE_MARGIN);
  assert.equal(layout.columns.find(column => column.bands.includes(long))!.bands.length, 1);
});

test('columns wrap into rows of eight, and lanes split the 98-pixel area like the page', () => {
  const chart = chartWithNotes([384, 384 * 40]);
  const layout = layoutChartImage(chart);
  assert.equal(layout.columns.length, 10);
  assert.equal(layout.rows, 2);
  assert.equal(layout.width, 8 * CHART_IMAGE_COLUMN_WIDTH);
  assert.equal(layout.height, 2 * layout.columnHeight);
  assert.deepEqual(
    [layout.columns[8].row, layout.columns[8].slot, layout.columns[8].x, layout.columns[8].y],
    [1, 0, 0, layout.columnHeight],
  );
  const column = layout.columns[0];
  assert.equal(chartImageLaneX(layout, column, 0), column.x + 51);
  assert.equal(chartImageLaneX(layout, column, 16), column.x + 51 + 98);
  assert.equal(chartImageLaneX(layout, column, 4), column.x + 51 + 25);
  assert.equal(layoutChartImage(chart, { columnsPerRow: 4 }).rows, 3);
});

test('ticks locate to a column and y, and a span crossing a column boundary is cut into pieces', () => {
  const chart = chartWithNotes([384, 384 * 6]);
  const layout = layoutChartImage(chart);
  const at = chartImageLocate(chart, layout, 384 + 96)!;
  assert.equal(at.column.index, 0);
  assert.equal(at.band.measure, 1);
  assert.equal(at.y, layout.columnHeight - CHART_IMAGE_MARGIN - 96);
  const pieces = chartImageSlice(chart, layout, 384 * 4 + 192, 384 * 5 + 96);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].column.index, 0);
  assert.equal(pieces[0].yStart, layout.columnHeight - CHART_IMAGE_MARGIN - 384 * 3 - 192);
  assert.equal(pieces[0].yEnd, CHART_IMAGE_MARGIN);
  assert.equal(pieces[0].endFraction, 192 / 288);
  assert.equal(pieces[1].column.index, 1);
  assert.equal(pieces[1].yStart, layout.columnHeight - CHART_IMAGE_MARGIN);
  assert.equal(pieces[1].yEnd, layout.columnHeight - CHART_IMAGE_MARGIN - 96);
  assert.equal(pieces[1].startFraction, 192 / 288);
  assert.equal(pieces[1].endFraction, 1);
  // An instant is a single zero-height piece.
  assert.equal(chartImageSlice(chart, layout, 384, 384).length, 1);
});
