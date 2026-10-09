import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createProject, createNote, type Project, type Note, type NoteType, type ChartEvent } from '../src/core/model';
import { tickToSeconds, getNoteScrollGroup, getScrollPosition } from '../src/core/timing';
import { analyzeC2SQuantization } from '../src/core/quantization';
import { validateProject } from '../src/core/validation';
import { parseC2S, serializeC2S } from '../src/core/c2s';
import { saveProject, readProject } from '../src/backend/projects';
import { exportOpt } from '../src/backend/export';
import { decodeDDS } from '../src/backend/dds-preview';

const examples = path.resolve('examples');
const gamePath = process.env.CHUNITHM_GAME_PATH ?? '/mnt/d/chunithm';
const duration = 26.2;
const sampleRate = 48000;
const beat = 96, bar = 384;
let counter = 0;
function note(type: NoteType, tick: number, lane: number, width: number, props: Partial<Note> = {}): Note {
  return { ...createNote(type, tick, lane, width), id: `calibration-note-${++counter}`, ...props };
}
const bpm = (id: string, tick: number, value: number): ChartEvent => ({ id, type: 'BPM', tick, value });
function metadata(project: Project, title: string): void {
  project.id = title.startsWith('Sevenfold') ? 'example-sevenths-v1' : 'example-calibration-v1';
  project.metadata = { title, artist: 'Chuni Studio Original Synthesis', designer: 'Chuni Studio', difficulty: 'WORLD’S END', level: '0' };
  project.exportSettings = { optId: 'AZ01', musicId: 7000, cueId: 7000, weTag: '改', stars: 3 };
  project.audio.previewStart = 8; project.audio.previewEnd = 14.4;
}
function makeCalibration(): Project {
  const project = createProject(); metadata(project, 'Chuni Studio Calibration');
  const chart = project.chart;
  chart.events = [bpm('bpm-120', 0, 120), bpm('bpm-150', bar * 4, 150), bpm('bpm-90', bar * 8, 90),
    { id: 'stop-sfl', type: 'SCROLL', tick: bar * 5, duration: beat, value: 0 },
    { id: 'reverse-sfl', type: 'SCROLL', tick: bar * 6, duration: beat, value: -1 },
    { id: 'fast-group', type: 'GROUP_SCROLL', tick: bar * 6 + beat * 2, duration: bar * 3, value: 2, group: 1 },
  ];
  chart.notes = [
    note('TAP', bar, 0, 4), note('EXTAP', bar + beat, 4, 4, { attributes: { effect: 'CE' } }),
    note('FLICK', bar + beat * 2, 8, 4, { attributes: { direction: 'L' } }), note('TAP', bar + beat * 3, 12, 4),
    note('AIR', bar + beat * 3, 12, 4, { attributes: { direction: 'UR', parent: 'TAP', color: 'DEF' } }),
    note('HOLD', bar * 2, 0, 4, { duration: beat * 3 }),
    note('SLIDE', bar * 2, 8, 4, { duration: beat, endLane: 4, endWidth: 4, attributes: { visible: false, parent: 'SLD' } }),
    note('SLIDE', bar * 2 + beat, 4, 4, { duration: beat * 2, endLane: 4, endWidth: 4, attributes: { visible: true, parent: 'SLD' } }),
    note('AIR', bar * 2 + beat * 3, 0, 4, { attributes: { direction: 'UL', parent: 'HLD', color: 'DEF' } }),
    note('TAP', bar * 3, 0, 4),
    note('AIR_HOLD', bar * 3, 0, 4, { duration: beat * 2, attributes: { parent: 'TAP', color: 'DEF', visible: true } }),
    note('AIR_HOLD', bar * 3 + beat * 2, 0, 4, { duration: beat, attributes: { parent: 'AHD', color: 'DEF', visible: true } }),
    note('TAP', bar * 3, 8, 4),
    note('AIR_SLIDE', bar * 3, 8, 4, { duration: beat * 2, endLane: 12, endWidth: 4, height: 5, endHeight: 5, attributes: { parent: 'TAP', color: 'DEF', visible: true } }),
    note('AIR_SLIDE', bar * 3 + beat * 2, 12, 4, { duration: beat, endLane: 12, endWidth: 4, height: 5, endHeight: 5, attributes: { parent: 'ASD', color: 'DEF', visible: true } }),
    ...[0, 1, 2, 3].map(i => note('TAP', bar * 4 + beat * i, i * 4, 4)),
    note('DAMAGE', bar * 4 + beat * 1.5, 6, 4),
    note('TAP', bar * 5 + beat * 2, 2, 4), note('TAP', bar * 5 + beat * 3, 10, 4),
    note('TAP', bar * 6 + beat * 2, 2, 4), note('TAP', bar * 6 + beat * 3, 10, 4),
    note('TAP', bar * 7 + beat, 10, 4), note('TAP', bar * 7 + beat * 2, 2, 4),
    note('TAP', bar * 7 + beat * 3, 10, 4), note('TAP', bar * 8, 2, 4),
    note('TAP', bar * 8 + beat, 4, 4),
    note('AIR_CRUSH', bar * 8 + beat * 2, 6, 4, { duration: beat * 2, endLane: 6, endWidth: 4, height: 5, endHeight: 5, attributes: { interval: 48, color: 'DEF', effect: 'DEF' } }),
    note('HOLD', bar * 9, 0, 4, { duration: beat * 3 }),
    note('SLIDE', bar * 9, 12, 4, { duration: beat, endLane: 8, endWidth: 4, attributes: { parent: 'SLD', visible: false } }),
    note('SLIDE', bar * 9 + beat, 8, 4, { duration: beat * 2, endLane: 8, endWidth: 4, attributes: { parent: 'SLD', visible: true } }),
    note('AIR', bar * 9 + beat * 3, 8, 4, { attributes: { direction: 'IR', parent: 'SLD', color: 'DEF' } }),
    note('TAP', bar * 10, 0, 4), note('DAMAGE', bar * 10 + beat, 12, 4), note('TAP', bar * 10 + beat * 2, 6, 4),
    note('AIR', bar * 10 + beat * 2, 6, 4, { attributes: { direction: 'DW', parent: 'TAP', color: 'DEF' } }),
    note('TAP', bar * 10 + beat * 3, 12, 4),
    note('TAP', bar * 11, 0, 4), note('TAP', bar * 11 + beat, 6, 4), note('FLICK', bar * 11 + beat * 2, 12, 4, { attributes: { direction: 'L' } }),
    note('EXTAP', bar * 11 + beat * 3, 4, 8, { attributes: { effect: 'CE' } }),
    note('AIR', bar * 11 + beat * 3, 4, 8, { attributes: { direction: 'IR', parent: 'CHR', color: 'DEF' } }),
  ];
  for (const tick of [bar * 7 + beat, bar * 7 + beat * 3]) chart.events.push({ id: `assign-${tick}`, type: 'SCROLL_ASSIGNMENT', tick, duration: 1, lane: 10, width: 4, group: 1, value: 1 });
  return project;
}
function makeSevenths(): Project {
  const project = createProject(); metadata(project, 'Sevenfold — 7等分演示');
  project.id = 'example-sevenths-v1'; project.metadata.difficulty = 'MASTER'; project.metadata.level = '8';
  project.chart.events = [bpm('sevenths-bpm-120', 0, 120), bpm('sevenths-bpm-150', bar * 4 + bar / 7, 150), bpm('sevenths-bpm-90', bar * 8, 90)];
  const notes: Note[] = [];
  for (let i = 0; i < 7; i++) notes.push(note('TAP', bar + i * bar / 7, i % 4 * 4, 4));
  for (let i = 0; i < 28; i++) notes.push(note('TAP', bar * 2 + i * beat / 7, i % 4 * 4, 4));
  notes.push(note('HOLD', bar * 3 + bar / 7, 2, 4, { duration: bar * 5 / 7 }));
  notes.push(note('HOLD', bar * 4, 10, 4, { duration: bar * 6 / 7 }));
  for (let measure = 5; measure < 12; measure++) for (let i = 0; i < 7; i++) notes.push(note(i === 6 ? 'EXTAP' : 'TAP', measure * bar + i * bar / 7, i % 4 * 4, 4));
  project.chart.notes = notes;
  return project;
}
function checkAirParents(project: Project): void {
  const nativeType: Partial<Record<NoteType, string>> = { TAP: 'TAP', EXTAP: 'CHR', HOLD: 'HLD', SLIDE: 'SLD', AIR_HOLD: 'AHD', AIR_SLIDE: 'ASD' };
  for (const child of project.chart.notes) {
    if (!['AIR', 'AIR_HOLD', 'AIR_SLIDE'].includes(child.type)) continue;
    const parent = project.chart.notes.find(candidate => candidate !== child && nativeType[candidate.type] === child.attributes.parent && (
      candidate.tick === child.tick && candidate.lane === child.lane && candidate.width === child.width ||
      candidate.duration !== undefined && candidate.tick + candidate.duration === child.tick && (candidate.endLane ?? candidate.lane) === child.lane && (candidate.endWidth ?? candidate.width) === child.width));
    assert.ok(parent, `AIR parent missing for ${child.id}`);
  }
  for (const segment of project.chart.notes.filter(n => n.type === 'SLIDE' && n.attributes.visible === false)) {
    assert.ok(project.chart.notes.some(n => n.type === 'SLIDE' && n.tick === segment.tick + segment.duration! && n.lane === segment.endLane && n.width === segment.endWidth), `Slide chain breaks at ${segment.id}`);
  }
}
function synthesize(project: Project): Buffer {
  const frameCount = Math.ceil(duration * sampleRate), mix = new Float32Array(frameCount * 2);
  function tone(seconds: number, frequency: number, amplitude: number, length = 0.08, pan = 0): void {
    const start = Math.round(seconds * sampleRate), frames = Math.ceil(length * sampleRate);
    for (let i = 0; i < frames && start + i < frameCount; i++) {
      if (start + i < 0) continue;
      const t = i / sampleRate;
      const value = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / (length / 5)) * Math.min(1, i / 48) * amplitude;
      mix[(start + i) * 2] += value * (1 - Math.max(0, pan) * 0.5);
      mix[(start + i) * 2 + 1] += value * (1 + Math.min(0, pan) * 0.5);
    }
  }
  for (let tick = 0; tick <= bar * 12; tick += beat) tone(tickToSeconds(project.chart, tick), tick % bar === 0 ? 1320 : 880, tick < bar ? 0.26 : 0.13, 0.035);
  for (const n of project.chart.notes) {
    if (n.type === 'DAMAGE') { tone(tickToSeconds(project.chart, n.tick), 165, 0.18, 0.12); continue; }
    const pan = (n.lane + n.width / 2 - 8) / 8;
    tone(tickToSeconds(project.chart, n.tick), 440 * 2 ** ((n.lane % 12) / 12), 0.20, 0.10, pan);
    if (n.duration) tone(tickToSeconds(project.chart, n.tick + n.duration), 1100, 0.12, 0.06, pan);
    if (n.type === 'AIR_CRUSH' && Number(n.attributes.interval) > 0) for (let tick = n.tick + Number(n.attributes.interval); tick < n.tick + n.duration!; tick += Number(n.attributes.interval)) tone(tickToSeconds(project.chart, tick), 1760, 0.17, 0.05);
  }
  let peak = 1; for (const sample of mix) peak = Math.max(peak, Math.abs(sample) / 0.88);
  const wav = Buffer.alloc(44 + frameCount * 4); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frameCount * 4, 40);
  for (let i = 0; i < mix.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[i] / peak)) * 32767), 44 + i * 2);
  return wav;
}
async function originalCover(filename: string): Promise<void> {
  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#091321"/><stop offset="1" stop-color="#12334d"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="205" r="152" fill="none" stroke="#2e687c" stroke-width="2"/><path d="M256 62 407 213 256 364 105 213Z" fill="#23c5b2"/><path d="M256 119 350 213 256 307 162 213Z" fill="#102037"/><path d="M256 157 303 236 209 236Z" fill="#f9c65b"/><path d="M241 242h30v39h-30Z" fill="#f9c65b"/>${Array.from({ length: 16 }, (_, i) => `<rect x="${40 + i * 27}" y="${405 - i % 4 * 10}" width="21" height="${50 + i % 4 * 10}" fill="${['#23c5b2', '#38a9d7', '#f9c65b', '#ee7ca1'][i % 4]}"/>`).join('')}<path d="M40 475h426" stroke="#fff" stroke-width="2" opacity=".25"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filename);
}
async function filesBelow(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory() ? filesBelow(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}
await mkdir(examples, { recursive: true });
for (const name of ['calibration.chuni.json', 'sevenths.chuni.json', 'exported/AZ01']) {
  let found = false; try { await access(path.join(examples, name)); found = true; } catch { /* Fresh output only. */ }
  if (found) throw new Error(`Refusing to overwrite examples/${name}; choose a fresh workspace/output.`);
}
const temporary = await mkdtemp(path.join(examples, '.calibration-source-'));
try {
  const calibration = makeCalibration(), sevenths = makeSevenths();
  checkAirParents(calibration);
  assert.deepEqual(validateProject(calibration).filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(validateProject(sevenths).filter(issue => issue.severity === 'error'), []);
  assert.equal(analyzeC2SQuantization(calibration.chart).required, false);
  assert.equal(analyzeC2SQuantization(sevenths.chart).required, true);
  const fast = calibration.chart.notes.find(n => n.tick === 2784 && n.lane === 10)!;
  const slow = calibration.chart.notes.find(n => n.tick === 2880 && n.lane === 2)!;
  assert.equal(getNoteScrollGroup(calibration.chart, fast), 1);
  assert.equal(getNoteScrollGroup(calibration.chart, slow), 0);
  assert.ok(Math.abs(getScrollPosition(calibration.chart, fast.tick, 2688, fast) - getScrollPosition(calibration.chart, slow.tick, 2688, slow)) < 1e-9);
  const cover = path.join(temporary, 'cover.png'); await originalCover(cover);
  for (const [project, stem] of [[calibration, 'calibration'], [sevenths, 'sevenths']] as const) {
    project.audio.path = path.join(temporary, `${stem}.wav`); project.coverPath = cover;
    await writeFile(project.audio.path, synthesize(project));
    const saved = await saveProject(path.join(examples, `${stem}.chuni.json`), project);
    Object.assign(project, saved);
    const loaded = await readProject(path.join(examples, `${stem}.chuni.json`));
    assert.deepEqual(loaded.chart, project.chart);
    assert.equal((await readFile(loaded.audio.path)).length, 44 + Math.ceil(duration * sampleRate) * 4);
  }
  const c2s = serializeC2S(calibration.chart, { designer: calibration.metadata.designer, difficulty: 5 });
  assert.equal(parseC2S(c2s).notes.length, calibration.chart.notes.length);
  const result = await exportOpt(calibration, { gamePath, outputDirectory: path.join(examples, 'exported'), c2s }, message => console.log(message));
  const exportedChart = parseC2S(await readFile(path.join(result.optPath, 'music/music7000/7000_05.c2s'), 'utf8'));
  assert.deepEqual(validateProject({ ...calibration, chart: exportedChart }).filter(issue => issue.severity === 'error'), []);
  checkAirParents({ ...calibration, chart: exportedChart });
  const dds = decodeDDS(await readFile(path.join(result.optPath, 'music/music7000/CHU_UI_Jacket_7000.dds'))); assert.equal(dds.width, 300); assert.equal(dds.height, 300);
  const sections = [
    [0, '0.000–2.000 秒：四次预备节拍，无音符。'],
    [384, '2.000–4.000 秒：120 BPM，TAP / EX-TAP / FLICK / 上举 AIR。'],
    [768, '4.000–6.000 秒：HOLD 与两段接续 SLIDE；5.500 秒 HOLD 终点 AIR。'],
    [1152, '6.000–8.000 秒：地面 TAP 引出的 AIR-HOLD 与 AIR-SLIDE 接续；7.500 秒结束。'],
    [1536, '8.000 秒：BPM 切换为 150；8.600 秒出现 DAMAGE（低音提示，不模拟血条）。'],
    [1920, '9.600–10.000 秒：SFL=0，全谱视觉停止；音乐节拍继续。10.000 秒恢复。'],
    [2304, '11.200–11.600 秒：SFL=-1，视觉逆向；11.600 秒恢复正向。'],
    [2688, '12.800 秒：右侧组1速度2×与左侧默认组音符深度相遇；右侧13.200秒先到，左侧13.600秒后到。下一对14.000/14.400秒到。'],
    [3072, '14.400 秒：BPM 切换为 90；15.733–17.067 秒 AIR-CRUSH，间隔48tick。'],
    [3456, '17.067–19.733 秒：低速 HOLD / 接续 SLIDE；19.067 秒 SLIDE 终点 AIR。'],
    [3840, '19.733–22.400 秒：TAP / DAMAGE / 下压 AIR。'],
    [4224, '22.400–25.067 秒：末段节拍；24.400 秒宽 EX-TAP + AIR；26.200 秒音频结束。'],
  ] as const;
  for (const [tick] of sections) assert.ok(tickToSeconds(calibration.chart, tick) < duration);
  await writeFile(path.join(examples, '校准说明.txt'), '\ufeff' + [
    'CHUNI STUDIO 原创校准与七等分演示', '',
    'calibration.chuni.json：26.2秒原创合成音频及原创几何封面，WE「改」3星，120→150→90 BPM；所有原生坐标均为整数tick。',
    'sevenths.chuni.json：全音符七等分、四分音符七等分、分数位置的BPM变化与跨变速长条。工程保留分数tick，未导出/量化这个工程。',
    '两个工程都通过相对路径引用旁边同名.assets文件夹；移动时请连同.assets一起移动。素材由脚本独立生成，没有提取原游戏的音乐、封面或谱面。', '',
    '校准时间表（以音频0秒起，播放器速度1×、音频偏移0）', ...sections.map(([, text]) => text), '',
    '声音规则：每四分拍有短节拍；音符起点和长条终点有合成提示音；DAMAGE使用低音。连续AIR/地面同刻可能叠音。音频依据tickToSeconds生成，采样率48kHz，双声道PCM16。', '',
    '原游戏验收',
    '源码目录中，独立测试包位于 examples/exported/AZ01；Music ID和cueFile ID均为7000。生成时已检查现有资源冲突。安装方法见 examples/exported/AZ01-安装说明.txt。',
    '交付版中，便携程序目录包含两个示例工程、各自.assets和本说明；同级的“校准OPT”目录另存AZ01测试包及AZ01-安装说明.txt。校准OPT不放在便携程序包内。',
    '先确认曲目出现、封面和WE「改」3星正确，再逐段确认试听、BPM同步、AIR接续、停止、逆走与分组超车。未自动复制到游戏目录，也没有启动游戏。',
    '已通过：工程回读、合法AIR父音符/长条接续检查、C2S整数精度及回读、分组超车数值检查、HCA编码/解码与ACB/AWB结构校验、DDS解码。',
    '这些检查不等于已经通过原游戏验收。校准谱采用SFL=0，不含STP。旧版STP目前仅按区间停滚近似预览，其精确视觉公式仍需原游戏比较；本校准包不能验证STP。', '',
    '七等分演示',
    '2–4秒：一个4/4小节分成7份；4–6秒：每四分拍分成7份。后续含七等分位置的BPM变化与跨变速长条。',
    '建议在编辑器切换网格基准（全音符/四分拍）并输入分母7，检查节点不会吸回整数tick。直接保存工程保留精度；若未来导出C2S，需查看并显式接受量化报告。', '',
    '复现脚本：scripts/create-calibration.ts。为避免覆盖手工编辑，脚本发现同名工程或已导出AZ01时会停止。', '',
  ].join('\r\n'), 'utf8');
  const files = await filesBelow(examples);
  const inventory = await Promise.all(files.filter(file => !file.startsWith(temporary + path.sep)).map(async filename => {
    const bytes = await readFile(filename); return { path: path.relative(examples, filename), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const report = { originalMedia: true, gameDirectoryModified: false, gameValidated: false, structuralVerified: result.structuralVerified, audioDurationSeconds: duration, calibration: { notes: calibration.chart.notes.length, events: calibration.chart.events.length, rawIntegerTicks: true }, sevenths: { notes: sevenths.chart.notes.length, quantization: analyzeC2SQuantization(sevenths.chart), nativeExported: false }, files: inventory, warnings: result.warnings };
  await writeFile(path.join(examples, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ files: inventory.length + 1, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0), calibrationNotes: calibration.chart.notes.length, calibrationEvents: calibration.chart.events.length, seventhsNotes: sevenths.chart.notes.length, optPath: result.optPath, structuralVerified: true, gameValidated: false }));
} finally { await rm(temporary, { recursive: true, force: true }); }
