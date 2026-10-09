import { transformStagePoint } from '../core/stage-animation';

export type Vector3 = readonly [number, number, number];
export interface StageCamera { eye: Vector3; target: Vector3; verticalFov: number; near: number; far: number }
export interface StageView {
  camera: StageCamera;
  toView(point: Vector3, world?: readonly number[]): [number, number, number];
  project(point: Vector3): { x: number; y: number };
}
/** AFNC matrices are column-major 4×4; the skinning renderer uses row-major 3×4. */
export function stageWorldToAffine(matrix: readonly number[]): number[] {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) throw new Error('舞台矩阵无效');
  return [0, 1, 2].flatMap(row => [0, 1, 2, 3].map(column => matrix[column * 4 + row]));
}
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3, b: Vector3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v: Vector3): [number, number, number] {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length < 1e-10) throw new Error('舞台相机方向无效');
  return [v[0] / length, v[1] / length, v[2] / length];
}
/** Perspective math only. Camera values must come from decoded scene data. */
export function createStageView(camera: StageCamera, width = 1920, height = 1080): StageView {
  if (!(camera.near > 0 && camera.far > camera.near && camera.verticalFov > 0 && camera.verticalFov < 180)
    || ![...camera.eye, ...camera.target, camera.far, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) throw new Error('舞台相机参数无效');
  const forward = normalize([camera.target[0] - camera.eye[0], camera.target[1] - camera.eye[1], camera.target[2] - camera.eye[2]]);
  const right = normalize(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const focal = height / (2 * Math.tan(camera.verticalFov * Math.PI / 360));
  return {
    camera,
    toView(point, world) {
      const p = world ? transformStagePoint(world, point) : point;
      const delta: Vector3 = [p[0] - camera.eye[0], p[1] - camera.eye[1], p[2] - camera.eye[2]];
      return [dot(delta, right), dot(delta, up), dot(delta, forward)];
    },
    project(point) { return { x: width / 2 + point[0] * focal / point[2], y: height / 2 - point[1] * focal / point[2] }; },
  };
}
/** Clip in view space before dividing by depth, including triangles crossing the camera plane. */
export function clipStageDepth(points: readonly Vector3[], near: number, far: number): Vector3[] {
  let result = [...points];
  for (const [bound, direction] of [[near, 1], [far, -1]]) {
    const input = result; result = [];
    if (!input.length) break;
    let previous = input.at(-1)!;
    for (const current of input) {
      const a = (previous[2] - bound) * direction >= 0, b = (current[2] - bound) * direction >= 0;
      if (a !== b) {
        const t = (bound - previous[2]) / (current[2] - previous[2]);
        result.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t, bound]);
      }
      if (b) result.push(current);
      previous = current;
    }
  }
  return result;
}
