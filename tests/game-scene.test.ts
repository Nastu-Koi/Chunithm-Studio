import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSrdRecords, resolveSrdCasts, type SrdRecord } from '../src/backend/game-scene';
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

test('SRD casts take placement from their parent chain and crops from the CREF they own', () => {
  const node = (name: string, child: number, sibling: number): [number, string | number | null][] => [[0xfc, null], [0x03, name], [0x3c, child], [0x3d, sibling]];
  const transform = (x: number, y: number, scale: number, visible = 1): [number, number | number[] | null][] => [[0xfc, null], [0x34, [x, y]], [0x36, [scale, scale]], [0x3b, visible]];
  const cast = (tag: string, index: number, size: number[]): SrdRecord => ({ tag, offset: 0, fields: [[0x51, index], [0x40, size[0]], [0x41, size[1]], [0x42, size[2]], [0x43, size[3]]] });
  const crops = (...refs: number[][]): SrdRecord => ({ tag: 'CREF', offset: 0, fields: refs.map(ref => [0x4a, ref]) });
  const casts = resolveSrdCasts([
    { tag: 'LAYR', offset: 0, fields: [[0x03, 'L']] },
    // root → half-scale group → image and hidden text; the slice and a repeated name are root siblings of the group.
    { tag: 'NODE', offset: 0, fields: [...node('root', 1, -1), ...node('group', 2, 4), ...node('image', -1, 3), ...node('text', -1, -1), ...node('slice', -1, 5), ...node('image', -1, -1)] },
    { tag: 'TRS2', offset: 0, fields: [...transform(960, 540, 1), ...transform(-100, -440, .5), ...transform(20, 10, 1), ...transform(0, 0, 1, 0), ...transform(0, -504, 1), ...transform(1, 1, 1)] },
    cast('CIMG', 2, [40, 20, 20, 10]), crops([11, 7], [11, 8]),
    cast('CIMG', 3, [100, 14, 0, 14]),
    cast('CSLI', 4, [784, 128, 392, 0]), crops([11, 130], [11, 132], [11, 131]),
    cast('CIMG', 5, [8, 8, 0, 0]), crops([3, 0]),
  ]);
  assert.deepEqual(casts.get('L/group'), { x: 860, y: 100, scaleX: .5, scaleY: .5, visible: true, crops: [] });
  // Translation and size are scaled by the parent; the pivot is subtracted after scaling.
  assert.deepEqual(casts.get('L/image'), { x: 870, y: 105, scaleX: .5, scaleY: .5, visible: true, rect: { x: 860, y: 100, width: 20, height: 10 }, crops: [[11, 7], [11, 8]] });
  // A text cast has no CREF and must not take the one that follows the slice.
  assert.deepEqual(casts.get('L/text'), { x: 860, y: 100, scaleX: .5, scaleY: .5, visible: false, rect: { x: 860, y: 93, width: 50, height: 7 }, crops: [] });
  assert.deepEqual(casts.get('L/slice'), { x: 960, y: 36, scaleX: 1, scaleY: 1, visible: true, rect: { x: 568, y: 36, width: 784, height: 128 }, crops: [[11, 130], [11, 132], [11, 131]] });
});

test('copied classic scene resolves every texture locally and retains valid atlas and mesh bounds', async () => {
  const root = path.resolve('assets/game');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as GameResourceManifest;
  const hashes = JSON.parse(await readFile(path.join(root, 'sha256.json'), 'utf8')) as Record<string, string>;
  const { textures } = await loadBundledGameResources(root), scene = textures.scene;
  assert.ok(scene); assert.equal(scene.stage.id, 1); assert.equal(scene.stage.name, 'CHUNITHM');
  assert.equal(scene.geometry.designWidth, 1920); assert.equal(scene.geometry.designHeight, 1080);
  const stored = manifest.textures.scene!;
  // The default FIELD WALL: 640×480, the 4:3 of the game's 72×54 wall quad.
  assert.deepEqual([stored.materials.fieldWall.width, stored.materials.fieldWall.height, stored.materials.fieldWall.sourcePath], [640, 480, 'data/A000/ddsFieldWall/ddsFieldWall0001/CHU_UI_Fieldwall_0001.dds']);
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
  // Casts resolved by SRD node name: crop from the node's CREF, layout from its static parent chain.
  assert.deepEqual(scene.hud.frame.layout, { x: 578, y: 36, width: 764, height: 140 });
  assert.deepEqual([scene.hud.frame.image.width, scene.hud.frame.image.height], [764, 140]);
  assert.deepEqual(scene.hud.namePlate.layout, { x: 0, y: 0, width: 576, height: 228 });
  assert.deepEqual(scene.hud.frameShadowLeft.layout, { x: 568, y: 36, width: 784, height: 128 });
  assert.deepEqual(['Left', 'Center', 'Right'].map(side => scene.hud[`frameShadow${side}`].rect.width), [16, 6, 16]);
  assert.deepEqual(scene.hud.stockEmpty.layout, { x: 708, y: 129, width: 64, height: 46 });
  assert.deepEqual(scene.hud.mirrorOff.rect, { x: 1225, y: 58, width: 36, height: 16 });
  assert.deepEqual(scene.hud.mirrorOff.layout, { x: 1768, y: 13, width: 36, height: 16 });
  assert.deepEqual([scene.hud.scoreComma.rect.width, scene.hud.scoreComma.rect.height, scene.hud.speedDot.rect.width, scene.hud.speedDot.rect.height], [12, 32, 6, 8]);
  assert.deepEqual(scene.hud.nameBase.layout, { x: 140, y: 83, width: 328, height: 90 });
  assert.deepEqual(scene.hud.trophyBase.layout, { x: 135.2, y: 38.8, width: 425.6, height: 50.4 });
  assert.deepEqual([scene.hud.trophyBase.rect.width, scene.hud.trophyBase.rect.height], [608, 72]);
  assert.deepEqual(scene.hud.levelHidden.layout, { x: 172, y: 104, width: 32, height: 32 });
  assert.deepEqual(scene.hud.ratingLabel.layout, { x: 148, y: 144, width: 68, height: 28 });
  assert.deepEqual(scene.hud.ratingHidden.layout, { x: 214, y: 148, width: 86, height: 17 });
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
