import { STAGE_COMMAND_NAMES, type StageCommand, type StageGoalRecord, type StageMatrixRecord,
  type StageMotionRecord, type StageNode, type StageProgram, type StageRawRecord, type StageVector } from '../core/stage-program';

/** Read-only, bounded AFNC decoder. Unknown commands remain visible in the returned program. */
export function parseGameStageProgram(bytes: Uint8Array, sourceName = ''): StageProgram {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function range(at: number, length: number, end = data.length) {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0
      || at + length > end) throw new Error(`AFNC range outside file at 0x${at.toString(16)}`);
  }
  function uint(at: number) { range(at, 4); return data.readUInt32LE(at); }
  function int(at: number) { range(at, 4); return data.readInt32LE(at); }
  function float(at: number) {
    range(at, 4); const v = data.readFloatLE(at);
    if (!Number.isFinite(v)) throw new Error(`AFNC non-finite value at 0x${at.toString(16)}`);
    return v;
  }
  function chunk(at: number, magic: string) {
    range(at, 16);
    if (data.toString('ascii', at, at + 4) !== magic) throw new Error(`Expected ${magic} block`);
    const size = uint(at + 4), header = uint(at + 8);
    if (header < 16 || header % 4) throw new Error(`Invalid ${magic} header`);
    range(at, header + size); return { at, header, end: at + header + size };
  }
  const fils = chunk(0, 'FILS'), file = chunk(fils.header, 'FILE');
  if (file.end > fils.end) throw new Error('FILE extends outside FILS');
  const afnc = chunk(file.at + file.header, 'AFNC');
  const origin = afnc.at, end = afnc.end;
  if (end > file.end || uint(origin + afnc.header) !== 2012060601)
    throw new Error('Unsupported AFNC version');
  const pof = chunk(end, 'POF0');
  if (pof.end !== file.end) throw new Error('Invalid AFNC relocation ownership');
  const lengthAt = pof.at + pof.header, length = uint(lengthAt);
  if (length < 4) throw new Error('Invalid POF0 length');
  range(lengthAt, length, pof.end);
  let cursor = lengthAt + 4, location = origin;
  const pointers = new Map<number, number>();
  while (cursor < lengthAt + length) {
    const first = data[cursor++], format = first >>> 6;
    if (!format) {
      if (data.subarray(cursor - 1, lengthAt + length).some(x => x !== 0))
        throw new Error('Invalid POF0 padding');
      break;
    }
    const count = format === 1 ? 1 : format === 2 ? 2 : 4;
    range(cursor, count - 1, lengthAt + length);
    let delta = first & 63;
    for (let i = 1; i < count; i++) delta = delta * 256 + data[cursor++];
    if (!delta) throw new Error('Duplicate POF0 pointer');
    location += delta * 4;
    range(location, 4, end);
    const target = origin + uint(location);
    if (target < origin || target >= end) throw new Error('POF0 target outside AFNC');
    pointers.set(location, target);
  }
  function ptr(slot: number, required = false): number | null {
    range(slot, 4, end);
    const target = pointers.get(slot);
    if (target !== undefined) return target;
    if (required || uint(slot) !== 0) throw new Error(`Missing relocation at 0x${slot.toString(16)}`);
    return null;
  }
  function words(at: number, count: number) { range(at, count * 4, end); return Array.from({ length: count }, (_, i) => int(at + i * 4)); }
  function vec(at: number): StageVector { return [float(at), float(at + 4), float(at + 8)]; }
  function records(slot: number, countAt: number, stride: number): number[] {
    const count = uint(countAt);
    if (count > 65536) throw new Error('AFNC record count exceeds limit');
    const at = ptr(slot, count > 0);
    if (!count) return [];
    range(at!, count * stride, end); return Array.from({ length: count }, (_, i) => at! + i * stride);
  }
  function string(slot: number) {
    const at = ptr(slot); if (at === null) return '';
    const stop = data.indexOf(0, at);
    if (stop < at || stop >= end) throw new Error('Unterminated AFNC string');
    return new TextDecoder('shift-jis').decode(data.subarray(at, stop));
  }
  const diagnostics: string[] = [];
  function command(at: number): StageCommand {
    range(at, 40, end);
    const kind = uint(at), descriptor = ptr(at + 36, true)!;
    const result: StageCommand = { offset: at, kind, nativeClass: STAGE_COMMAND_NAMES[kind],
      descriptorOffset: descriptor, words: words(at, 10),
      descriptorWords: words(descriptor, Math.min(10, Math.floor((end - descriptor) / 4))) };
    if (kind === 100) {
      result.selector = int(descriptor);
      result.matrix = records(descriptor + 8, descriptor + 4, 116).map((r): StageMatrixRecord => ({
        offset: r, words: words(r, 29), mode: int(r), property: int(r + 4),
        translationMode: int(r + 8), randomMode: int(r + 12), timeSource: int(r + 16),
        start: float(r + 24), end: float(r + 28), persist: int(r + 32),
        period: float(r + 36), phase: float(r + 44), value: vec(r + 52), secondValue: vec(r + 84),
      }));
    } else if (kind === 106) {
      result.goalTarget = int(descriptor + 8); result.goalSpace = int(descriptor + 12);
      result.goals = records(descriptor, descriptor + 4, 92).map((r): StageGoalRecord => ({
        offset: r, words: words(r, 23), value: vec(r), start: float(r + 32), property: int(r + 36),
        mode: int(r + 40), duration: float(r + 44), durationUpper: float(r + 48),
        easing: int(r + 56), randomize: int(r + 84),
      }));
    } else if (kind === 600) {
      result.motionMode = int(descriptor + 4); result.motionRepeats = int(descriptor + 8);
      result.motions = records(descriptor + 32, descriptor + 28, 92).map((r): StageMotionRecord => ({
        offset: r, words: words(r, 23), clip: int(r), secondary: int(r + 4), speed: float(r + 8),
        start: float(r + 12), end: float(r + 16), loops: int(r + 20),
      }));
    } else if (kind === 751) {
      result.trigger = { maxCount: int(descriptor), mode: int(descriptor + 4), time: int(descriptor + 8),
        actions: records(descriptor + 20, descriptor + 24, 28).map((r): StageRawRecord => ({ offset: r, words: words(r, 7) })) };
    } else diagnostics.push(`${result.nativeClass ?? `Unknown command ${kind}`} at 0x${at.toString(16)} retained without execution`);
    return result;
  }
  function commandChain(slot: number, countAt: number): StageCommand[] {
    const count = uint(countAt);
    if (count > 65536) throw new Error('AFNC command count exceeds limit');
    let current = ptr(slot, count > 0);
    const result: StageCommand[] = [], seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      if (current === null || seen.has(current)) throw new Error('Broken AFNC command chain');
      seen.add(current); result.push(command(current)); current = ptr(current + 32);
    }
    if (current !== null && count > 0) throw new Error('AFNC command count mismatch');
    return result;
  }
  const nodes: StageNode[] = [], seenNodes = new Set<number>();
  const stack: { at: number; parent: number | null; depth: number }[] = [{ at: ptr(origin + 0x80, true)!, parent: null, depth: 0 }];
  while (stack.length) {
    const { at, parent, depth } = stack.pop()!;
    if (seenNodes.has(at) || seenNodes.size >= 65536 || depth > 512) throw new Error('Invalid AFNC node tree');
    seenNodes.add(at); range(at, 96, end);
    const node: StageNode = { offset: at, ordinal: uint(at + 36), type: uint(at), id: int(at + 4),
      flags: uint(at + 8), parent, defaultState: int(at + 52), sourceName: string(at + 32),
      settingsWords: [], resources: [], states: [], commonCommands: [], postCommands: [] };
    const settings = ptr(at + 92);
    if (settings !== null) node.settingsWords = words(settings, Math.min(16, Math.floor((end - settings) / 4)));
    if (node.type === 6000001 && settings !== null) {
      // SglCamera ctor 0x1474e46 and projection update 0x1475e06/0x1272ce0.
      node.camera = { verticalFovDegrees: float(settings + 12), near: float(settings + 16),
        far: float(settings + 20), aspect: float(settings + 24) };
    }
    let property = ptr(at + 60);
    const seenProps = new Set<number>();
    while (property !== null) {
      if (seenProps.has(property)) throw new Error('AFNC property cycle');
      seenProps.add(property); range(property, 20, end);
      const kind = uint(property);
      if ([200, 400, 402].includes(kind)) node.resources.push({ kind,
        entries: records(property + 8, property + 12, 8).map(r => [int(r), int(r + 4)]) });
      property = ptr(property + 16);
    }
    const count = uint(at + 68);
    if (count > 65536) throw new Error('AFNC state count exceeds limit');
    let state = ptr(at + 64, count > 0);
    const seenStates = new Set<number>();
    for (let i = 0; i < count; i++) {
      if (state === null || seenStates.has(state)) throw new Error('Broken AFNC state chain');
      seenStates.add(state); range(state, 32, end);
      node.states.push({ id: int(state), commands: commandChain(state + 20, state + 24) });
      state = ptr(state + 28);
    }
    if (state !== null && count > 0) throw new Error('AFNC state count mismatch');
    const common = ptr(at + 72);
    if (common !== null) node.commonCommands = commandChain(common, common + 4);
    const post = ptr(at + 76);
    if (post !== null) node.postCommands = commandChain(post, post + 4);
    nodes.push(node);
    const sibling = ptr(at + 84), child = ptr(at + 80);
    if (sibling !== null) stack.push({ at: sibling, parent, depth });
    if (child !== null) stack.push({ at: child, parent: at, depth: depth + 1 });
  }
  return { format: 'AFNC', version: 2012060601, sourceName, nodes,
    relocationCount: pointers.size, diagnostics };
}
