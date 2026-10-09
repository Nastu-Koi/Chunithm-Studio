import { parseYabx, type YabxObject } from './game-animation';
import { transformStagePoint } from '../core/stage-animation';
import type { GameModelMesh } from '../core/game-assets';
import type { SvoEntry } from './game-textures';

/** Decode the original object graph, rather than guessing a DDS for each VBO. */
export function parseSvoMeshes(entries: SvoEntry[]): GameModelMesh[] {
  const entry = entries.find(e => e.kind === 0 && e.data.toString('ascii', 0, 4) === 'YABX');
  if (!entry) return [];
  const document = parseYabx(entry.data), root = document.objects[0];
  const field = (o: YabxObject, name: string, size?: number): Buffer => {
    const value = o.fields[name]?.data;
    if (!value || size !== undefined && value.length !== size) throw new Error(`模型缺少字段 ${name}`);
    return value;
  };
  const uint = (o: YabxObject, name: string) => field(o, name, 4).readUInt32LE();
  const text = (o: YabxObject, name: string): string => {
    const b = field(o, name);
    if (b.length < 2 || b.readUInt16LE() !== b.length - 2 || b.length > 2 && b[b.length - 1] !== 0) throw new Error('模型名称字段无效');
    return b.length === 2 ? '' : b.toString('utf8', 2, b.length - 1);
  };
  const refs = (o: YabxObject, name: string): number[] => {
    const b = field(o, name); if (b.length < 4) throw new Error('模型引用列表过短');
    const count = b.readUInt32LE(); if (count > 65536 || b.length !== 4 + count * 2) throw new Error('模型引用列表长度无效');
    return Array.from({ length: count }, (_, i) => b.readUInt16LE(4 + i * 2));
  };
  const floats = (o: YabxObject, name: string, count: number): number[] => {
    const b = field(o, name, count * 4), values = Array.from({ length: count }, (_, i) => b.readFloatLE(i * 4));
    if (values.some(n => !Number.isFinite(n))) throw new Error(`模型 ${name} 包含无效浮点数`);
    return values;
  };
  const stateIndex = document.objects.findIndex(o => o.className === 'stevia::State');
  const stateHandle = refs(root, '_state')[0];
  if (stateIndex < 0 || !stateHandle) throw new Error('模型缺少材质引用基址');
  const base = stateHandle - stateIndex;
  const resolve = (id: number, kind: string): YabxObject => {
    const o = document.objects[id - base];
    if (!id || o?.className !== `stevia::${kind}`) throw new Error(`模型 ${kind} 引用无效`);
    return o;
  };
  const ref = (o: YabxObject, name: string, kind: string) => resolve(field(o, name, 2).readUInt16LE(), kind);
  const images = entries.filter(e => e.kind === 1 && /\.dds$/i.test(e.name));
  const buffer = (o: YabxObject, kind: number) => {
    const name = text(o, '_chunkFileName'), result = entries.find(e => e.name === name && e.kind === kind);
    if (!result) throw new Error(`模型缺少缓冲 ${name}`); return result;
  };
  const material = (state: YabxObject): GameModelMesh['material'] => {
    const params = new Map(refs(state, '_userParameter').map(id => {
      const p = resolve(id, 'Parameter'); return [text(p, '_name'), ref(p, '_value', 'Variant')];
    }));
    const diffuse = params.get('diffuse'), opacity = params.get('opacity'), color = params.get('tsEnableVertexColor');
    const integer = (name: string, fallback: number) => params.has(name) ? field(params.get(name)!, '_valueS32', 4).readInt32LE() : fallback;
    const textureLayers = ['', '2'].map(suffix => ({
      sourceFactor: integer(`tsLayerBlendFactorSrc${suffix}`, 2), destinationFactor: integer(`tsLayerBlendFactorDst${suffix}`, 3),
      operation: integer(`tsLayerBlendFunction${suffix}`, 0),
    }));
    const textureTransforms = [0, 1, 2].map(i => {
      const value = params.get(`tsUVScrollUV${i}`);
      const raw = integer('tsEnableUVOffset', 0) && value ? floats(value, '_valueColor', 4) : [0, 0, 1, 1];
      return { offset: raw.slice(0, 2) as [number, number], scale: raw.slice(2, 4) as [number, number] };
    });
    return { name: text(state, '_name'),
      textures: refs(state, '_texture').map(id => {
        const t = resolve(id, 'Texture'), image = ref(t, '_image', 'Image');
        const imageIndex = images.findIndex(i => i.name === text(image, '_chunkFileName'));
        if (imageIndex < 0) throw new Error('模型纹理引用未找到图像');
        return { image: imageIndex, uvSet: uint(t, '_uvSetIndex'), wrapU: uint(t, '_wrapU'), wrapV: uint(t, '_wrapV'), type: text(t, '_textureType') };
      }),
      blendOperation: uint(state, '_blendOperation'), blendSource: uint(state, '_blendFactorSrc'),
      blendDestination: uint(state, '_blendFactorDst'), alphaRef: uint(state, '_alphaRef'), cullMode: uint(state, '_cullMode'),
      diffuse: diffuse ? floats(diffuse, '_valueColor', 4) as [number, number, number, number] : [1, 1, 1, 1],
      opacity: opacity ? floats(opacity, '_valueF32', 1)[0] : 1,
      vertexColor: color ? uint(color, '_valueS32') !== 0 : true,
      textureLayers, textureTransforms,
    };
  };
  const result: GameModelMesh[] = [];
  for (const node of document.objects.filter(o => o.className === 'stevia::Node')) {
    if (!field(node, '_mesh', 2).readUInt16LE()) continue;
    const mesh = ref(node, '_mesh', 'Mesh'), matrix = floats(node, '_mtxWorld', 12);
    if (field(node, '_blendIndex', 4).readInt32LE() >= 0) throw new Error('音符模型使用未支持的骨骼绑定');
    for (const id of refs(mesh, '_shape')) {
      const shape = resolve(id, 'Shape'), batch = ref(shape, '_batch', 'Batch'), state = ref(shape, '_state', 'State');
      const vertexRefs = refs(batch, '_vertexBufferList');
      if (vertexRefs.length !== 1) throw new Error('模型多流顶点布局尚未支持');
      const vb = resolve(vertexRefs[0], 'VertexBuffer'), vertexData = buffer(vb, 2), stride = uint(vb, '_stride'), count = uint(vb, '_vertexNumber');
      if (count > 100000 || vertexData.size !== stride * count || stride < 12 || stride > 128) throw new Error('模型顶点长度无效');
      const declaration = ref(vb, '_vertexDeclaration', 'VertexDeclaration');
      let position = -1, uv = -1, uv2 = -1, color = -1, cursor = 0;
      for (const id of refs(declaration, '_vertexElement')) {
        const element = resolve(id, 'VertexElement'), type = uint(element, '_elementType'), semantic = uint(element, '_semantics'), index = uint(element, '_index');
        const bytes = type === 2 ? 12 : type === 1 ? 8 : type === 8 ? 4 : 0;
        if (!bytes) throw new Error('模型顶点数据格式尚未支持');
        if (semantic === 0 && type === 2 && index === 0) position = cursor;
        else if (semantic === 5 && type === 1 && index === 0) uv = cursor;
        else if (semantic === 5 && type === 1 && index === 1) uv2 = cursor;
        else if (semantic === 10 && type === 8 && index === 0) color = cursor;
        else if (semantic !== 3 || type !== 8) throw new Error('模型顶点属性尚未支持');
        cursor += bytes;
      }
      if (cursor !== stride || position < 0) throw new Error('模型顶点声明与缓冲不一致');
      const vertices: GameModelMesh['vertices'] = Array.from({ length: count }, (_, i) => {
        const at = i * stride, p = [0, 4, 8].map(d => vertexData.data.readFloatLE(at + position + d));
        const pair = (offset: number): [number, number] => [vertexData.data.readFloatLE(at + offset), vertexData.data.readFloatLE(at + offset + 4)];
        const value: GameModelMesh['vertices'][number] = { position: transformStagePoint(matrix, p), uv: uv < 0 ? [0, 0] : pair(uv),
          color: color < 0 ? [1, 1, 1, 1] : [0, 1, 2, 3].map(d => vertexData.data[at + color + d] / 255) as [number, number, number, number] };
        if (uv2 >= 0) value.uv2 = pair(uv2);
        if ([...value.position, ...value.uv, ...(value.uv2 ?? [])].some(n => !Number.isFinite(n))) throw new Error('模型顶点含无效数值');
        return value;
      });
      const ib = ref(batch, '_indexBuffer', 'IndexBuffer'), indexData = buffer(ib, 3), start = uint(batch, '_indexStart'), length = uint(batch, '_indexNumber');
      if (uint(ib, '_indexType') !== 0 || uint(ib, '_indexNumber') * 2 !== indexData.size || (start + length) * 2 > indexData.size) throw new Error('模型索引范围无效');
      const sourceIndices = Array.from({ length }, (_, i) => indexData.data.readUInt16LE((start + i) * 2));
      if (sourceIndices.some(v => v >= count)) throw new Error('模型顶点索引越界');
      const indices: number[] = [], primitive = uint(batch, '_primitiveType');
      if (primitive !== 4) throw new Error(`模型拓扑尚未支持: ${primitive}`);
      for (let i = 2; i < sourceIndices.length; i++) {
        const a = sourceIndices[i - 2], b = sourceIndices[i - 1], c = sourceIndices[i];
        if (a === b || b === c || a === c) continue;
        indices.push(...(i & 1 ? [b, a, c] : [a, b, c]));
      }
      if (indices.length / 3 !== uint(batch, '_polygonNumber')) throw new Error('模型三角形数量与原批次不一致');
      result.push({ name: text(shape, '_fullName'), vertices, indices, topology: 'triangles', material: material(state),
        sourceOffset: entry.offset + shape.offset, sourceVertexOffset: vertexData.offset,
        sourceIndexOffset: indexData.offset + start * 2, sourceMatrix: matrix });
    }
  }
  return result;
}
