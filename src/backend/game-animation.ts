import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSvoEntries } from './game-textures';
import type {
  StageAnimation,
  StageAnimationClip,
  StageAnimationNode,
  StageBone,
  StageCurve,
  StageKey,
} from '../core/stage-animation';

interface YabxFieldDefinition {
  name: string;
  flags: number;
  size: number;
}
interface YabxClass {
  name: string;
  base: number;
  fields: YabxFieldDefinition[];
}
export interface YabxField {
  offset: number;
  data: Buffer;
  variable: boolean;
}
export interface YabxObject {
  index: number;
  className: string;
  offset: number;
  fields: Record<string, YabxField>;
}
export interface YabxDocument {
  rootClass: string;
  name: string;
  byteLength: number;
  classes: YabxClass[];
  objects: YabxObject[];
}

/** The file carries its own class and field schema; no original executable is used. */
export function parseYabx(buffer: Buffer, opaqueClasses: readonly string[] = []): YabxDocument {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'YABX' || buffer.readUInt32LE(4) !== 1)
    throw new Error('不支持的 YABX 头');
  const end = 16 + buffer.readUInt32LE(8);
  if (end > buffer.length || end < 16) throw new Error('YABX 数据不完整');
  let p = 16;
  const take = (size: number, bound = end): number => {
    if (size < 0 || p + size > bound) throw new Error('YABX 字段越界');
    const offset = p;
    p += size;
    return offset;
  };
  const u8 = (): number => buffer.readUInt8(take(1));
  const u16 = (): number => buffer.readUInt16LE(take(2));
  const u32 = (): number => buffer.readUInt32LE(take(4));
  const string = (long = false): string => {
    const length = long ? u16() : u8();
    if (!length) return '';
    const offset = take(length);
    if (buffer[offset + length - 1] !== 0) throw new Error('YABX 字符串未终止');
    return buffer.toString('utf8', offset, offset + length - 1);
  };
  let rootClass = '';
  while (true) {
    const tag = u8();
    if (!tag) break;
    if (tag !== 4 && tag !== 7) throw new Error('未知 YABX 顶层字段');
    const value = string(true);
    if (tag === 7) rootClass = value;
  }
  const name = string();
  while (string()) u32();
  const classes: YabxClass[] = [];
  while (buffer[p]) {
    const name = string(),
      tag = u8(),
      base = u8(),
      reserved = u8();
    if (tag !== 1 || reserved !== 0 || base > classes.length) throw new Error('YABX 类型继承无效');
    const fields: YabxFieldDefinition[] = [];
    while (buffer[p]) {
      const name = string(),
        flags = u8(),
        size = u16();
      fields.push({ name, flags, size });
    }
    u8();
    classes.push({ name, base, fields });
  }
  u8();
  if (u16() !== 0) throw new Error('YABX 对象表头无效');
  const count = u16();
  if (count > 20000) throw new Error('YABX 对象数量过大');
  const objects: YabxObject[] = [];
  for (let index = 0; index < count; index++) {
    const offset = p,
      classIndex = u16() - 1,
      size = u32(),
      objectEnd = p + size;
    if (!classes[classIndex] || objectEnd > end) throw new Error('YABX 对象类型或长度无效');
    const fields: Record<string, YabxField> = {};
    if (opaqueClasses.includes(classes[classIndex].name)) {
      fields.raw = { offset: p, data: buffer.subarray(p, objectEnd), variable: true };
      p = objectEnd;
      objects.push({ index, className: classes[classIndex].name, offset, fields });
      continue;
    }
    for (let type = classes[classIndex]; type; type = classes[type.base - 1]) {
      for (const field of type.fields) {
        const length = field.size || u32(),
          at = take(length, objectEnd);
        fields[field.name] = { offset: at, data: buffer.subarray(at, at + length), variable: field.size === 0 };
      }
    }
    if (p !== objectEnd) throw new Error(`YABX ${classes[classIndex].name} 字段长度与对象不一致`);
    objects.push({ index, className: classes[classIndex].name, offset, fields });
  }
  if (buffer.subarray(p, end).some(byte => byte !== 0)) throw new Error('YABX 尾部含未解析数据');
  if (objects[0]?.className !== rootClass) throw new Error('YABX 根对象类型不一致');
  return { rootClass, name, byteLength: end, classes, objects };
}
function field(object: YabxObject, name: string, length?: number): Buffer {
  const value = object.fields[name]?.data;
  if (!value || (length !== undefined && value.length !== length)) throw new Error(`YABX 缺少字段 ${name}`);
  return value;
}
function textField(object: YabxObject, name: string): string {
  const data = field(object, name);
  if (data.length < 2 || data.readUInt16LE() !== data.length - 2 || data[data.length - 1] !== 0)
    throw new Error('YABX 字符串字段格式无效');
  return data.toString('utf8', 2, data.length - 1);
}
function refs(object: YabxObject, name: string): number[] {
  const data = field(object, name),
    count = data.readUInt32LE();
  if (data.length !== 4 + count * 2) throw new Error('YABX 对象列表长度无效');
  return Array.from({ length: count }, (_, i) => data.readUInt16LE(4 + i * 2));
}
function floats(object: YabxObject, name: string, count: number): number[] {
  const data = field(object, name, count * 4),
    result = Array.from({ length: count }, (_, i) => data.readFloatLE(i * 4));
  if (result.some(value => !Number.isFinite(value))) throw new Error(`YABX ${name} 含非有限值`);
  return result;
}
export interface SvoRig {
  bones: StageBone[];
  declarations: {
    name: string;
    stride: number;
    count: number;
    elements: { semantics: number; type: number; index: number }[];
  }[];
}

export function parseSvoRig(buffer: Buffer): SvoRig {
  const archive = parseSvoEntries(buffer),
    entry = archive.find(e => e.kind === 0 && e.data.toString('ascii', 0, 4) === 'YABX');
  if (!entry) throw new Error('SVO 缺少 YABX 对象');
  const document = parseYabx(entry.data),
    root = document.objects[0];
  const stateIndex = document.objects.findIndex(o => o.className === 'stevia::State'),
    stateHandle = refs(root, '_state')[0];
  if (stateIndex < 0 || !stateHandle) throw new Error('SVO 无法确定对象引用基址');
  const base = stateHandle - stateIndex;
  const resolve = (handle: number, expected?: string): YabxObject | undefined => {
    if (!handle) return undefined;
    const object = document.objects[handle - base];
    if (!object || (expected && object.className !== expected)) throw new Error('SVO 对象引用类型无效');
    return object;
  };
  for (const [name, suffix] of [
    ['_mesh', 'Mesh'],
    ['_batch', 'Batch'],
    ['_vertexBuffer', 'VertexBuffer'],
    ['_indexBuffer', 'IndexBuffer'],
    ['_texture', 'Texture'],
    ['_image', 'Image'],
    ['_tree', 'Tree'],
  ])
    for (const id of refs(root, name)) resolve(id, `stevia::${suffix}`);
  const nodes = document.objects.filter(o => o.className === 'stevia::Node'),
    nodeIndices = new Map(nodes.map((o, i) => [o.index, i]));
  const nodeRef = (o: YabxObject, name: string): number | null => {
    const referenced = resolve(field(o, name, 2).readUInt16LE(), 'stevia::Node');
    return referenced ? nodeIndices.get(referenced.index)! : null;
  };
  const bones: StageBone[] = nodes.map((o, index) => ({
    index,
    name: textField(o, '_name'),
    fullName: textField(o, '_fullName'),
    parent: nodeRef(o, '_parent'),
    child: nodeRef(o, '_child'),
    sibling: nodeRef(o, '_sibling'),
    blendIndex: field(o, '_blendIndex', 4).readInt32LE(),
    scale: floats(o, '_scale', 3),
    rotation: floats(o, '_rotation', 3),
    quaternion: floats(o, '_quaternion', 4),
    translation: floats(o, '_translation', 3),
    localMatrix: floats(o, '_mtxLocal', 12),
    worldMatrix: floats(o, '_mtxWorld', 12),
    inverseWorldMatrix: floats(o, '_mtxWorldInv', 12),
    bindMatrix: floats(o, '_mtxBind', 12),
    sourceOffset: entry.offset + o.offset,
  }));
  const declarations = document.objects
    .filter(o => o.className === 'stevia::VertexBuffer')
    .map(o => {
      const declaration = resolve(field(o, '_vertexDeclaration', 2).readUInt16LE(), 'stevia::VertexDeclaration')!;
      const elements = refs(declaration, '_vertexElement').map(id => {
        const element = resolve(id, 'stevia::VertexElement')!;
        return {
          semantics: field(element, '_semantics', 4).readUInt32LE(),
          type: field(element, '_elementType', 4).readUInt32LE(),
          index: field(element, '_index', 4).readUInt32LE(),
        };
      });
      return {
        name: textField(o, '_chunkFileName'),
        stride: field(o, '_stride', 4).readUInt32LE(),
        count: field(o, '_vertexNumber', 4).readUInt32LE(),
        elements,
      };
    });
  return { bones, declarations };
}

export interface AfbResource {
  name: string;
  originalPath: string;
  offset: number;
  size: number;
  data: Buffer;
}
export function parseAfbResources(buffer: Buffer): AfbResource[] {
  if (buffer.toString('ascii', 0, 4) !== 'FILS') throw new Error('AFB 文件头无效');
  let fileOffset = 64;
  while (fileOffset + 64 <= buffer.length) {
    if (buffer.toString('ascii', fileOffset, fileOffset + 4) !== 'FILE') throw new Error('AFB FILE 块无效');
    const fileSize = buffer.readUInt32LE(fileOffset + 4),
      header = buffer.readUInt32LE(fileOffset + 8),
      chunk = fileOffset + header;
    if (header < 32 || fileSize < 32 || fileOffset + header + fileSize > buffer.length)
      throw new Error('AFB FILE 长度无效');
    if (buffer.toString('ascii', chunk, chunk + 4) === 'AFRC') {
      const body = chunk + buffer.readUInt32LE(chunk + 8),
        count = buffer.readUInt32LE(body + 8),
        table = body + 12;
      if (count > 10000 || table + count * 16 > fileOffset + header + fileSize) throw new Error('AFRC 资源表无效');
      const readString = (at: number): string => {
        const stop = buffer.indexOf(0, at);
        if (stop < at || stop > fileOffset + header + fileSize) throw new Error('AFRC 字符串越界');
        return buffer.toString('utf8', at, stop);
      };
      return Array.from({ length: count }, (_, i) => {
        const at = table + i * 16,
          offset = chunk + buffer.readUInt32LE(at),
          size = buffer.readUInt32LE(at + 4);
        if (offset < table + count * 16 || offset + size > fileOffset + header + fileSize)
          throw new Error('AFRC 资源边界无效');
        return {
          originalPath: readString(chunk + buffer.readUInt32LE(at + 8)),
          name: readString(chunk + buffer.readUInt32LE(at + 12)),
          offset,
          size,
          data: buffer.subarray(offset, offset + size),
        };
      });
    }
    fileOffset += header + fileSize;
  }
  throw new Error('AFB 缺少 AFRC 资源块');
}

export async function inspectClassicAnimation(
  gameRoot: string,
): Promise<{ resources: Omit<AfbResource, 'data'>[]; ringRig: SvoRig }> {
  const file = path.join(gameRoot, 'data/A000/stage/stage000001/st_label_basic_0001_yellowring.afb');
  const resources = parseAfbResources(await readFile(file));
  const ring = resources.find(r => r.name === 'st_00001_ring.svo');
  if (!ring) throw new Error('经典舞台缺少圆环模型');
  return { resources: resources.map(({ data: _data, ...entry }) => entry), ringRig: parseSvoRig(ring.data) };
}

export function parseUvcClip(buffer: Buffer, resourceName: string, sourceOffset = 0): StageAnimationClip {
  if (buffer.length < 128 || buffer.toString('ascii', 0, 4) !== 'CVU\0') throw new Error('UVC 文件头无效');
  const count = buffer.readUInt32LE(4),
    sections = new Map<number, Buffer>();
  if (count !== 6 || 128 + count * 256 > buffer.length) throw new Error('UVC 目录布局不受支持');
  for (let i = 0; i < count; i++) {
    const p = 128 + i * 256,
      type = buffer.readUInt32LE(p),
      id = buffer.readUInt32LE(p + 4),
      size = buffer.readUInt32LE(p + 8),
      offset = buffer.readUInt32LE(p + 12);
    if (id !== i || sections.has(type) || offset < 128 + count * 256 || offset + size > buffer.length)
      throw new Error('UVC 区块边界无效');
    sections.set(type, buffer.subarray(offset, offset + size));
  }
  const section = (type: number): Buffer => {
    const result = sections.get(type);
    if (!result) throw new Error(`UVC 缺少区块 ${type}`);
    return result;
  };
  if (section(10).length !== 4 || section(10).readUInt32LE() !== 20130903) throw new Error('UVC 数据版本未核对');
  const document = parseYabx(section(0)),
    property = document.objects.find(o => o.className === 'uva::SceneProperty');
  if (!property || field(property, '_magicWord', 4).toString('ascii') !== 'HMA0') throw new Error('UVC 场景元数据无效');
  const frameCount = field(property, '_frameNumber', 4).readUInt32LE(),
    nodeCount = field(property, '_sceneNodeNumber', 4).readUInt32LE();
  const quaternion = field(property, '_bQuaternion', 1)[0] !== 0,
    ignoreParentScale = field(property, '_bIgnoreParentScale', 1)[0] !== 0;
  if (!quaternion || ignoreParentScale || frameCount < 1 || frameCount > 32768 || nodeCount > 10000)
    throw new Error('UVC 场景模式未核对');
  const names = section(6).toString('utf8').split('\0');
  if (names.pop() !== '' || names.length !== nodeCount || new Set(names).size !== names.length)
    throw new Error('UVC 节点名称表无效');
  const keys = (type: number): StageKey[] => {
    const data = section(type),
      count = data.readUInt32LE(),
      stride = type === 2 ? 12 : 8;
    if (data.length !== 4 + count * stride) throw new Error('UVC 关键帧表长度无效');
    return Array.from({ length: count }, (_, i) => {
      const p = 4 + i * stride,
        value = type === 2 ? data.readFloatLE(p) : data.readInt16LE(p + 4) / 32767;
      const tangent = data.readFloatLE(p + (type === 2 ? 4 : 0)),
        encoded = data.readUInt16LE(p + (type === 2 ? 8 : 6));
      const flags = type === 2 ? data.readUInt16LE(p + 10) : encoded >>> 14,
        frame = type === 2 ? encoded : encoded & 0x3fff;
      if (!Number.isFinite(value) || !Number.isFinite(tangent) || frame >= frameCount || flags > 3)
        throw new Error('UVC 关键帧值或标志无效');
      return { frame, value, tangent, flags };
    });
  };
  const floatKeys = keys(2),
    shortKeys = keys(3),
    nodes: StageAnimationNode[] = [],
    nodeData = section(1);
  if (nodeData.readUInt32LE() !== nodeCount || nodeData.length !== 4 + nodeCount * 172)
    throw new Error('UVC 节点表长度无效');
  for (let i = 0; i < nodeCount; i++) {
    const p = 4 + i * 172,
      channels: StageCurve[] = [];
    for (let channel = 0; channel < 10; channel++) {
      const at = p + channel * 12,
        type = nodeData.readUInt32LE(at),
        index = nodeData.readUInt32LE(at + 4),
        count = nodeData.readUInt32LE(at + 8);
      if (type > 1) throw new Error('UVC 曲线编码未知');
      const table = type === 0 ? floatKeys : shortKeys;
      if (index + count > table.length) throw new Error('UVC 曲线索引越界');
      const curve = table.slice(index, index + count);
      if (curve.some((key, j) => j > 0 && key.frame <= curve[j - 1].frame)) throw new Error('UVC 曲线时间无效');
      channels.push(curve);
    }
    if (
      nodeData.readUInt32LE(p + 120) ||
      nodeData.readUInt32LE(p + 124) ||
      nodeData.readUInt32LE(p + 128) ||
      nodeData.readUInt32LE(p + 144)
    )
      throw new Error('UVC 节点含未支持的额外数据');
    const flags = nodeData.readUInt32LE(p + 132);
    if (flags & ~7) throw new Error('UVC 变换标志未知');
    const readFloats = (offset: number): number[] =>
      Array.from({ length: 3 }, (_, j) => nodeData.readFloatLE(p + offset + j * 4));
    nodes.push({
      name: names[i],
      flags,
      quaternion: Array.from({ length: 4 }, (_, j) => nodeData.readInt16LE(p + 136 + j * 2) / 32767),
      translation: readFloats(148),
      scale: readFloats(160),
      channels: { translation: channels.slice(0, 3), scale: channels.slice(3, 6), quaternion: channels.slice(6, 10) },
    });
  }
  if (nodes.filter(n => n.flags).length !== field(property, '_transformAnimationNumber', 4).readUInt32LE())
    throw new Error('UVC 动画节点数量不一致');
  return {
    name: textField(property, '_animationName'),
    resourceName,
    frameCount,
    sourceOffset,
    quaternion,
    ignoreParentScale,
    nodes,
  };
}

export async function loadClassicStageAnimation(gameRoot: string): Promise<StageAnimation> {
  const source = path.join(gameRoot, 'data/A000/stage/stage000001/st_label_basic_0001_yellowring.afb');
  const resources = parseAfbResources(await readFile(source)),
    ring = resources.find(r => r.name === 'st_00001_ring.svo');
  if (!ring) throw new Error('经典舞台缺少圆环模型');
  const rig = parseSvoRig(ring.data),
    entries = parseSvoEntries(ring.data),
    vertex = entries.find(e => /__PNTW_0000\.VBO$/.test(e.name));
  const declaration = rig.declarations.find(d => d.name === vertex?.name);
  if (
    !vertex ||
    !declaration ||
    declaration.stride !== 28 ||
    declaration.elements.length !== 4 ||
    declaration.elements[3].semantics !== 1 ||
    declaration.elements[3].type !== 8
  )
    throw new Error('圆环顶点蒙皮布局未核对');
  const blendIndices = new Set(rig.bones.map(b => b.blendIndex));
  const vertexBones = Array.from({ length: declaration.count }, (_, i) => {
    const p = i * 28 + 24,
      weight = vertex.data[p],
      bone = vertex.data[p + 1];
    if (weight !== 255 || vertex.data[p + 2] !== 0 || vertex.data[p + 3] !== 0 || !blendIndices.has(bone))
      throw new Error('圆环不是已核对的单骨顶点');
    return bone;
  });
  const clips = resources
    .filter(r => /st_00001_ring_\d+\.uvc$/.test(r.name))
    .map(r => parseUvcClip(r.data, r.name, r.offset));
  const names = new Set(rig.bones.map(b => b.name));
  if (clips.length !== 10 || clips.some(c => c.nodes.some(n => n.flags && !names.has(n.name))))
    throw new Error('UVC 动画无法映射到圆环节点');
  return {
    version: 1,
    sourcePath: 'data/A000/stage/stage000001/st_label_basic_0001_yellowring.afb',
    rig: { bones: rig.bones.map(bone => ({ ...bone, sourceOffset: ring.offset + bone.sourceOffset })), vertexBones },
    clips,
    interpolation: 'uvc-native',
    framesPerSecond: null,
    warnings: [
      '曲线标志与整数帧旋转采样已对照原程序的隔离数学函数；浏览器浮点运算不承诺逐位一致。',
      '舞台时间基准、父级变换与动作编排由场景控制层决定，不能仅从 UVC 曲线推断。',
    ],
  };
}
