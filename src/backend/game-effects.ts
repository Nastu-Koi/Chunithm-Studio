import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAfbResources } from './game-animation';
import { parseGameStageProgram } from './game-stage-program';
import { parseGameEffectTable } from './game-textures';
import {
  unpackEffectColor,
  type EffectRawRecord,
  type NativeEffectProgram,
  type NativeEffectProperty,
  type NativeParticleSettings,
  type NativeEffectPrimitive,
  type NativeTexturePattern,
} from '../core/game-effects';
import type { StageVector } from '../core/stage-program';

/** Bounded decoder for extra AFNC data. Original files are never modified. */
export function parseGameEffectProgram(bytes: Uint8Array, sourceName: string): NativeEffectProgram {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const program = parseGameStageProgram(bytes, sourceName);
  const origin = data.readUInt32LE(8) + data.readUInt32LE(data.readUInt32LE(8) + 8);
  const end = origin + data.readUInt32LE(origin + 8) + data.readUInt32LE(origin + 4);
  function range(at: number, length: number) {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < origin || length < 0 || at + length > end)
      throw new Error(`Effect record outside AFNC at 0x${at.toString(16)}`);
  }
  function u(at: number) {
    range(at, 4);
    return data.readUInt32LE(at);
  }
  function i(at: number) {
    range(at, 4);
    return data.readInt32LE(at);
  }
  function f(at: number) {
    range(at, 4);
    const value = data.readFloatLE(at);
    if (!Number.isFinite(value)) throw new Error('Non-finite native effect value');
    return value;
  }
  // parseGameStageProgram has already validated POF0 ownership, padding and all targets.
  const pofHeader = data.readUInt32LE(end + 8),
    lengthAt = end + pofHeader;
  const relocEnd = lengthAt + data.readUInt32LE(lengthAt),
    relocations = new Set<number>();
  let cursor = lengthAt + 4,
    slot = origin;
  while (cursor < relocEnd) {
    const first = data[cursor++],
      format = first >>> 6;
    if (!format) break;
    const count = format === 1 ? 1 : format === 2 ? 2 : 4;
    let delta = first & 63;
    for (let n = 1; n < count; n++) delta = delta * 256 + data[cursor++];
    slot += delta * 4;
    relocations.add(slot);
  }
  function ptr(at: number): number | null {
    const value = u(at);
    if (!relocations.has(at)) {
      if (value) throw new Error(`Unrelocated effect pointer at 0x${at.toString(16)}`);
      return null;
    }
    const target = origin + value;
    range(target, 1);
    return target;
  }
  function raw(at: number, size: number): EffectRawRecord {
    range(at, size);
    return { offset: at, words: Array.from({ length: size / 4 }, (_, n) => i(at + n * 4)) };
  }
  function records(settings: number, countOffset: number, stride: number): number[] {
    const count = u(settings + countOffset),
      at = ptr(settings + countOffset + 4);
    if (count > 4096 || (count && at === null)) throw new Error('Invalid native effect curve count');
    if (!count) return [];
    range(at!, count * stride);
    return Array.from({ length: count }, (_, n) => at! + n * stride);
  }
  const vec = (at: number): StageVector => [f(at), f(at + 4), f(at + 8)];
  const resources = parseAfbResources(data).map((r, index) => ({
    index,
    name: r.name,
    offset: r.offset,
    size: r.size,
  }));
  const properties: NativeEffectProperty[] = [],
    particles: NativeParticleSettings[] = [],
    primitives: NativeEffectPrimitive[] = [];
  const lifecycles: NonNullable<NativeEffectProgram['lifecycles']> = [];
  const diagnostics: string[] = [];
  for (const node of program.nodes) {
    const common = ptr(node.offset + 56);
    if (common !== null && u(common) === 2) {
      const settings = ptr(common + 4);
      if (settings === null) throw new Error('Missing native CorForester settings');
      lifecycles.push({
        ...raw(settings, 32),
        node: node.ordinal,
        kind: 2,
        duration: f(settings + 16),
        durationUpper: f(settings + 20),
      });
    }
    let property = ptr(node.offset + 60);
    while (property !== null) {
      const kind = u(property),
        result: NativeEffectProperty = { node: node.ordinal, kind, ...raw(property, 20) };
      const propertySettings = ptr(property + 20);
      if (propertySettings !== null && [101, 300].includes(kind))
        // SpkTextureState's constructor copies the complete 52-byte record.
        result.settings = raw(propertySettings, kind === 101 ? 4 : 52);
      if (kind === 300) {
        const count = u(property + 12),
          entries = ptr(property + 8);
        if (count > 4096 || (count && entries === null)) throw new Error('Invalid material resource count');
        if (count) {
          // SpkMaterial resource rows contain eight words, with texture resource ID first.
          range(entries!, count * 32);
          result.textureResources = Array.from({ length: count }, (_, n) => i(entries! + n * 32));
          if (result.textureResources.some(id => id < 0 || id >= resources.length))
            throw new Error('Effect material references a missing AFRC resource');
        } else result.textureResources = [];
      }
      properties.push(result);
      property = ptr(property + 16);
    }
    if (node.type === 100) {
      const settings = ptr(node.offset + 92);
      if (settings === null) throw new Error('Missing SglPrimitive settings');
      primitives.push({
        ...raw(settings, 52),
        node: node.ordinal,
        width: f(settings + 16),
        height: f(settings + 24),
        count: i(settings + 12),
        textureResources: properties
          .filter(p => p.node === node.ordinal && p.kind === 300)
          .flatMap(p => p.textureResources ?? []),
        fixedRectangle:
          i(settings) === 0 &&
          f(settings + 4) === 0 &&
          f(settings + 8) === 0 &&
          i(settings + 12) === 1 &&
          f(settings + 20) < 0 &&
          f(settings + 28) < 0 &&
          // +32 preserves the original height/width ratio. With fixed width it is identical.
          [0, 1].includes(i(settings + 32)) &&
          i(settings + 36) === 0 &&
          i(settings + 40) === 0 &&
          i(settings + 44) === 0 &&
          i(settings + 48) === 0,
      });
    }
    if (node.type !== 6001008) continue;
    const settings = ptr(node.offset + 92);
    if (settings === null) throw new Error('Missing SglBasicParticle settings');
    const words = raw(settings, 228).words;
    const columns = i(settings + 0xbc),
      rows = i(settings + 0xc0) > 0 ? i(settings + 0xc0) : columns;
    const frames = i(settings + 0xc8) > 0 ? i(settings + 0xc8) : columns * rows;
    const life = f(settings + 0x7c);
    const firstLife = f(settings + 0x80),
      secondLife = f(settings + 0x84);
    const firstSecondary = f(settings + 0x88),
      secondSecondary = f(settings + 0x8c);
    const particle: NativeParticleSettings = {
      node: node.ordinal,
      offset: settings,
      words,
      initialization: {
        shape: i(settings + 0x30),
        extent: vec(settings + 0x34),
        maxParticles: i(settings + 0x54),
        emissionInterval: Math.max(0.0001, f(settings + 0x60)),
        emissionCount: [i(settings + 0x68), i(settings + 0x6c) < 0 ? i(settings + 0x68) : i(settings + 0x6c)],
        emissionMode: i(settings + 0x70),
        emissionLimit: f(settings + 0x74),
        life,
        sizeX: [firstLife, secondLife < 0 ? firstLife : secondLife],
        sizeY: [firstSecondary, secondSecondary < 0 ? firstSecondary : secondSecondary],
        angleRanges: [0x90, 0x94, 0x98, 0x9c].map(o => i(settings + o)) as [number, number, number, number],
        textureColumns: columns,
        textureRows: rows,
        textureFirstFrame: i(settings + 0xc4),
        textureFrameCount: frames,
        textureFrameDuration: f(settings + 0xcc) < 0 ? life / frames : f(settings + 0xcc),
        textureLoop: i(settings + 0xd0) !== 0,
      },
      colorKeys: records(settings, 0, 28).map(at => ({
        ...raw(at, 28),
        mode: i(at),
        time: f(at + 16),
        first: unpackEffectColor(u(at + 4)),
        second: unpackEffectColor(u(at + (i(at) === 1 ? 8 : 4))),
      })),
      scaleKeys: records(settings, 8, 32).map(at => ({
        ...raw(at, 32),
        time: f(at + 20),
        value: [f(at + 4), f(at + 8), 1],
      })),
      vectorKeys: records(settings, 16, 52).map(at => ({
        ...raw(at, 52),
        mode: i(at + 32),
        time: [f(at + 36), f(at + 40)],
        first: vec(at),
        second: vec(at + 16),
      })),
      extraVectorKeys: records(settings, 24, 40).map(at => ({
        ...raw(at, 40),
        time: f(at + 32),
        first: vec(at),
        second: vec(at + 16),
      })),
      scalarKeys: records(settings, 32, 8).map(at => ({ ...raw(at, 8), time: f(at + 4), value: f(at) })),
      undecodedCurve: { count: u(settings + 40), offset: ptr(settings + 44) },
      textureResources: properties
        .filter(p => p.node === node.ordinal && p.kind === 300)
        .flatMap(p => p.textureResources ?? []),
      executable:
        i(settings + 0x44) === 0 && [0, 2, 3].includes(i(settings + 0x30)) && [0, 1, 2].includes(i(settings + 0x70)),
    };
    if (columns <= 0 || rows <= 0 || frames <= 0 || !Number.isFinite(particle.initialization.textureFrameDuration))
      throw new Error('Invalid native particle texture grid');
    particles.push(particle);
  }
  const commands = program.nodes.flatMap(node =>
    [...node.commonCommands, ...node.states.flatMap(s => s.commands), ...(node.postCommands ?? [])].map(command => ({
      node: node.ordinal,
      command,
    })),
  );
  const texturePatterns: NativeTexturePattern[] = commands
    .filter(({ command }) => command.kind === 401)
    .map(({ node, command }) => {
      const at = command.descriptorOffset;
      return {
        ...raw(at, 68),
        node,
        command: command.offset,
        resourceFirst: i(at),
        resourceLast: i(at + 4),
        randomResource: i(at + 8),
        sheetFirst: i(at + 12),
        sheetLast: i(at + 16),
        layout: i(at + 20),
        columns: i(at + 24),
        rows: i(at + 28) > 0 ? i(at + 28) : i(at + 24),
        frameDuration: f(at + 32),
        first: i(at + 36),
        last: i(at + 40),
        direction: i(at + 44),
        initial: Math.min(i(at + 48), i(at + 40)),
        loop: i(at + 52) !== 0,
      };
    });
  const curves: NonNullable<NativeEffectProgram['curves']> = commands
    .filter(({ command }) => command.kind === 1003)
    .flatMap(({ node, command }) => {
      const at = command.descriptorOffset,
        count = u(at),
        first = ptr(at + 20);
      if (count > 4096 || (count && first === null)) throw new Error('Invalid MomCurve count');
      if (!count) return [];
      range(first!, count * 32);
      return Array.from({ length: count }, (_, index) => {
        const entry = first! + index * 32,
          keyCount = u(entry + 24),
          keys = ptr(entry + 28);
        if (keyCount > 4096 || !keyCount || keys === null) throw new Error('Invalid MomCurve keys');
        range(keys, keyCount * 28);
        return {
          ...raw(entry, 32),
          node,
          command: command.offset,
          property: i(entry),
          interpolation: i(entry + 8),
          wrap: i(entry + 12),
          keys: Array.from({ length: keyCount }, (_, n) => {
            const key = keys + n * 28;
            return {
              ...raw(key, 28),
              value: f(key),
              time: f(key + 4),
              incoming: [f(key + 8), f(key + 12)] as [number, number],
              outgoing: [f(key + 16), f(key + 20)] as [number, number],
            };
          }),
        };
      });
    });
  const colorAnimations: NonNullable<NativeEffectProgram['colorAnimations']> = commands
    .filter(({ command }) => command.kind === 300)
    .map(({ node, command }) => {
      const at = command.descriptorOffset;
      return {
        ...raw(at, 44),
        node,
        command: command.offset,
        keys: records(at, 12, 40).map(key => ({
          ...raw(key, 40),
          color: u(key),
          mode: i(key + 12),
          easing: i(key + 24),
          duration: f(key + 32),
          durationUpper: f(key + 36),
        })),
      };
    });
  const extraCommands = commands
    .filter(({ command }) => ![100, 106, 600, 751].includes(command.kind))
    .map(({ node, command }) => ({
      node,
      kind: command.kind,
      offset: command.offset,
      descriptor: raw(command.descriptorOffset, Math.min(64, end - command.descriptorOffset) & ~3),
    }));
  if (particles.length)
    diagnostics.push(
      '已实现原始粒子着色器的局部公式；全局种子、父命令与摄像机淡出/包裹以采样器 diagnostics 标记覆盖范围。',
    );
  diagnostics.push('AFNC 时间单位仍由调用方明确提供；没有把资源数值擅自换算为秒。');
  const retainedNodeTypes = [...new Set(program.nodes.map(n => n.type).filter(n => ![100, 6001008].includes(n)))];
  const retainedCommands = [...new Set(commands.map(c => c.command.kind))];
  const nodeRenderModes = program.nodes.map(node => ({ node: node.ordinal, mode: u(node.offset + 12) }));
  return {
    sourceName,
    program,
    resources,
    particles,
    primitives,
    texturePatterns,
    properties,
    nodeRenderModes,
    lifecycles,
    curves,
    colorAnimations,
    extraCommands,
    coverage: {
      decodedNodeTypes: [...(particles.length ? [6001008] : []), ...(primitives.length ? [100] : [])],
      retainedNodeTypes,
      executableCommands: [100, 300, 401, 402, 751, 1003],
      retainedCommands,
    },
    diagnostics,
  };
}

export async function loadGameEffects(gameRoot: string): Promise<Record<string, NativeEffectProgram>> {
  const table = parseGameEffectTable(
    await readFile(path.join(gameRoot, 'data/db/AcroartsTableRecord.bin')),
    'acroarts',
  );
  const result: Record<string, NativeEffectProgram> = {};
  for (const entry of table.filter(e => /^EF_/.test(e.name) && e.filename)) {
    if (/[\\/]/.test(entry.filename) || !/\.afb$/i.test(entry.filename))
      throw new Error('Invalid effect source filename');
    const name = entry.filename.replace(/\.afb$/i, '');
    if (result[name]) continue;
    result[name] = parseGameEffectProgram(await readFile(path.join(gameRoot, 'data/acroarts', entry.filename)), name);
  }
  return result;
}
