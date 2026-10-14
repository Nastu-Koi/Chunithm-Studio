/** AFNC 2012060601 data and the statically verified command subset.
 * Time is in AFNC units, never implicitly seconds. See docs/game-camera-decoding.md.
 */
export type StageVector = [number, number, number];
/** Column-major affine matrix; transforms column vectors. */
export type StageMatrix = number[];
export interface StageCameraParameters {
  verticalFovDegrees: number;
  near: number;
  far: number;
  /** Negative preserves the engine's default/inherited aspect; preview supplies its viewport ratio. */
  aspect: number;
}
export interface StageCameraSample extends StageCameraParameters {
  node: number;
  eye: StageVector;
  target: StageVector;
  up: StageVector;
}
export interface StageRawRecord {
  offset: number;
  words: number[];
}
export interface StageMatrixRecord extends StageRawRecord {
  mode: number;
  property: number;
  translationMode: number;
  randomMode: number;
  timeSource: number;
  start: number;
  end: number;
  persist: number;
  period: number;
  phase: number;
  value: StageVector;
  secondValue: StageVector;
}
export interface StageGoalRecord extends StageRawRecord {
  value: StageVector;
  start: number;
  property: number;
  mode: number;
  duration: number;
  durationUpper: number;
  easing: number;
  randomize: number;
}
export interface StageMotionRecord extends StageRawRecord {
  clip: number;
  secondary: number;
  speed: number;
  start: number;
  end: number;
  loops: number;
}
export interface StageCommand {
  offset: number;
  kind: number;
  nativeClass?: string;
  descriptorOffset: number;
  words: number[];
  descriptorWords: number[];
  selector?: number;
  matrix?: StageMatrixRecord[];
  goals?: StageGoalRecord[];
  goalSpace?: number;
  goalTarget?: number;
  motions?: StageMotionRecord[];
  motionMode?: number;
  motionRepeats?: number;
  trigger?: { maxCount: number; mode: number; time: number; actions: StageRawRecord[] };
}
export interface StageNode {
  offset: number;
  ordinal: number;
  type: number;
  id: number;
  flags: number;
  parent: number | null;
  defaultState: number;
  sourceName: string;
  settingsWords: number[];
  resources: { kind: number; entries: [number, number][] }[];
  states: { id: number; commands: StageCommand[] }[];
  commonCommands: StageCommand[];
  postCommands?: StageCommand[];
  camera?: StageCameraParameters;
}
export interface StageProgram {
  format: 'AFNC';
  version: 2012060601;
  sourceName: string;
  nodes: StageNode[];
  relocationCount: number;
  diagnostics: string[];
}
export const STAGE_COMMAND_NAMES: Readonly<Record<number, string>> = {
  100: 'MomMatrix',
  102: 'MomTranslateGoal',
  103: 'MomTranslateInput',
  104: 'MomMouseDrag',
  105: 'MomMatrixErase',
  106: 'MomMatrixGoal',
  107: 'MomMatrixSpeed',
  108: 'MomScaleProportional',
  110: 'MomChangeRotate',
  120: 'MomTurnCamera',
  121: 'MomTurnDirection',
  150: 'MomMoveBound',
  151: 'MomMovePendulum',
  200: 'MomPlaceLinear',
  201: 'MomPlaceFanShaped',
  251: 'MomDimensionConvert',
  300: 'MomMaterial',
  302: 'MomMaterialInterlocked',
  401: 'MomTexturePatternAnimation',
  402: 'MomUvSet',
  403: 'MomUvScroll',
  600: 'MomMotionSet',
  700: 'MomEssenceSet',
  750: 'MomTimeRate',
  751: 'MomChangeState',
  900: 'MomSendParam',
  901: 'MomRandomSeed',
};

function requireFinite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new Error(`Invalid AFNC ${name}`);
  return value;
}

const f32 = Math.fround;
const ANGLE_SCALE = f32(65536 / 360);
/** Native 16-bit-angle sine/cosine polynomial (0x126aae0), including float32 stages. */
export function stageSinCos(angle: number): [number, number] {
  const a = angle & 0xffff;
  const quadrant = Math.floor((a + 8192) / 16384);
  const x = f32((a - quadrant * 16384) * f32((Math.PI * 2) / 65536));
  const square = f32(x * x);
  const sin = f32(f32(1 - f32(f32(f32(1 / 6) - f32(square * f32(1 / 120))) * square)) * x);
  const cos = f32(1 + f32(f32(f32(f32(f32(1 / 24) - f32(square * f32(1 / 720))) * square) - 0.5) * square));
  switch (quadrant & 3) {
    case 1:
      return [cos, -sin];
    case 2:
      return [-sin, -cos];
    case 3:
      return [-cos, sin];
    default:
      return [sin, cos];
  }
}

export function identityStageMatrix(): StageMatrix {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** MomMatrix's local translation / Z,Y,X rotation / scale, in original record order.
 * The inherited parent matrix is the initial value. No viewport fitting is involved.
 */
export function applyStageTransform(
  matrix: readonly number[],
  property: number,
  value: StageVector,
  translationMode = 0,
): StageMatrix {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite) || !value.every(Number.isFinite))
    throw new Error('Invalid AFNC transform');
  if (![0, 1, 2].includes(property) || translationMode !== 0) throw new Error('Unsupported AFNC transform mode');
  value = value.map(f32) as StageVector;
  const out = [...matrix];
  if (property === 0) {
    for (let r = 0; r < 3; r++)
      out[12 + r] = f32(
        f32(f32(f32(matrix[r] * value[0]) + f32(matrix[4 + r] * value[1])) + f32(matrix[8 + r] * value[2])) +
          matrix[12 + r],
      );
  } else if (property === 2) {
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = f32(out[c * 4 + r] * value[c]);
  } else {
    // Native helpers mutate column pairs, preserving translation.
    for (const axis of [2, 1, 0]) {
      const angle = Math.trunc(f32(f32(f32(value[axis]) % 360) * ANGLE_SCALE));
      if (!angle) continue;
      const [s, c] = stageSinCos(angle);
      const first = axis === 0 ? 4 : 0,
        second = axis === 2 ? 4 : 8;
      const sign = axis === 1 ? -1 : 1;
      for (let r = 0; r < 3; r++) {
        const a = out[first + r],
          b = out[second + r];
        out[first + r] = f32(f32(a * c) + f32(b * s * sign));
        out[second + r] = f32(f32(b * c) - f32(a * s * sign));
      }
    }
  }
  return out;
}

/** The fixed-value and fixed sine modes used by yellowring's ancestor matrices. */
export function sampleStageMatrixRecord(record: StageMatrixRecord, time: number): StageVector | null {
  requireFinite(time, 'time');
  if (![0, 3].includes(record.mode) || record.timeSource !== 0 || record.randomMode !== 0)
    throw new Error(`Unsupported MomMatrix mode at 0x${record.offset.toString(16)}`);
  if (time < record.start || (record.end >= 0 && time > record.end && !record.persist)) return null;
  if (record.mode === 0) return [...record.value];
  if (!(record.period > 0)) throw new Error('Invalid MomMatrix sine period');
  // 0x149e937: float angular velocity and time, then quantized engine sine.
  let degrees = f32(f32(f32(360 / record.period) * f32(time)) + record.phase);
  if (degrees > 360) degrees = f32(degrees - f32(Math.trunc(degrees / 360) * 360));
  const wave = stageSinCos(Math.trunc(f32(degrees * ANGLE_SCALE)))[0];
  return record.value.map((v, i) =>
    f32(f32(f32(v + record.secondValue[i]) * 0.5) + f32(f32(f32(v - record.secondValue[i]) * 0.5) * wave)),
  ) as StageVector;
}

export interface StageModelSample {
  node: number;
  cycle: number;
  localTime: number;
  clipResource: number;
  clipFrame: number;
  translation: StageVector;
  /** Includes the AFNC ancestor matrices and the model's local goal translation. */
  worldMatrix: StageMatrix;
  camera?: StageCameraSample;
  /** In file/ancestor order, retained for diagnostics. */
  ancestors: { node: number; property: number; translationMode: number; value: StageVector }[];
  diagnostics: string[];
}

/** Replay-local PRNG: same two-word recurrence as 0x126a570, with explicit caller seed.
 * Other native scene random consumers are not emulated: identical game RNG sequence is not claimed.
 */
export function nextStageRandom(
  state: readonly [number, number],
  count: number,
): {
  state: [number, number];
  index: number;
} {
  if (!Number.isSafeInteger(count) || count < 1 || count > 0x7fffffff)
    throw new Error('Invalid AFNC random choice count');
  const low = (state[0] ^ (0xac897965 << (state[0] & 3))) >>> 0;
  const high = state[1] >>> 0;
  const bits = (BigInt(high) << 32n) | BigInt(low);
  const mask = (1n << 64n) - 1n;
  const mixed = bits ^ (((bits ^ (bits << 1n)) << 2n) & mask) ^ ((bits ^ (bits >> 1n)) >> 2n);
  const nextLow = Number(mixed & 0xffffffffn) >>> 0;
  const nextHigh = Number((mixed >> 32n) & 0xffffffffn) >>> 0;
  return { state: [nextLow, nextHigh], index: (nextLow & 0x7fffffff) % count };
}

/** Compile only the verified single-motion / single linear translation / timed self-reset subset.
 * Unsupported geometry/state behavior fails explicitly; material/UV omissions are reported.
 */
export function createStageModelSampler(
  program: StageProgram,
  nodeOrdinal: number,
  seed: readonly [number, number] = [0x12345678, 0x9abcdef0],
) {
  const node = program.nodes.find(n => n.ordinal === nodeOrdinal);
  if (!node) throw new Error(`AFNC node ${nodeOrdinal} does not exist`);
  const state = node.states.find(s => s.id === node.defaultState) ?? node.states[0];
  if (!state) throw new Error('AFNC node has no state');
  const motionCommand = state.commands.find(c => c.kind === 600);
  const goalCommand = state.commands.find(c => c.kind === 106);
  const reset = state.commands.find(c => c.kind === 751)?.trigger;
  const motion = motionCommand?.motions?.[0];
  const goal = goalCommand?.goals?.[0];
  const choices = node.resources.find(r => r.kind === 400)?.entries.map(r => r[0]) ?? [];
  if (
    !motion ||
    motionCommand?.motions?.length !== 1 ||
    !choices.length ||
    motion.loops !== 0 ||
    motionCommand.motionMode !== 0 ||
    motionCommand.motionRepeats !== 0 ||
    motion.secondary !== -1 ||
    motion.start !== 0 ||
    motion.end !== -1 ||
    motion.speed < 0
  )
    throw new Error('Unsupported AFNC motion orchestration');
  if (
    !goal ||
    goalCommand?.goals?.length !== 1 ||
    goal.property !== 0 ||
    goal.mode !== 0 ||
    goal.easing !== 0 ||
    goal.randomize !== 0 ||
    goal.durationUpper >= 0 ||
    goalCommand.goalSpace !== 0 ||
    goalCommand.goalTarget !== -1 ||
    goal.start !== -1 ||
    !(goal.duration > 0)
  )
    throw new Error('Unsupported AFNC matrix goal');
  const action = reset?.actions[0]?.words;
  if (
    !reset ||
    reset.mode !== 0 ||
    reset.maxCount !== 1 ||
    !(reset.time > 0) ||
    reset.actions.length !== 1 ||
    !action ||
    action[0] !== 2 ||
    action[1] !== 3 ||
    action[4] !== state.id ||
    action[5] !== 0 ||
    action.slice(2, 4).some(v => v !== 0) ||
    action[6] !== 0
  )
    throw new Error('Unsupported AFNC state transition');
  const commands = [...node.commonCommands, ...state.commands, ...(node.postCommands ?? [])];
  const supported = new Set([600, 106, 751, 300, 403]);
  if (commands.some(c => !supported.has(c.kind))) throw new Error('Unsupported AFNC model command');
  const ancestorNodes: StageNode[] = [];
  let parentOffset = node.parent;
  const seen = new Set<number>();
  while (parentOffset !== null) {
    if (seen.has(parentOffset)) throw new Error('AFNC ancestor cycle');
    seen.add(parentOffset);
    const parent = program.nodes.find(n => n.offset === parentOffset);
    if (!parent) throw new Error('Missing AFNC parent');
    ancestorNodes.unshift(parent);
    parentOffset = parent.parent;
  }
  const ancestorCommands = ancestorNodes.flatMap(n => {
    const s = n.states.find(s => s.id === n.defaultState) ?? n.states[0];
    return [...n.commonCommands, ...(s?.commands ?? []), ...(n.postCommands ?? [])].map(c => ({
      node: n.ordinal,
      command: c,
    }));
  });
  for (const { command } of ancestorCommands) {
    if (command.kind !== 100 || command.selector !== 0 || !command.matrix)
      throw new Error('Unsupported AFNC ancestor command');
    for (const r of command.matrix) {
      sampleStageMatrixRecord(r, 0);
      applyStageTransform(identityStageMatrix(), r.property, r.value, r.translationMode);
    }
  }
  const diagnostics = [
    'AFNC 时间单位与真实秒率尚未关联；调用方必须显式提供内部时间。',
    '随机选片使用独立可重放种子；未复现整个游戏的随机调用顺序。',
    '世界矩阵执行 AFNC 默认父级继承；游戏外部附加矩阵、骨骼挂接及其他舞台节点尚未模拟。',
    '重建边界按连续内部时间采样；原引擎更新步长与命令执行相位未完整复现。',
  ];
  if (commands.some(c => c.kind === 300 || c.kind === 403))
    diagnostics.push('MomMaterial / MomUvScroll 已保留，当前采样未执行材质与 UV 动画。');
  const cameraNodes = program.nodes.filter(n => n.camera);
  const camera = cameraNodes.length === 1 ? getStageCamera(program, cameraNodes[0].ordinal) : undefined;
  if (cameraNodes.length > 1) throw new Error('Ambiguous AFNC stage camera');
  let randomState: [number, number] = [seed[0] >>> 0, seed[1] >>> 0];
  const clips: number[] = [];
  const period = reset.time;
  return (time: number): StageModelSample => {
    requireFinite(time, 'time');
    if (time < 0) throw new Error('AFNC time must be nonnegative');
    const cycle = Math.floor(time / period);
    if (cycle > 1_000_000) throw new Error('AFNC replay exceeds supported duration');
    while (clips.length <= cycle) {
      if (motion.clip >= 0) {
        if (motion.clip >= choices.length) throw new Error('AFNC clip outside resource table');
        clips.push(motion.clip);
      } else if (motion.clip === -1) {
        const next = nextStageRandom(randomState, choices.length);
        randomState = next.state;
        clips.push(next.index);
      } else throw new Error('Unsupported AFNC clip selector');
    }
    const localTime = time - cycle * period;
    const ancestors = ancestorCommands.flatMap(({ node, command }) =>
      command.matrix!.flatMap(r => {
        const value = sampleStageMatrixRecord(r, time);
        return value ? [{ node, property: r.property, translationMode: r.translationMode, value }] : [];
      }),
    );
    const translation = goal.value.map(v => f32(v * f32(Math.min(1, localTime / goal.duration)))) as StageVector;
    const parentMatrix = ancestors.reduce(
      (m, r) => applyStageTransform(m, r.property, r.value, r.translationMode),
      identityStageMatrix(),
    );
    const worldMatrix = applyStageTransform(parentMatrix, 0, translation);
    return {
      node: nodeOrdinal,
      cycle,
      localTime,
      clipResource: choices[clips[cycle]],
      clipFrame: localTime * motion.speed,
      translation,
      worldMatrix,
      camera: camera ? { ...camera, eye: [...camera.eye], target: [...camera.target], up: [...camera.up] } : undefined,
      ancestors,
      diagnostics: [...diagnostics],
    };
  };
}

/** Verified static SglBasicCamera2 selector-1 eye / selector-2 target subset.
 * Dynamic camera effects and external attachment matrices are rejected, not guessed.
 */
export function getStageCamera(program: StageProgram, nodeOrdinal: number, stateId?: number): StageCameraSample {
  const node = program.nodes.find(n => n.ordinal === nodeOrdinal);
  if (!node?.camera) throw new Error('AFNC node has no decoded camera');
  const state = node.states.find(s => s.id === (stateId ?? node.defaultState));
  if (!state) throw new Error('AFNC camera state does not exist');
  const commands = [...node.commonCommands, ...state.commands, ...(node.postCommands ?? [])];
  if (commands.length !== 2 || commands.some(c => c.kind !== 100 || ![1, 2].includes(c.selector!)))
    throw new Error('Unsupported AFNC camera commands');
  const vectors = [1, 2].map(selector => {
    const records = commands.find(c => c.selector === selector)?.matrix;
    if (
      records?.length !== 1 ||
      records[0].mode !== 0 ||
      records[0].property !== 0 ||
      records[0].translationMode !== 0 ||
      records[0].start !== 0 ||
      records[0].end !== -1
    )
      throw new Error('Unsupported AFNC camera transform');
    return sampleStageMatrixRecord(records[0], 0)!;
  });
  let parent = node.parent;
  const seen = new Set<number>();
  while (parent !== null) {
    if (seen.has(parent)) throw new Error('AFNC camera ancestor cycle');
    seen.add(parent);
    const n = program.nodes.find(n => n.offset === parent);
    if (!n || n.states.some(s => s.commands.length) || n.commonCommands.length || n.postCommands?.length)
      throw new Error('Unsupported AFNC camera ancestor transform');
    parent = n.parent;
  }
  const c = node.camera;
  if (!(c.verticalFovDegrees > 0 && c.verticalFovDegrees < 180 && c.near > 0 && c.far > c.near))
    throw new Error('Invalid AFNC camera frustum');
  return { ...c, node: nodeOrdinal, eye: vectors[0], target: vectors[1], up: [0, 1, 0] };
}
