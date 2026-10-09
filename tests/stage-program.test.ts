import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseGameStageProgram } from '../src/backend/game-stage-program';
import { applyStageTransform, createStageModelSampler, getStageCamera, identityStageMatrix,
  nextStageRandom, sampleStageMatrixRecord, stageSinCos, type StageMatrixRecord, type StageVector } from '../src/core/stage-program';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/stage-native-math.json', import.meta.url), 'utf8')) as {
  matrices: { operations: [number, StageVector][]; matrix: number[] }[];
  trig: { angle: number; sin: number; cos: number }[];
  random: { state: [number, number]; index: number }[];
};

test('16-bit trigonometry matches native functions at octant boundaries and negative angles', () => {
  for (const sample of oracle.trig) {
    const [sin, cos] = stageSinCos(sample.angle);
    assert.ok(Math.abs(sin - sample.sin) <= 1e-7, `sin ${sample.angle}`);
    assert.ok(Math.abs(cos - sample.cos) <= 1e-7, `cos ${sample.angle}`);
  }
});

test('native parent matrices: translation, mixed XYZ rotations and pivot do not cancel', () => {
  for (const [i, sample] of oracle.matrices.entries()) {
    const matrix = sample.operations.reduce((m, [property, value]) => applyStageTransform(m, property, value), identityStageMatrix());
    for (let j = 0; j < 16; j++) assert.ok(Math.abs(matrix[j] - sample.matrix[j]) < 1e-7,
      `native matrix ${i}[${j}]: ${matrix[j]} vs ${sample.matrix[j]}`);
  }
  const pivot = oracle.matrices[0].matrix;
  assert.ok(Math.abs(pivot[12]) > 100);
});

test('clip-choice recurrence agrees with twenty successive native PRNG calls', () => {
  let state: [number, number] = [0x12345678, 0x9abcdef0];
  for (const expected of oracle.random) {
    const actual = nextStageRandom(state, 10);
    assert.deepEqual(actual, expected); state = actual.state;
  }
});

function fixture() {
  const b = Buffer.alloc(2048), origin = 96, end = 1408;
  const pointers: number[] = [];
  const u = (at: number, value: number) => b.writeUInt32LE(value >>> 0, at);
  const f = (at: number, value: number) => b.writeFloatLE(value, at);
  const ptr = (at: number, target: number) => { u(at, target - origin); pointers.push(at); };
  const block = (at: number, name: string, size: number, header: number) => { b.write(name, at); u(at + 4, size); u(at + 8, header); };
  block(0, 'FILS', 2016, 32); block(32, 'FILE', 1984 - 32, 64);
  block(origin, 'AFNC', end - origin - 32, 32); u(origin + 32, 2012060601);
  ptr(origin + 128, 260);
  u(260, 6001001); u(296, 13); u(312, 0); ptr(324, 360); u(328, 1);
  u(360, 0); ptr(380, 392); u(384, 3);
  const commands = [392, 432, 472];
  commands.forEach((at, i) => { u(at, [600, 106, 751][i]); if (i < 2) ptr(at + 32, commands[i + 1]); });
  ptr(428, 520); ptr(468, 680); ptr(508, 840);
  u(548, 1); ptr(552, 560);
  u(560, -1); u(564, -1); f(568, 1); f(572, 0); f(576, -1);
  ptr(680, 704); u(684, 1); u(688, -1);
  f(712, -1600); f(736, -1); f(748, 800); f(752, -1);
  u(840, 1); u(844, 0); u(848, 900); ptr(860, 872); u(864, 1);
  u(872, 2); u(876, 3);
  ptr(320, 920); u(920, 400); ptr(928, 944); u(932, 3);
  [1, 2, 3].forEach((v, i) => { u(944 + i * 8, v); u(948 + i * 8, -1); });
  pointers.sort((a, b) => a - b);
  let cursor = end + 36, previous = origin;
  for (const at of pointers) {
    const delta = (at - previous) / 4;
    if (delta < 64) b[cursor++] = 0x40 | delta;
    else { b[cursor++] = 0x80 | (delta >>> 8); b[cursor++] = delta & 255; }
    previous = at;
  }
  const pofEnd = Math.ceil(cursor / 32) * 32;
  block(end, 'POF0', pofEnd - end - 32, 32); u(end + 32, cursor - end - 32);
  u(36, pofEnd - 96); u(4, pofEnd - 32);
  return b.subarray(0, pofEnd);
}

test('decodes relocated modern command records and state reset without source install', () => {
  const p = parseGameStageProgram(fixture(), 'synthetic.afb');
  assert.equal(p.nodes.length, 1);
  assert.deepEqual(p.nodes[0].states[0].commands.map(c => c.nativeClass), ['MomMotionSet', 'MomMatrixGoal', 'MomChangeState']);
  const sample = createStageModelSampler(p, 13);
  assert.deepEqual(sample(400).translation, [0, 0, -800]);
  assert.equal(sample(400).worldMatrix.length, 16);
  assert.deepEqual(sample(400).worldMatrix.slice(12, 15), [0, 0, -800]);
  assert.deepEqual(sample(850).translation, [0, 0, -1600]);
  assert.equal(sample(900).cycle, 1);
  assert.equal(sample(900).clipFrame, 0);
  assert.ok(sample(900).translation.every(value => value === 0));
});

test('seek/replay does not depend on sample order and random choice remains bounded', () => {
  const p = parseGameStageProgram(fixture());
  const a = createStageModelSampler(p, 13), b = createStageModelSampler(p, 13);
  const expected = a(5000);
  b(12000); b(17); b(4000);
  assert.deepEqual(b(5000), expected);
  assert.deepEqual(b(0), a(0));
  assert.throws(() => a(NaN), /Invalid/);
  assert.throws(() => a(-1), /nonnegative/);
  let state: [number, number] = [0x12345678, 0x9abcdef0];
  for (let i = 0; i < 100; i++) {
    const n = nextStageRandom(state, 10); state = n.state;
    assert.ok(n.index >= 0 && n.index < 10);
  }
});

test('fixed sine matrix mode uses endpoint midpoint, period and native angle quantization', () => {
  const record: StageMatrixRecord = { offset: 0, words: [], mode: 3, property: 1,
    translationMode: 0, randomMode: 0, timeSource: 0, start: 0, end: -1, persist: 1,
    period: 1600, phase: 0, value: [0, 3.5, 0], secondValue: [0, -3.5, 0] };
  assert.deepEqual(sampleStageMatrixRecord(record, 0), [0, 0, 0]);
  assert.deepEqual(sampleStageMatrixRecord(record, 400), [0, 3.5, 0]);
  assert.deepEqual(sampleStageMatrixRecord(record, 1200), [0, -3.5, 0]);
  assert.throws(() => sampleStageMatrixRecord({ ...record, mode: 7 }, 0), /Unsupported/);
});

test('rejects unrelocated pointers, truncated blocks, cycles and unsupported command execution', () => {
  const bytes = fixture();
  assert.throws(() => parseGameStageProgram(bytes.subarray(0, 100)), /range/);
  const invalid = Buffer.from(bytes); invalid.writeUInt32LE(12345, 352);
  assert.throws(() => parseGameStageProgram(invalid), /relocation/);
  const cycle = Buffer.from(bytes); cycle.writeUInt32LE(392 - 96, 424);
  assert.throws(() => parseGameStageProgram(cycle), /chain/);
  const p = parseGameStageProgram(bytes);
  p.nodes[0].states[0].commands[1].goals![0].easing = 5;
  assert.throws(() => createStageModelSampler(p, 13), /Unsupported/);
});

const local = '/mnt/d/chunithm/data/A000/stage/stage000001/st_label_basic_0001_yellowring.afb';
test('local yellowring: all 28 nodes, common UV command, ten clips and verified matrix parameters',
  { skip: !existsSync(local) }, () => {
    const p = parseGameStageProgram(readFileSync(local), 'yellowring');
    assert.equal(p.nodes.length, 28); assert.equal(p.relocationCount, 346);
    assert.equal(p.nodes.find(n => n.ordinal === 13)!.commonCommands[0].nativeClass, 'MomUvScroll');
    const f = createStageModelSampler(p, 13), s = f(400);
    assert.equal(s.ancestors.length, 5);
    assert.deepEqual(s.ancestors[2].value, [0, 3.5, 0]);
    assert.deepEqual(s.translation, [0, 0, -800]);
    assert.ok(s.clipResource >= 1 && s.clipResource <= 10);
    assert.equal(f(900).cycle, 1);
    assert.equal(s.worldMatrix.length, 16);
    const camera = getStageCamera(p, 25);
    assert.deepEqual(camera, { node: 25, eye: [0, 57, 44], target: [0, 3, -146.5], up: [0, 1, 0],
      verticalFovDegrees: 27, near: 10, far: 10000, aspect: -1 });
    assert.deepEqual(s.camera, camera);
    assert.ok(s.diagnostics.some(d => d.includes('秒率')));
  });

const fieldCamera = '/mnt/d/chunithm/data/acroarts/nf_gamecamera.afb';
test('track camera remains a separate 27.5-degree configuration and requires an explicit state',
  { skip: !existsSync(fieldCamera) }, () => {
    const p = parseGameStageProgram(readFileSync(fieldCamera));
    const c = getStageCamera(p, 1, 0);
    assert.equal(c.verticalFovDegrees, 27.5);
    assert.equal(c.near, 1); assert.equal(c.far, 1500);
    assert.deepEqual(c.eye, [0, 57, 44]);
    assert.throws(() => getStageCamera(p, 1, 999), /state does not exist/);
  });
