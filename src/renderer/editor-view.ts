import { LANES, type Chart } from '../core/model';

/** Width of one lane on the canvas; lanes only get narrower when the view holds more of them than the canvas has room for. */
const LANE_WIDTH = 15;

/** 横向分割: the editor draws a lane line every this many lanes. */
export const LANE_DIVISIONS = [1, 2, 4, 8, 16] as const;
export type LaneDivision = (typeof LANE_DIVISIONS)[number];
/** The line on the left boundary of `lane`: the track edges always, inner lines every `division` lanes, brighter every 4. */
export function laneLine(lane: number, division: number): 'edge' | 'major' | 'minor' | undefined {
  if (lane === 0 || lane === LANES) return 'edge';
  if (lane % division !== 0) return undefined;
  return lane % 4 === 0 ? 'major' : 'minor';
}

/** `lane` is the lane under the pointer; `laneAt` is the same place as a fractional lane coordinate. */
export type Position = { x: number; y: number; tick: number; lane: number; laneAt: number };

/** The editor canvas layout: fixed columns, the visible time span and lane range, and the conversions between them. */
export class EditorView {
  /** Left columns, from left to right: AIR heights, measure ruler, events, waveform, then the track. */
  readonly airLeft = 9;
  readonly airWidth = 98;
  readonly rulerLeft = 116;
  readonly rulerWidth = 68;
  readonly eventLeft = 186;
  readonly waveformLeft = 219;
  /** Width of the waveform in alignment mode, laid over the track. */
  readonly alignWidth = 120;
  readonly left = 250;
  /** Height of the lane-number strip under the track. */
  readonly bottom = 30;
  scroll = 0;
  viewStart = 0;
  viewEnd = LANES;
  canvasWidth = 1;
  canvasHeight = 1;

  constructor(public zoom: number) {}

  get trackViewportWidth(): number {
    return Math.max(1, this.canvasWidth - this.left - 18);
  }
  get trackWidth(): number {
    return Math.min(this.trackViewportWidth, LANE_WIDTH * (this.viewEnd - this.viewStart));
  }
  get trackRight(): number {
    return this.left + this.trackWidth;
  }
  get laneWidth(): number {
    return this.trackWidth / (this.viewEnd - this.viewStart);
  }
  /** Bottom edge of the time area, above the lane-number strip. */
  get trackBottom(): number {
    return this.canvasHeight - this.bottom;
  }
  x(lane: number): number {
    return this.left + (lane - this.viewStart) * this.laneWidth;
  }
  y(tick: number): number {
    return this.trackBottom - (tick - this.scroll) * this.zoom;
  }
  /** The unquantized tick at a canvas row. */
  tickAt(y: number): number {
    return this.scroll + (this.trackBottom - y) / this.zoom;
  }
  /** The fractional lane coordinate at a canvas column. */
  laneAt(x: number): number {
    return this.viewStart + (x - this.left) / this.laneWidth;
  }
  inTrack(x: number): boolean {
    return x >= this.left && x <= this.trackRight;
  }
  airHeightX(height: number, maximum: number): number {
    return this.airLeft + (height / maximum) * this.airWidth;
  }
  inAlignWaveform(point: Position): boolean {
    return (
      point.x >= this.waveformLeft && point.x <= this.waveformLeft + this.alignWidth && point.y <= this.trackBottom
    );
  }
}

/**
 * What the game camera makes of AIR height: 5 is the normal air plane, and from there up an AIR climbs toward the top
 * of the screen; at 15 it is above the frame along the whole track (player projection check, issue 036).
 */
export const AIR_VISIBLE_HEIGHT = 5;
export const AIR_HIDDEN_HEIGHT = 15;
/** How much of an AIR at this height the game still shows: 1 up to the normal plane, falling to 0 at the hidden height. */
export function airHeightVisibility(height: number): number {
  const fraction = (AIR_HIDDEN_HEIGHT - height) / (AIR_HIDDEN_HEIGHT - AIR_VISIBLE_HEIGHT);
  return Math.max(0, Math.min(1, fraction));
}
/**
 * Full scale of the AIR-height column: the normal air plane (5) alone, the hidden height (15) as soon as anything rises
 * above the plane so the visible-limit line is in view, and more when the chart goes higher still.
 */
export function airHeightMaximum(chart: Chart): number {
  const highest = Math.ceil(
    chart.notes.reduce((maximum, note) => Math.max(maximum, note.height ?? 0, note.endHeight ?? 0), 0),
  );
  if (highest <= AIR_VISIBLE_HEIGHT) return AIR_VISIBLE_HEIGHT;
  return Math.max(AIR_HIDDEN_HEIGHT, highest);
}
