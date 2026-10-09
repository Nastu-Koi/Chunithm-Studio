import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSvoMeshes } from '../src/backend/game-models';
import type { SvoEntry } from '../src/backend/game-textures';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-note-meshes.json', import.meta.url), 'utf8')) as {
  models: { name: string; entries: (Omit<SvoEntry, 'data'> & { data: string })[] }[];
};
const source = (name: string): SvoEntry[] => fixture.models.find(m => m.name === name)!.entries.map(e => ({ ...e, data: Buffer.from(e.data, 'base64') }));

test('original AIR object graph binds its own image, triangle strip and vertex alpha', () => {
  const mesh = parseSvoMeshes(source('NotesAirU_04'));
  assert.ok(mesh.length >= 1);
  assert.ok(mesh.every(m => m.indices.length > 0 && m.indices.length % 3 === 0));
  const vertices = mesh.flatMap(m => m.vertices);
  assert.ok(Math.abs(Math.min(...vertices.map(v => v.position[1]))) < 1e-4);
  assert.ok(Math.abs(Math.max(...vertices.map(v => v.position[1])) - 15.574455) < 1e-4);
  assert.ok(vertices.some(v => Math.abs(v.color[3] - 0.2) < 1e-4));
  assert.deepEqual(mesh.map(m => [m.material.blendSource, m.material.blendDestination]), [[4, 5], [4, 1]]);
  for (const m of mesh) assert.ok(m.indices.every(i => i < m.vertices.length));
});

test('CRUSH preserves two texture bindings with separate UV coordinates and additive material', () => {
  const mesh = parseSvoMeshes(source('NotesAirLadder_04'));
  const glow = mesh.find(m => m.material.textures.length === 2)!;
  assert.ok(glow);
  assert.deepEqual(glow.material.textures.map(t => [t.image, t.uvSet]), [[2, 0], [0, 1]]);
  assert.ok(glow.vertices.every(v => v.uv2));
  assert.equal(glow.material.blendSource, 4);
  assert.equal(glow.material.blendDestination, 1);
  assert.deepEqual(glow.material.textureLayers?.[0], { sourceFactor: 1, destinationFactor: 1, operation: 2 });
  assert.ok(mesh.some(m => m.material.textures.length === 1));
});

test('original untextured arch is retained with alpha gradient instead of discarded as missing DDS', () => {
  const mesh = parseSvoMeshes(source('NotesAirArch_04'));
  assert.ok(mesh.length);
  assert.ok(mesh.every(m => m.material.textures.length === 0));
  const alpha = mesh.flatMap(m => m.vertices.map(v => v.color[3]));
  assert.equal(Math.min(...alpha), 0);
  assert.equal(Math.max(...alpha), 1);
});

test('model parser rejects invalid source buffers and missing exact image binding', () => {
  const sourceEntries = source('NotesAirU_04');
  const badIndex = sourceEntries.map(e => ({ ...e, data: Buffer.from(e.data) }));
  badIndex.find(e => e.kind === 3)!.data.writeUInt16LE(65535, 0);
  assert.throws(() => parseSvoMeshes(badIndex), /索引越界/);
  assert.throws(() => parseSvoMeshes(sourceEntries.filter(e => e.kind !== 1)), /纹理引用/);
});
