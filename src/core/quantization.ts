import type { Chart, ChartEvent, Note } from './model';
import { getTimeline, tickToSeconds } from './timing';

export interface C2SQuantizationEntry {
  entityId: string;
  kind: 'note' | 'event';
  type: string;
  tick: number;
  nativeTick: number;
  endTick?: number;
  nativeEndTick?: number;
  /** Signed native-export time minus project time, including shifted BPM boundaries. */
  startErrorMs: number;
  endErrorMs?: number;
  /** Largest absolute timing change among corresponding internal AIR-CRUSH ticks. */
  intervalErrorMs?: number;
  judgementCountChanged?: boolean;
  maxErrorMs: number;
  fields: Array<'tick' | 'duration' | 'interval'>;
  /** A positive duration rounded to zero, so one native tick was retained. */
  minimumDurationApplied?: boolean;
}
export interface C2SQuantizationReport {
  required: boolean;
  resolution: number;
  entries: C2SQuantizationEntry[];
  maxErrorMs: number;
  affectedCount: number;
  roundedEntityCount: number;
}
export class C2SQuantizationRequiredError extends Error {
  constructor(public readonly report: C2SQuantizationReport) {
    super(`原生 C2S 需要整数 tick：${report.roundedEntityCount} 项需要量化，最大时间误差 ${report.maxErrorMs.toFixed(3)} ms。请先确认量化报告。`);
    this.name = 'C2SQuantizationRequiredError';
  }
}
const fractional = (value: number | undefined): boolean => value !== undefined && Number.isFinite(value) && !Number.isInteger(value);
function needsRounding(item: Note | ChartEvent): boolean {
  return fractional(item.tick) || fractional(item.duration) || ('attributes' in item && item.type === 'AIR_CRUSH' && fractional(Number(item.attributes.interval ?? 24)));
}
function quantizeItem<T extends Note | ChartEvent>(item: T): T {
  if (!needsRounding(item)) return item;
  const tick = Math.round(item.tick);
  const rounded: T = { ...item, tick };
  if (item.duration !== undefined) {
    // Round endpoints together so adjacent long segments keep a shared endpoint.
    const duration = Math.round(item.tick + item.duration) - tick;
    rounded.duration = item.duration > 0 ? Math.max(1, duration) : duration;
  }
  if ('attributes' in item && item.type === 'AIR_CRUSH') {
    const interval = Number(item.attributes.interval ?? 24);
    (rounded as Note).attributes = { ...item.attributes, interval: interval > 0 ? Math.max(1, Math.round(interval)) : 0 };
  }
  return rounded;
}
/** Native coordinates use the chart's existing resolution; never changes it or mutates the project. */
export function quantizeChartForC2S(chart: Chart): Chart {
  if (!chart.notes.some(needsRounding) && !chart.events.some(needsRounding)) return chart;
  return { ...chart, notes: chart.notes.map(quantizeItem), events: chart.events.map(quantizeItem) };
}
const reports = new WeakMap<Chart, C2SQuantizationReport>();
/** Includes downstream timing drift when a fractional BPM boundary moves during export. */
export function analyzeC2SQuantization(chart: Chart): C2SQuantizationReport {
  const cached = reports.get(chart); if (cached) return cached;
  const native = quantizeChartForC2S(chart);
  const report: C2SQuantizationReport = { required: native !== chart, resolution: chart.resolution, entries: [], maxErrorMs: 0, affectedCount: 0, roundedEntityCount: 0 };
  if (native !== chart) {
    const pairs: Array<[Note | ChartEvent, Note | ChartEvent, 'note' | 'event']> = [
      ...chart.notes.map((note, i) => [note, native.notes[i], 'note'] as [Note, Note, 'note']),
      ...chart.events.map((event, i) => [event, native.events[i], 'event'] as [ChartEvent, ChartEvent, 'event']),
    ];
    for (const [item, rounded, kind] of pairs) {
      const fields: C2SQuantizationEntry['fields'] = [];
      if (item.tick !== rounded.tick) fields.push('tick');
      if (item.duration !== rounded.duration) fields.push('duration');
      const entry: C2SQuantizationEntry = {
        entityId: item.id, kind, type: item.type, tick: item.tick, nativeTick: rounded.tick,
        startErrorMs: (tickToSeconds(native, rounded.tick) - tickToSeconds(chart, item.tick)) * 1000,
        maxErrorMs: 0, fields,
      };
      if (item.duration !== undefined) {
        entry.endTick = item.tick + item.duration;
        entry.nativeEndTick = rounded.tick + (rounded.duration ?? 0);
        entry.endErrorMs = (tickToSeconds(native, entry.nativeEndTick) - tickToSeconds(chart, entry.endTick)) * 1000;
        if (item.duration > 0 && Math.round(entry.endTick) === Math.round(item.tick)) entry.minimumDurationApplied = true;
      }
      if ('attributes' in item && 'attributes' in rounded && item.type === 'AIR_CRUSH') {
        const interval = Number(item.attributes.interval ?? 24);
        const nativeInterval = Number(rounded.attributes.interval ?? 24);
        if (interval !== nativeInterval) {
          fields.push('interval');
          const count = interval > 0 ? Math.floor((item.duration ?? 0) / interval + 1e-9) : 0;
          const nativeCount = nativeInterval > 0 ? Math.floor((rounded.duration ?? 0) / nativeInterval + 1e-9) : 0;
          entry.judgementCountChanged = count !== nativeCount;
          const shared = Math.min(count, nativeCount);
          // Between BPM changes, timing error is linear in the judgement index.
          // Checking their neighbouring indices gives the exact maximum without
          // allocating potentially millions of synthetic judgement records.
          const indices = new Set<number>([0, shared]);
          for (const [timeline, origin, spacing] of [[getTimeline(chart), item.tick, interval], [getTimeline(native), rounded.tick, nativeInterval]] as const) {
            if (!(spacing > 0)) continue;
            for (const boundary of timeline) {
              const index = (boundary.tick - origin) / spacing;
              for (const candidate of [Math.floor(index), Math.ceil(index)]) if (candidate >= 0 && candidate <= shared) indices.add(candidate);
            }
          }
          entry.intervalErrorMs = 0;
          for (const index of indices) entry.intervalErrorMs = Math.max(entry.intervalErrorMs, Math.abs(tickToSeconds(native, rounded.tick + index * nativeInterval) - tickToSeconds(chart, item.tick + index * interval)) * 1000);
        }
      }
      entry.maxErrorMs = Math.max(Math.abs(entry.startErrorMs), Math.abs(entry.endErrorMs ?? 0), Math.abs(entry.intervalErrorMs ?? 0));
      if (fields.length) report.roundedEntityCount += 1;
      if (fields.length || entry.maxErrorMs > 1e-8) report.entries.push(entry);
      report.maxErrorMs = Math.max(report.maxErrorMs, entry.maxErrorMs);
    }
  }
  report.affectedCount = report.entries.length;
  reports.set(chart, report); return report;
}
