import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseGameResourceTable,
  parseGameEffectTable,
  parseSvoEntries,
  getSvoRectangle,
  findEmbeddedDDS,
  decodeGameDDS,
  loadGameTextures,
} from '../src/backend/game-textures';

const u32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};
function table(type: 'model' | 'texture', name: string, filename: string): Buffer {
  const text = (s: string): Buffer => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  return Buffer.concat([
    u32(1),
    u32(7),
    text(name),
    text(name),
    text(filename),
    ...(type === 'model' ? [u32(16)] : []),
  ]);
}
function dds24(): Buffer {
  const b = Buffer.alloc(128 + 6);
  b.write('DDS ');
  b.writeUInt32LE(124, 4);
  b.writeUInt32LE(1, 12);
  b.writeUInt32LE(2, 16);
  b.writeUInt32LE(32, 76);
  b.writeUInt32LE(64, 80);
  b.writeUInt32LE(24, 88);
  [0xff0000, 0xff00, 0xff].forEach((mask, i) => b.writeUInt32LE(mask, 92 + i * 4));
  b.set([1, 2, 3, 4, 5, 6], 128);
  return b;
}
function svo(items: { name: string; kind: number; data: Buffer }[]): Buffer {
  const headerLength = 128 + items.length * 1024;
  const b = Buffer.alloc(headerLength + items.reduce((sum, item) => sum + item.data.length, 0));
  b.write('AVTS');
  b.writeUInt32LE(items.length, 4);
  let offset = headerLength;
  items.forEach((item, i) => {
    const entry = 128 + i * 1024;
    b.write(item.name, entry);
    b.writeUInt32LE(item.kind, entry + 512);
    b.writeUInt32LE(item.data.length, entry + 520);
    b.writeUInt32LE(offset, entry + 524);
    item.data.copy(b, offset);
    offset += item.data.length;
  });
  return b;
}

test('resource table reads model flags and rejects truncation or extra schema fields', () => {
  assert.deepEqual(parseGameResourceTable(table('model', 'NotesTap_04', 'tap.svo'), 'model'), [
    { id: 7, name: 'NotesTap_04', label: 'NotesTap_04', filename: 'tap.svo', flags: 16 },
  ]);
  assert.equal(parseGameResourceTable(table('texture', 'HoldJoint', 'hold.dds'), 'texture')[0].filename, 'hold.dds');
  assert.throws(() => parseGameResourceTable(table('model', 'Tap', 'tap.svo').subarray(0, -1), 'model'), /不完整/);
  assert.throws(
    () => parseGameResourceTable(Buffer.concat([table('texture', 'Hold', 'hold.dds'), u32(1)]), 'texture'),
    /结构/,
  );
});

test('effect tables retain exact source IDs and reject truncated or duplicate records', () => {
  const text = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const record = Buffer.concat([
    u32(23),
    text('EF_Tap_bomb'),
    text('tap'),
    text('CHU_EF_Tap_bomb_v10.afb'),
    u32(1),
    u32(0),
  ]);
  assert.deepEqual(parseGameEffectTable(Buffer.concat([u32(1), record]), 'acroarts'), [
    { id: 23, name: 'EF_Tap_bomb', filename: 'CHU_EF_Tap_bomb_v10.afb', values: [1, 0] },
  ]);
  const note = Buffer.concat([u32(0), text('Tap'), text('tap'), ...Array.from({ length: 14 }, (_, i) => u32(i + 20))]);
  assert.equal(parseGameEffectTable(Buffer.concat([u32(1), note]), 'notes')[0].values.length, 14);
  assert.throws(() => parseGameEffectTable(Buffer.concat([u32(2), record, record]), 'acroarts'), /结构/);
  assert.throws(() => parseGameEffectTable(Buffer.concat([u32(1), note]).subarray(0, -1), 'notes'), /不完整/);
});

test('SVO directory honors declared boundaries and exposes only actual sprite UV rectangles', () => {
  const vertices = Buffer.alloc(112);
  [
    [0, 1],
    [0, 0],
    [1, 1],
    [1, 0],
  ].forEach((uv, i) => {
    vertices.writeFloatLE(uv[0], i * 28 + 20);
    vertices.writeFloatLE(uv[1], i * 28 + 24);
  });
  const bytes = svo([
    { name: 'test.dds', kind: 1, data: dds24() },
    { name: 'test__PNCT_0000.VBO', kind: 2, data: vertices },
  ]);
  const entries = parseSvoEntries(bytes);
  assert.deepEqual(entries[0].data, dds24());
  assert.deepEqual(getSvoRectangle(entries), { u0: 0, v0: 0, u1: 1, v1: 1 });
  const mesh = svo([{ name: 'air__PNCT_0000.VBO', kind: 2, data: Buffer.alloc(18 * 28) }]);
  assert.equal(getSvoRectangle(parseSvoEntries(mesh)), undefined);
  const bad = Buffer.from(bytes);
  bad.writeUInt32LE(0, 128 + 524);
  assert.throws(() => parseSvoEntries(bad), /边界/);
  assert.throws(() => parseSvoEntries(bytes.subarray(0, -1)), /边界/);
});

test('game DDS reads real 24-bit BGR channel order and rejects truncated payload', () => {
  const decoded = decodeGameDDS(dds24());
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.data], [3, 2, 1, 255, 6, 5, 4, 255]);
  assert.throws(() => decodeGameDDS(dds24().subarray(0, -1)), /不完整/);
});

test('embedded DDS detection excludes false magic and incomplete images', () => {
  const valid = dds24();
  const container = Buffer.concat([Buffer.from('FILS fake DDS '), Buffer.alloc(128), valid, Buffer.from('DDS ')]);
  const images = findEmbeddedDDS(container);
  assert.equal(images.length, 1);
  assert.deepEqual(images[0].data, valid);
  assert.equal(findEmbeddedDDS(valid.subarray(0, -1)).length, 0);
});

test('asset importer decodes synthetic local resources and reports missing effects without hiding usable heads', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-game-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name: string, data: Buffer): Promise<void> => {
    const f = path.join(root, 'data', name);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, data);
  };
  await put('db/ModelTableRecord.bin', table('model', 'NotesTap_04', 'tap.svo'));
  await put('db/TextureTableRecord.bin', table('texture', 'HoldJoint', 'hold.dds'));
  await put('svo/tap.svo', svo([{ name: 'tap.dds', kind: 1, data: dds24() }]));
  await put('dds/hold.dds', dds24());
  const assets = await loadGameTextures(root);
  assert.equal(assets.models.NotesTap_04.nominalWidth, 16);
  assert.equal(assets.models.NotesTap_04.images[0].width, 2);
  assert.match(assets.models.NotesTap_04.images[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(assets.textures.HoldJoint.sourcePath, path.join(root, 'data/dds/hold.dds'));
  assert.equal(assets.warnings.length, 7);
});
