import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  compileNativeParticleCurves,
  effectLifetime,
  effectResourceIndices,
  nativeParticleRandom,
  sampleNativeEffect,
  sampleNativeEffectPlanes,
  sampleNativeEffectCurve,
  sampleNativeEffectAlpha,
  sampleNativeParticle,
  sampleNativeParticleBurst,
  sampleNativeTexturePattern,
  selectNativeEffects,
  type NativeParticleSettings,
  type NativeTexturePattern,
} from '../src/core/game-effects';
import { loadGameEffects, parseGameEffectProgram } from '../src/backend/game-effects';
import { parseGameEffectTable } from '../src/backend/game-textures';
const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const raw = { offset: 0, words: [] };
function particle(): NativeParticleSettings {
  const words = new Array(57).fill(0);
  words[40] = 1;
  return {
    ...raw,
    node: 1,
    words,
    executable: true,
    initialization: {
      shape: 0,
      extent: [0, 0, 0],
      maxParticles: 80,
      emissionInterval: 1,
      emissionCount: [40, 40],
      emissionMode: 2,
      emissionLimit: 2,
      life: 60,
      sizeX: [2, 2],
      sizeY: [-1, -1],
      angleRanges: [0, 0, 0, 0],
      textureColumns: 8,
      textureRows: 8,
      textureFirstFrame: 0,
      textureFrameCount: 64,
      textureFrameDuration: 1,
      textureLoop: false,
    },
    colorKeys: [],
    scaleKeys: [],
    vectorKeys: [],
    extraVectorKeys: [],
    scalarKeys: [],
    textureResources: [0],
    undecodedCurve: { count: 0, offset: null },
  };
}
test('texture-grid arithmetic matches 160 isolated native updates, including remainder reset', () => {
  for (const c of fixture('effect-native-uv.json').cases) {
    const pattern: NativeTexturePattern = {
      ...raw,
      node: 1,
      command: 0,
      resourceFirst: 0,
      resourceLast: 0,
      randomResource: 0,
      sheetFirst: 0,
      sheetLast: 0,
      layout: c.mode,
      ...c,
    };
    for (const s of c.samples) assert.deepEqual(sampleNativeTexturePattern(pattern, s.time).uv, s.uv);
  }
});
test('particle curve packing matches original initializer for empty, single and multiple keys', () => {
  for (const c of fixture('effect-native-particle-init.json').cases) {
    const p = particle();
    p.colorKeys = c.colors.map((k: any) => ({ ...raw, mode: 1, ...k }));
    p.scaleKeys = c.scales.map((k: any) => ({ ...raw, ...k }));
    p.vectorKeys = c.groups
      .slice(0, 3)
      .flatMap((keys: any[], mode: number) =>
        keys.map(k => ({ ...raw, mode, first: k.second, second: k.first, time: k.time })),
      );
    p.extraVectorKeys = c.groups[3].map((k: any) => ({ ...raw, first: k.second, second: k.first, time: k.time[0] }));
    p.scalarKeys = c.groups[4].map((k: any) => ({ ...raw, value: k.first[0], time: k.time[0] }));
    const actual = compileNativeParticleCurves(p);
    for (let i = 6; i < 52; i++)
      for (let n = 0; n < 4; n++)
        assert.ok(
          Math.abs(actual[i][n] - c.params[i][n]) < 1e-6,
          `count ${c.count}, p[${i}][${n}]: ${actual[i][n]} != ${c.params[i][n]}`,
        );
  }
});
test('original shader local curves control motion, quad orientation and lifetime', () => {
  const p = particle();
  p.scalarKeys = [{ ...raw, time: 0, value: 1 }];
  p.vectorKeys = [{ ...raw, mode: 0, time: [0, -1], first: [2, 0, 0], second: [2, 0, 0] }];
  p.colorKeys = [{ ...raw, mode: 0, time: 0, first: [1, 1, 1, 1], second: [1, 1, 1, 1] }];
  p.scaleKeys = [{ ...raw, time: 0, value: [2, 3, 1] }];
  const s = sampleNativeParticle(p, 5, [0, 0, 1])!;
  assert.deepEqual(s.position, [10, 0, 0]);
  assert.deepEqual(s.offsets, [
    [-2, -3],
    [-2, 3],
    [2, 3],
    [2, -3],
  ]);
  assert.deepEqual(s.color, [1, 1, 1, 1]);
  assert.deepEqual(s.uv, [5 / 8, 0, 6 / 8, 1 / 8]);
  assert.equal(sampleNativeParticle(p, -1, [0, 0, 1]), null);
  assert.equal(sampleNativeParticle(p, 60, [0, 0, 1]), null);
  assert.throws(() => sampleNativeParticle(p, NaN, [0, 0, 1]));
  assert.deepEqual(nativeParticleRandom([0, 0, 1], 0.234), [0, 0, Math.fround(900.234) % 1, 0]);
});
test('native burst obeys emission rate/count/life and bounded preview budget', () => {
  const p = particle();
  assert.equal(sampleNativeParticleBurst(p, 1).length, 41);
  assert.equal(sampleNativeParticleBurst(p, 2).length, 80);
  assert.equal(sampleNativeParticleBurst(p, 100).length, 0);
  assert.equal(sampleNativeParticleBurst(p, 2, 1, 12).length, 12);
  assert.deepEqual(sampleNativeParticleBurst(p, 3, 34), sampleNativeParticleBurst(p, 3, 34));
  assert.throws(() => sampleNativeParticleBurst(p, Infinity));
  assert.throws(() => sampleNativeParticleBurst(p, 2, 1, 1000000));
});
test('alpha interpolation matches original packed-color helper at 27 boundary and fractional samples', () => {
  for (const c of fixture('effect-native-material.json')) {
    const key = (color: number, duration: number) => ({
      ...raw,
      words: [color, 0, 0, 0],
      color,
      duration,
      durationUpper: -1,
      mode: 0,
      easing: 1,
    });
    const animation = {
      ...raw,
      words: [0, 0, -1082130432, 2, 0, 0, 0, 0, -1, 5, 8],
      node: 1,
      command: 0,
      keys: [key(c.a, 0), key(c.b, c.duration)],
    };
    assert.equal(Math.round(sampleNativeEffectAlpha(animation, c.time) * 255), c.result >>> 24);
  }
});
const gameRoot = '/mnt/d/chunithm';
const local = fs.existsSync(`${gameRoot}/data/db/NotesEffectTableRecord.bin`);
test(
  'all 19 native families and 16 widths use actual table references; AIR uses ceiling correction',
  { skip: !local },
  () => {
    const tables = {
      acroarts: parseGameEffectTable(fs.readFileSync(`${gameRoot}/data/db/AcroartsTableRecord.bin`), 'acroarts'),
      notes: parseGameEffectTable(fs.readFileSync(`${gameRoot}/data/db/NotesEffectTableRecord.bin`), 'notes'),
    };
    assert.equal(tables.notes.length, 19);
    for (const kind of tables.notes)
      for (let width = 1; width <= 16; width++) {
        const s = selectNativeEffects(tables, kind.name, width);
        assert.equal(s.diagnostics.length, 0);
        assert.ok(s.selectedWidth >= width);
        for (const ref of [s.bomb, s.reaction, s.text, s.keep])
          if (ref) assert.ok(tables.acroarts.some(r => r.id === ref.id));
      }
    assert.equal(selectNativeEffects(tables, 'Tap', 5).reaction?.sourceName, 'CHU_EF_Tap_reaction_v20');
    assert.equal(selectNativeEffects(tables, 'Air', 5).bomb?.id, 33);
    assert.equal(selectNativeEffects(tables, 'Air', 5).scaleX, 5 / 6);
    assert.equal(selectNativeEffects(tables, 'AirDown', 7).bomb?.id, 41);
    assert.equal(selectNativeEffects(tables, 'Air', 9).bomb?.id, 35);
    assert.equal(selectNativeEffects(tables, 'AirLadder', 5).bomb?.id, 60);
  },
);
test(
  'real AFB programs select one branch, execute original particles and retain unsupported commands',
  { skip: !local },
  async () => {
    const effects = await loadGameEffects(gameRoot);
    assert.equal(Object.keys(effects).length, 53);
    const reaction = sampleNativeEffectPlanes(effects.CHU_EF_Tap_reaction_v20, 5, 0);
    assert.equal(reaction.planes.length, 1);
    assert.equal(reaction.planes[0].resource, 1);
    assert.deepEqual(reaction.diagnostics, []);
    const bomb = sampleNativeEffect(effects.CHU_EF_Tap_bomb_v10, 5, 0);
    assert.equal(new Set(bomb.particles.map(p => p.node)).size, 1);
    assert.equal(bomb.particles.length, 80);
    assert.ok(bomb.partial); // Camera-facing matrix and material fade remain explicit.
    assert.ok(!bomb.diagnostics.some(d => d.includes('1003')));
    const curve = effects.CHU_EF_Tap_bomb_v10.curves![0];
    for (const [time, expected] of fixture('effect-native-curve.json'))
      assert.ok(Math.abs(sampleNativeEffectCurve(curve, time) - expected) < 0.0005, `MomCurve at ${time}`);
    assert.ok(bomb.particles.every(p => Math.abs(p.world[13] - 5.6936268) < 0.0005));
    assert.ok(
      bomb.particles.every(
        p =>
          p.material.blendEnabled &&
          p.material.blendSource === 4 &&
          p.material.blendDestination === 1 &&
          p.material.blendOperation === 0,
      ),
    );
    assert.ok(bomb.particles.every(p => p.position.every(Number.isFinite) && p.offsets.flat().every(Number.isFinite)));
    const bombResources = effectResourceIndices(effects.CHU_EF_Tap_bomb_v10, 0);
    assert.equal(bombResources.length, 1);
    assert.ok(bomb.particles.every(p => p.material.resources.every(id => bombResources.includes(id))));
    assert.notDeepEqual(bombResources, effectResourceIndices(effects.CHU_EF_Tap_bomb_v10, 1));
    assert.equal(effectLifetime(effects.CHU_EF_Tap_bomb_v10, 0), 30);
    assert.ok(sampleNativeEffect(effects.CHU_EF_Tap_bomb_v10, 29.999, 0).particles.length > 0);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_bomb_v10, 30, 0).particles.length, 0);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_bomb_v10, 1500, 0).particles.length, 0);
    const text = sampleNativeEffect(effects.CHU_EF_Tap_text_v10, 5, 0);
    assert.equal(text.planes.length, 1);
    assert.deepEqual(effectResourceIndices(effects.CHU_EF_Tap_text_v10, 0), text.planes[0].material.resources);
    assert.equal(text.planes[0].node, 20);
    assert.deepEqual(text.planes[0].uv, [Math.fround(0.477), Math.fround(0.111), 1, Math.fround(0.266)]);
    assert.equal(effectLifetime(effects.CHU_EF_Tap_text_v10, 0), 35);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_text_v10, 35, 0).planes.length, 0);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_text_v10, 0, 0).planes[0].material.color[3], 0);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_text_v10, 3, 0).planes[0].material.color[3], 129 / 255);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_text_v10, 20, 0).planes[0].material.color[3], 1);
    assert.equal(sampleNativeEffect(effects.CHU_EF_Tap_text_v10, 25, 0).planes[0].material.color[3], 0);
    const bytes = fs.readFileSync(`${gameRoot}/data/acroarts/CHU_EF_Tap_bomb_v10.afb`);
    assert.throws(() => parseGameEffectProgram(bytes.subarray(0, bytes.length / 2), 'broken'));
    const corrupt = Buffer.from(bytes);
    corrupt.writeUInt32LE(0xffffffff, effects.CHU_EF_Tap_bomb_v10.particles[0].offset);
    assert.throws(() => parseGameEffectProgram(corrupt, 'broken'));
  },
);
