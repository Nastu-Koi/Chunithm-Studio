import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decodeDDS } from './dds-preview';
import { parseSvoMeshes } from './game-models';
import { parseAfbResources } from './game-animation';
import type { GameTexture, GameModelTexture, GameTextures } from '../core/game-assets';
export type { GameTexture, GameModelTexture, GameTextures } from '../core/game-assets';
export interface ResourceTableRecord { id: number; name: string; label: string; filename: string; flags?: number }
export interface SvoEntry { name: string; kind: number; offset: number; size: number; data: Buffer }

/** Current tables: id, two/three UTF-8 strings, then fixed numeric fields. */
export function parseGameEffectTable(buffer: Buffer, type: 'acroarts' | 'notes'): { id: number; name: string; filename: string; values: number[] }[] {
  let at = 0;
  const uint = () => { if (at + 4 > buffer.length) throw new Error('特效资源表不完整'); const n = buffer.readUInt32LE(at); at += 4; return n; };
  const string = () => { const n = uint(); if (n > 4096 || at + n > buffer.length) throw new Error('特效资源表字符串无效'); const s = buffer.toString('utf8', at, at + n).replace(/\0+$/, ''); at += n; return s; };
  const count = uint(); if (count > 10000) throw new Error('特效资源表项目数无效');
  const records = Array.from({ length: count }, () => {
    const id = uint(), name = string(); string();
    const filename = type === 'acroarts' ? string() : '';
    const values = Array.from({ length: type === 'acroarts' ? 2 : 14 }, uint);
    return { id, name, filename, values };
  });
  if (at !== buffer.length || new Set(records.map(r => r.id)).size !== records.length) throw new Error('特效资源表结构无效');
  return records;
}

/** The installed game's tables contain a count and length-prefixed UTF-8 strings. */
export function parseGameResourceTable(buffer: Buffer, type: 'model' | 'texture'): ResourceTableRecord[] {
  let offset = 0;
  const uint = (): number => {
    if (offset + 4 > buffer.length) throw new Error('游戏资源表不完整');
    const value = buffer.readUInt32LE(offset); offset += 4; return value;
  };
  const string = (): string => {
    const length = uint();
    if (length > 4096 || offset + length > buffer.length) throw new Error('游戏资源表字符串无效');
    const value = buffer.toString('utf8', offset, offset + length).replace(/\0+$/, ''); offset += length; return value;
  };
  const count = uint();
  if (count > 10000) throw new Error('游戏资源表项目数无效');
  const records: ResourceTableRecord[] = [];
  for (let i = 0; i < count; i++) {
    const record: ResourceTableRecord = { id: uint(), name: string(), label: string(), filename: string() };
    if (type === 'model') record.flags = uint();
    records.push(record);
  }
  if (offset !== buffer.length) throw new Error('未知的游戏资源表结构');
  return records;
}

/** AVTS is an archive: 128-byte header and 1024-byte named directory entries. */
export function parseSvoEntries(buffer: Buffer): SvoEntry[] {
  if (buffer.length < 128 || buffer.toString('ascii', 0, 4) !== 'AVTS') throw new Error('SVO 容器头无效');
  const count = buffer.readUInt32LE(4), directoryEnd = 128 + count * 1024;
  if (count > 4096 || directoryEnd > buffer.length) throw new Error('SVO 目录不完整');
  const result: SvoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const start = 128 + i * 1024;
    const name = buffer.toString('utf8', start, start + 512).split('\0')[0];
    const kind = buffer.readUInt32LE(start + 512), size = buffer.readUInt32LE(start + 520), offset = buffer.readUInt32LE(start + 524);
    if (!name || offset < directoryEnd || offset + size > buffer.length) throw new Error('SVO 项目边界无效');
    result.push({ name, kind, offset, size, data: buffer.subarray(offset, offset + size) });
  }
  return result;
}

/** Only expose a sprite rectangle when its four P(N)(C)T vertices use one UV rectangle. */
export function getSvoRectangle(entries: SvoEntry[]): GameModelTexture['rectangle'] {
  const vertices = entries.filter(entry => /__PNC?T_\d+\.VBO$/i.test(entry.name));
  if (vertices.length !== 1) return undefined;
  const stride = /__PNCT_/i.test(vertices[0].name) ? 28 : 24;
  if (vertices[0].size !== 4 * stride) return undefined;
  const uv = Array.from({ length: 4 }, (_, i) => [vertices[0].data.readFloatLE(i * stride + stride - 8), vertices[0].data.readFloatLE(i * stride + stride - 4)]);
  if (uv.some(pair => pair.some(value => !Number.isFinite(value)))) return undefined;
  const us = [...new Set(uv.map(pair => pair[0]))].sort((a, b) => a - b), vs = [...new Set(uv.map(pair => pair[1]))].sort((a, b) => a - b);
  if (us.length !== 2 || vs.length !== 2 || new Set(uv.map(pair => pair.join(','))).size !== 4) return undefined;
  if (us[0] < 0 || vs[0] < 0 || us[1] > 1 || vs[1] > 1) return undefined;
  return { u0: us[0], v0: vs[0], u1: us[1], v1: vs[1] };
}

function safeResourcePath(root: string, filename: string): string {
  if (!filename || filename.includes('..') || /[\\/]/.test(filename) || path.isAbsolute(filename)) throw new Error('资源文件名无效');
  return path.join(root, filename);
}
async function boundedRead(filename: string): Promise<Buffer> {
  const info = await stat(filename);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('资源文件大小不受支持');
  return readFile(filename);
}
async function texture(buffer: Buffer, sourcePath: string, sourceName: string, sourceOffset: number): Promise<GameTexture> {
  const decoded = decodeGameDDS(buffer);
  const png = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: decoded.width, height: decoded.height, sourcePath, sourceName, sourceOffset };
}

/** SVO also uses tightly packed BGR24 DDS; jacket decoder already handles other formats. */
export function decodeGameDDS(buffer: Buffer): ReturnType<typeof decodeDDS> {
  if (buffer.length < 128 || buffer.toString('ascii', 0, 4) !== 'DDS ' || buffer.readUInt32LE(88) !== 24) return decodeDDS(buffer);
  const width = buffer.readUInt32LE(16), height = buffer.readUInt32LE(12);
  if (width < 1 || height < 1 || width * height > 16777216 || buffer.length < 128 + width * height * 3) throw new Error('DDS 24 位像素数据不完整');
  if (buffer.readUInt32LE(92) !== 0xff0000 || buffer.readUInt32LE(96) !== 0xff00 || buffer.readUInt32LE(100) !== 0xff || buffer.readUInt32LE(104) !== 0) throw new Error('未知的 DDS 24 位颜色布局');
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = buffer[128 + i * 3 + 2]; data[i * 4 + 1] = buffer[128 + i * 3 + 1]; data[i * 4 + 2] = buffer[128 + i * 3]; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** AFB effect containers embed standalone DDS images. Header and payload are validated before use. */
export function findEmbeddedDDS(buffer: Buffer): { offset: number; data: Buffer }[] {
  const result: { offset: number; data: Buffer }[] = [];
  for (let offset = buffer.indexOf('DDS '); offset >= 0; offset = buffer.indexOf('DDS ', offset + 4)) {
    if (offset + 128 > buffer.length || buffer.readUInt32LE(offset + 4) !== 124 || buffer.readUInt32LE(offset + 76) !== 32) continue;
    const width = buffer.readUInt32LE(offset + 16), height = buffer.readUInt32LE(offset + 12);
    if (width < 1 || height < 1 || width * height > 16777216) continue;
    const fourCC = buffer.toString('ascii', offset + 84, offset + 88);
    const bytes = fourCC === 'DXT1' ? Math.ceil(width / 4) * Math.ceil(height / 4) * 8
      : ['DXT3', 'DXT5'].includes(fourCC) ? Math.ceil(width / 4) * Math.ceil(height / 4) * 16
        : [16, 24, 32].includes(buffer.readUInt32LE(offset + 88)) ? width * height * buffer.readUInt32LE(offset + 88) / 8 : -1;
    if (bytes < 0 || offset + 128 + bytes > buffer.length) continue;
    result.push({ offset, data: buffer.subarray(offset, offset + 128 + bytes) });
  }
  return result;
}

const effectFiles = ['CHU_EF_Tap_bomb_v10.afb', 'CHU_EF_Flick_bomb_v10.afb', 'CHU_EF_Tap_reaction_v10.afb', 'CHU_EF_Tap_text_v10.afb', 'CHU_EF_Tap_textAirAction_v10.afb', 'chu_ef_air_bomb_04.afb', 'chu_ef_airdown_bomb_04.afb'];

/** Reads only the user's installation. Missing/changed formats are returned as explicit warnings. */
export async function loadGameTextures(gameRoot: string): Promise<GameTextures> {
  const result: GameTextures = { gameRoot, models: {}, textures: {}, effects: {}, warnings: [] };
  const data = path.join(gameRoot, 'data');
  const report = (source: string, error: unknown): void => { result.warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`); };
  let models: ResourceTableRecord[] = [], textures: ResourceTableRecord[] = [];
  try { models = parseGameResourceTable(await boundedRead(path.join(data, 'db', 'ModelTableRecord.bin')), 'model'); }
  catch (error) { report('ModelTableRecord.bin', error); }
  try { textures = parseGameResourceTable(await boundedRead(path.join(data, 'db', 'TextureTableRecord.bin')), 'texture'); }
  catch (error) { report('TextureTableRecord.bin', error); }
  let selectedEffects = effectFiles;
  try {
    const acroarts = parseGameEffectTable(await boundedRead(path.join(data, 'db', 'AcroartsTableRecord.bin')), 'acroarts');
    const notes = parseGameEffectTable(await boundedRead(path.join(data, 'db', 'NotesEffectTableRecord.bin')), 'notes');
    if (notes.some(n => n.values.some(id => !acroarts.some(a => a.id === id)))) throw new Error('音符特效引用不存在');
    result.effectTables = { acroarts, notes: notes.map(({ id, name, values }) => ({ id, name, values })) };
    selectedEffects = [...new Set(acroarts.filter(r => /^EF_/i.test(r.name) && r.filename).map(r => r.filename))];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report('Effect tables', error);
  }
  // Ground heads and AIR materials have separate records for each supported width.
  const selected = models.filter(record => /^(Notes|GoalLine$)/.test(record.name) && record.filename);
  for (let index = 0; index < selected.length; index += 8) await Promise.all(selected.slice(index, index + 8).map(async record => {
    try {
      const source = safeResourcePath(path.join(data, 'svo'), record.filename), entries = parseSvoEntries(await boundedRead(source));
      const images = await Promise.all(entries.filter(entry => entry.kind === 1 && /\.dds$/i.test(entry.name)).map(entry => texture(entry.data, source, entry.name, entry.offset)));
      let meshes: GameModelTexture['meshes'];
      try { meshes = parseSvoMeshes(entries); } catch (error) { report(`${record.name} mesh`, error); }
      if (!images.length && !meshes?.length) throw new Error('模型不含受支持的 DDS 贴图或原生网格');
      result.models[record.name] = { images, nominalWidth: record.flags, rectangle: getSvoRectangle(entries), meshes };
    } catch (error) { report(record.name, error); }
  }));
  for (const record of textures) {
    try {
      const source = safeResourcePath(path.join(data, 'dds'), record.filename);
      result.textures[record.name] = await texture(await boundedRead(source), source, record.filename, 0);
    } catch (error) { report(record.name, error); }
  }
  for (const filename of selectedEffects) {
    try {
      const source = safeResourcePath(path.join(data, 'acroarts'), filename), buffer = await boundedRead(source);
      if (buffer.toString('ascii', 0, 4) !== 'FILS') throw new Error('未知的 AFB 容器');
      const images = findEmbeddedDDS(buffer);
      if (!images.length) throw new Error('特效中未找到受支持的 DDS 贴图');
      const names = new Map<number, string>();
      for (const r of parseAfbResources(buffer)) {
        if (/\.dds$/i.test(r.name)) names.set(r.offset, r.name);
        else if (r.data.toString('ascii', 0, 4) === 'AVTS') for (const e of parseSvoEntries(r.data)) if (e.kind === 1) names.set(r.offset + e.offset, e.name);
      }
      result.effects[filename.replace(/\.afb$/i, '')] = await Promise.all(images.map((entry, index) => texture(entry.data, source, names.get(entry.offset) ?? `DDS_${index}`, entry.offset)));
    } catch (error) { report(filename, error); }
  }
  return result;
}
