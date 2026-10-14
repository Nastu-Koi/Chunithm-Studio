import { upperBound } from './search';
/** Original object-space rig and UVC keys. Frame duration is deliberately not assumed. */
export interface StageBone {
  index: number;
  name: string;
  fullName: string;
  parent: number | null;
  child: number | null;
  sibling: number | null;
  blendIndex: number;
  scale: number[];
  rotation: number[];
  quaternion: number[];
  translation: number[];
  localMatrix: number[];
  worldMatrix: number[];
  inverseWorldMatrix: number[];
  bindMatrix: number[];
  sourceOffset: number;
}
export interface StageKey {
  frame: number;
  value: number;
  tangent: number;
  flags: number;
}
export type StageCurve = StageKey[];
export interface StageAnimationNode {
  name: string;
  flags: number;
  translation: number[];
  scale: number[];
  quaternion: number[];
  channels: { translation: StageCurve[]; scale: StageCurve[]; quaternion: StageCurve[] };
}
export interface StageAnimationClip {
  name: string;
  resourceName: string;
  frameCount: number;
  sourceOffset: number;
  quaternion: boolean;
  ignoreParentScale: boolean;
  nodes: StageAnimationNode[];
}
export interface StageAnimation {
  version: 1;
  sourcePath: string;
  rig: { bones: StageBone[]; vertexBones: number[] };
  clips: StageAnimationClip[];
  /** Source UVC interpolation is checked independently; scene time units remain separate. */
  interpolation: 'hermite-preview' | 'uvc-native';
  framesPerSecond: number | null;
  warnings: string[];
}
const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function transformStagePoint(matrix: readonly number[], position: readonly number[]): [number, number, number] {
  return [0, 1, 2].map(
    row =>
      matrix[row * 4] * position[0] +
      matrix[row * 4 + 1] * position[1] +
      matrix[row * 4 + 2] * position[2] +
      matrix[row * 4 + 3],
  ) as [number, number, number];
}
/** Row-major 3×4 affine matrices, operating on column vectors. */
export function multiplyStageMatrices(a: readonly number[], b: readonly number[]): number[] {
  const out = Array<number>(12);
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 4; column++) {
      out[row * 4 + column] =
        a[row * 4] * b[column] +
        a[row * 4 + 1] * b[4 + column] +
        a[row * 4 + 2] * b[8 + column] +
        (column === 3 ? a[row * 4 + 3] : 0);
    }
  return out;
}
export function stageTrsMatrix(
  translation: readonly number[],
  scale: readonly number[],
  quaternion: readonly number[],
): number[] {
  const length = Math.hypot(...quaternion) || 1,
    [x, y, z, w] = quaternion.map(value => value / length),
    [sx, sy, sz] = scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y - z * w) * sy,
    2 * (x * z + y * w) * sz,
    translation[0],
    2 * (x * y + z * w) * sx,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z - x * w) * sz,
    translation[1],
    2 * (x * z - y * w) * sx,
    2 * (y * z + x * w) * sy,
    (1 - 2 * (x * x + y * y)) * sz,
    translation[2],
  ];
}
/** UVC mode 2 holds; mode 1 reverses the outgoing tangent; mode 3 is the source's one-frame blend. */
export function sampleStageCurve(curve: readonly StageKey[], frame: number, fallback: number): number {
  if (!curve.length) return fallback;
  if (frame <= curve[0].frame) return curve[0].value;
  if (frame >= curve[curve.length - 1].frame) return curve[curve.length - 1].value;
  const lo = upperBound(curve, frame, key => key.frame) - 1;
  const a = curve[lo],
    b = curve[lo + 1],
    duration = b.frame - a.frame,
    t = (frame - a.frame) / duration,
    t2 = t * t,
    t3 = t2 * t;
  if (a.flags === 2) return a.value;
  if (a.flags === 3) {
    const remaining = b.frame - frame;
    return remaining * a.value + (1 - remaining) * b.value;
  }
  const tangent = a.flags === 1 ? -a.tangent : a.tangent;
  return (
    (2 * t3 - 3 * t2 + 1) * a.value +
    (t3 - 2 * t2 + t) * tangent * duration +
    (-2 * t3 + 3 * t2) * b.value +
    (t3 - t2) * b.tangent * duration
  );
}
/** Original AnimationBridge samples integer rotations, then takes the shortest spherical arc at subframes. */
export function sampleStageQuaternion(node: StageAnimationNode, frame: number, frameCount: number): number[] {
  frame = Math.max(0, Math.min(frameCount - 1, frame));
  const integer = Math.floor(frame),
    fraction = frame - integer;
  const sample = (at: number): number[] =>
    node.quaternion.map((value, i) => sampleStageCurve(node.channels.quaternion[i] ?? [], at, value));
  let result = sample(integer);
  if (fraction > 2 ** -23) {
    const next = sample(integer + 1),
      dot = result.reduce((sum, value, i) => sum + value * next[i], 0);
    const cosine = Math.min(1, Math.abs(dot)),
      sign = dot < 0 ? -1 : 1;
    let first = 1 - fraction,
      second = fraction;
    if (1 - cosine >= 2 ** -23) {
      const angle = Math.acos(cosine),
        sine = Math.sin(angle);
      first = Math.sin((1 - fraction) * angle) / sine;
      second = Math.sin(fraction * angle) / sine;
    }
    result = result.map((value, i) => first * value * sign + second * next[i]);
  }
  return result[3] < 0 ? result.map(value => -value) : result;
}
/** Returns world×inverse-bind matrices indexed by the source blend index. Does not invent clip loops. */
export function sampleStageSkinMatrices(animation: StageAnimation, clipIndex: number, frame: number): number[][] {
  const clip = animation.clips[clipIndex],
    bones = animation.rig.bones;
  if (!clip || !Number.isFinite(frame)) return [];
  if (clip.ignoreParentScale) throw new Error('不支持忽略父缩放的舞台动画');
  frame = Math.max(0, Math.min(clip.frameCount - 1, frame));
  const byName = new Map(clip.nodes.map(node => [node.name, node])),
    worlds: number[][] = [],
    result: number[][] = [],
    active = new Set<number>();
  const world = (index: number): number[] => {
    if (worlds[index]) return worlds[index];
    if (active.has(index)) throw new Error('舞台骨骼父节点循环');
    const bone = bones[index];
    if (!bone) throw new Error('舞台骨骼引用无效');
    active.add(index);
    const node = byName.get(bone.name);
    let local = bone.localMatrix;
    if (node?.flags) {
      const sample = (curves: StageCurve[], values: number[]) =>
        values.map((value, i) => sampleStageCurve(curves[i] ?? [], frame, value));
      local = stageTrsMatrix(
        node.flags & 1 ? sample(node.channels.translation, node.translation) : bone.translation,
        node.flags & 4 ? sample(node.channels.scale, node.scale) : bone.scale,
        node.flags & 2 ? sampleStageQuaternion(node, frame, clip.frameCount) : bone.quaternion,
      );
    }
    worlds[index] = multiplyStageMatrices(bone.parent === null ? identity() : world(bone.parent), local);
    active.delete(index);
    return worlds[index];
  };
  for (const bone of bones)
    if (bone.blendIndex >= 0) result[bone.blendIndex] = multiplyStageMatrices(world(bone.index), bone.bindMatrix);
  return result;
}
