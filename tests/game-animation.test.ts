import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { loadClassicStageAnimation, parseAfbResources, parseUvcClip, parseYabx } from '../src/backend/game-animation';
import { multiplyStageMatrices, sampleStageCurve, sampleStageQuaternion, sampleStageSkinMatrices, stageTrsMatrix, transformStagePoint, type StageAnimation, type StageKey } from '../src/core/stage-animation';
import samplerFixture from './fixtures/stage-sampler-native.json';

test('UVC scalar interpolation agrees with isolated original float and packed-short samplers', () => {
  for (const row of samplerFixture.scalars) {
    const actual = sampleStageCurve(row.curve, row.frame, NaN);
    assert.ok(Math.abs(actual - row.expected) < 2e-6, `${row.encoding} mode ${row.curve[0].flags} frame ${row.frame}: ${actual} != ${row.expected}`);
  }
});

test('original rotations at integer and fractional frames agree with isolated AnimationBridge', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/game/manifest.json', import.meta.url), 'utf8'));
  const animation: StageAnimation = manifest.textures.scene.animation;
  for (const row of samplerFixture.rotations) {
    const clip = animation.clips[row.clip], node = clip.nodes.find(n => n.name === row.node)!;
    const actual = sampleStageQuaternion(node, row.frame, clip.frameCount);
    actual.forEach((value, i) => assert.ok(Math.abs(value - row.expected[i]) < 3e-6, `clip ${row.clip} ${row.node} frame ${row.frame} axis ${i}: ${value} != ${row.expected[i]}`));
  }
});

test('affine transform composition preserves parent space and source quaternion orientation', () => {
  const parent = stageTrsMatrix([10, 20, 30], [2, 2, 2], [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  const child = stageTrsMatrix([1, 0, 0], [1, 1, 1], [0, 0, 0, 1]);
  const point = transformStagePoint(multiplyStageMatrices(parent, child), [1, 0, 0]);
  point.forEach((value, i) => assert.ok(Math.abs(value - [10, 24, 30][i]) < 1e-10));
});

test('source-key sampling preserves endpoints, uses tangent direction, and clamps instead of inventing loops', () => {
  const curve: StageKey[] = [{ frame: 0, value: 0, tangent: 1, flags: 0 }, { frame: 10, value: 10, tangent: 1, flags: 2 }];
  assert.equal(sampleStageCurve(curve, -1, 9), 0);
  assert.equal(sampleStageCurve(curve, 5, 9), 5);
  assert.equal(sampleStageCurve(curve, 11, 9), 10);
  const ease: StageKey[] = [{ frame: 0, value: 0, tangent: 0, flags: 0 }, { frame: 10, value: 10, tangent: 0, flags: 2 }];
  assert.equal(sampleStageCurve(ease, 2.5, 9), 1.5625);
  assert.equal(sampleStageCurve([], 5, 9), 9);
});

const gameRoot = process.env.CHUNI_GAME_ROOT ?? '/mnt/d/chunithm';
const source = `${gameRoot}/data/A000/stage/stage000001/st_label_basic_0001_yellowring.afb`;
let available = true;
try { await access(source); } catch { available = false; }
test('installed original rig, clip directories and keyframe defaults close consistently', { skip: !available }, async () => {
  const animation = await loadClassicStageAnimation(gameRoot);
  assert.equal(animation.rig.bones.length, 40);
  assert.equal(animation.rig.vertexBones.length, 4008);
  assert.equal(animation.clips.length, 10);
  assert.equal(animation.framesPerSecond, null);
  for (const clip of animation.clips) {
    assert.equal(clip.frameCount, 901); assert.equal(clip.nodes.length, 47); assert.equal(clip.nodes.filter(node => node.flags).length, 37);
    for (const node of clip.nodes) for (const key of ['translation', 'scale', 'quaternion'] as const) {
      node.channels[key].forEach((curve, i) => {
        if (!curve.length) return;
        assert.ok(Math.abs(curve[0].value - node[key][i]) <= 1 / 32767 + 1e-7, `${node.name}.${key}[${i}] default disagrees`);
        for (const point of curve) assert.equal(sampleStageCurve(curve, point.frame, NaN), point.value);
        for (let j = 0; j < curve.length - 1; j++) if (curve[j].flags === 2) assert.ok(Math.abs(curve[j].value - curve[j + 1].value) < 4e-5);
      });
    }
  }
  for (const bone of animation.rig.bones) {
    const local = stageTrsMatrix(bone.translation, bone.scale, bone.quaternion);
    local.forEach((value, i) => assert.ok(Math.abs(value - bone.localMatrix[i]) < 3e-5, `${bone.name} matrix ${i}`));
    const world = bone.parent === null ? local : multiplyStageMatrices(animation.rig.bones[bone.parent].worldMatrix, local);
    world.forEach((value, i) => assert.ok(Math.abs(value - bone.worldMatrix[i]) < 1e-4, `${bone.name} world ${i}`));
  }
  const box1 = animation.rig.bones.find(bone => bone.name === 'box_1')!;
  assert.deepEqual(transformStagePoint(box1.bindMatrix, [0, 70, 0]), [0, 0, 0]);
  const first = sampleStageSkinMatrices(animation, 0, 0), last = sampleStageSkinMatrices(animation, 0, 900);
  assert.ok(first.length === 38 && first.flat().every(Number.isFinite));
  assert.notDeepEqual(first, last);
  assert.deepEqual(sampleStageSkinMatrices(animation, 0, 2000), last);
  const file = await readFile(source), resources = parseAfbResources(file), clip = resources.find(resource => resource.name === 'st_00001_ring_0.uvc')!;
  assert.equal(clip.offset, 168960); assert.equal(clip.size, 32768);
  const corrupted = Buffer.from(clip.data); corrupted.writeUInt32LE(0xffffffff, 128 + 12);
  assert.throws(() => parseUvcClip(corrupted, clip.name), /边界/);
  const yabxOffset = clip.data.readUInt32LE(128 + 12), yabxSize = clip.data.readUInt32LE(128 + 8);
  assert.throws(() => parseYabx(clip.data.subarray(yabxOffset, yabxOffset + yabxSize - 1)), /不完整/);
  const offsets = new Map(Array.from({ length: 6 }, (_, i) => [clip.data.readUInt32LE(128 + i * 256), clip.data.readUInt32LE(128 + i * 256 + 12)]));
  const packed = Buffer.from(clip.data), nodesAt = offsets.get(1)!, keysAt = offsets.get(3)!;
  let checked = false;
  for (let node = 0; node < 47 && !checked; node++) for (let channel = 0; channel < 10 && !checked; channel++) {
    const descriptor = nodesAt + 4 + node * 172 + channel * 12;
    if (packed.readUInt32LE(descriptor) !== 1 || !packed.readUInt32LE(descriptor + 8)) continue;
    const key = keysAt + 4 + packed.readUInt32LE(descriptor + 4) * 8, frame = packed.readUInt16LE(key + 6) & 0x3fff;
    packed.writeUInt16LE(frame | 0x4000, key + 6);
    const parsed = parseUvcClip(packed, clip.name), curves = parsed.nodes[node].channels;
    const decoded = [...curves.translation, ...curves.scale, ...curves.quaternion][channel][0];
    assert.equal(decoded.frame, frame); assert.equal(decoded.flags, 1); checked = true;
  }
  assert.ok(checked, 'The packed-short mode bit must not be interpreted as frame bit 14.');
});
