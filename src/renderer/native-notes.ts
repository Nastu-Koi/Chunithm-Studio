import type { Chart, Note } from '../core/model';
import { TRACK_REFERENCE, projectTrackPoint } from './player-scene';
import type { MeshPoint } from './game-mesh-renderer';

/** Note::height conversion at 0xb412e0; public C2S heights are already decimal values. */
export const AIR_HEIGHT_STEP = 3.8934998512268066;
export const AIR_LINE_HEIGHT = 15.574000358581543;
const focal = 540 / Math.tan(27.5 * Math.PI / 360), cameraLength = Math.hypot(54, 190.5);
const sine = 54 / cameraLength, cosine = 190.5 / cameraLength;
/** Converts the preview's scroll distance to the source geometry's Z units. */
export function nativeScrollWorldUnit(speed = 6): number { return focal / (TRACK_REFERENCE.judgeWidth / 64) * (1.8 * speed / 6) / cosine; }
export function nativeAirBaseHeight(height = 1): number { return (height - 1) * AIR_HEIGHT_STEP; }
/** Carries the first center through ASD/ASC connections so texture U does not jump at each record. */
export function getNativeAirSlideRoots(chart: Chart): Map<string, number> {
  const result = new Map<string, number>(), tails = new Map<string, number[]>();
  const key = (note: Note, tail: boolean) => [tail ? note.attributes.visible === false ? 'ASC' : 'ASD' : note.attributes.parent,
    tail ? note.tick + (note.duration ?? 0) : note.tick, tail ? note.endLane ?? note.lane : note.lane,
    tail ? note.endWidth ?? note.width : note.width, tail ? note.endHeight ?? note.height ?? 1 : note.height ?? 1,
    note.attributes.color ?? 'DEF'].join(':');
  for (const note of chart.notes.filter(n => n.type === 'AIR_SLIDE').sort((a, b) => a.tick - b.tick)) {
    const center = tails.get(key(note, false))?.shift() ?? note.lane + note.width / 2;
    result.set(note.id, center);
    const end = key(note, true), waiting = tails.get(end) ?? []; waiting.push(center); tails.set(end, waiting);
  }
  return result;
}
export interface NativeNoteModel { key: string; width: number; mirror: number }
/** Exact ModelTable families; left directions reuse the right-leaning mesh with negative X scale. */
export function getNativeHeadModel(note: Note, width = note.width, endpoint = false): NativeNoteModel | undefined {
  if (!(width > 0 && Number.isFinite(width))) return undefined;
  const nativeWidth = Math.max(1, Math.min(16, Math.round(width))), size = String(nativeWidth).padStart(2, '0');
  let prefix: string | undefined, suffix = '', mirror = 1;
  if (note.type === 'AIR') {
    const direction = String(note.attributes.direction ?? 'IR'), down = ['DOWN', 'DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR'].includes(direction);
    const tilted = ['UL', 'UR', 'DL', 'DR', 'AUL', 'AUR', 'ADL', 'ADR'].includes(direction);
    mirror = ['UL', 'DL', 'AUL', 'ADL'].includes(direction) ? -1 : 1;
    prefix = down ? tilted ? 'NotesAirDR' : 'NotesAirD' : tilted ? 'NotesAirUR' : 'NotesAirU';
    if (note.attributes.color === 'PNK' && !down) suffix = '_P';
    if (note.attributes.color === 'GRN' && down) suffix = '_G';
  } else {
    prefix = ({ TAP: 'NotesTap', EXTAP: 'NotesChara', HOLD: 'NotesHold', SLIDE: 'NotesSlide',
      FLICK: 'NotesFlick', DAMAGE: 'NotesMine', AIR_HOLD: 'NotesAirU', AIR_SLIDE: 'NotesAirU', AIR_CRUSH: endpoint ? 'NotesAirLadderTop' : 'NotesAirLadder' } as Partial<Record<Note['type'], string>>)[note.type];
    if (!endpoint && note.attributes.ex && ['TAP', 'HOLD', 'SLIDE'].includes(note.type)) prefix = 'NotesChara';
    if (endpoint && ['HOLD', 'SLIDE'].includes(note.type)) suffix = '_point';
    if (['AIR_HOLD', 'AIR_SLIDE'].includes(note.type) && note.attributes.color === 'PNK') suffix = '_P';
  }
  return prefix ? { key: `${prefix}_${size}${suffix}`, width: nativeWidth, mirror } : undefined;
}

/** Project source geometry in the native note-camera orientation, retaining the
 * separately documented, screenshot-calibrated ground-track anchor. One lane = 4 source units. */
export function projectNativeNotePoint(lane: number, distance: number, position: readonly number[], speed = 6): MeshPoint {
  const anchor = projectTrackPoint(lane, distance, speed);
  const depth = focal / (TRACK_REFERENCE.judgeWidth / 64 * anchor.scale);
  const x = (anchor.x - TRACK_REFERENCE.centerX) * depth / focal;
  const y = (540 - anchor.y) * depth / focal;
  const actualDepth = Math.max(1, depth - sine * position[1] - cosine * position[2]);
  return { x: TRACK_REFERENCE.centerX + focal * (x + position[0]) / actualDepth,
    y: 540 - focal * (y + cosine * position[1] - sine * position[2]) / actualDepth,
    scale: anchor.scale * depth / actualDepth };
}
