import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSrdRecords } from '../src/backend/game-scene';
import { loadBundledGameResources, type GameResourceManifest } from '../src/backend/bundled-assets';

test('SRD static fields are bounded by their record rather than the following record', () => {
  const buffer = Buffer.alloc(40);
  buffer.write('VTBF'); buffer.write('SRFF', 8); buffer.write('vtc0', 16); buffer.writeUInt32LE(16, 20); buffer.write('SCN ', 24); buffer.writeUInt16LE(2, 30);
  buffer.set([0x40, 6, 0x80, 7, 0x41, 6, 0x38, 4], 32);
  assert.deepEqual(parseSrdRecords(buffer)[0].fields, [[0x40, 1920], [0x41, 1080]]);
  assert.throws(() => parseSrdRecords(buffer.subarray(0, 39)), /边界/);
  const corrupt = Buffer.from(buffer); corrupt[33] = 0x4a;
  assert.throws(() => parseSrdRecords(corrupt), /越界/);
});

test('copied classic scene resolves every texture locally and retains valid atlas and mesh bounds', async () => {
  const root = path.resolve('assets/game');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as GameResourceManifest;
  const hashes = JSON.parse(await readFile(path.join(root, 'sha256.json'), 'utf8')) as Record<string, string>;
  const { textures } = await loadBundledGameResources(root), scene = textures.scene;
  assert.ok(scene); assert.equal(scene.stage.id, 1); assert.equal(scene.stage.name, 'CHUNITHM');
  assert.equal(scene.geometry.designWidth, 1920); assert.equal(scene.geometry.designHeight, 1080);
  const stored = manifest.textures.scene!;
  for (const item of [...Object.values(stored.materials), ...Object.values(stored.hud).map(sprite => sprite.image)]) {
    assert.equal(createHash('sha256').update(await readFile(path.join(root, item.file))).digest('hex'), hashes[item.file]);
  }
  for (const item of [...Object.values(scene.materials), ...Object.values(scene.hud).map(sprite => sprite.image)]) {
    assert.ok(item.sourcePath.startsWith(`${root}${path.sep}`)); assert.ok(item.dataUrl.startsWith('data:image/png;base64,'));
  }
  for (const sprite of Object.values(scene.hud)) {
    assert.ok(sprite.rect.x >= 0 && sprite.rect.y >= 0);
    assert.ok(sprite.rect.x + sprite.rect.width <= sprite.image.width);
    assert.ok(sprite.rect.y + sprite.rect.height <= sprite.image.height);
  }
  assert.deepEqual(scene.hud.musicMaster.layout, { x: 1334, y: 0, width: 586, height: 182 });
  assert.equal(scene.hud.scoreDigit0.rect.width, 24); assert.equal(scene.hud.levelDigit0.rect.width, 28);
  assert.deepEqual(scene.hud.trackDigit1.rect, { x: 1360, y: 60, width: 14, height: 18 });
  assert.deepEqual(scene.hud.trackDigit1.layout, { x: 1572, y: 47, width: 14, height: 18 });
  assert.deepEqual([1, 2, 3, 4, 5].map(stars => scene.hud[`stars${stars}`].rect.width), [14, 28, 42, 55, 70]);
  assert.deepEqual(scene.hud.stars3.layout, { x: 1765, y: 44, width: 42, height: 16 });
  const ring = scene.geometry.meshes.ring;
  assert.equal(ring.vertexCount, 4008); assert.equal(ring.indices?.length, 4451);
  assert.equal(ring.bounds.min[2], -1); assert.equal(ring.bounds.max[2], 1);
  for (const mesh of Object.values(scene.geometry.meshes)) {
    assert.equal(mesh.vertices?.length, mesh.vertexCount);
    assert.ok(mesh.indices?.every(index => Number.isInteger(index) && index >= 0 && index < mesh.vertexCount));
  }
  assert.equal(scene.geometry.meshes.notesField.vertices?.[8].position[0], -32);
  assert.equal(scene.geometry.meshes.notesField.vertices?.[10].position[0], 32);
  assert.equal(scene.geometry.meshes.notesField.bounds.min[2], -470);
});
