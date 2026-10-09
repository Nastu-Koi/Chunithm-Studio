import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAfs2, parseCommands, parseUtf, type UtfTable, type UtfValue } from './cri';
import { decodeAdx, prepareAudio } from './audio';
import type { GameHitSoundId, GameHitSounds } from '../core/game-sounds';
export type { GameHitSoundId, GameHitSounds } from '../core/game-sounds';

/** Names are taken from the user's chu.h and the bank's CueNameTable, never row numbers. */
const CUES: Partial<Record<GameHitSoundId, string>> = {
  tap: 'se_touch_tap_jcritical_action',
  ex: 'se_touch_chara_fire',
  flick: 'se_touch_flick_jcritical',
  hold: 'se_touch_hold_jcritical',
  slide: 'se_touch_slide_jcritical',
  airUp: 'se_air_cut_up',
  airDown: 'se_air_cut_down',
  airHold: 'se_air_hold_jcritical',
};

export interface ExtractedCueLayer {
  waveformId: number;
  bytes: Buffer;
  sampleRate: number;
  sampleCount: number;
  gain: number;
  playbackRate: number;
}
type Row = Record<string, UtfValue>;

/**
 * Independent reader for the installed bank's ADX one-shot cues. The traversal of
 * sequence -> track event -> synth -> waveform follows the actual UTF references.
 * It chooses the named Default instrument and the Phone_1pass route. It does not
 * attempt to emulate CRI's dynamic AISAC, DSP, envelope or randomization engine.
 * Reference facts: https://github.com/vgmstream/vgmstream/blob/master/src/meta/acb.c
 */
class HitSoundBank {
  private root: Row;
  private tables = new Map<string, UtfTable>();
  private archive?: ReturnType<typeof parseAfs2>;

  constructor(acb: Buffer) {
    const header = parseUtf(acb);
    if (header.rows.length !== 1) throw new Error('音效 ACB 必须有一个 Header 行。');
    this.root = header.rows[0];
  }
  private table(name: string): UtfTable {
    let table = this.tables.get(name);
    if (!table) {
      const data = this.root[name];
      if (!Buffer.isBuffer(data) || !data.length) throw new Error(`音效 ACB 缺少 ${name}。`);
      table = parseUtf(data); this.tables.set(name, table);
    }
    return table;
  }
  private row(name: string, index: number): Row {
    if (!Number.isInteger(index) || index < 0) throw new Error(`音效 ${name} 索引无效。`);
    const row = this.table(name).rows[index];
    if (!row) throw new Error(`音效 ${name}[${index}] 引用越界。`);
    return row;
  }
  private commands(table: string, index: UtfValue | undefined): ReturnType<typeof parseCommands> {
    if (index === undefined || Number(index) === 65535) return [];
    const data = this.row(table, Number(index)).Command;
    if (!Buffer.isBuffer(data)) throw new Error(`音效 ${table} 命令无效。`);
    return parseCommands(data);
  }
  private parameters(table: string, index: UtfValue | undefined, inherited: number): number | null {
    let gain = inherited;
    for (const command of this.commands(table, index)) {
      if (command.type === 100) {
        if (command.data.length !== 4) throw new Error('音效 selector 格式不支持。');
        const selector = this.row('StringValueTable', command.data.readUInt16BE(0)).StringValue;
        const label = this.row('StringValueTable', command.data.readUInt16BE(2)).StringValue;
        if (selector !== 'Options_Tap_Inst') throw new Error(`暂不支持音效 selector ${selector}。`);
        if (label !== 'Default') return null;
      }
      if (command.type === 111) {
        if (command.data.length !== 4) throw new Error('音效总线路由格式不支持。');
        const bus = this.row('StringValueTable', command.data.readUInt16BE(0)).StringValue;
        if (bus === 'Phone_1pass') gain *= command.data.readUInt16BE(2) / 10000;
      }
    }
    return gain;
  }
  extract(cueName: string): ExtractedCueLayer[] {
    const name = this.table('CueNameTable').rows.find(row => row.CueName === cueName);
    if (!name) throw new Error(`本地音效库没有 ${cueName}。`);
    const cue = this.row('CueTable', Number(name.CueIndex));
    const layers: ExtractedCueLayer[] = [], active = new Set<string>();
    const visit = (type: number, index: number, gain: number, depth = 0): void => {
      if (gain === 0) return;
      if (depth > 16 || active.has(`${type}:${index}`)) throw new Error('音效引用含循环或过深嵌套。');
      active.add(`${type}:${index}`);
      try {
        if (type === 1) {
          const wave = this.row('WaveformTable', index);
          if (Number(wave.Streaming) !== 0 || Number(wave.EncodeType) !== 0) throw new Error('此音效不是受支持的内嵌 ADX 波形。');
          if (!this.archive) {
            if (!Buffer.isBuffer(this.root.AwbFile)) throw new Error('音效 ACB 缺少内嵌 AWB。');
            this.archive = parseAfs2(this.root.AwbFile);
            if (this.archive.subkey !== 0) throw new Error('音效 AWB 使用了未支持的 subkey。');
          }
          const id = Number(wave.MemoryAwbId), entry = this.archive.entries.find(row => row.id === id);
          if (!entry) throw new Error(`音效波形 ${id} 不在内嵌 AWB 中。`);
          if (entry.bytes.length < 24 || entry.bytes.readUInt16BE(0) !== 0x8000) throw new Error('内嵌音效的 ADX 头无效。');
          const sampleRate = Number(wave.SamplingRate), sampleCount = Number(wave.NumSamples);
          if (!(sampleRate > 0) || !(sampleCount > 0)) throw new Error('音效采样信息无效。');
          layers.push({ waveformId: id, bytes: entry.bytes, sampleRate, sampleCount, gain, playbackRate: 1 });
        } else if (type === 2) {
          const synth = this.row('SynthTable', index);
          if (Number(synth.Type) !== 0 || Number(synth.NumActionTracks) > 0) throw new Error('此音效使用了未支持的 synth 触发方式。');
          const nextGain = this.parameters('SynthCommandTable', synth.CommandIndex, gain);
          if (nextGain === null || nextGain === 0) return;
          const items = synth.ReferenceItems;
          if (!Buffer.isBuffer(items) || items.length % 4 !== 0) throw new Error('音效 synth 引用列表损坏。');
          for (let i = 0; i < items.length; i += 4) visit(items.readUInt16BE(i), items.readUInt16BE(i + 2), nextGain, depth + 1);
        } else if (type === 3) {
          const sequence = this.row('SequenceTable', index);
          if (Number(sequence.Type) !== 0 || Number(sequence.NumActionTracks) > 0) throw new Error('此音效使用了未支持的 sequence 触发方式。');
          const nextGain = this.parameters('SeqCommandTable', sequence.CommandIndex, gain);
          if (nextGain === null || nextGain === 0) return;
          const indexes = sequence.TrackIndex;
          if (!Buffer.isBuffer(indexes) || indexes.length !== Number(sequence.NumTracks) * 2) throw new Error('音效 track 引用列表损坏。');
          for (let i = 0; i < indexes.length; i += 2) {
            const track = this.row('TrackTable', indexes.readUInt16BE(i));
            const trackGain = this.parameters('TrackCommandTable', track.CommandIndex, nextGain);
            if (trackGain === null || trackGain === 0) continue;
            for (const command of this.commands('TrackEventTable', track.EventIndex)) {
              if (command.type === 0) continue;
              if (![2000, 2003].includes(command.type) || command.data.length < 4) throw new Error('此音效包含未支持的时间或触发命令。');
              visit(command.data.readUInt16BE(0), command.data.readUInt16BE(2), trackGain, depth + 1);
            }
          }
        } else throw new Error(`音效引用类型 ${type} 暂不支持。`);
      } finally { active.delete(`${type}:${index}`); }
    };
    visit(Number(cue.ReferenceType), Number(cue.ReferenceIndex), 1);
    if (!layers.length) throw new Error(`音效 ${cueName} 在默认音色与耳机路由下没有波形。`);
    return layers;
  }
}

export function extractCueLayers(acb: Buffer, cueName: string): ExtractedCueLayer[] {
  return new HitSoundBank(acb).extract(cueName);
}

async function exists(filename: string): Promise<boolean> { try { await access(filename); return true; } catch { return false; } }
function localPath(filename: string): string { return process.platform !== 'win32' && /^[a-z]:[/\\]/i.test(filename) ? `/mnt/${filename[0].toLowerCase()}/${filename.slice(3).replaceAll('\\', '/')}` : filename; }
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }

/** One-time import or cache refresh. Writes only to the explicitly supplied destination. */
export async function loadGameHitSounds(gamePath: string, cacheDirectory: string): Promise<GameHitSounds> {
  const gameRoot = await realpath(path.resolve(localPath(gamePath)));
  const output = path.resolve(localPath(cacheDirectory));
  let ancestor = output;
  while (!await exists(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  const realOutput = path.resolve(await realpath(ancestor), path.relative(ancestor, output));
  if (inside(gameRoot, realOutput)) throw new Error('音效导入目标不能位于原游戏目录内。');
  const source = path.join(gameRoot, 'data', 'sound', 'chu.acb');
  if (!await exists(source)) throw new Error('游戏目录中没有 data/sound/chu.acb，无法读取原版打击音。');
  const bank = new HitSoundBank(await readFile(source));
  const result: GameHitSounds = { source, sounds: {}, warnings: [
    '使用原版 ADX 波形、默认 TAP 音色及 Phone_1pass 路由；尚未重现 CRI 的动态 AISAC、包络、滤波、音高命令与持续循环音，听感不等于原游戏完整混音。',
    'EX 选用归于 VolumeOptions_ExTap 的 se_touch_chara_fire；具体 EX 特效分支和 se_touch_chara_laser 的调用条件尚未实机对照。',
    'airHold 使用 se_air_hold_jcritical；将它用于 AIR-SLIDE 属于预览映射，原版 AIR-SLIDE 的音效触发规则尚未确认。',
    'AIR-CRUSH 的原版 cue 调用关系尚未确认，本次没有指定该音效。',
  ] };
  await mkdir(output, { recursive: true });
  for (const [id, cueName] of Object.entries(CUES)) {
    const layers = bank.extract(cueName);
    const imported = [];
    for (const layer of layers) {
      const digest = createHash('sha256').update(layer.bytes).digest('hex');
      const wavPath = path.join(output, `adx-pcm48-v2-${digest.slice(0, 24)}.wav`);
      let cached = false;
      try { const wav = await readFile(wavPath); cached = wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE'; } catch { /* Missing cache entry. */ }
      if (!cached) {
        const temp = await mkdtemp(path.join(output, '.game-audio-'));
        try {
          const adx = path.join(temp, 'sound.adx'), decoded = path.join(temp, 'decoded.wav'), wav = path.join(temp, 'sound.wav');
          await writeFile(adx, layer.bytes, { flag: 'wx' });
          await decodeAdx(adx, decoded);
          await prepareAudio(decoded, wav);
          await rename(wav, wavPath);
        } finally { await rm(temp, { recursive: true, force: true }); }
      }
      imported.push({ path: wavPath, gain: layer.gain, playbackRate: layer.playbackRate });
    }
    result.sounds[id as GameHitSoundId] = { cueName, layers: imported };
  }
  return result;
}
