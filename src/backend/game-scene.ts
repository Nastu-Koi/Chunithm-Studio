import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { XMLParser } from 'fast-xml-parser';
import { decodeGameDDS, findEmbeddedDDS, parseSvoEntries } from './game-textures';
import { loadClassicStageAnimation } from './game-animation';
import { parseGameStageProgram } from './game-stage-program';
import type { GameSceneAssets, GameSceneSprite, GameTexture } from '../core/game-assets';

type Value = number | string | number[] | null;
export interface SrdRecord { tag: string; offset: number; fields: [number, Value][] }
const selectedTags = new Set(['SCN ', 'LAYR', 'NODE', 'TRS2', 'CIMG', 'CNUM', 'CSLI', 'CREF', 'TEX ', 'CROP']);

/** Reads the typed fields used by static Surfride layouts. Animation records are skipped. */
export function parseSrdRecords(buffer: Buffer): SrdRecord[] {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'VTBF' || buffer.toString('ascii', 8, 12) !== 'SRFF') throw new Error('SRD 文件头无效');
  const records: SrdRecord[] = [];
  for (let start = 16; start < buffer.length;) {
    if (start + 16 > buffer.length || buffer.toString('ascii', start, start + 4) !== 'vtc0') throw new Error('SRD 记录头无效');
    const end = start + 8 + buffer.readUInt32LE(start + 4), tag = buffer.toString('ascii', start + 8, start + 12);
    if (end < start + 16 || end > buffer.length) throw new Error('SRD 记录边界无效');
    if (selectedTags.has(tag)) {
      let p = start + 16;
      const take = (bytes: number): number => { if (bytes < 0 || p + bytes > end) throw new Error('SRD 字段越界'); const at = p; p += bytes; return at; };
      const u8 = (): number => buffer.readUInt8(take(1));
      const fields: [number, Value][] = [];
      const count = buffer.readUInt16LE(start + 14);
      for (let i = 0; i < count; i++) {
        const id = u8(), type = u8(); let value: Value;
        if (type === 0) value = null;
        else if (type === 1 || type === 3 || type === 4) value = u8();
        else if (type === 2) {
          const lead = u8(), length = lead & 0x80 ? ((lead & 0x7f) << 8) | u8() : lead;
          const at = take(length); value = buffer.toString('utf8', at, at + length).replace(/\0+$/, '');
        } else if (type === 5) value = buffer.readInt16LE(take(2));
        else if (type === 6 || type === 7) value = buffer.readUInt16LE(take(2));
        else if (type === 8 || type === 11) value = buffer.readInt32LE(take(4));
        else if (type === 9 || type === 12) value = buffer.readUInt32LE(take(4));
        else if (type === 10) value = buffer.readFloatLE(take(4));
        else if ([0x45, 0x4a, 0x4b].includes(type)) {
          const length = u8() + 2;
          value = Array.from({ length }, () => type === 0x45 ? buffer.readInt16LE(take(2)) : type === 0x4a ? buffer.readFloatLE(take(4)) : buffer.readInt32LE(take(4)));
        } else if (type === 0x84) {
          const width = u8();
          if (![8, 16, 24].includes(width)) throw new Error('SRD 数组长度格式未知');
          const length = (width === 8 ? u8() : width === 16 ? buffer.readUInt16LE(take(2)) : buffer.readUInt32LE(take(4))) + 1;
          const at = take(length); value = Array.from(buffer.subarray(at, at + length));
        } else throw new Error(`SRD 静态字段类型不受支持: ${type}`);
        fields.push([id, value]);
      }
      if (p !== end) throw new Error('SRD 字段长度与记录不一致');
      records.push({ tag, offset: start, fields });
    }
    start = end;
  }
  return records;
}
const field = (row: SrdRecord, id: number): Value | undefined => row.fields.find(pair => pair[0] === id)?.[1];
function list(row: SrdRecord): Map<number, Value>[] {
  const result: Map<number, Value>[] = []; let item = new Map<number, Value>();
  for (const [key, value] of row.fields) {
    if (key === 0xfc || key === 0xfe) { if (item.size) result.push(item); item = new Map(); }
    else if (key !== 0xfd) item.set(key, value);
  }
  if (item.size) result.push(item);
  return result;
}
export interface SrdCast {
  /** Static screen position and accumulated scale of the node; animations are not evaluated. */
  x: number; y: number; scaleX: number; scaleY: number; visible: boolean;
  /** Cast box after pivot and scale. Plain group nodes have none. */
  rect?: { x: number; y: number; width: number; height: number };
  /** `[texture, crop]` pairs of the CREF owned by this cast, in pattern order. */
  crops: number[][];
}
/** Resolves every named node of each layer as `layer/node`; the first node of a repeated name wins. */
export function resolveSrdCasts(records: readonly SrdRecord[]): Map<string, SrdCast> {
  const result = new Map<string, SrdCast>();
  let layer = '', nodes: Map<number, Value>[] = [], resolved: (SrdCast | undefined)[] = [], current: number | undefined;
  for (const row of records) {
    if (row.tag === 'LAYR') { layer = String(field(row, 0x03)); nodes = []; resolved = []; current = undefined; }
    else if (row.tag === 'NODE') nodes = list(row);
    else if (row.tag === 'TRS2') {
      const transforms = list(row), parents = new Array<number>(nodes.length).fill(-1);
      for (const [parent, node] of nodes.entries()) for (let child = Number(node.get(0x3c) ?? -1), guard = 0; child >= 0 && child < nodes.length && guard++ < nodes.length; child = Number(nodes[child].get(0x3d) ?? -1)) parents[child] = parent;
      const place = (index: number, depth = 0): SrdCast | undefined => {
        if (resolved[index]) return resolved[index];
        const transform = transforms[index], translation = transform?.get(0x34) as number[] | undefined, scale = transform?.get(0x36) as number[] | undefined;
        if (!translation || !scale || depth > nodes.length) return undefined;
        const parent = parents[index] < 0 ? { x: 0, y: 0, scaleX: 1, scaleY: 1 } : place(parents[index], depth + 1);
        if (!parent) return undefined;
        return resolved[index] = { x: parent.x + translation[0] * parent.scaleX, y: parent.y + translation[1] * parent.scaleY, scaleX: parent.scaleX * scale[0], scaleY: parent.scaleY * scale[1], visible: transform!.get(0x3b) !== 0, crops: [] };
      };
      for (const [index, node] of nodes.entries()) {
        const cast = place(index), key = `${layer}/${node.get(0x03)}`;
        if (cast && !result.has(key)) result.set(key, cast);
      }
    } else if (row.tag === 'CIMG' || row.tag === 'CNUM' || row.tag === 'CSLI') {
      current = Number(field(row, 0x51));
      const cast = resolved[current], size = [0x40, 0x41, 0x42, 0x43].map(id => Number(field(row, id)));
      // Float32 scales such as 0.7 are rounded back to the authored four decimals.
      const tidy = (value: number): number => Math.round(value * 1e4) / 1e4;
      if (cast && size.every(Number.isFinite)) cast.rect = { x: tidy(cast.x - size[2] * cast.scaleX), y: tidy(cast.y - size[3] * cast.scaleY), width: tidy(size[0] * cast.scaleX), height: tidy(size[1] * cast.scaleY) };
    } else if (row.tag === 'CREF' && current !== undefined) {
      const cast = resolved[current];
      if (cast) cast.crops = row.fields.filter(pair => pair[0] === 0x4a).map(pair => pair[1] as number[]);
      current = undefined;
    }
  }
  return result;
}
async function boundedRead(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('场景资源大小不受支持');
  return readFile(file);
}
async function image(bytes: Buffer, sourcePath: string, sourceName: string, sourceOffset: number): Promise<GameTexture> {
  const decoded = decodeGameDDS(bytes);
  const png = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: decoded.width, height: decoded.height, sourcePath, sourceName, sourceOffset };
}
function embeddedSvo(buffer: Buffer): { offset: number; entries: ReturnType<typeof parseSvoEntries> }[] {
  const result = [];
  for (let offset = buffer.indexOf('AVTS'); offset >= 0; offset = buffer.indexOf('AVTS', offset + 4)) {
    try { result.push({ offset, entries: parseSvoEntries(buffer.subarray(offset)) }); } catch { /* Other chunks can contain signature bytes. */ }
  }
  return result;
}
function mesh(buffer: Buffer, sourcePath: string, sourceOffset: number, stride: number, indexData?: Buffer, sourceIndexOffset?: number): GameSceneAssets['geometry']['meshes'][string] {
  if (buffer.length % stride) throw new Error('场景顶点缓冲长度无效');
  const vertices = Array.from({ length: buffer.length / stride }, (_, i) => ({
    position: [buffer.readFloatLE(i * stride), buffer.readFloatLE(i * stride + 4), buffer.readFloatLE(i * stride + 8)] as [number, number, number],
    uv: [buffer.readFloatLE(i * stride + 16), buffer.readFloatLE(i * stride + 20)] as [number, number],
    ...(stride === 28 ? { attachment: buffer.readUInt32LE(i * stride + 24) } : {}),
  }));
  if (!vertices.length || vertices.some(v => [...v.position, ...v.uv].some(n => !Number.isFinite(n)))) throw new Error('场景顶点无效');
  const min = [0, 1, 2].map(axis => Math.min(...vertices.map(v => v.position[axis]))) as [number, number, number];
  const max = [0, 1, 2].map(axis => Math.max(...vertices.map(v => v.position[axis]))) as [number, number, number];
  if (indexData && indexData.length % 2) throw new Error('场景索引缓冲长度无效');
  const indices = indexData ? Array.from({ length: indexData.length / 2 }, (_, i) => indexData.readUInt16LE(i * 2)) : undefined;
  if (indices?.some(i => i >= vertices.length)) throw new Error('场景顶点索引越界');
  return { sourcePath, sourceOffset, vertexCount: vertices.length, bounds: { min, max }, vertices, indices, topology: 'triangle-strip', sourceIndexOffset };
}

/** Copies are made by the importer; this function only reads the installed classic stage and HUD. */
export async function loadGameSceneAssets(gameRoot: string): Promise<GameSceneAssets> {
  const data = path.join(gameRoot, 'data'), stageFolder = path.join(data, 'A000/stage/stage000001');
  const stagePath = path.join(stageFolder, 'Stage.xml');
  const stage = new XMLParser().parse(await boundedRead(stagePath)).StageData;
  if (Number(stage?.name?.id) !== 1 || stage?.name?.str !== 'CHUNITHM') throw new Error('未找到已核对的经典 CHUNITHM 舞台');
  const scene: GameSceneAssets = {
    stage: { id: 1, name: stage.name.str, sourcePath: stagePath }, materials: {}, hud: {},
    geometry: { designWidth: 1920, designHeight: 1080, meshes: {} },
    warnings: ['经典舞台骨骼与曲线取自原资源；背景世界矩阵、相机与循环编排已核对，时间基准、材质、光照、雾与 bloom 仍需实机校准。', 'SRD 布局为静态节点坐标，未运行原游戏的动画及运行时替换。', '经典舞台缩略图是 DUMMY 占位图，未作为背景导入。'],
  };
  const baseFile = String(stage.baseFile?.path ?? ''), fieldFile = String(stage.notesFieldFile?.path ?? '');
  if (baseFile !== 'st_label_basic_0001_yellowring.afb' || fieldFile !== 'nf_label_basic_0001_yellowring.afb') throw new Error('经典舞台素材引用与已核对版本不同');
  for (const filename of [baseFile, fieldFile]) {
    const source = path.join(stageFolder, filename), bytes = await boundedRead(source), archives = embeddedSvo(bytes);
    if (filename === baseFile) scene.program = parseGameStageProgram(bytes, `data/A000/stage/stage000001/${filename}`);
    const names = new Map<number, string>();
    for (const archive of archives) for (const entry of archive.entries) {
      const offset = archive.offset + entry.offset;
      if (entry.kind === 1) names.set(offset, entry.name);
      if (entry.kind === 2 && /__PNT(W)?_\d+\.VBO$/i.test(entry.name)) {
        const role = entry.name.includes('st_00001_ring__') ? 'ring' : entry.name.includes('st_00001_grid__') ? 'grid' : entry.name.includes('notesfild__') ? 'notesField' : entry.name.includes('sideglow__') ? 'sideGlow' : 'fieldSide';
        const index = archive.entries.find(candidate => candidate.kind === 3 && candidate.name === entry.name.replace(/_\d+\.VBO$/i, '.IBO'));
        scene.geometry.meshes[role] = mesh(entry.data, source, offset, /__PNTW_/.test(entry.name) ? 28 : 24, index?.data, index ? archive.offset + index.offset : undefined);
      }
    }
    const entries = findEmbeddedDDS(bytes);
    const directNames = ['chu_st_basic_yellowring01_tail03_y_v10.dds', 'chu_st_basic_yellowring01_oval02_y_v10.dds', 'chu_st_basic_yellowring01_grade01_y_v10.dds', 'chu_st_basic_yellowring01_point01_y_v10.dds'];
    let directIndex = 0;
    for (const entry of entries) {
      const sourceName = names.get(entry.offset) ?? directNames[directIndex++];
      if (!sourceName || !bytes.includes(Buffer.from(sourceName))) throw new Error('舞台材质名称无法核对');
      const role = /RingColor/.test(sourceName) ? 'ringColor' : /Grid_df/.test(sourceName) ? 'grid' : /mainfild/.test(sourceName) ? 'notesField' : /sideglow/.test(sourceName) ? 'sideGlow' : /side_y/.test(sourceName) ? 'fieldSide' : /tail03/.test(sourceName) ? 'ringTail' : /oval02/.test(sourceName) ? 'ringOval' : /grade01/.test(sourceName) ? 'ringGradient' : 'ringPoint';
      scene.materials[role] = await image(entry.data, source, sourceName, entry.offset);
    }
  }
  scene.animation = await loadClassicStageAnimation(gameRoot);
  scene.warnings.push(...scene.animation.warnings);
  await loadHud(scene, data);
  for (const [filename, role, index] of [['chu_count_combo.afb', 'comboLabel', 1], ['chu_count_score.afb', 'scoreLabel', 0]] as const) {
    const source = path.join(data, 'acroarts', filename), entry = findEmbeddedDDS(await boundedRead(source))[index];
    if (!entry) throw new Error(`未找到 ${role} 贴图`);
    const decoded = await image(entry.data, source, role, entry.offset);
    scene.hud[role] = { image: decoded, rect: { x: 0, y: 0, width: decoded.width, height: decoded.height }, sourceLayout: source, sourceOffset: entry.offset };
  }
  return scene;
}

async function loadHud(scene: GameSceneAssets, data: string): Promise<void> {
  const sourceLayout = path.join(data, 'surfboard/play/musicInfo/CHU_UI_Playing_00_v10.srd');
  const records = parseSrdRecords(await boundedRead(sourceLayout));
  const firstScene = records.find(row => row.tag === 'SCN ');
  if (!firstScene || field(firstScene, 0x40) !== 1920 || field(firstScene, 0x41) !== 1080) throw new Error('HUD 设计尺寸与已核对版本不一致');
  const textureRows = records.filter(row => row.tag === 'TEX '), crops = records.filter(row => row.tag === 'CROP');
  const atlasIndex = textureRows.findIndex(row => field(row, 0x61) === 'CHU_UI_playing_00_v11');
  if (atlasIndex < 0 || !crops[atlasIndex]) throw new Error('HUD 图集引用不存在');
  const atlasName = String(field(textureRows[atlasIndex], 0x61)), atlasPath = path.join(data, 'surfboard/texture', `${atlasName}.dds`);
  const atlas = await image(await boundedRead(atlasPath), atlasPath, atlasName, 0);
  const cropRows = crops[atlasIndex].fields.filter(pair => pair[0] === 0x65).map(pair => pair[1] as number[]);
  const add = (name: string, index: number, layout?: GameSceneSprite['layout']): void => {
    const c = cropRows[index];
    if (!c || c.length !== 4 || c[0] < 0 || c[1] < 0 || c[2] > atlas.width || c[3] > atlas.height || c[2] <= c[0] || c[3] <= c[1]) throw new Error('HUD 裁剪边界无效');
    scene.hud[name] = { image: atlas, rect: { x: c[0], y: c[1], width: c[2] - c[0], height: c[3] - c[1] }, layout, sourceLayout, sourceOffset: crops[atlasIndex].offset };
  };
  // Crop identities are cross-checked against the named SRD casts below.
  for (const [name, index] of [['Basic', 0], ['Advanced', 1], ['Expert', 2], ['Master', 3], ['WorldsEnd', 4], ['Ultima', 89]] as const) add(`music${name}`, index, { x: 1334, y: 0, width: 586, height: 182 });
  for (const [name, index] of [['Basic', 90], ['Advanced', 91], ['Expert', 92], ['Master', 93], ['WorldsEnd', 94], ['Ultima', 96]] as const) add(`banner${name}`, index, { x: 0, y: 0, width: 586, height: 182 });
  for (let digit = 0; digit < 10; digit++) {
    add(`levelDigit${digit}`, 78 + digit); add(`scoreDigit${digit}`, 108 + digit); add(`comboDigit${digit}`, 108 + digit); add(`judgeDigit${digit}`, 12 + digit);
    add(`trackDigit${digit}`, 68 + digit, { x: 1572, y: 47, width: 14, height: 18 });
  }
  for (const [stars, crop] of [49, 52, 54, 56, 51].entries()) {
    const rectangle = cropRows[crop];
    add(`stars${stars + 1}`, crop, { x: 1765, y: 44, width: rectangle[2] - rectangle[0], height: 16 });
  }
  add('levelPlus', 88); add('judgeHeader', 129, { x: 578, y: 0, width: 764, height: 36 });
  add('musicOptions', 6, { x: 1362, y: 0, width: 489, height: 36 });
  add('gaugeBlue', 7, { x: 689, y: 70, width: 544, height: 58 }); add('gaugeYellow', 8, { x: 689, y: 70, width: 544, height: 58 });
  // Verify semantic assignments from the original CNUM/CIMG and following CREF.
  let nodes: Map<number, Value>[] = [], transforms: Map<number, Value>[] = [], currentNode: number | undefined;
  const found = new Set<string>();
  for (const row of records) {
    if (row.tag === 'LAYR') { nodes = []; transforms = []; currentNode = undefined; }
    if (row.tag === 'NODE') nodes = list(row);
    if (row.tag === 'TRS2') transforms = list(row);
    if (row.tag === 'CIMG' || row.tag === 'CNUM') currentNode = Number(field(row, 0x51));
    if (row.tag === 'CREF' && currentNode !== undefined) {
      const name = nodes[currentNode]?.get(0x03), refs = row.fields.filter(pair => pair[0] === 0x4a).map(pair => pair[1] as number[]);
      const expected = name === 'C_score_num' || name === 'C_combo_num' ? 108 : name === 'C_music_level_normal_num' ? 78 : name === 'C_track_num' ? 68 : undefined;
      if (expected !== undefined) {
        if (refs.length < 10 || refs.slice(0, 10).some((ref, i) => ref[0] !== atlasIndex || ref[1] !== expected + i)) throw new Error('HUD 数字用途与已核对版本不同');
        found.add(String(name));
      }
      if (name === 'C_music_box_jacket_level_box_WE_level') {
        const fullStars = [49, 52, 54, 56, 51];
        if (refs.length !== 20 || fullStars.some((crop, i) => refs[i * 2 + 1]?.[0] !== atlasIndex || refs[i * 2 + 1]?.[1] !== crop)) throw new Error('HUD 星级用途与已核对版本不同');
      }
      if (name === 'PAT_base_left' || name === 'PAT_base_right') {
        const translation = transforms[currentNode]?.get(0x34) as number[] | undefined;
        if (!translation || translation[1] !== -540 || Math.abs(translation[0]) !== 960) throw new Error('难度背景位置与已核对版本不同');
      }
      currentNode = undefined;
    }
  }
  if (found.size !== 4) throw new Error('未找到全部 HUD 数字用途引用');
  // Remaining play-screen casts take both crop and placement from their named SRD node.
  const casts = resolveSrdCasts(records);
  const cast = (key: string): SrdCast => { const value = casts.get(key); if (!value) throw new Error(`HUD 节点不存在: ${key}`); return value; };
  const addCast = (name: string, key: string, pattern = 0, placed = true): void => {
    const source = cast(key), ref = source.crops[pattern];
    if (!ref || ref[0] !== atlasIndex) throw new Error(`HUD 节点贴图与已核对版本不同: ${key}`);
    add(name, ref[1], placed ? source.rect : undefined);
  };
  addCast('scoreComma', 'L_Playing_gauge/C_score_num', 10, false); addCast('speedDot', 'L_Playing_music/NUM_speed', 10, false);
  addCast('mirrorOff', 'L_Playing_music/PAT_mirror', 0); addCast('mirrorOn', 'L_Playing_music/PAT_mirror', 1);
  addCast('gaugeEdge', 'L_Playing_gauge/C_gauge_eff_00', 0, false);
  for (const [index, side] of ['Left', 'Center', 'Right'].entries()) addCast(`frameShadow${side}`, 'L_Playing_difficulty/Shadow', index);
  // Each stock box is a linked layer drawn at its reference node; twelve are visible before any animation.
  const stocks = Array.from({ length: 20 }, (_, index) => cast(`L_Playing_gauge/C_gauge_stock_ref_${String(index).padStart(2, '0')}`));
  if (stocks.filter(stock => stock.visible).length !== 12 || stocks.some((stock, index) => stock.x !== stocks[0].x + 37 * index || stock.y !== stocks[0].y)) throw new Error('技能槽方块位置与已核对版本不同');
  const empty = cast('L_Playing_gauge_stock_box/C_gauge_empty');
  addCast('stockEmpty', 'L_Playing_gauge_stock_box/C_gauge_empty', 0, false);
  scene.hud.stockEmpty.layout = { ...empty.rect!, x: empty.rect!.x + stocks[0].x, y: empty.rect!.y + stocks[0].y };
  await loadPlayerPlate(scene, data, cast('L_Playing_gauge/DMY_Frame').rect!);
}

/** The frame and player plate are textures the game composes at run time; both use the default-owned item 1. */
async function loadPlayerPlate(scene: GameSceneAssets, data: string, frameLayout: NonNullable<GameSceneSprite['layout']>): Promise<void> {
  const item = async (folder: string, file: string, root: string, layout: NonNullable<GameSceneSprite['layout']>): Promise<GameSceneSprite> => {
    const sourceLayout = path.join(data, 'A000', folder, file), xml = new XMLParser().parse(await boundedRead(sourceLayout))[root];
    if (Number(xml?.name?.id) !== 1 || xml?.defaultHave !== true) throw new Error(`${root} 默认项与已核对版本不同`);
    const source = path.join(path.dirname(sourceLayout), String(xml.image?.path ?? '')), decoded = await image(await boundedRead(source), source, path.basename(source, '.dds'), 0);
    if (decoded.width !== layout.width || decoded.height !== layout.height) throw new Error(`${root} 尺寸与原布局不一致`);
    return { image: decoded, rect: { x: 0, y: 0, width: decoded.width, height: decoded.height }, layout, sourceLayout, sourceOffset: 0 };
  };
  scene.hud.frame = await item('frame/frame00000001', 'Frame.xml', 'FrameData', frameLayout);
  const textures = new Map<string, GameTexture>();
  const layoutSprites = async (file: string, wanted: [name: string, key: string, origin?: string][]): Promise<Map<string, SrdCast>> => {
    const sourceLayout = path.join(data, 'surfboard/common', file), records = parseSrdRecords(await boundedRead(sourceLayout)), casts = resolveSrdCasts(records);
    const textureRows = records.filter(row => row.tag === 'TEX '), cropRows = records.filter(row => row.tag === 'CROP');
    for (const [name, key, origin] of wanted) {
      const source = casts.get(key), base = origin ? casts.get(origin) : { x: 0, y: 0 }, ref = source?.crops[0];
      const atlasName = ref && textureRows[ref[0]] && field(textureRows[ref[0]], 0x61), crop = ref && cropRows[ref[0]]?.fields.filter(pair => pair[0] === 0x65)[ref[1]]?.[1] as number[] | undefined;
      if (!source?.rect || !base || typeof atlasName !== 'string' || !/^CHU_UI_\w+$/.test(atlasName) || crop?.length !== 4) throw new Error(`玩家信息节点与已核对版本不同: ${key}`);
      if (!textures.has(atlasName)) { const atlasPath = path.join(data, 'surfboard/texture', `${atlasName}.dds`); textures.set(atlasName, await image(await boundedRead(atlasPath), atlasPath, atlasName, 0)); }
      const atlas = textures.get(atlasName)!;
      if (crop[0] < 0 || crop[1] < 0 || crop[2] > atlas.width || crop[3] > atlas.height || crop[2] <= crop[0] || crop[3] <= crop[1]) throw new Error('玩家信息裁剪边界无效');
      scene.hud[name] = { image: atlas, rect: { x: crop[0], y: crop[1], width: crop[2] - crop[0], height: crop[3] - crop[1] }, layout: { ...source.rect, x: source.rect.x + base.x, y: source.rect.y + base.y }, sourceLayout, sourceOffset: cropRows[ref![0]].offset };
    }
    return casts;
  };
  // Level and rating use the original hidden-value casts: the preview has no player profile to show.
  const player = await layoutSprites('playerData/CHU_UI_PlayerData_00_v10.srd', [
    ['nameBase', 'L_Playing_player/C_base'], ['charaBase', 'L_Playing_player/C_chara_base'],
    ['levelLabel', 'L_Playing_player/C_player_level_txt'], ['levelHidden', 'L_Playing_player/C_no_disp'],
    ['ratingLabel', 'L_CHU_UI_Common_Rating_00/C_player_rating_no_disp_06', 'L_Playing_player/C_player_rating'],
    ['ratingHidden', 'L_CHU_UI_Common_Rating_00/C_player_rating_no_disp_01', 'L_Playing_player/C_player_rating'],
  ]);
  const plate = player.get('L_Playing_player/C_nameplate_dummy')?.rect, trophy = player.get('L_Playing_player/C_player_character_title_rank')?.rect;
  if (!plate || !trophy) throw new Error('未找到名牌或称号节点');
  scene.hud.namePlate = await item('namePlate/namePlate00000001', 'NamePlate.xml', 'NamePlateData', plate);
  // The plate shows a run-time texture of the trophy bar; the normal-rank bar is placed where its dummy sits.
  await layoutSprites('trophyRank/CHU_UI_Character_title_rank_00_v10.srd', [['trophyBase', 'L_player_character_title_rank_big_org/C_player_title_base']]);
  scene.hud.trophyBase.layout = trophy;
}
