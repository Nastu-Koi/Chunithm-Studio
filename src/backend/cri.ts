import { createHash, randomBytes } from 'node:crypto';

/** CRI @UTF and AFS2 structures. Offsets are rebuilt, never patched by byte search. */
export type UtfValue = number | bigint | string | Buffer;
export interface UtfColumn { name: string; type: number; storage: number }
export interface UtfTable { name: string; version: number; columns: UtfColumn[]; rows: Record<string, UtfValue>[] }
const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 8, 7: 8, 8: 4, 9: 8, 10: 4, 11: 8 };
const align = (n: number, boundary: number) => Math.ceil(n / boundary) * boundary;
function range(buffer: Buffer, position: number, length: number): void {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > buffer.length) throw new Error('损坏的 CRI 文件：字段越界。');
}
function zstring(buffer: Buffer, position: number, end: number): string {
  range(buffer, position, 1);
  const stop = buffer.indexOf(0, position);
  if (stop < 0 || stop >= end) throw new Error('损坏的 UTF 字符串。');
  return buffer.toString('utf8', position, stop);
}
function zero(type: number): UtfValue { return type === 10 ? '' : type === 11 ? Buffer.alloc(0) : type === 6 || type === 7 ? 0n : 0; }
export function parseUtf(source: Buffer): UtfTable {
  range(source, 0, 32);
  if (source.toString('ascii', 0, 4) !== '@UTF') throw new Error('不是 CRI @UTF 表。');
  const tableEnd = source.readUInt32BE(4) + 8;
  range(source, 0, tableEnd);
  const b = source.subarray(0, tableEnd);
  const rowStart = b.readUInt16BE(10) + 8, stringStart = b.readUInt32BE(12) + 8, dataStart = b.readUInt32BE(16) + 8;
  const count = b.readUInt16BE(24), rowLength = b.readUInt16BE(26), rowsCount = b.readUInt32BE(28);
  range(b, rowStart, rowLength * rowsCount);
  if (rowStart < 32 || stringStart < rowStart + rowLength * rowsCount || dataStart < stringStart || dataStart > b.length) throw new Error('UTF 段顺序无效。');
  const read = (position: number, type: number): UtfValue => {
    range(b, position, sizes[type]);
    switch (type) {
      case 0: return b.readUInt8(position); case 1: return b.readInt8(position);
      case 2: return b.readUInt16BE(position); case 3: return b.readInt16BE(position);
      case 4: return b.readUInt32BE(position); case 5: return b.readInt32BE(position);
      case 6: return b.readBigUInt64BE(position); case 7: return b.readBigInt64BE(position);
      case 8: return b.readFloatBE(position); case 9: return b.readDoubleBE(position);
      case 10: return zstring(b, stringStart + b.readUInt32BE(position), dataStart);
      case 11: { const start = dataStart + b.readUInt32BE(position), length = b.readUInt32BE(position + 4); range(b, start, length); return Buffer.from(b.subarray(start, start + length)); }
      default: throw new Error(`不支持的 UTF 数据类型 ${type}。`);
    }
  };
  const columns: UtfColumn[] = [], constants = new Map<string, UtfValue>();
  let p = 32;
  for (let i = 0; i < count; i++) {
    range(b, p, 5);
    const flag = b[p], type = flag & 15, storage = flag & 0xf0;
    if (!(type in sizes) || ![0x10, 0x30, 0x50].includes(storage)) throw new Error(`不支持的 UTF 列标记 ${flag}。`);
    const name = zstring(b, stringStart + b.readUInt32BE(p + 1), dataStart);
    if (columns.some(c => c.name === name)) throw new Error('UTF 列名重复。');
    columns.push({ name, type, storage }); p += 5;
    if (storage === 0x30) { constants.set(name, read(p, type)); p += sizes[type]; }
  }
  if (p > rowStart) throw new Error('UTF 表头越过行数据。');
  const rows: Record<string, UtfValue>[] = [];
  for (let i = 0; i < rowsCount; i++) {
    let q = rowStart + rowLength * i;
    const row: Record<string, UtfValue> = {};
    for (const col of columns) {
      row[col.name] = col.storage === 0x10 ? zero(col.type) : col.storage === 0x30 ? constants.get(col.name)! : read(q, col.type);
      if (col.storage === 0x50) q += sizes[col.type];
    }
    if (q !== rowStart + rowLength * (i + 1)) throw new Error('UTF 行长度不匹配。');
    rows.push(row);
  }
  return { name: zstring(b, stringStart + b.readUInt32BE(20), dataStart), version: b.readUInt16BE(8), columns, rows };
}

export function writeUtf(table: UtfTable): Buffer {
  // Materialize constant/zero columns. This permits safe edits without stale shared values.
  const strings: Buffer[] = [Buffer.from([0])], stringOffsets = new Map<string, number>([['', 0]]);
  let stringLength = 1;
  const stringOffset = (value: string): number => {
    const known = stringOffsets.get(value); if (known !== undefined) return known;
    if (value.includes('\0')) throw new Error('UTF 文本不能包含空字符。');
    const offset = stringLength, bytes = Buffer.from(value + '\0', 'utf8');
    strings.push(bytes); stringOffsets.set(value, offset); stringLength += bytes.length; return offset;
  };
  const nameOffset = stringOffset(table.name);
  for (const column of table.columns) stringOffset(column.name);
  for (const row of table.rows) for (const column of table.columns) if (column.type === 10) stringOffset(String(row[column.name] ?? ''));
  const rowLength = table.columns.reduce((n, c) => n + sizes[c.type], 0);
  const rowStart = align(32 + table.columns.length * 5, 8);
  const stringStart = rowStart + rowLength * table.rows.length;
  const dataStart = align(stringStart + stringLength, 8);
  if (rowStart - 8 > 65535 || rowLength > 65535) throw new Error('UTF 表超过 16 位头部限制。');
  const dataParts: Buffer[] = [], dataRefs = new Map<Buffer, { offset: number; length: number }>();
  let dataLength = 0;
  for (const row of table.rows) for (const column of table.columns) {
    if (column.type !== 11) continue;
    const bytes = row[column.name]; if (!Buffer.isBuffer(bytes)) throw new Error(`UTF 二进制列 ${column.name} 无效。`);
    if (dataRefs.has(bytes)) continue;
    const aligned = align(dataLength, 8); if (aligned > dataLength) dataParts.push(Buffer.alloc(aligned - dataLength));
    dataRefs.set(bytes, { offset: aligned, length: bytes.length }); dataParts.push(bytes); dataLength = aligned + bytes.length;
  }
  const output = Buffer.alloc(align(dataStart + dataLength, 8));
  output.write('@UTF'); output.writeUInt32BE(output.length - 8, 4); output.writeUInt16BE(table.version, 8);
  output.writeUInt16BE(rowStart - 8, 10); output.writeUInt32BE(stringStart - 8, 12); output.writeUInt32BE(dataStart - 8, 16);
  output.writeUInt32BE(nameOffset, 20); output.writeUInt16BE(table.columns.length, 24); output.writeUInt16BE(rowLength, 26); output.writeUInt32BE(table.rows.length, 28);
  let p = 32;
  for (const col of table.columns) { output[p] = 0x50 | col.type; output.writeUInt32BE(stringOffsets.get(col.name)!, p + 1); p += 5; }
  p = rowStart;
  for (const row of table.rows) for (const col of table.columns) {
    const value = row[col.name] ?? zero(col.type);
    switch (col.type) {
      case 0: output.writeUInt8(Number(value), p); break; case 1: output.writeInt8(Number(value), p); break;
      case 2: output.writeUInt16BE(Number(value), p); break; case 3: output.writeInt16BE(Number(value), p); break;
      case 4: output.writeUInt32BE(Number(value), p); break; case 5: output.writeInt32BE(Number(value), p); break;
      case 6: output.writeBigUInt64BE(BigInt(value as bigint), p); break; case 7: output.writeBigInt64BE(BigInt(value as bigint), p); break;
      case 8: output.writeFloatBE(Number(value), p); break; case 9: output.writeDoubleBE(Number(value), p); break;
      case 10: output.writeUInt32BE(stringOffsets.get(String(value))!, p); break;
      case 11: { const ref = dataRefs.get(value as Buffer)!; output.writeUInt32BE(ref.offset, p); output.writeUInt32BE(ref.length, p + 4); break; }
      default: throw new Error('不支持的 UTF 列类型。');
    }
    p += sizes[col.type];
  }
  Buffer.concat(strings).copy(output, stringStart); Buffer.concat(dataParts).copy(output, dataStart);
  return output;
}

export interface AfsArchive { alignment: number; subkey: number; entries: { id: number; bytes: Buffer }[]; header: Buffer }
export function parseAfs2(b: Buffer, headerOnly = false): AfsArchive {
  range(b, 0, 16); if (b.toString('ascii', 0, 4) !== 'AFS2') throw new Error('不是 AFS2 音频容器。');
  const offsetSize = b[5], idSize = b[6], count = b.readUInt32LE(8), alignment = b.readUInt16LE(12), subkey = b.readUInt16LE(14);
  if (![2, 4, 8].includes(offsetSize) || ![1, 2, 4].includes(idSize) || !alignment || count > 65535) throw new Error('不支持的 AFS2 头。');
  const headerLength = 16 + count * idSize + (count + 1) * offsetSize; range(b, 0, headerLength);
  const readOffset = (p: number) => offsetSize === 8 ? Number(b.readBigUInt64LE(p)) : b.readUIntLE(p, offsetSize);
  const entries: AfsArchive['entries'] = [];
  for (let i = 0; i < count; i++) {
    const id = b.readUIntLE(16 + i * idSize, idSize), pos = 16 + count * idSize + i * offsetSize;
    const start = align(readOffset(pos), alignment), end = readOffset(pos + offsetSize);
    if (end < start) throw new Error('AFS2 音频段范围无效。');
    if (!headerOnly) range(b, start, end - start);
    entries.push({ id, bytes: headerOnly ? Buffer.alloc(0) : Buffer.from(b.subarray(start, end)) });
  }
  return { alignment, subkey, entries, header: Buffer.from(b.subarray(0, headerLength)) };
}
export function writeAfs2(entries: AfsArchive['entries'], alignment = 32, subkey = 0): Buffer {
  if (!entries.length || entries.length > 65535 || alignment < 1 || alignment > 65535) throw new Error('AFS2 参数无效。');
  const headerLength = 16 + entries.length * 2 + (entries.length + 1) * 4;
  let end = headerLength; const locations = entries.map(entry => { const start = align(end, alignment); end = start + entry.bytes.length; return start; });
  const b = Buffer.alloc(end); b.write('AFS2'); b[4] = 1; b[5] = 4; b[6] = 2;
  b.writeUInt32LE(entries.length, 8); b.writeUInt16LE(alignment, 12); b.writeUInt16LE(subkey, 14);
  b.writeUInt32LE(headerLength, 16 + entries.length * 2);
  entries.forEach((entry, i) => { b.writeUInt16LE(entry.id, 16 + i * 2); entry.bytes.copy(b, locations[i]); b.writeUInt32LE(locations[i] + entry.bytes.length, 16 + entries.length * 2 + (i + 1) * 4); });
  return b;
}

interface CriCommand { type: number; data: Buffer }
export function parseCommands(b: Buffer): CriCommand[] {
  const commands: CriCommand[] = []; let p = 0;
  while (p < b.length) { range(b, p, 3); const type = b.readUInt16BE(p), length = b[p + 2]; p += 3; range(b, p, length); commands.push({ type, data: Buffer.from(b.subarray(p, p + length)) }); p += length; }
  return commands;
}
function writeCommands(commands: CriCommand[]): Buffer { return Buffer.concat(commands.map(c => { const h = Buffer.alloc(3); h.writeUInt16BE(c.type); h[2] = c.data.length; return Buffer.concat([h, c.data]); })); }
function nested(root: UtfTable, name: string): UtfTable { const data = root.rows[0]?.[name]; if (!Buffer.isBuffer(data) || !data.length) throw new Error(`音频模板缺少 ${name}，无法安全重封装。`); return parseUtf(data); }
function replaceNested(root: UtfTable, name: string, value: UtfTable): void { root.rows[0][name] = writeUtf(value); }
export interface CueAudioInfo { sampleRate: number; channels: number; sampleCount: number; duration: number }

/** Supports the installed game's two-cue (music/preview), single-stream template. Rejects other layouts. */
export function buildCueBank(templateAcb: Buffer, hca: Buffer, name: string, info: CueAudioInfo, previewStart: number, previewEnd: number): { acb: Buffer; awb: Buffer } {
  const root = parseUtf(templateAcb), header = root.rows[0];
  if (root.rows.length !== 1) throw new Error('ACB 模板必须有一个 Header 行。');
  const waves = nested(root, 'WaveformTable'), cue = nested(root, 'CueTable'), cueNames = nested(root, 'CueNameTable');
  const previewIndex = Number(cueNames.rows.find(r => r.CueName === 'preview')?.CueIndex);
  const musicIndex = Number(cueNames.rows.find(r => r.CueName === 'music')?.CueIndex);
  if (waves.rows.length !== 1 || cue.rows.length !== 2 || !Number.isInteger(previewIndex) || !Number.isInteger(musicIndex)) throw new Error('需要只有一个音频流、music/preview 两个 cue 的游戏模板。');
  const wave = waves.rows[0];
  if (Number(wave.EncodeType) !== 2 || Number(wave.Streaming) !== 1 || !('StreamAwbId' in wave)) throw new Error('模板不是可支持的 HCA streaming 布局。');
  Object.assign(wave, { NumSamples: info.sampleCount, NumChannels: info.channels, SamplingRate: info.sampleRate, LoopFlag: 0 });
  cue.rows[musicIndex].Length = Math.round(info.duration * 1000);
  // Keep preview's indefinite sequence length; its seek/end commands delimit the repeated segment.
  const sequences = nested(root, 'SequenceTable'), tracks = nested(root, 'TrackTable'), events = nested(root, 'TrackEventTable');
  if (Number(cue.rows[previewIndex].ReferenceType) !== 3) throw new Error('模板 preview 不是受支持的 sequence 引用。');
  const sequence = sequences.rows[Number(cue.rows[previewIndex].ReferenceIndex)];
  const trackIndices = sequence?.TrackIndex;
  if (!Buffer.isBuffer(trackIndices) || trackIndices.length !== 2 || Number(sequence.NumTracks) !== 1) throw new Error('模板 preview track 布局不受支持。');
  const track = tracks.rows[trackIndices.readUInt16BE(0)], event = events.rows[Number(track?.EventIndex)];
  if (!event || !Buffer.isBuffer(event.Command)) throw new Error('模板 preview event 缺失。');
  const commands = parseCommands(event.Command);
  const start = commands.find(c => c.type === 999 && c.data.length === 4), stop = commands.find(c => c.type === 2001 && c.data.length === 4);
  if (!start || !stop || !commands.some(c => c.type === 2000) || !commands.some(c => c.type === 4000)) throw new Error('模板 preview 命令与当前支持的游戏结构不符。');
  start.data.writeUInt32BE(Math.round(previewStart * 1000)); stop.data.writeUInt32BE(Math.round(previewEnd * 1000)); event.Command = writeCommands(commands);
  const awb = writeAfs2([{ id: Number(wave.StreamAwbId), bytes: hca }]);
  header.Name = name; header.AcbGuid = randomBytes(16);
  const hash = nested(root, 'StreamAwbHash');
  if (hash.rows.length !== 1 || !('Hash' in hash.rows[0])) throw new Error('模板 AWB hash 结构不受支持。');
  hash.rows[0].Name = name; hash.rows[0].Hash = createHash('md5').update(awb).digest();
  const streamHeader = nested(root, 'StreamAwbAfs2Header');
  if (streamHeader.rows.length !== 1 || !('Header' in streamHeader.rows[0])) throw new Error('模板 AWB 头结构不受支持。');
  streamHeader.rows[0].Header = parseAfs2(awb).header;
  for (const [key, value] of Object.entries({ WaveformTable: waves, CueTable: cue, TrackEventTable: events, StreamAwbHash: hash, StreamAwbAfs2Header: streamHeader })) replaceNested(root, key, value);
  // TocWork is a runtime work area. The supported template and new bank both have one entry.
  const work = header.StreamAwbTocWork; if (Buffer.isBuffer(work)) header.StreamAwbTocWork = Buffer.alloc(work.length);
  const acb = writeUtf(root);
  verifyCueBank(acb, awb, name, info, previewStart, previewEnd);
  return { acb, awb };
}

export function verifyCueBank(acb: Buffer, awb: Buffer, name: string, info: CueAudioInfo, previewStart: number, previewEnd: number): void {
  const root = parseUtf(acb), archive = parseAfs2(awb), wave = nested(root, 'WaveformTable').rows[0];
  if (root.rows[0].Name !== name || Number(wave.NumSamples) !== info.sampleCount || Number(wave.SamplingRate) !== info.sampleRate || Number(wave.NumChannels) !== info.channels) throw new Error('ACB 回验：音频元数据不匹配。');
  const hash = nested(root, 'StreamAwbHash').rows[0];
  if (hash.Name !== name || !Buffer.isBuffer(hash.Hash) || !hash.Hash.equals(createHash('md5').update(awb).digest())) throw new Error('ACB 回验：AWB 哈希错误。');
  const storedHeader = nested(root, 'StreamAwbAfs2Header').rows[0].Header;
  if (!Buffer.isBuffer(storedHeader) || !storedHeader.equals(archive.header)) throw new Error('ACB 回验：AFS2 头不匹配。');
  if (archive.entries.length !== 1 || archive.entries[0].id !== Number(wave.StreamAwbId)) throw new Error('ACB 回验：波形引用无效。');
  const commands = nested(root, 'TrackEventTable').rows.flatMap(r => Buffer.isBuffer(r.Command) ? parseCommands(r.Command) : []);
  if (!commands.some(c => c.type === 999 && c.data.length === 4 && c.data.readUInt32BE() === Math.round(previewStart * 1000)) || !commands.some(c => c.type === 2001 && c.data.length === 4 && c.data.readUInt32BE() === Math.round(previewEnd * 1000))) throw new Error('ACB 回验：预览区间错误。');
}

export function extractMusicHca(acb: Buffer, awb: Buffer): Buffer {
  const root = parseUtf(acb), waves = nested(root, 'WaveformTable'), archive = parseAfs2(awb);
  const wave = waves.rows.find(row => Number(row.EncodeType) === 2 && Number(row.Streaming) === 1);
  if (!wave) throw new Error('该曲目没有支持的 streaming HCA 音频。');
  if (archive.subkey !== 0) throw new Error('该 AWB 使用了额外 subkey，当前解码配置不支持。');
  const entry = archive.entries.find(e => e.id === Number(wave.StreamAwbId ?? wave.Id));
  if (!entry) throw new Error('ACB 引用的 HCA 不存在于 AWB。');
  return entry.bytes;
}
