import type { Chart, Note } from '../core/model';
import { getPlayerPlaybackPoints } from './playback-points';
import { buildJudgementTimeline } from '../core/judgement';
import { tickToSeconds } from '../core/timing';
import { nativeAirBaseHeight, AIR_LINE_HEIGHT } from './native-notes';

export interface NoteEffectEvent {
  note: Note;
  time: number;
  kind: string;
  lane: number;
  width: number;
  y: number;
  seed: number;
}
const endKey = (tick: number, lane: number, width: number) => `${tick}:${lane}:${width}`;
/** Effect placement is built once with the same chain heads used by autoplay audio. */
export function buildNoteEffectEvents(chart: Chart): NoteEffectEvent[] {
  const events: NoteEffectEvent[] = [];
  const starts = new Map<string, Note[]>();
  for (const note of chart.notes) {
    const key = endKey(note.tick, note.lane, note.width),
      values = starts.get(key) ?? [];
    values.push(note);
    starts.set(key, values);
  }
  const append = (note: Note, tick: number, kind: string, lane: number, width: number, y: number) => {
    events.push({ note, time: tickToSeconds(chart, tick), kind, lane, width, y, seed: events.length + 1 });
  };
  for (const note of chart.notes) {
    if (note.type === 'DAMAGE' || note.type === 'AIR_CRUSH') continue;
    for (const point of getPlayerPlaybackPoints(chart, note)) {
      if (point.position === 'head') {
        const down = ['DOWN', 'DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR'].includes(String(note.attributes.direction));
        const kind =
          point.type === 'AIR'
            ? note.type === 'AIR_HOLD'
              ? 'AirHoldIn'
              : down
                ? 'AirDown'
                : 'Air'
            : note.attributes.ex || note.type === 'EXTAP'
              ? 'Chara'
              : (
                  { TAP: 'Tap', HOLD: 'Hold', SLIDE: 'Slide', FLICK: 'FlickNone' } as Partial<
                    Record<Note['type'], string>
                  >
                )[note.type];
        if (kind)
          append(
            note,
            point.tick,
            kind,
            point.lane,
            point.width,
            note.type === 'AIR' ? nativeAirBaseHeight(note.height ?? 1) : 0,
          );
      } else {
        const continuation = (starts.get(endKey(point.tick, point.lane, point.width)) ?? []).some(
          n => n.id !== note.id && n.type === note.type,
        );
        const kind =
          note.type === 'HOLD'
            ? 'HoldEnd'
            : note.type === 'SLIDE'
              ? continuation
                ? 'SlideChain'
                : 'SlideEnd'
              : continuation
                ? 'AirAction'
                : 'AirActionEnd';
        const y =
          note.type === 'AIR_HOLD'
            ? AIR_LINE_HEIGHT
            : note.type === 'AIR_SLIDE'
              ? nativeAirBaseHeight(note.endHeight ?? note.height ?? 1)
              : 0;
        append(note, point.tick, kind, point.lane, point.width, y);
      }
    }
  }
  const notes = new Map(chart.notes.map(note => [note.id, note]));
  for (const point of buildJudgementTimeline(chart).points)
    if (point.kind === 'crush') {
      const note = notes.get(point.noteId)!;
      const t = note.duration ? (point.tick - note.tick) / note.duration : 0;
      append(
        note,
        point.tick,
        'AirLadder',
        note.lane + ((note.endLane ?? note.lane) - note.lane) * t,
        note.width + ((note.endWidth ?? note.width) - note.width) * t,
        nativeAirBaseHeight((note.height ?? 1) + ((note.endHeight ?? note.height ?? 1) - (note.height ?? 1)) * t),
      );
    }
  return events.sort((a, b) => a.time - b.time || a.seed - b.seed);
}

export function recentNoteEffects(
  events: readonly NoteEffectEvent[],
  seconds: number,
  lifetime: number,
): readonly NoteEffectEvent[] {
  const bound = (time: number) => {
    let low = 0,
      high = events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (events[mid].time <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return events.slice(bound(seconds - lifetime), bound(seconds));
}
