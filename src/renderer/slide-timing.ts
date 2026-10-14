import type { Chart } from '../core/model';
import { getNativeSlideChains } from '../core/judgement';
import { tickToSeconds } from '../core/timing';
export interface SlideUvSpan {
  startSeconds: number;
  endSeconds: number;
}
const cache = new WeakMap<Chart, ReadonlyMap<string, SlideUvSpan>>();
/** Control nodes bend one surface; only ordinary nodes begin a new texture span. */
export function getSlideUvSpans(chart: Chart): ReadonlyMap<string, SlideUvSpan> {
  const cached = cache.get(chart);
  if (cached) return cached;
  const spans = new Map<string, SlideUvSpan>();
  for (const chain of getNativeSlideChains(chart)) {
    let first = 0;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].attributes.visible === false && i < chain.length - 1) continue;
      const span = {
        startSeconds: tickToSeconds(chart, chain[first].tick),
        endSeconds: tickToSeconds(chart, chain[i].tick + (chain[i].duration ?? 0)),
      };
      for (let j = first; j <= i; j++) spans.set(chain[j].id, span);
      first = i + 1;
    }
  }
  cache.set(chart, spans);
  return spans;
}
export function slideUvProgress(chart: Chart, span: SlideUvSpan, tick: number): number {
  const duration = span.endSeconds - span.startSeconds;
  return duration <= 0 ? 0 : Math.max(0, Math.min(1, (tickToSeconds(chart, tick) - span.startSeconds) / duration));
}
