import { createXmlMetadata, type XmlMetadata } from './xml-metadata';
/** A tick is 1 / resolution of four quarter beats (normally 384). Project times may be fractional; native C2S export requires integer ticks. */
export const LANES = 16;
export const DEFAULT_RESOLUTION = 384;
export const NOTE_TYPES = [
  'TAP',
  'EXTAP',
  'FLICK',
  'HOLD',
  'SLIDE',
  'AIR',
  'AIR_HOLD',
  'AIR_SLIDE',
  'AIR_CRUSH',
  'DAMAGE',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
/** 长条：有持续时间的音符。 */
export const LONG_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['HOLD', 'SLIDE', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH']);
/** AIR 系列：在空中判定的音符。 */
export const AIR_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['AIR', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH']);
/** 必须绑定父音符的 AIR 系列。 */
export const PARENTED_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['AIR', 'AIR_HOLD', 'AIR_SLIDE']);
/** 由首尾相接的多段组成的长条。 */
export const CHAIN_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['SLIDE', 'AIR_SLIDE', 'AIR_CRUSH']);
/** 节点分普通节点与控制节点的长条。 */
export const NODE_KIND_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['SLIDE', 'AIR_HOLD', 'AIR_SLIDE']);
/** 首尾各带 AIR 高度的长条。 */
export const HEIGHT_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['AIR_SLIDE', 'AIR_CRUSH']);
/** 有 EX 变体的音符。 */
export const EX_NOTE_TYPES: ReadonlySet<NoteType> = new Set(['TAP', 'HOLD', 'SLIDE']);
/** In native order: the index is the difficulty number in chart file names and Music.xml. */
export const DIFFICULTIES = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'ULTIMA', 'WORLD’S END'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export type Scalar = string | number | boolean;
/** Native note attributes. Every key is optional; absent means the native default. */
export interface NoteAttributes {
  /** Segment-end kind for SLIDE / AIR HOLD / AIR SLIDE: true = SLD/AHD/ASD, false = control SLC/AHX/ASC. */
  visible?: boolean;
  /** Native parent token of an AIR-family note or chained segment (TAP, HLD, SLD, ASD …). */
  parent?: string;
  /** Native colour token; DEF or absent is the default colour. */
  color?: string;
  /** AIR direction token: IR, UL, UR, DW, DL, DR. */
  direction?: string;
  /** EX variant of TAP / HOLD / SLIDE (CHR, HXD, SXD/SXC). */
  ex?: boolean;
  /** EX effect token written after SXD/SXC. */
  effect?: string;
  /** AIR-CRUSH judgement interval in ticks; 0 is a decorative segment. */
  interval?: number;
  /** Native scroll group kept from grouped charts. */
  speedGroup?: number;
}
export interface NativeRecord {
  /** Stable link to the original record, for preserving ordering and unknown columns. */
  recordId: string;
  tag: string;
  columns: string[];
  raw: string;
  /** Snapshot of the decoded fields. Only changed fields are rewritten. */
  original: Record<string, unknown>;
}
export interface Note {
  id: string;
  type: NoteType;
  tick: number;
  lane: number;
  width: number;
  duration?: number;
  endLane?: number;
  endWidth?: number;
  height?: number;
  endHeight?: number;
  attributes: NoteAttributes;
  native?: NativeRecord;
}
export type EventType = 'BPM' | 'METER' | 'SCROLL' | 'NOTE_SPEED' | 'GROUP_SCROLL' | 'SCROLL_ASSIGNMENT' | 'STOP';
export interface ChartEvent {
  id: string;
  type: EventType;
  tick: number;
  /** BPM for BPM, multiplier for SCROLL / NOTE_SPEED. */
  value: number;
  duration?: number;
  numerator?: number;
  denominator?: number;
  group?: number;
  lane?: number;
  width?: number;
  native?: NativeRecord;
}
export interface SourceRecord {
  id: string;
  kind: 'header' | 'note' | 'event' | 'unknown' | 'blank';
  tag: string;
  raw: string;
  ending: string;
  entityId?: string;
}
export interface Chart {
  /** Explicit authoring mode for offstage visual notes. Native offstage charts enable this on import. */
  allowOutOfLane?: boolean;
  version: string;
  resolution: number;
  defaultBpm: number;
  notes: Note[];
  events: ChartEvent[];
  headerRecords: SourceRecord[];
  unknownRecords: SourceRecord[];
  source?: {
    records: SourceRecord[];
    bom: boolean;
    newline: string;
    originalVersion: string;
    originalResolution: number;
    originalDefaultBpm: number;
  };
}
export interface Project {
  format: 'chunithm-studio';
  formatVersion: 1;
  id: string;
  metadata: {
    title: string;
    artist: string;
    designer: string;
    difficulty: Difficulty;
    level: string;
  };
  audio: {
    path: string;
    /** Positive offset delays the song relative to chart time. */
    offset: number;
    previewStart: number;
    previewEnd: number;
  };
  coverPath: string;
  /** Optional only for loading projects saved before XML metadata support. */
  xmlMetadata?: XmlMetadata;
  exportSettings: {
    optId: string;
    musicId: number;
    cueId: number;
    weTag: string;
    stars: number;
  };
  chart: Chart;
}
export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  entityId?: string;
  tick?: number;
}
export interface TimelineSegment {
  tick: number;
  seconds: number;
  bpm: number;
}
export interface MeasureLine {
  tick: number;
  measure: number;
  numerator: number;
  denominator: number;
}
let idSequence = 0;
export function makeId(prefix = 'item'): string {
  idSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`;
}
export function createChart(bpm = 120): Chart {
  return {
    version: '1.15.00',
    resolution: DEFAULT_RESOLUTION,
    defaultBpm: bpm,
    notes: [],
    events: [],
    headerRecords: [],
    unknownRecords: [],
  };
}
export function createProject(): Project {
  return {
    format: 'chunithm-studio',
    formatVersion: 1,
    id: makeId('project'),
    metadata: { title: '新建乐曲', artist: '', designer: '', difficulty: 'MASTER', level: '1' },
    audio: { path: '', offset: 0, previewStart: 0, previewEnd: 15 },
    coverPath: '',
    xmlMetadata: createXmlMetadata(),
    exportSettings: { optId: 'AZ01', musicId: 7000, cueId: 7000, weTag: '改', stars: 1 },
    chart: createChart(),
  };
}
export function createNote(type: NoteType, tick: number, lane = 0, width = 2): Note {
  const long = LONG_NOTE_TYPES.has(type);
  // Native height 1 is the ground plane; 5 is the normal 15.574-unit AIR plane.
  return {
    id: makeId('note'),
    type,
    tick,
    lane,
    width,
    ...(long ? { duration: 96, endLane: lane, endWidth: width } : {}),
    ...(HEIGHT_NOTE_TYPES.has(type) ? { height: 5, endHeight: 5 } : {}),
    attributes: {},
  };
}
