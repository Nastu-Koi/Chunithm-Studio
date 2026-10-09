/** Pure geometry transcribed from the installed executable's 0xc275e0 mode 8
 * path. Camera projection, scroll conversion and visible-range clipping belong
 * to the caller; this module does not invent a new AIR ribbon shape. */
export interface NativeAirPoint {
  centerLane: number;
  width: number;
  /** Absolute source-space Y; C2S height h maps to (h - 1) * 3.8934998512268066. */
  y: number;
  /** Source-space Z after the caller's scroll mapping. */
  z: number;
}
export interface NativeAirSurface {
  part: 'joint' | 'ground' | 'line';
  texture: string;
  vertices: { position: [number, number, number]; uv: [number, number]; color: [number, number, number, number] }[];
  indices: number[];
}
export interface NativeAirSlideGeometryOptions {
  color?: string;
  /** The first point's center for the entire chain, not each piece. */
  rootCenterLane?: number;
  /** Native status 0 pending, 1 held, 2 failed, at strip-update parameter +0. */
  status?: 0 | 1 | 2;
  /** Native parameter +0x20; changes the line's half-width from 1.96 to 0.98. */
  narrowLine?: boolean;
  /** Exact source V bounds are 1 to 0 between ordinary nodes. Callers splitting
   * a piece for clipping/scroll changes must interpolate these same bounds. */
  vStart?: number;
  vEnd?: number;
  /** Only the chain head receives the initial vertical connection. */
  headRiser?: boolean;
  /** Original head-riser base; normally 0. Parent-height offsets are explicit. */
  baseY?: number;
  /** Source line-orientation enum: DEF, AxisY, AxisZ, Trace. */
  lineOrientation?: 0 | 1 | 2 | 3;
  /** The original first, unclipped Trace segment has a near-end cap. Artificial
   * clipping/scroll subdivisions and later segments must leave this false. */
  traceHeadCap?: boolean;
}

const NATIVE_HEIGHT = 15.574000358581543;
const U_SCALE = 1.2999999523162842;

/** Native 0x1203c50 accepts DEF/GRN/PNK; 0xc4c700 maps DEF to the sky variant. */
export function getNativeAirSlideTextures(color = 'DEF'): { joint: string; ground: string; line: string } {
  const suffix = color === 'GRN' ? '' : color === 'PNK' ? '_P' : '_S';
  return { joint: `AirHoldJoint${suffix}`, ground: 'Field', line: `AirHoldLine${suffix}` };
}

/** AIR HOLD intentionally has a different default from AIR SLIDE (0xc483d5). */
export function getNativeAirHoldSuffix(color = 'DEF'): '' | '_P' { return color === 'PNK' ? '_P' : ''; }

/** Material constant 0x11 overrides in 0xc47245 / 0xc47374 / 0xc472f3.
 * The strip status is normalized here from native AH states pending / 3 / 4. */
export function getNativeAirHoldMaterialColors(status: 0 | 1 | 2 = 0): {
  roof: [number, number, number, number]; lineTop: [number, number, number, number];
} {
  return { roof: status === 2 ? [.5, .5, .5, 3 / 255] : [1, 1, 1, (status === 1 ? 80 : 27) / 255],
    lineTop: [1, 1, 1, status === 2 ? 128 / 255 : 1] };
}

// Original parser table 0x1c26e00 and atlas rows at 0x190f198. These deliberately
// retain the stored floats, rather than assuming evenly spaced texel centers.
const CRUSH_COLORS = ['DEF', 'RED', 'ORN', 'YEL', 'LIM', 'GRN', 'AQA', 'CYN', 'DGR', 'BLU', 'PPL', 'VLT', 'PNK', 'GRY', 'BLK', 'NON'];
const CRUSH_V = [.15619999170303345, .9688000082969666, .9061999917030334, .8436999917030334,
  .7811999917030334, .7186999917030334, .6561999917030334, .5938000082969666,
  .5311999917030334, .46880000829696655, .40619999170303345, .34380000829696655,
  .28119999170303345, .09399998188018799, .03100001811981201, 0];

/** Unknown tokens use DEF, matching the installed parser; NON has no surface. */
export function getNativeAirCrushLineV(color = 'DEF'): number | undefined {
  if (color === 'NON') return undefined;
  return CRUSH_V[Math.max(0, CRUSH_COLORS.indexOf(color))];
}

/** Original Trace branch 0xc28c69..0xc29029: a diamond-section tube, not a
 * camera-facing ribbon. Radius 0.5 ignores the ordinary/narrow line width. */
function traceLine(start: NativeAirPoint, end: NativeAirPoint, vStart: number, vEnd: number,
  alpha: number, cap: boolean, texture: string): NativeAirSurface {
  const reverse = end.z > start.z, near = reverse ? end : start, far = reverse ? start : end;
  const ring = (p: NativeAirPoint, v: number): NativeAirSurface['vertices'] => {
    const x = (p.centerLane - 8) * 4, r = .5;
    return [
      { position: [x - r, p.y, p.z], uv: [.2969000041484833, v], color: [1, 1, 1, alpha] },
      { position: [x + r, p.y, p.z], uv: [.6875, v], color: [1, 1, 1, alpha] },
      { position: [x, p.y + r, p.z], uv: [.5, v], color: [1, 1, 1, alpha] },
      { position: [x, p.y - r, p.z], uv: [.5, v], color: [1, 1, 1, alpha] },
    ];
  };
  return { part: 'line', texture,
    vertices: [...ring(near, reverse ? vEnd : vStart), ...ring(far, reverse ? vStart : vEnd)],
    indices: [...(cap ? [0, 1, 2, 0, 3, 1] : []),
      0, 6, 4, 0, 2, 6, 2, 5, 6, 2, 1, 5, 0, 4, 3, 3, 4, 7, 3, 7, 1, 1, 7, 5],
  };
}

/** The first generated ladder entry uses Top; all subsequent entries use Ladder
 * (0xc37550 / 0xc3759a). This does not infer ground/arch placement. */
export function getNativeAirCrushMarker(width: number, first: boolean): string | undefined {
  if (!Number.isFinite(width) || width < 1 || width > 16 || !Number.isInteger(width)) return undefined;
  return `NotesAirLadder${first ? 'Top' : ''}_${String(width).padStart(2, '0')}`;
}

/** Produces the confirmed ordinary AIR SLIDE joint, ground and center-line
 * surfaces. Active clipping and color-time animation belong to the caller. */
export function getNativeAirSlideGeometry(start: NativeAirPoint, end: NativeAirPoint,
  options: NativeAirSlideGeometryOptions = {}): NativeAirSurface[] {
  const valid = (p: NativeAirPoint) => [p.centerLane, p.width, p.y, p.z].every(Number.isFinite) && p.width > 0;
  if (!valid(start) || !valid(end)) return [];
  const root = options.rootCenterLane ?? start.centerLane, base = options.baseY ?? 0;
  const vStart = options.vStart ?? 1, vEnd = options.vEnd ?? 0;
  if (![root, base, vStart, vEnd].every(Number.isFinite)) return [];
  const textures = getNativeAirSlideTextures(options.color), status = options.status ?? 0;
  const bodyAlpha = (status === 1 ? 80 : status === 2 ? 3 : 27) / 255;
  const lineAlpha = status === 2 ? 128 / 255 : 1;
  const halfLine = options.narrowLine ? .9800000190734863 : 1.9600000381469727;
  const surfaces: NativeAirSurface[] = [];
  const shadowScale = (y: number) => .65 + .1 * (1 - Math.max(0, Math.min(1, y / NATIVE_HEIGHT)));
  function append(a: NativeAirPoint, b: NativeAirPoint, v0: number, v1: number, ground: boolean): void {
    const x0 = (a.centerLane - 8) * 4, x1 = (b.centerLane - 8) * 4;
    // 0xc27b66: horizontal UV uses the full unshrunk lane width relative to root.
    const us = [a.centerLane - a.width / 2, a.centerLane + a.width / 2,
      b.centerLane - b.width / 2, b.centerLane + b.width / 2].map(edge => (edge - root) * U_SCALE + .5);
    const indices = b.z > a.z ? [0, 2, 3, 0, 3, 1] : [0, 3, 2, 0, 1, 3];
    const surface = (part: NativeAirSurface['part'], w0: number, w1: number, y0: number, y1: number,
      alpha: number, u: readonly number[]) => {
      const positions: [number, number, number][] = [[x0 - w0, y0, a.z], [x0 + w0, y0, a.z],
        [x1 - w1, y1, b.z], [x1 + w1, y1, b.z]];
      surfaces.push({ part, texture: textures[part], indices: [...indices], vertices: positions.map((position, i) => ({
        position, uv: [u[i], i < 2 ? v0 : v1], color: [1, 1, 1, alpha],
      })) });
    };
    surface('joint', a.width * 2 * .75, b.width * 2 * .75, a.y, b.y, bodyAlpha, us);
    if (ground) surface('ground', a.width * 2 * shadowScale(a.y), b.width * 2 * shadowScale(b.y),
      0, 0, 64 / 255, us);
    if (options.lineOrientation === 3) {
      surfaces.push(traceLine(a, b, v0, v1, lineAlpha, options.traceHeadCap ?? false, textures.line));
    } else surface('line', halfLine, halfLine, a.y, b.y, lineAlpha, [0, 1, 0, 1]);
    if (options.lineOrientation === 1 || options.lineOrientation === 2) {
      // 0xc29126 / 0xc291c5: the same strip is expanded along Z or Y instead of X.
      const line = surfaces[surfaces.length - 1];
      line.vertices.forEach((vertex, i) => {
        const point = i < 2 ? a : b, sign = i % 2 ? 1 : -1;
        vertex.position = [(point.centerLane - 8) * 4, point.y, point.z];
        vertex.position[options.lineOrientation === 1 ? 1 : 2] += sign * halfLine * (options.lineOrientation === 2 ? 3 : 1);
      });
    }
  }
  if (options.headRiser && Math.abs(start.y - base) > 1e-9) append({ ...start, y: base }, start, 1, 0, false);
  append(start, end, vStart, vEnd, true);
  return surfaces;
}

/** CRUSH mode 9 uses the same native strip builder, but its resource table is
 * [-1, -1, AirLadderLine] (0xb3c846 / 0x1c1cfd0): no joint or ground sheet.
 * NON explicitly disables all three resource slots at 0xb3c887. */
export function getNativeAirCrushGeometry(start: NativeAirPoint, end: NativeAirPoint,
  options: Omit<NativeAirSlideGeometryOptions, 'headRiser'> = {}): NativeAirSurface[] {
  const v = getNativeAirCrushLineV(options.color);
  if (v === undefined) return [];
  // 0xb3cb82 / 0xb3cb87 assign the same color-atlas row to both endpoints.
  return getNativeAirSlideGeometry(start, end, { ...options, headRiser: false, vStart: v, vEnd: v })
    .filter(surface => surface.part === 'line')
    .map(surface => ({ ...surface, texture: 'AirLadderLine' }));
}
