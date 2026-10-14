import { NODE_KIND_NOTE_TYPES, type Chart, type Note } from '../core/model';
import { buildJudgementTimeline } from '../core/judgement';
import { getNotePlaybackPoints, type NotePlaybackPoint } from '../core/timing';

const cache = new WeakMap<Chart, Map<string, readonly NotePlaybackPoint[]>>();
/** Share the native reader's chain heads with visuals and audio. Endpoint bars remain
 * visible even when an AIR release window removes their scoring judgement. */
export function getPlayerPlaybackPoints(chart: Chart, target: Note): readonly NotePlaybackPoint[] {
  let points = cache.get(chart);
  if (!points) {
    points = new Map();
    const heads = new Set(
      buildJudgementTimeline(chart)
        .points.filter(p => p.kind === 'head')
        .map(p => p.noteId),
    );
    for (const note of chart.notes) {
      const original = getNotePlaybackPoints(chart, note);
      if (!NODE_KIND_NOTE_TYPES.has(note.type)) {
        points.set(note.id, original);
        continue;
      }
      const result = original.filter(p => p.position !== 'head');
      if (heads.has(note.id)) {
        const air = note.type !== 'SLIDE';
        result.unshift({
          noteId: note.id,
          position: 'head',
          tick: note.tick,
          lane: note.lane,
          width: note.width,
          type: air ? 'AIR' : note.type,
          height: air ? 0.48 : note.height,
          direction: air ? 'IR' : String(note.attributes.direction ?? ''),
          sound: true,
        });
      }
      points.set(note.id, result);
    }
    cache.set(chart, points);
  }
  return points.get(target.id) ?? [];
}
