import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAfs2, parseCommands, parseUtf, type UtfTable, type UtfValue } from './cri';
import { decodeAdx, prepareAudio } from './audio';
import type { GameHitSoundEnvelope, GameHitSoundId, GameHitSoundLimit, GameHitSounds } from '../core/game-sounds';
export type { GameHitSoundId, GameHitSounds } from '../core/game-sounds';

/** Names are taken from the user's chu.h and the bank's CueNameTable, never row numbers. */
const CUES: Partial<Record<GameHitSoundId, string>> = {
  tap: 'se_touch_tap_jcritical',
  ex: 'se_touch_chara_laser',
  flick: 'se_touch_flick_jcritical',
  hold: 'se_touch_hold_jcritical',
  slide: 'se_touch_slide_jcritical',
  holdStart: 'se_touch_hold_jcritical_loop',
  slideStart: 'se_touch_slide_jcritical_loop',
  airUp: 'se_air_cut_up',
  airDown: 'se_air_cut_down',
  airHoldIn: 'se_air_hold_in',
  airHoldLoop: 'se_air_hold_loop',
  airHold: 'se_air_hold_beat',
  airCrush: 'se_air_cut_break',
};

export interface ExtractedCueLayer {
  waveformId: number;
  bytes: Buffer;
  sampleRate: number;
  sampleCount: number;
  gain: number;
  playbackRate: number;
  envelope?: GameHitSoundEnvelope;
  stopAfter?: number;
  loop?: { start: number; end: number };
  group?: number;
}
export interface ExtractedCue {
  layers: ExtractedCueLayer[];
  limits: GameHitSoundLimit[];
  /** Command codes found on the cue's path whose meaning is not established; their effect is not reproduced. */
  unsupported: number[];
  /** Parts handled approximately, as `kind:cueName`: `curve` (a non-linear envelope curve, played linear) and `aisac` (a time-driven AISAC, not reproduced). */
  notes: string[];
}
type Row = Record<string, UtfValue>;
type CueContext = { limit?: number; categories: number[]; unsupported: Set<number>; notes: Set<string> };
/** Times in milliseconds as the bank stores them; sustain is a level from 0 to 1. */
type LayerState = { gain: number; cents: number; attack: number; hold: number; decay: number; sustain: number; release: number };
type CueParts = { layers: ExtractedCueLayer[]; limits: GameHitSoundLimit[]; unsupported: Set<number>; notes: Set<string> };
const START: LayerState = { gain: 1, cents: 0, attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
const table = (root: Row, name: string): Row[] => { const data = root[name]; return Buffer.isBuffer(data) && data.length ? parseUtf(data).rows : []; };

/**
 * The parts of the Atom Config File that shape a one-shot hit sound on the headphone route.
 * Evidence for the command codes read here: chu_acf.h documents SE_Game as "Volume0.75" and its category command is
 * 87 with value 75; the Limit_* categories carry command 73 with a count and one of the file's cue-limit work slots.
 */
export class HitSoundMix {
  private categories = new Map<number, { name: string; volume: number; limit?: number }>();
  private busVolume = 1;
  constructor(acf: Buffer) {
    const header = parseUtf(acf);
    if (header.rows.length !== 1) throw new Error('音效 ACF 必须有一个 Header 行。');
    const root = header.rows[0], commands = table(root, 'CommandTable'), names = new Map(table(root, 'CategoryNameTable').map(row => [Number(row.Index), String(row.Name)]));
    for (const [index, row] of table(root, 'CategoryTable').entries()) {
      const category: { name: string; volume: number; limit?: number } = { name: names.get(index) ?? `category${index}`, volume: 1 };
      const command = commands[Number(row.CommandIndex)]?.Command;
      if (Number(row.CommandIndex) !== 65535 && Buffer.isBuffer(command)) for (const item of parseCommands(command)) {
        if (item.type === 87 && item.data.length === 2) category.volume *= item.data.readUInt16BE(0) / 100;
        if (item.type === 73 && item.data.length === 4) category.limit = item.data.readUInt16BE(0);
      }
      this.categories.set(Number(row.Id ?? index), category);
    }
    // The first DSP bus setting is the one a project attaches by default.
    const setting = table(root, 'DspSettingTable')[0], busNames = table(root, 'BusNameTable'), buses = table(root, 'BusTable');
    if (setting) for (const bus of buses.slice(Number(setting.StartIndex), Number(setting.StartIndex) + Number(setting.NumBuses)))
      if (Object.values(busNames[Number(bus.BusNameIndex)] ?? {}).includes('Phone_1pass')) this.busVolume = Number(bus.Volume);
  }
  /** Category volumes and the Phone_1pass bus volume, as one factor. */
  gain(categories: readonly number[]): number { return categories.reduce((gain, id) => gain * (this.categories.get(id)?.volume ?? 1), this.busVolume); }
  limits(categories: readonly number[]): GameHitSoundLimit[] {
    return categories.flatMap(id => { const category = this.categories.get(id); return category?.limit ? [{ key: `category:${category.name}`, max: category.limit }] : []; });
  }
}

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
  /**
   * Command meanings beyond the bus send were checked against the CRI Atom runtime linked into chusanApp.exe: its command
   * reader writes 87 to the parameter criAtomExPlayer_SetVolume uses, 5 to the one criAtomExPlayer_SetPitch uses (cents),
   * and 36 to 40 to the five parameters behind criAtomExPlayer_SetEnvelope{Attack,Hold,Decay}Time, ...SustainLevel
   * and ...ReleaseTime. 121 repeats the summed pitch as the voice's maximum pitch and changes nothing audible.
   * See docs/native-hit-sounds.md.
   */
  private parameters(table: string, index: UtfValue | undefined, inherited: LayerState, context: CueContext): LayerState | null {
    const state = { ...inherited };
    for (const command of this.commands(table, index)) {
      const { type, data } = command, word = (offset: number) => data.readUInt16BE(offset);
      if (type === 100) {
        if (data.length !== 4) throw new Error('音效 selector 格式不支持。');
        const selector = this.row('StringValueTable', word(0)).StringValue;
        const label = this.row('StringValueTable', word(2)).StringValue;
        if (selector !== 'Options_Tap_Inst') throw new Error(`暂不支持音效 selector ${selector}。`);
        if (label !== 'Default') return null;
      } else if (type === 111) {
        if (data.length !== 4) throw new Error('音效总线路由格式不支持。');
        const bus = this.row('StringValueTable', word(0)).StringValue;
        if (bus === 'Phone_1pass') state.gain *= word(2) / 10000;
      }
      // Volume in percent, the same command a category uses for its volume.
      else if (type === 87 && data.length === 2) state.gain *= word(0) / 100;
      // Pitch in cents, added down the sequence, track and synth.
      else if (type === 5 && data.length === 2) state.cents += data.readInt16BE(0);
      else if (type === 121 && data.length === 2) { /* Maximum pitch of the voice: a hint for the mixer. */ }
      // Envelope. The times with a curve carry its type in the third byte; 0 is linear.
      else if ((type === 36 || type === 38 || type === 40) && data.length === 4) {
        state[type === 36 ? 'attack' : type === 38 ? 'decay' : 'release'] = word(0);
        if (data[2] !== 0) context.notes.add('curve');
      }
      else if (type === 37 && data.length === 4) state.hold = word(2);
      else if (type === 39 && data.length === 2) state.sustain = Math.min(1, word(0) / 10000);
      // Cue limit: the first value is the number of simultaneous playbacks of this cue.
      else if (type === 79 && data.length >= 2) context.limit = word(0);
      // Category indexes into the ACF's CategoryTable.
      else if (type === 65 && data.length % 4 === 0) for (let offset = 0; offset < data.length; offset += 4) context.categories.push(data.readUInt32BE(offset));
      else context.unsupported.add(type);
    }
    return state;
  }
  /** Time-driven AISACs (filter sweeps and the like) are attached per sequence, track or synth; none is reproduced. */
  private aisacs(row: Row, context: CueContext): void { if (Buffer.isBuffer(row.LocalAisacs) && row.LocalAisacs.length) context.notes.add('aisac'); }
  /** One cue's own waveforms, plus those of the cues its action tracks start. */
  private parts(cueName: string, mix: HitSoundMix | undefined, stopAfter: number | undefined, level: number): CueParts {
    if (level > 4) throw new Error('音效动作引用过深。');
    const name = this.table('CueNameTable').rows.find(row => row.CueName === cueName);
    if (!name) throw new Error(`本地音效库没有 ${cueName}。`);
    const cue = this.row('CueTable', Number(name.CueIndex));
    const layers: ExtractedCueLayer[] = [], started: CueParts[] = [], active = new Set<string>();
    const context: CueContext = { categories: [], unsupported: new Set(), notes: new Set() };
    const visit = (type: number, index: number, state: LayerState, depth = 0): void => {
      if (state.gain === 0) return;
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
          // Sustained waveforms carry their loop points in an extension row.
          const extension = Number(wave.LoopFlag) === 2 && Number(wave.ExtensionData) !== 65535 ? this.row('WaveformExtensionDataTable', Number(wave.ExtensionData)) : undefined;
          const loop = extension && Number(extension.LoopEnd) > Number(extension.LoopStart) ? { start: Number(extension.LoopStart) / sampleRate, end: Number(extension.LoopEnd) / sampleRate } : undefined;
          const shaped = state.attack > 0 || state.hold > 0 || state.decay > 0 || state.sustain < 1 || state.release > 0;
          layers.push({ waveformId: id, bytes: entry.bytes, sampleRate, sampleCount, gain: state.gain, playbackRate: 2 ** (state.cents / 1200),
            ...(shaped ? { envelope: { attack: state.attack / 1000, hold: state.hold / 1000, decay: state.decay / 1000, sustain: state.sustain, release: state.release / 1000 } } : {}),
            ...(stopAfter === undefined ? {} : { stopAfter }), ...(loop ? { loop } : {}) });
        } else if (type === 2) {
          const synth = this.row('SynthTable', index);
          if (Number(synth.Type) !== 0 || Number(synth.NumActionTracks) > 0) throw new Error('此音效使用了未支持的 synth 触发方式。');
          this.aisacs(synth, context);
          const next = this.parameters('SynthCommandTable', synth.CommandIndex, state, context);
          if (next === null || next.gain === 0) return;
          const items = synth.ReferenceItems;
          if (!Buffer.isBuffer(items) || items.length % 4 !== 0) throw new Error('音效 synth 引用列表损坏。');
          for (let i = 0; i < items.length; i += 4) visit(items.readUInt16BE(i), items.readUInt16BE(i + 2), next, depth + 1);
        } else if (type === 3) {
          const sequence = this.row('SequenceTable', index);
          // Type 6 (the sustained loops) plays one of its tracks per start; they share a waveform, so the first stands for all.
          const single = Number(sequence.Type) === 6;
          if (Number(sequence.Type) !== 0 && !single) throw new Error('此音效使用了未支持的 sequence 触发方式。');
          if (single) context.notes.add('variant');
          this.aisacs(sequence, context);
          const next = this.parameters('SeqCommandTable', sequence.CommandIndex, state, context);
          if (next === null) return;
          // Action tracks start (and may later stop) other cues of this bank: TAP judgements are built this way.
          for (let i = 0; i < Number(sequence.NumActionTracks ?? 0); i++) {
            const action = this.row('ActionTrackTable', Number(sequence.ActionTrackStartIndex) + i);
            if (Number(action.TargetType) !== 1 || (this.root.Name !== undefined && action.TargetAcbName !== this.root.Name)) throw new Error('此音效的动作目标不在本音效库内。');
            const cueIndex = this.table('CueTable').rows.findIndex(row => Number(row.CueId) === Number(action.TargetId));
            const target = this.table('CueNameTable').rows.find(row => Number(row.CueIndex) === cueIndex)?.CueName;
            if (cueIndex < 0 || typeof target !== 'string') throw new Error('此音效的动作目标不存在。');
            let time = 0, play: number | undefined, stop: number | undefined;
            for (const command of this.commands('TrackEventTable', action.CommandIndex)) {
              if (command.type === 0) continue;
              if (command.type === 7100 && play === undefined) play = time;
              else if (command.type === 2001 && command.data.length === 4) time += command.data.readUInt32BE(0);
              else if (command.type === 7101 && play !== undefined && stop === undefined) stop = time;
              else throw new Error('此音效包含未支持的动作命令。');
            }
            if (play !== 0) throw new Error('此音效的动作不是立即播放，暂不支持。');
            const after = stop === undefined ? stopAfter : Math.min(stop / 1000, stopAfter ?? Infinity);
            started.push(this.parts(target, mix, after, level + 1));
          }
          // A cue silent on this route still starts its actions: they are routed by their own cues.
          if (next.gain === 0) return;
          const indexes = sequence.TrackIndex;
          if (!Buffer.isBuffer(indexes) || indexes.length !== Number(sequence.NumTracks) * 2) throw new Error('音效 track 引用列表损坏。');
          for (let i = 0; i < (single ? Math.min(2, indexes.length) : indexes.length); i += 2) {
            const track = this.row('TrackTable', indexes.readUInt16BE(i));
            this.aisacs(track, context);
            const trackState = this.parameters('TrackCommandTable', track.CommandIndex, next, context);
            if (trackState === null || trackState.gain === 0) continue;
            for (const command of this.commands('TrackEventTable', track.EventIndex)) {
              if (command.type === 0) continue;
              if (![2000, 2003].includes(command.type) || command.data.length < 4) throw new Error('此音效包含未支持的时间或触发命令。');
              visit(command.data.readUInt16BE(0), command.data.readUInt16BE(2), trackState, depth + 1);
            }
          }
        } else throw new Error(`音效引用类型 ${type} 暂不支持。`);
      } finally { active.delete(`${type}:${index}`); }
    };
    visit(Number(cue.ReferenceType), Number(cue.ReferenceIndex), START);
    const scale = mix?.gain(context.categories) ?? 1;
    const parts: CueParts = { layers: layers.map(layer => ({ ...layer, gain: layer.gain * scale })),
      limits: [...(context.limit ? [{ key: `cue:${cueName}`, max: context.limit }] : []), ...(mix?.limits(context.categories) ?? [])],
      unsupported: context.unsupported, notes: new Set([...context.notes].map(note => `${note}:${cueName}`)) };
    // Each started cue is a group of its own: its limits stop its layers and leave the rest of the sound playing.
    let group = 0;
    for (const other of started) {
      group++;
      parts.layers.push(...other.layers.map(layer => ({ ...layer, group })));
      for (const limit of other.limits) parts.limits.push({ ...limit, group });
      for (const code of other.unsupported) parts.unsupported.add(code);
      for (const note of other.notes) parts.notes.add(note);
    }
    return parts;
  }
  extract(cueName: string, mix?: HitSoundMix): ExtractedCue {
    const parts = this.parts(cueName, mix, undefined, 0);
    if (!parts.layers.length) throw new Error(`音效 ${cueName} 在默认音色与耳机路由下没有波形。`);
    return { layers: parts.layers, limits: parts.limits, unsupported: [...parts.unsupported].sort((a, b) => a - b), notes: [...parts.notes].sort() };
  }
}

export function extractCueLayers(acb: Buffer, cueName: string): ExtractedCueLayer[] {
  return new HitSoundBank(acb).extract(cueName).layers;
}
export function extractCue(acb: Buffer, cueName: string, acf?: Buffer): ExtractedCue {
  return new HitSoundBank(acb).extract(cueName, acf ? new HitSoundMix(acf) : undefined);
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
    '使用原版 ADX 波形、默认 TAP 音色及 Phone_1pass 路由，并按音效库还原各级音量、音高、包络、动作轨（TAP 判定音在 50 毫秒后转入释音）以及 Cue 与分类的同时发声数限制；尚未重现游戏内各项音量选项（AISAC）。',
  ] };
  const config = path.join(gameRoot, 'data', 'sound', 'chu.acf');
  const mix = await exists(config) ? new HitSoundMix(await readFile(config)) : undefined;
  if (!mix) result.warnings.push('游戏目录中没有 data/sound/chu.acf：未应用分类音量、总线音量与分类发声数限制。');
  const unsupported = new Map<number, string[]>(), notes = new Map<string, string[]>();
  await mkdir(output, { recursive: true });
  for (const [id, cueName] of Object.entries(CUES)) {
    const { layers, limits, unsupported: codes, notes: approximations } = bank.extract(cueName, mix);
    for (const code of codes) unsupported.set(code, [...(unsupported.get(code) ?? []), cueName]);
    for (const note of approximations) { const [kind, cue] = note.split(':'); notes.set(kind, [...new Set([...(notes.get(kind) ?? []), cue])]); }
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
      imported.push({ path: wavPath, gain: layer.gain, playbackRate: layer.playbackRate, ...(layer.envelope ? { envelope: layer.envelope } : {}), ...(layer.stopAfter === undefined ? {} : { stopAfter: layer.stopAfter }),
        ...(layer.loop ? { loop: layer.loop } : {}), ...(layer.group === undefined ? {} : { group: layer.group }) });
    }
    result.sounds[id as GameHitSoundId] = { cueName, layers: imported, ...(limits.length ? { limits } : {}) };
  }
  const short = (cues: string[]) => cues.map(cue => cue.replace(/^se_/, '')).join('、');
  if (unsupported.size) result.warnings.push(`以下命令的含义尚无依据，未套用其效果：${[...unsupported].sort((a, b) => a[0] - b[0]).map(([code, cues]) => `${code}（${short(cues)}）`).join('；')}。`);
  if (notes.has('aisac')) result.warnings.push(`以下音效带随时间变化的 AISAC（滤波或音量扫动），未重现：${short(notes.get('aisac')!)}。`);
  if (notes.has('variant')) result.warnings.push(`以下循环音每次从四条音轨里取一条，这里固定取第一条：${short(notes.get('variant')!)}。`);
  if (notes.has('curve')) result.warnings.push(`以下音效的包络使用非线性曲线，按线性处理：${short(notes.get('curve')!)}。`);
  return result;
}
