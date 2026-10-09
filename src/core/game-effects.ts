import { applyStageTransform, identityStageMatrix, sampleStageMatrixRecord,
  type StageProgram, type StageVector, type StageMatrix, type StageNode } from './stage-program';

/** All numbers below remain in the original AFNC time/space units. */
export type EffectColor = [number, number, number, number];
export interface EffectRawRecord { offset: number; words: number[] }
export interface NativeParticleSettings {
  node: number;
  offset: number;
  words: number[];
  /** SglBasicParticle -> ParticleInitParam, verified in the local executable. */
  initialization: {
    shape: number;
    extent: StageVector;
    maxParticles: number;
    emissionInterval: number;
    emissionCount: [number, number];
    emissionMode: number;
    emissionLimit: number;
    life: number;
    sizeX: [number, number];
    sizeY: [number, number];
    angleRanges: [number, number, number, number];
    textureColumns: number;
    textureRows: number;
    textureFirstFrame: number;
    textureFrameCount: number;
    textureFrameDuration: number;
    textureLoop: boolean;
  };
  colorKeys: (EffectRawRecord & { mode: number; time: number; first: EffectColor; second: EffectColor })[];
  scaleKeys: (EffectRawRecord & { time: number; value: StageVector })[];
  vectorKeys: (EffectRawRecord & { mode: number; time: [number, number]; first: StageVector; second: StageVector })[];
  extraVectorKeys: (EffectRawRecord & { time: number; first: StageVector; second: StageVector })[];
  scalarKeys: (EffectRawRecord & { time: number; value: number })[];
  /** The sixth curve has not been assigned a meaning or executable stride. */
  undecodedCurve: { count: number; offset: number | null };
  textureResources: number[];
  /** The verified local-space shader subset; orchestration coverage is reported separately. */
  executable: boolean;
}
export interface NativeEffectProperty {
  node: number; kind: number; offset: number; words: number[];
  /** Exact resource IDs from material property 300; resource IDs index resources. */
  textureResources?: number[];
  settings?: EffectRawRecord;
}
export interface NativeTexturePattern extends EffectRawRecord {
  node: number; command: number; resourceFirst: number; resourceLast: number; randomResource: number;
  sheetFirst: number; sheetLast: number; layout: number; columns: number; rows: number;
  frameDuration: number; first: number; last: number; direction: number; initial: number; loop: boolean;
}
export interface NativeEffectPrimitive extends EffectRawRecord {
  node: number; width: number; height: number; count: number; textureResources: number[];
  fixedRectangle: boolean;
}
export interface NativeEffectCurve extends EffectRawRecord {
  node: number; command: number; property: number; interpolation: number; wrap: number;
  keys: (EffectRawRecord & { time: number; value: number; incoming: [number, number]; outgoing: [number, number] })[];
}
export interface NativeEffectColorAnimation extends EffectRawRecord {
  node: number; command: number;
  keys: (EffectRawRecord & { color: number; duration: number; durationUpper: number; mode: number; easing: number })[];
}
export interface NativeEffectProgram {
  sourceName: string;
  program: StageProgram;
  resources: { index: number; name: string; offset: number; size: number }[];
  particles: NativeParticleSettings[];
  primitives: NativeEffectPrimitive[];
  texturePatterns: NativeTexturePattern[];
  properties: NativeEffectProperty[];
  /** AFNC node header +0x0c, passed to the original shader BlendMode setter. */
  nodeRenderModes?: { node: number; mode: number }[];
  lifecycles?: (EffectRawRecord & { node: number; kind: number; duration: number; durationUpper: number })[];
  curves?: NativeEffectCurve[];
  colorAnimations?: NativeEffectColorAnimation[];
  /** Command records decoded beyond the common stage reader. */
  extraCommands: { node: number; kind: number; offset: number; descriptor: EffectRawRecord }[];
  coverage: { decodedNodeTypes: number[]; retainedNodeTypes: number[]; executableCommands: number[]; retainedCommands: number[] };
  diagnostics: string[];
}

export interface EffectTableLike {
  acroarts: { id: number; name: string; filename: string; values: number[] }[];
  notes: { id: number; name: string; values: number[] }[];
}
export interface NativeEffectSelection {
  kind: string; width: number; widthSlot: number | null;
  selectedWidth: number;
  /** Native AIR/AIR DOWN/AIR HOLD IN correction; other families keep scale 1. */
  scaleX: number;
  bomb: { id: number; sourceName: string } | null;
  reaction: { id: number; sourceName: string } | null;
  text: { id: number; sourceName: string } | null;
  keep: { id: number; sourceName: string } | null;
  diagnostics: string[];
}

/** Native bomb helper 0xb33c10 chooses the smallest available width >= actual width. */
export function selectNativeEffects(tables: EffectTableLike, kind: string, width: number): NativeEffectSelection {
  if (!Number.isInteger(width) || width < 1 || width > 16) throw new Error('Invalid effect lane width');
  const row = tables.notes.find(r => r.name === kind);
  if (!row || row.values.length !== 14) throw new Error(`Unknown native note effect ${kind}`);
  const diagnostics: string[] = [];
  const known: Record<number, number> = { 1: 10, 2: 9, 3: 8, 4: 7, 6: 5, 8: 4, 16: 0 };
  const selectedWidth = [1, 2, 3, 4, 6, 8, 16].find(w => width <= w)!;
  const widthSlot = known[selectedWidth];
  function reference(id: number) {
    if (!id) return null;
    const resource = tables.acroarts.find(r => r.id === id);
    if (!resource?.filename || /[\\/]/.test(resource.filename)) throw new Error(`Invalid native effect reference ${id}`);
    return { id, sourceName: resource.filename.replace(/\.afb$/i, '') };
  }
  const bomb = reference(row.values[widthSlot]);
  return { kind, width, widthSlot, selectedWidth, scaleX: ['Air', 'AirDown', 'AirHoldIn'].includes(kind) ? width / selectedWidth : 1,
    bomb, reaction: reference(row.values[11]), text: reference(row.values[12]),
    keep: reference(row.values[13]), diagnostics };
}

/** RGBA packing used by native function 0x63d510, low byte first. */
export function unpackEffectColor(word: number): EffectColor {
  return [word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24].map(x => x / 255) as EffectColor;
}

/** Exact deterministic grid subset of MomTexturePatternAnimation (0x14b39f0/0x14b3c00).
 * Time means the number of native unit updates, including its reset-without-remainder behavior.
 * No caller FPS, effect lifetime, or resource dimensions are inferred here.
 */
export function sampleNativeTexturePattern(pattern: NativeTexturePattern, time: number) {
  if (!Number.isFinite(time) || time < 0 || time > 1e9) throw new Error('Invalid native effect time');
  if (![0, 1].includes(pattern.layout) || ![0, 1].includes(pattern.direction) || pattern.randomResource !== 0
    || pattern.resourceFirst !== pattern.resourceLast || pattern.sheetFirst !== pattern.sheetLast
    || !Number.isInteger(pattern.columns) || pattern.columns < 1 || !Number.isInteger(pattern.rows) || pattern.rows < 1
    || ![pattern.first, pattern.last, pattern.initial].every(Number.isSafeInteger)
    || pattern.first < 0 || pattern.last < pattern.first || pattern.last >= pattern.columns * pattern.rows
    || pattern.initial < pattern.first || pattern.initial > pattern.last || !Number.isFinite(pattern.frameDuration))
    throw new Error('Unsupported native texture pattern');
  const steps = pattern.frameDuration < 0 ? 0 : Math.floor(time / Math.max(1, Math.ceil(pattern.frameDuration)));
  const sign = pattern.direction === 1 ? -1 : 1;
  const range = pattern.last - pattern.first + 1;
  let frame = pattern.initial + steps * sign;
  if (pattern.loop) frame = pattern.first + ((frame - pattern.first) % range + range) % range;
  else frame = Math.max(pattern.first, Math.min(pattern.last, frame));
  const x = pattern.layout === 0 ? frame % pattern.columns : Math.floor(frame / pattern.rows);
  const y = pattern.layout === 0 ? Math.floor(frame / pattern.columns) : frame % pattern.rows;
  const du = Math.fround(1 / pattern.columns), dv = Math.fround(1 / pattern.rows);
  const u = Math.fround(x * du), v = Math.fround(y * dv);
  return { frame, resource: pattern.resourceFirst,
    uv: [u, v, Math.fround(u + du), Math.fround(v + dv)] as [number, number, number, number] };
}

export interface NativeEffectPlaneSample {
  node: number; resource: number; frame: number;
  positions: [StageVector, StageVector, StageVector, StageVector];
  uv: [number, number, number, number];
}

/** MomUvSet mode 0 writes these four atlas coordinates directly (0x14b73e1).
 * Its width/height-relative flags are applied before the material's UV rectangle is stored.
 */
export function sampleNativeUvSet(words: readonly number[]): [number, number, number, number] {
  if (words.length < 10 || words[0] !== -1 || words[1] !== 0 || (words[9] & ~3) !== 0)
    throw new Error('Unsupported MomUvSet mode');
  const uv = words.slice(2, 6).map(asFloat) as [number, number, number, number];
  if (!uv.every(Number.isFinite)) throw new Error('Invalid MomUvSet coordinates');
  if (words[9] & 1) uv[2] = Math.fround(uv[2] + uv[0]);
  if (words[9] & 2) uv[3] = Math.fround(uv[3] + uv[1]);
  return uv;
}

/** MomCurve's AD3 time/value Hermite spline. Native setters normalize tangent X by
 * key duration, and the getter multiplies it back before inverting the time cubic.
 * Bisection is bounded; ambiguous non-monotone time curves are not guessed.
 */
export function sampleNativeEffectCurve(curve: NativeEffectCurve, time: number): number {
  if (!Number.isFinite(time) || curve.interpolation !== 3 || curve.wrap !== 0 || !curve.keys.length)
    throw new Error('Unsupported native effect curve');
  const keys = curve.keys;
  if (time <= keys[0].time) return keys[0].value;
  if (time >= keys.at(-1)!.time) return keys.at(-1)!.value;
  const index = keys.findIndex(k => k.time >= time), a = keys[index - 1], b = keys[index];
  const duration = b.time - a.time, dx0 = a.outgoing[0], dx1 = b.incoming[0];
  if (!(duration > 0) || dx0 < 0 || dx1 < 0) throw new Error('Unsupported native curve time direction');
  const c2 = 3 * duration - 2 * dx0 - dx1, c3 = -2 * duration + dx0 + dx1;
  const stationary = c3 ? -c2 / (3 * c3) : -1;
  if (stationary > 0 && stationary < 1 && dx0 + 2 * c2 * stationary + 3 * c3 * stationary ** 2 < 0)
    throw new Error('Ambiguous native curve time');
  let lo = 0, hi = 1;
  for (let n = 0; n < 28; n++) {
    const t = (lo + hi) / 2;
    if (a.time + t * (dx0 + t * (c2 + t * c3)) < time) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2, delta = b.value - a.value, dy0 = a.outgoing[1], dy1 = b.incoming[1];
  return Math.fround(a.value + t * (dy0 + t * (3 * delta - 2 * dy0 - dy1 + t * (-2 * delta + dy0 + dy1))));
}
function applyNativeEffectCurves(effect: NativeEffectProgram, command: number, matrix: StageMatrix, time: number) {
  const curves = effect.curves?.filter(c => c.command === command);
  if (!curves?.length) throw new Error('Missing native effect curve');
  const values: StageVector[] = [[0, 0, 0], [0, 0, 0], [1, 1, 1]], used = new Set<number>();
  for (const curve of curves) {
    if (!Number.isInteger(curve.property) || curve.property < 0 || curve.property > 8)
      throw new Error('Unsupported MomCurve property');
    const group = Math.floor(curve.property / 3); used.add(group);
    values[group][curve.property % 3] = sampleNativeEffectCurve(curve, time);
  }
  for (const group of [0, 1, 2]) if (used.has(group)) matrix = applyStageTransform(matrix, group, values[group]);
  return matrix;
}

function supportsNativeAlpha(animation: NativeEffectColorAnimation) {
  const w = animation.words;
  return w[0] === 0 && w[1] === 0 && asFloat(w[2]) < 0 && w[5] === 0 && w[6] === 0 && w[7] === 0
    && w[10] === 8 && animation.keys.length > 0
    && animation.keys.every(k => k.mode === 0 && k.words[2] === 0 && k.easing === 1 && k.duration >= 0 && k.durationUpper < 0);
}
/** Original fixed, linear, alpha-only MomMaterial sequence. Packed byte interpolation
 * truncates like 0x148ba30 / 0x44cab4 instead of silently retaining floating alpha.
 */
export function sampleNativeEffectAlpha(animation: NativeEffectColorAnimation, time: number) {
  if (!Number.isFinite(time) || time < 0 || !supportsNativeAlpha(animation)) throw new Error('Unsupported MomMaterial sequence');
  let previous = animation.keys[0].color >>> 24, elapsed = time;
  for (const key of animation.keys) {
    const next = key.color >>> 24;
    if (elapsed <= key.duration && key.duration > 0) {
      const rate = Math.fround(Math.min(1, Math.fround(elapsed / key.duration)));
      return Math.trunc(Math.fround(Math.fround(previous * Math.fround(1 - rate)) + Math.fround(next * rate))) / 255;
    }
    elapsed -= key.duration; previous = next;
  }
  return previous / 255;
}

/** Deterministic original SglPrimitive rectangle + constant/sine matrix + texture-grid subset.
 * Unsupported motion is reported while the original geometry and atlas crop remain available.
 * Root state is an explicit native state ID; the caller is responsible for the judgement-to-state mapping.
 */
export function sampleNativeEffectPlanes(effect: NativeEffectProgram, time: number, rootState: number) {
  if (!Number.isFinite(time) || time < 0 || time > 1e9) throw new Error('Invalid native effect time');
  const nodes = effect.program.nodes, root = nodes.find(n => n.parent === null);
  if (!root) throw new Error('Missing native effect root');
  const state = root.states.find(s => s.id === rootState);
  if (!state) throw new Error(`Missing native effect root state ${rootState}`);
  const diagnostics: string[] = [], planes: NativeEffectPlaneSample[] = [];
  const actions = state.commands.flatMap(c => c.kind === 751 && c.trigger?.time === 0 ? c.trigger.actions : []);
  const enabled = actions.filter(a => a.words.length === 7 && a.words[0] === 0 && a.words[1] === 0
    && a.words[2] === 0 && a.words[4] === -1 && a.words[5] === 1 && a.words[6] === 0).map(a => a.words[3]);
  if (actions.length !== enabled.length || state.commands.some(c => c.kind !== 751))
    return { planes, diagnostics: ['Unsupported native root activation command'] };
  for (const primitive of effect.primitives) {
    try {
      const node = nodes.find(n => n.ordinal === primitive.node)!;
      const chain = [node]; let parent = node.parent;
      while (parent !== null) {
        const p = nodes.find(n => n.offset === parent);
        if (!p || chain.includes(p)) throw new Error('invalid primitive parent');
        chain.unshift(p); parent = p.parent;
      }
      if (enabled.length && !chain.some(n => enabled.includes(n.id))) continue;
      if (!enabled.length && chain.some(n => n !== root && n.flags === 8)) continue;
      if (time >= effectChainLifetime(effect, chain)) continue;
      if (!primitive.fixedRectangle) throw new Error('non-constant primitive geometry');
      let matrix = identityStageMatrix();
      for (const n of chain) {
        const s = n === root ? state : n.states.find(s => s.id === n.defaultState);
        const commands = [...n.commonCommands, ...(s?.commands ?? []), ...(n.postCommands ?? [])];
        for (const command of commands) {
          if (n === root && command.kind === 751) continue;
          if ([401, 402].includes(command.kind) && n === node) continue;
          if (n === node && command.kind === 300 && effect.colorAnimations?.some(a => a.command === command.offset && supportsNativeAlpha(a))) continue;
          try {
            if (command.kind === 1003) { matrix = applyNativeEffectCurves(effect, command.offset, matrix, time); continue; }
            if (command.kind !== 100 || command.selector !== 0 || !command.matrix) throw new Error(`command ${command.kind}`);
            for (const record of command.matrix) {
              try {
                const value = sampleStageMatrixRecord(record, time);
                if (value) matrix = applyStageTransform(matrix, record.property, value, record.translationMode);
              } catch (error) { diagnostics.push(`Node ${n.ordinal}: matrix property ${record.property}: ${error instanceof Error ? error.message : error} (not applied)`); }
            }
          } catch (error) { diagnostics.push(`Node ${n.ordinal}: ${error instanceof Error ? error.message : error} (not applied)`); }
        }
      }
      const patterns = effect.texturePatterns.filter(p => p.node === node.ordinal);
      if (patterns.length > 1 || primitive.textureResources.length !== 1) throw new Error('multiple primitive resources/patterns');
      const pattern = patterns[0];
      const sample = pattern ? sampleNativeTexturePattern(pattern, time) : { frame: 0, resource: 0, uv: [0, 0, 1, 1] as [number, number, number, number] };
      const uvSets = effect.extraCommands.filter(c => c.node === node.ordinal && c.kind === 402);
      if (uvSets.length > 1 || (uvSets.length && pattern)) throw new Error('Multiple native UV commands');
      if (uvSets.length) sample.uv = sampleNativeUvSet(uvSets[0].descriptor.words);
      if (sample.resource !== 0) throw new Error('resource selector outside primitive material');
      const halfW = primitive.width / 2, halfH = primitive.height / 2;
      const local: StageVector[] = [[-halfW, halfH, 0], [-halfW, -halfH, 0], [halfW, -halfH, 0], [halfW, halfH, 0]];
      const positions = local.map(p => [0, 1, 2].map(r => matrix[r] * p[0] + matrix[r + 4] * p[1]
        + matrix[r + 8] * p[2] + matrix[r + 12]) as StageVector) as NativeEffectPlaneSample['positions'];
      planes.push({ node: node.ordinal, resource: primitive.textureResources[0], frame: sample.frame, positions, uv: sample.uv });
    } catch (error) { diagnostics.push(`Node ${primitive.node}: ${error instanceof Error ? error.message : error}`); }
  }
  return { planes, diagnostics };
}

type Four = [number, number, number, number];
const f32 = Math.fround;
const asFloat = (word: number) => new Float32Array(new Int32Array([word]).buffer)[0];
const fraction = (x: number) => x - Math.floor(x);

/** Deterministic random arithmetic from the original embedded ParticleSystem.h.
 * tangent is the already rotated native seed direction, supplied explicitly by the caller.
 */
export function nativeParticleRandom(tangent: StageVector, seed: number): Four {
  return [0, 1, 2, 0].map((axis, n) => fraction(f32(tangent[axis] * f32(seed + 700 + n * 100)))) as Four;
}

/** The initialization arithmetic for the shader's parameter arrays (0x6dd0f0).
 * We expose only parameter ranges used by the local-space evaluator; no graphics device is needed.
 */
export function compileNativeParticleCurves(particle: NativeParticleSettings) {
  const params: Four[] = Array.from({ length: 52 }, () => [0, 0, 0, 0]);
  for (let n = 0; n < 5; n++) {
    const key = particle.colorKeys[Math.min(n, particle.colorKeys.length - 1)];
    const first = key?.first ?? [1, 1, 1, 1], second = key?.second ?? first;
    params[8 + n * 2] = key ? first.map((v, i) => f32(f32(v) - f32(second[i]))) as Four : [1, 1, 1, 1];
    params[9 + n * 2] = second.map(f32) as Four;
    if (n < particle.colorKeys.length) {
      if (n === 4) params[6][0] = key.time;
      else params[7][n] = key.time;
    }
  }
  for (let n = 0; n < 4; n++) {
    const key = particle.scaleKeys[Math.min(n, particle.scaleKeys.length - 1)];
    params[18 + n] = key ? [...key.value.map(f32), n < particle.scaleKeys.length ? key.time : 1] as Four : [1, 1, 1, 0];
  }
  const groups = [0, 1, 2].map(mode => particle.vectorKeys.filter(k => k.mode === mode).map(k => ({
    first: k.second, second: k.first, time: k.time,
  })));
  groups.push(particle.extraVectorKeys.map(k => ({ first: k.second, second: k.first, time: [k.time, k.time] })));
  groups.push(particle.scalarKeys.map(k => ({ first: [k.value, 0, 0], second: [0, 0, 0], time: [k.time, k.time] })));
  if (particle.colorKeys.length > 5 || particle.scaleKeys.length > 4 || groups.some(g => g.length > 3)
    || particle.vectorKeys.some(k => ![0, 1, 2].includes(k.mode))) throw new Error('Unsupported native particle curve capacity');
  for (let group = 0; group < groups.length; group++) for (let n = 0; n < 3; n++) {
    const keys = groups[group], key = keys[Math.min(n, keys.length - 1)];
    if (!key) continue;
    const at = 22 + group * 6 + n * 2;
    params[at] = [...key.first.map((v, i) => f32(v - key.second[i])), n < keys.length ? key.time[0] : 1] as Four;
    params[at + 1] = [...key.second, n < keys.length ? key.time[1] < 0 ? 10_000_000 : key.time[1] : 1] as Four;
  }
  return params;
}

// Imported programs are immutable assets. Editing a chart never mutates these curve objects.
const compiledParticleCurves = new WeakMap<NativeParticleSettings, Four[]>();
function particleCurves(particle: NativeParticleSettings) {
  let curves = compiledParticleCurves.get(particle);
  if (!curves) { curves = compileNativeParticleCurves(particle); compiledParticleCurves.set(particle, curves); }
  return curves;
}

export interface NativeParticleSample {
  position: StageVector;
  /** Original billboard quad offsets, before camera orientation. */
  offsets: [number, number][];
  color: EffectColor;
  uv: [number, number, number, number];
  billboard: number;
}

/** Local-space portion of the original particle shader, with explicit input seed and age.
 * The emitter/world transform and material commands remain separate AFNC operations.
 */
export function sampleNativeParticle(particle: NativeParticleSettings, age: number, tangent: StageVector): NativeParticleSample | null {
  if (!Number.isFinite(age) || tangent.some(v => !Number.isFinite(v))) throw new Error('Invalid native particle input');
  const init = particle.initialization;
  if (age < 0 || age >= init.life) return null;
  if (particle.words[0x44 / 4] !== 0 || ![0, 2, 3].includes(init.shape)) throw new Error('Unsupported particle coordinate/shape mode');
  const p = particleCurves(particle);
  const randomTime = nativeParticleRandom(tangent, .634);
  const time = f32(age * f32(1 + f32(asFloat(particle.words[0x64 / 4]) * randomTime[0])));
  const minCount = Math.min(...init.emissionCount), maxCount = Math.max(...init.emissionCount);
  const removal = maxCount > 0 ? (maxCount - minCount) / maxCount : 0;
  const ratio = fraction(f32(f32(tangent[0] * randomTime[1]) + randomTime[2]));
  if (1 + (ratio - 1) * removal < .5) return null;
  const radius = init.shape === 2 ? 10000 : init.extent[0];
  const extent = init.shape === 2 ? init.extent.map(v => v / 2) : [10000, init.shape === 3 ? 0 : 10000, 10000];
  const position = tangent.map((v, i) => extent[i] === 0 ? 0 : f32(f32(v * radius) % extent[i])) as StageVector;
  let remaining = time, movementTime = 0, speed = 1;
  for (const [n, at] of [46, 48, 50].entries()) {
    if (!(remaining > 0)) break;
    const value = p[at][0], duration = p[at][3], next = remaining - duration;
    const part = duration === 0 ? 1 : Math.max(0, Math.min(1, remaining / duration));
    if (next < 0) { const newSpeed = speed + (value - speed) * part; movementTime += remaining * (speed + newSpeed) / 2; speed = newSpeed; }
    else if (n === 2) { const newSpeed = speed + (value - speed) * part; movementTime += duration * (speed + newSpeed) / 2 + next * value; speed = newSpeed; }
    else { movementTime += duration * (speed + value) / 2; speed = value; }
    remaining = next;
  }
  function motion(first: Four, second: Four, seed: number, acceleration: boolean, radial = false) {
    const random = nativeParticleRandom(tangent, seed);
    const elapsed = Math.max(0, Math.min(movementTime, second[3]) - first[3]);
    let velocity: number[];
    if (radial) {
      const direction = random.slice(0, 3).map(v => v - .5), length = Math.hypot(...direction);
      velocity = direction.map(v => length ? v / length * (random[3] * first[0] + second[0]) : 0);
    } else velocity = [0, 1, 2].map(i => random[i] * first[i] + second[i]);
    for (let i = 0; i < 3; i++) position[i] += velocity[i] * (acceleration ? elapsed * elapsed / 2 : elapsed);
  }
  // Preserve the source shader's unusual repeated parameter indices exactly.
  for (const [a, b] of [[22, 23], [24, 24], [26, 25]]) motion(p[a], p[b], .234, false);
  for (const [a, b] of [[28, 29], [30, 31], [32, 33]]) motion(p[a], p[b], .345, true);
  for (const [a, b] of [[34, 35], [36, 37], [38, 39]]) motion(p[a], p[b], .456, false, true);
  remaining = movementTime; let force = [0, 0, 0];
  for (const [n, at] of [40, 42, 44].entries()) {
    if (!(remaining > 0)) break;
    const duration = p[at][3], next = remaining - duration, random = nativeParticleRandom(tangent, .567);
    const acceleration = [0, 1, 2].map(i => random[i] * p[at][i] + p[at + 1][i]);
    if (next < 0 || n === 2) {
      const amount = duration === 0 ? 1 : Math.max(0, Math.min(1, remaining / duration));
      force = force.map((v, i) => v + (acceleration[i] - v) * amount);
      for (let i = 0; i < 3; i++) position[i] += force[i] * remaining;
    } else {
      force = acceleration; for (let i = 0; i < 3; i++) position[i] += force[i] * duration;
    }
    remaining = next;
  }
  let scale = [1, 1, 0, 0]; remaining = time;
  for (let at = 18; at < 22 && remaining > 0; at++) {
    const next = remaining - p[at][3], amount = next < 0 ? remaining / p[at][3] : 1;
    scale = scale.map((v, i) => v + (p[at][i] - v) * amount); remaining = next;
  }
  let color: EffectColor = [1, 1, 1, 0]; remaining = time;
  const randomColor = nativeParticleRandom(tangent, .789);
  for (let n = 0; n < 5 && remaining > 0; n++) {
    const duration = n === 4 ? p[6][0] : p[7][n], next = remaining - duration;
    const target = randomColor.map((v, i) => v * p[8 + n * 2][i] + p[9 + n * 2][i]);
    const amount = next < 0 ? remaining / duration : 1;
    color = color.map((v, i) => v + (target[i] - v) * amount) as EffectColor; remaining = next;
  }
  const random = nativeParticleRandom(tangent, .123);
  const sampleRange = (range: [number, number], r: number) => Math.min(...range) + Math.abs(range[0] - range[1]) * r;
  const width = sampleRange(init.sizeX, random[0]), height = init.sizeY[0] < 0 ? width : sampleRange(init.sizeY, random[1]);
  const radians = 2 * Math.PI / 65536;
  const angle = (Math.min(init.angleRanges[0], init.angleRanges[1]) + Math.abs(init.angleRanges[0] - init.angleRanges[1]) * random[2]
    + (Math.min(init.angleRanges[2], init.angleRanges[3]) + Math.abs(init.angleRanges[2] - init.angleRanges[3]) * random[3]) * time) * radians;
  // Corner order matches UV (0,0), (0,1), (1,1), (1,0) in the original shader.
  const offsets = [[-.5, -.5], [-.5, .5], [.5, .5], [.5, -.5]].map(([x, y]): [number, number] => {
    x *= width * scale[0]; y *= height * scale[1]; return [Math.cos(angle) * x - Math.sin(angle) * y, Math.sin(angle) * x + Math.cos(angle) * y];
  });
  const randomPattern = nativeParticleRandom(tangent, .17934);
  let frame = Math.floor(time / Math.max(.0001, init.textureFrameDuration)
    + Math.min(1, init.textureFirstFrame) * init.textureFrameCount * randomPattern[2]);
  frame = init.textureLoop ? frame % init.textureFrameCount : Math.min(frame, init.textureFrameCount);
  const du = 1 / init.textureColumns, dv = 1 / init.textureRows;
  const uv: [number, number, number, number] = [(frame % init.textureColumns) * du, Math.floor(frame / init.textureColumns) * dv,
    (frame % init.textureColumns + 1) * du, (Math.floor(frame / init.textureColumns) + 1) * dv];
  return { position, offsets, color, uv, billboard: particle.words[0xa0 / 4] };
}

/** Exact duration/rate/max-count subset, with a caller-visible deterministic preview seed.
 * The game's shared CPU seed rotation is intentionally not claimed to match a running cabinet.
 */
export function sampleNativeParticleBurst(particle: NativeParticleSettings, time: number, seed = 1, limit = 512) {
  if (!Number.isFinite(time) || time < 0 || time > 1e9 || !Number.isInteger(limit) || limit < 1 || limit > 4096)
    throw new Error('Invalid native particle burst input');
  const init = particle.initialization;
  if (![0, 1, 2].includes(init.emissionMode) || !(init.emissionLimit >= 0) || !(init.life > 0)) throw new Error('Unsupported native emission mode');
  const rate = Math.max(...init.emissionCount) / init.emissionInterval;
  if (!(rate > 0) || !Number.isFinite(rate)) return [];
  const count = Math.min(limit, init.maxParticles, init.emissionMode === 2 ? Math.ceil(init.emissionLimit * rate)
    : init.emissionMode === 1 ? Math.floor(init.emissionLimit + 1) : init.maxParticles);
  const output: (NativeParticleSample & { index: number; birth: number })[] = [];
  let state = seed >>> 0;
  // Seed directions are preview-local inputs to the original shader, not invented motion paths.
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let index = 0; index < count; index++) {
    const z = random() * 2 - 1, angle = random() * Math.PI * 2, radius = Math.sqrt(1 - z * z);
    const tangent: StageVector = [radius * Math.cos(angle), radius * Math.sin(angle), z];
    const birth = index / rate, sample = sampleNativeParticle(particle, time - birth, tangent);
    if (sample) output.push({ ...sample, index, birth });
  }
  return output;
}

export interface NativeEffectMaterialSample {
  resources: number[];
  color: EffectColor;
  /** Original texture-state records, separate from the node's blend mode. */
  properties: NativeEffectProperty[];
  blendSource?: number; blendDestination?: number; blendOperation?: number;
  blendEnabled?: boolean;
  wrap?: [number, number];
}
export interface NativeEffectParticleSample extends NativeParticleSample {
  node: number; index: number; birth: number;
  /** Column-major affine emitter matrix, without gameplay/note placement. */
  world: StageMatrix;
  material: NativeEffectMaterialSample;
}
export interface NativeEffectSample {
  planes: (NativeEffectPlaneSample & { material: NativeEffectMaterialSample })[];
  particles: NativeEffectParticleSample[];
  /** True when unsupported AFNC orchestration/material commands affect a drawn component. */
  partial: boolean;
  diagnostics: string[];
}
function effectNodeChain(effect: NativeEffectProgram, ordinal: number): StageNode[] {
  const nodes = effect.program.nodes;
  const node = nodes.find(n => n.ordinal === ordinal);
  if (!node) throw new Error('Missing effect node');
  const chain = [node]; let parent = node.parent;
  while (parent !== null) {
    const p = nodes.find(n => n.offset === parent);
    if (!p || chain.includes(p)) throw new Error('Invalid effect parent');
    chain.unshift(p); parent = p.parent;
  }
  return chain;
}
function effectChainLifetime(effect: NativeEffectProgram, chain: StageNode[]) {
  let end = Infinity;
  for (const node of chain) {
    const life = effect.lifecycles?.find(l => l.node === node.ordinal);
    // CorForester's fixed-duration branch. Random upper bounds are not silently chosen.
    if (life?.kind === 2 && life.duration >= 0 && life.durationUpper <= 0) end = Math.min(end, life.duration);
  }
  return end;
}
/** Resource IDs needed by the selected, executable activation branch. Original
 * geometry which is retained but not rendered does not force a texture decode.
 */
export function effectResourceIndices(effect: NativeEffectProgram, rootState: number): number[] {
  const root = effect.program.nodes.find(n => n.parent === null);
  const state = root?.states.find(s => s.id === rootState);
  if (!root || !state) throw new Error('Missing native root state');
  const actions = state.commands.flatMap(c => c.kind === 751 && c.trigger?.time === 0 ? c.trigger.actions : []);
  const enabled = actions.filter(a => a.words.length === 7 && a.words[0] === 0 && a.words[1] === 0
    && a.words[2] === 0 && a.words[4] === -1 && a.words[5] === 1 && a.words[6] === 0).map(a => a.words[3]);
  if (actions.length !== enabled.length || state.commands.some(c => c.kind !== 751)) return [];
  const resources = new Set<number>();
  for (const component of [...effect.primitives.filter(p => p.fixedRectangle), ...effect.particles.filter(p => p.executable)]) {
    const chain = effectNodeChain(effect, component.node);
    if (enabled.length ? !chain.some(n => enabled.includes(n.id)) : chain.some(n => n !== root && n.flags === 8)) continue;
    for (const resource of component.textureResources) resources.add(resource);
  }
  return [...resources].sort((a, b) => a - b);
}
/** Native fixed CorForester lifetime bound in original time units; null means not bounded here. */
export function effectLifetime(effect: NativeEffectProgram, rootState: number): number | null {
  const root = effect.program.nodes.find(n => n.parent === null);
  const state = root?.states.find(s => s.id === rootState);
  if (!root || !state) throw new Error('Missing native root state');
  const enabled = state.commands.flatMap(c => c.kind === 751 && c.trigger?.time === 0 ? c.trigger.actions : [])
    .filter(a => a.words[0] === 0 && a.words[1] === 0 && a.words[2] === 0 && a.words[4] === -1 && a.words[5] === 1 && a.words[6] === 0)
    .map(a => a.words[3]);
  const chains = [...effect.primitives, ...effect.particles].map(p => effectNodeChain(effect, p.node))
    .filter(chain => enabled.length ? chain.some(n => enabled.includes(n.id)) : !chain.some(n => n !== root && n.flags === 8));
  const end = chains.length ? Math.max(...chains.map(chain => effectChainLifetime(effect, chain))) : effectChainLifetime(effect, [root]);
  return Number.isFinite(end) ? end : null;
}
function effectMaterial(effect: NativeEffectProgram, node: number, resources: number[], time: number): NativeEffectMaterialSample {
  const packed = effect.properties.find(p => p.node === node && p.kind === 101)?.settings?.words[0];
  const color: EffectColor = packed === undefined ? [1, 1, 1, 1] : unpackEffectColor(packed);
  const n = effect.program.nodes.find(n => n.ordinal === node)!;
  const commands = [...n.commonCommands, ...(n.states.find(s => s.id === n.defaultState)?.commands ?? []), ...(n.postCommands ?? [])];
  for (const command of commands) {
    const alpha = effect.colorAnimations?.find(a => a.command === command.offset);
    if (alpha && supportsNativeAlpha(alpha)) color[3] = sampleNativeEffectAlpha(alpha, time);
  }
  const properties = effect.properties.filter(p => p.node === node && p.kind === 300);
  const mode = effect.nodeRenderModes?.find(m => m.node === node)?.mode;
  // Native table 0x18a6908, selected by 0x6cd870 and applied by 0x129588b.
  const states = [[0, 4, 5, 0], [0, 4, 5, 0], [1, 4, 5, 0], [1, 4, 5, 0],
    [1, 4, 1, 0], [1, 4, 1, 2], [1, 0, 2, 0], [1, 7, 0, 0]];
  const state = mode === undefined ? undefined : states[Math.max(0, Math.min(7, mode))];
  const textureState = properties[0]?.settings?.words;
  return { resources, color, properties,
    ...(state ? { blendEnabled: Boolean(state[0]), blendSource: state[0] ? state[1] : 1,
      blendDestination: state[0] ? state[2] : 0, blendOperation: state[3] } : {}),
    ...(textureState ? { wrap: [textureState[0] === 0 ? 0 : 2, textureState[1] === 0 ? 0 : 2] as [number, number] } : {}) };
}

/** Runs verified local particle/shader and deterministic plane components from one native state.
 * Unsupported ancestor transforms are explicitly partial, never replaced with invented motion.
 * Emission mode 0 currently samples its first native-capacity batch only; no guessed repeat/reset.
 */
export function sampleNativeEffect(effect: NativeEffectProgram, time: number, rootState: number, seed = 1,
  options: { particleLimit?: number } = {}): NativeEffectSample {
  const limit = options.particleLimit ?? 512;
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new Error('Invalid native effect particle limit');
  const result = sampleNativeEffectPlanes(effect, time, rootState);
  const planes = result.planes.map(plane => ({ ...plane, material: effectMaterial(effect, plane.node, [plane.resource], time) }));
  const particles: NativeEffectParticleSample[] = [], diagnostics = new Set(result.diagnostics);
  const root = effect.program.nodes.find(n => n.parent === null)!;
  const rootCommands = root.states.find(s => s.id === rootState)!.commands;
  const actions = rootCommands.flatMap(c => c.kind === 751 && c.trigger?.time === 0 ? c.trigger.actions : []);
  const enabled = actions.filter(a => a.words.length === 7 && a.words[0] === 0 && a.words[1] === 0
    && a.words[2] === 0 && a.words[4] === -1 && a.words[5] === 1 && a.words[6] === 0).map(a => a.words[3]);
  if (actions.length !== enabled.length || rootCommands.some(c => c.kind !== 751))
    return { planes, particles, partial: true, diagnostics: [...diagnostics, 'Unsupported native root activation command'] };
  for (const node of effect.program.nodes) {
    if ([3, 9, 100, 6001008].includes(node.type)) continue;
    const chain = effectNodeChain(effect, node.ordinal);
    if (enabled.length ? !chain.some(n => enabled.includes(n.id)) : chain.some(n => n !== root && n.flags === 8)) continue;
    if (time < effectChainLifetime(effect, chain)) diagnostics.add(`Node ${node.ordinal}: drawable type ${node.type} retained, not executed`);
  }
  for (const particle of effect.particles) {
    if (particles.length >= limit) { diagnostics.add(`Particle output capped at ${limit}`); break; }
    const chain = effectNodeChain(effect, particle.node);
    if (enabled.length && !chain.some(n => enabled.includes(n.id))) continue;
    if (!enabled.length && chain.some(n => n !== root && n.flags === 8)) continue;
    if (time >= effectChainLifetime(effect, chain)) continue;
    let matrix = identityStageMatrix();
    for (const node of chain) {
      const state = node === root ? rootCommands : node.states.find(s => s.id === node.defaultState)?.commands ?? [];
      for (const command of [...node.commonCommands, ...state, ...(node.postCommands ?? [])]) {
        if (node === root && command.kind === 751) continue;
        if (node.ordinal === particle.node && command.kind === 300 && effect.colorAnimations?.some(a => a.command === command.offset && supportsNativeAlpha(a))) continue;
        try {
          if (command.kind === 1003) { matrix = applyNativeEffectCurves(effect, command.offset, matrix, time); continue; }
          if (command.kind !== 100 || command.selector !== 0 || !command.matrix) throw new Error(`command ${command.kind}`);
          for (const record of command.matrix) {
            const value = sampleStageMatrixRecord(record, time);
            if (value) matrix = applyStageTransform(matrix, record.property, value, record.translationMode);
          }
        } catch (error) { diagnostics.add(`Node ${node.ordinal}: ${error instanceof Error ? error.message : error} (not applied)`); }
      }
    }
    try {
      const material = effectMaterial(effect, particle.node, particle.textureResources, time);
      if (material.resources.length !== 1) throw new Error('Unsupported particle material texture count');
      const samples = sampleNativeParticleBurst(particle, time, seed ^ particle.node, limit - particles.length);
      particles.push(...samples.map(sample => ({ ...sample, node: particle.node, world: matrix, material })));
      if (particle.initialization.emissionMode === 0) diagnostics.add('Continuous emitter: first native-capacity batch only; restart schedule not decoded');
      if (particle.undecodedCurve.count) diagnostics.add(`Node ${particle.node}: sixth curve retained, not applied`);
    } catch (error) { diagnostics.add(`Node ${particle.node}: ${error instanceof Error ? error.message : error}`); }
  }
  if (particles.length) diagnostics.add('Particle shader uses an explicit preview seed; cabinet global seed, camera fade/wrap not calibrated');
  return { planes, particles, partial: diagnostics.size > 0, diagnostics: [...diagnostics] };
}
