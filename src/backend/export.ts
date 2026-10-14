import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';
import { DIFFICULTIES, type Project } from '../core/model';
import { serializeC2S, parseC2S } from '../core/c2s';
import { validateChart } from '../core/validation';
import {
  applyMusicXmlSettings,
  getXmlMetadata,
  mergeXmlNodes,
  validateXmlMetadata,
  type XmlNode,
} from '../core/xml-metadata';
import { encodeHca, prepareAudio } from './audio';
import { buildCueBank, verifyCueBank, parseUtf } from './cri';

export interface ExportOptions {
  gamePath: string;
  outputDirectory: string;
  cover?: { width: number; height: number; rgba: Uint8Array };
  c2s?: string;
}
export interface ExportResult {
  optPath: string;
  files: string[];
  warnings: string[];
  structuralVerified: true;
}
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const builder = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true });
const xml = (data: unknown) =>
  '\ufeff<?xml version="1.0" encoding="utf-8"?>\r\n' + builder.build(data).replace(/\r?\n/g, '\r\n');
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const stock = (id: number, str: string, data = '') => ({ id: String(id), str, data });
const fields = (source: unknown, changes: XmlNode): XmlNode =>
  mergeXmlNodes(source && typeof source === 'object' && !Array.isArray(source) ? (source as XmlNode) : {}, changes);
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function directories(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}
function localPath(p: string): string {
  return process.platform !== 'win32' && /^[a-z]:[/\\]/i.test(p)
    ? `/mnt/${p[0].toLowerCase()}/${p.slice(3).replaceAll('\\', '/')}`
    : p;
}
function contains(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
}
export async function gamePackageDirectories(gamePath: string): Promise<string[]> {
  const root = path.resolve(localPath(gamePath)),
    packages: string[] = [];
  for (const container of [path.join(root, 'data'), path.join(root, 'bin', 'option'), path.join(root, 'option')]) {
    for (const name of await directories(container))
      if (/^A[A-Z0-9]{3}$/i.test(name)) packages.push(path.join(container, name));
  }
  if (!packages.some(p => path.basename(p) === 'A000')) throw new Error('游戏目录里没有 data/A000，无法读取兼容模板。');
  return packages;
}

/** Matches the installed jacket format: 300×300, one mip, DXT1/BC1. */
export function encodeDdsBc1(rgba: Uint8Array, width: number, height: number): Buffer {
  if (width % 4 || height % 4 || width < 4 || height < 4 || rgba.length !== width * height * 4)
    throw new Error('DDS 输入尺寸或像素数据无效。');
  const data = Buffer.alloc(128 + (width * height) / 2);
  data.write('DDS ');
  data.writeUInt32LE(124, 4);
  data.writeUInt32LE(0x00081007, 8);
  data.writeUInt32LE(height, 12);
  data.writeUInt32LE(width, 16);
  data.writeUInt32LE((width * height) / 2, 20);
  data.writeUInt32LE(1, 28);
  data.writeUInt32LE(32, 76);
  data.writeUInt32LE(4, 80);
  data.write('DXT1', 84);
  data.writeUInt32LE(0x1000, 108);
  const pack = (c: number[]) =>
    (Math.round((c[0] * 31) / 255) << 11) | (Math.round((c[1] * 63) / 255) << 5) | Math.round((c[2] * 31) / 255);
  const unpack = (c: number) => [(((c >> 11) & 31) * 255) / 31, (((c >> 5) & 63) * 255) / 63, ((c & 31) * 255) / 31];
  let offset = 128;
  for (let y = 0; y < height; y += 4)
    for (let x = 0; x < width; x += 4) {
      const colors: number[][] = [];
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 4; dx++) {
          const i = ((y + dy) * width + x + dx) * 4,
            a = rgba[i + 3] / 255;
          colors.push([rgba[i] * a, rgba[i + 1] * a, rgba[i + 2] * a]);
        }
      let first = colors[0],
        second = colors[0],
        distance = -1;
      for (let i = 0; i < 16; i++)
        for (let j = i + 1; j < 16; j++) {
          const d = colors[i].reduce((sum, n, k) => sum + (n - colors[j][k]) ** 2, 0);
          if (d > distance) {
            distance = d;
            first = colors[i];
            second = colors[j];
          }
        }
      let c0 = Math.max(pack(first), pack(second)),
        c1 = Math.min(pack(first), pack(second));
      if (c0 === c1) {
        if (c0 < 65535) c0++;
        else c1--;
      }
      const a = unpack(c0),
        b = unpack(c1),
        palette = [a, b, a.map((n, i) => (2 * n + b[i]) / 3), a.map((n, i) => (n + 2 * b[i]) / 3)];
      let indices = 0;
      colors.forEach((color, i) => {
        let nearest = 0,
          best = Infinity;
        palette.forEach((p, j) => {
          const d = color.reduce((sum, n, k) => sum + (n - p[k]) ** 2, 0);
          if (d < best) {
            nearest = j;
            best = d;
          }
        });
        indices |= nearest << (2 * i);
      });
      data.writeUInt16LE(c0, offset);
      data.writeUInt16LE(c1, offset + 2);
      data.writeUInt32LE(indices >>> 0, offset + 4);
      offset += 8;
    }
  return data;
}

async function findTemplates(packages: string[]): Promise<{ musicXml: string; acbPath: string }> {
  let musicXml = '',
    acbPath = '';
  // Prefer known standard layouts, then inspect a bounded set of ordinary music/cue resources.
  for (const pkg of [...packages].reverse()) {
    if (!musicXml) {
      const dirs = await directories(path.join(pkg, 'music'));
      for (const name of ['music2927', ...dirs.filter(n => /^music[0-7]\d{3}$/.test(n)).slice(0, 24)]) {
        const candidate = path.join(pkg, 'music', name, 'Music.xml');
        if (await exists(candidate)) {
          musicXml = candidate;
          break;
        }
      }
    }
    if (!acbPath) {
      const dirs = await directories(path.join(pkg, 'cueFile'));
      for (const name of ['cueFile002892', ...dirs.filter(n => /^cueFile00\d{4}$/.test(n)).slice(0, 32)]) {
        const dir = path.join(pkg, 'cueFile', name),
          meta = path.join(dir, 'CueFile.xml');
        if (!(await exists(meta))) continue;
        try {
          const cue = parser.parse(await readFile(meta, 'utf8')).CueFileData;
          const filename = cue?.acbFile?.path;
          if (typeof filename !== 'string' || path.basename(filename) !== filename) continue;
          const candidate = path.join(dir, filename),
            bank = parseUtf(await readFile(candidate));
          const wave = bank.rows[0]?.WaveformTable;
          if (
            Buffer.isBuffer(wave) &&
            parseUtf(wave).rows.length === 1 &&
            Buffer.isBuffer(bank.rows[0].TrackEventTable)
          ) {
            acbPath = candidate;
            break;
          }
        } catch {
          /* Try the next compatible local template. */
        }
      }
    }
    if (musicXml && acbPath) break;
  }
  if (!musicXml || !acbPath) throw new Error('未找到兼容的 Music.xml 与单流 HCA ACB 模板。');
  return { musicXml, acbPath };
}

async function unlockEventTemplate(packages: string[], musicType: 1 | 2): Promise<Record<string, any>> {
  for (const pkg of [...packages].reverse()) {
    const dirs = await directories(path.join(pkg, 'event'));
    const preferred = musicType === 1 ? ['event00900001'] : ['event00900002', 'event01000024'];
    for (const dir of [...new Set([...preferred, ...dirs.slice(0, 160)])]) {
      const p = path.join(pkg, 'event', dir, 'Event.xml');
      if (!(await exists(p))) continue;
      const event = parser.parse(await readFile(p, 'utf8')).EventData;
      if (Number(event?.substances?.type) === 3 && Number(event?.substances?.music?.musicType) === musicType)
        return event;
    }
  }
  throw new Error(`缺少 ${musicType === 1 ? 'WORLD’S END' : 'ULTIMA'} 开放事件模板，无法完成该难度的登记。`);
}

function displayPath(filename: string): string {
  const wsl = filename.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replaceAll('/', '\\')}` : filename;
}

async function installationInstructions(
  project: Project,
  gameRoot: string,
  packages: string[],
  warnings: string[],
): Promise<string> {
  const { optId, musicId, cueId } = project.exportSettings;
  const container = [path.join(gameRoot, 'bin', 'option'), path.join(gameRoot, 'option')].find(dir =>
    packages.some(pkg => path.dirname(pkg) === dir),
  );
  const withoutConf: string[] = [];
  for (const pkg of packages)
    if (path.basename(pkg) !== 'A000' && !(await exists(path.join(pkg, 'data.conf'))))
      withoutConf.push(path.basename(pkg));
  const steps = container
    ? [
        `1. 关闭游戏。确认当前启动方式读取追加包目录：${displayPath(container)}`,
        `2. 检查目标 ${displayPath(path.join(container, optId))} 不存在。不要覆盖或合并任何已有同名包；如已存在，请回到制谱器更换 OPT ID 并重新导出。`,
        `3. 把本说明旁的整个 ${optId} 文件夹复制到 ${displayPath(container)}，保持文件夹层级。最终 Music.xml 应位于 ${displayPath(path.join(container, optId, 'music', `music${String(musicId).padStart(4, '0')}`, 'Music.xml'))}。`,
      ]
    : [
        '1. 关闭游戏。本次未检测到含现有追加包的 option 目录，无法确定安装目标。',
        `2. 先确认当前启动方式实际读取的追加包目录，再把整个 ${optId} 文件夹复制进去。不要覆盖或合并任何已有同名包。`,
      ];
  return (
    '\ufeff' +
    [
      `CHUNI STUDIO — ${optId} 安装说明`,
      '',
      `曲名：${project.metadata.title}`,
      `难度：${project.metadata.difficulty}`,
      `Music ID：${musicId}；cueFile ID：${cueId}`,
      `本次模板来源：${displayPath(gameRoot)}`,
      '',
      '校验状态：已完成文件结构、资源引用、音频编码及回读检查；结构校验通过不等于已经通过原游戏验证。制谱器没有启动游戏，也没有修改游戏目录。',
      '',
      '手动安装',
      ...steps,
      '',
      '原游戏验收',
      '1. 启动游戏，确认新曲能在选曲中出现，曲名、封面、难度和 WORLD’S END 属性/星级正确。',
      '2. 确认选曲试听区间与音乐正常，进入谱面后从开头、中段、结尾检查音乐与音符同步。',
      '3. 检查 BPM/拍号变化、长条与 AIR 接续、停止/倒流/分组滚速及本谱使用的特殊演出。播放器预览不代表所有原游戏特殊玩法已验证。',
      '4. 如未显示曲目，检查追加包加载位置和 MusicSort.xml 的加载顺序；保留原包，不要通过覆盖它们排查。',
      '',
      '移除本次新包',
      `关闭游戏后，只移除本次复制进去的 ${optId} 文件夹，即可撤回此次安装。不要删除其他包或 data/A000，也不要把新包内容拆开合并到它们中。`,
      '',
      '版本登记说明',
      `本次未生成 data.conf。${withoutConf.length ? `本地现有追加目录 ${withoutConf.join('、')} 也没有此文件；` : ''}这些文件事实不能证明新包已经能被当前启动方式加载，仍需上述原游戏验收。`,
      '',
      ...warnings,
      '',
    ].join('\r\n')
  );
}

export async function exportOpt(
  project: Project,
  options: ExportOptions,
  onProgress: (message: string) => void = () => {},
): Promise<ExportResult> {
  const chartErrors = validateChart(project.chart).filter(issue => issue.severity === 'error');
  if (chartErrors.length)
    throw new Error(
      `谱面包含 ${chartErrors.length} 项错误，无法导出 OPT：\n${chartErrors
        .slice(0, 4)
        .map(issue => issue.message)
        .join('\n')}${chartErrors.length > 4 ? '\n其余错误请在“检查谱面”中查看。' : ''}`,
    );
  const xmlMetadata = getXmlMetadata(project);
  validateXmlMetadata(xmlMetadata);
  const { optId, musicId, cueId, weTag, stars } = project.exportSettings;
  if (!/^A[A-Z0-9]{3}$/.test(optId) || optId === 'A000')
    throw new Error('OPT ID 必须是 A 开头的四位大写字母/数字，且不能使用 A000。');
  if (![musicId, cueId].every(id => Number.isInteger(id) && id > 0 && id <= 9999))
    throw new Error('Music ID 与 cueFile ID 必须是 1–9999 的整数。');
  if (!project.metadata.title.trim()) throw new Error('请填写曲名。');
  if (!project.audio.path || (!project.coverPath && !options.cover)) throw new Error('完整 OPT 导出需要音乐和封面。');
  const difficulty = DIFFICULTIES.indexOf(project.metadata.difficulty),
    worldsEnd = difficulty === 5;
  if (difficulty < 0) throw new Error('未知难度。');
  if (worldsEnd && (!weTag || !Number.isInteger(stars) || stars < 1 || stars > 5))
    throw new Error('WORLD’S END 需要有效属性与 1–5 星。');
  const packages = await gamePackageDirectories(options.gamePath);
  const gameRoot = await realpath(path.resolve(localPath(options.gamePath))),
    outputRoot = path.resolve(localPath(options.outputDirectory));
  // Resolve the nearest existing ancestor as well, preventing output through a symlink into the game.
  let ancestor = outputRoot;
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realOutput = path.resolve(await realpath(ancestor), path.relative(ancestor, outputRoot));
  if (contains(gameRoot, realOutput)) throw new Error('请导出到独立目录；制谱器不会直接修改游戏目录。');
  const target = path.join(outputRoot, optId);
  if (await exists(target)) throw new Error(`输出目录已经存在 ${optId}，请更换目录或 OPT ID。`);
  const instructionsPath = path.join(outputRoot, `${optId}-安装说明.txt`);
  if (await exists(instructionsPath)) throw new Error(`输出目录已经存在 ${optId}-安装说明.txt，请更换目录或 OPT ID。`);
  const mid = String(musicId).padStart(4, '0'),
    cid = String(cueId).padStart(4, '0');
  const sortIds = new Set<number>(),
    warnings: string[] = [];
  let sortTemplate: Record<string, any> | undefined;
  onProgress('检查曲目 ID、OPT 冲突和本地资源模板…');
  for (const pkg of packages) {
    if (path.basename(pkg) === optId) throw new Error(`游戏已经有 ${optId}，请选择另一个 OPT ID。`);
    if (await exists(path.join(pkg, 'music', `music${mid}`))) throw new Error(`Music ID ${musicId} 已被现有曲目使用。`);
    if (await exists(path.join(pkg, 'cueFile', `cueFile${String(cueId).padStart(6, '0')}`)))
      throw new Error(`cueFile ID ${cueId} 已被现有音乐使用。`);
    const sortPath = path.join(pkg, 'music', 'MusicSort.xml');
    if (await exists(sortPath)) {
      const doc = parser.parse(await readFile(sortPath, 'utf8'));
      if (doc.SerializeSortData) {
        sortTemplate = doc;
        for (const item of list<Record<string, string>>(doc.SerializeSortData.SortList?.StringID)) {
          const id = Number(item.id);
          if (Number.isInteger(id)) sortIds.add(id);
        }
      }
      if (path.basename(pkg) !== 'A000' && path.basename(pkg).localeCompare(optId) > 0)
        warnings.push(`已有 ${path.basename(pkg)} 含曲目排序表；安装后请确认加载顺序，避免它覆盖 ${optId} 的新 ID。`);
    }
  }
  if (sortIds.has(musicId)) throw new Error(`Music ID ${musicId} 已被现有 MusicSort.xml 预留，请使用未登记的 ID。`);
  if (!sortTemplate) throw new Error('没有找到 MusicSort.xml，无法保留曲目登记表。');
  const templates = await findTemplates(packages);
  const musicTemplate = parser.parse(await readFile(templates.musicXml, 'utf8')).MusicData;
  if (!musicTemplate) throw new Error('Music.xml 模板无效。');
  const music = applyMusicXmlSettings(
    musicTemplate,
    xmlMetadata,
    project.metadata.title.toUpperCase().replace(/[\s\p{P}]/gu, ''),
    { id: worldsEnd ? 0 : 1, str: worldsEnd ? "WORLD'S END" : 'CHUNITHM', data: '' },
  ) as Record<string, any>;
  const cueTemplate = parser.parse(
    await readFile(path.join(path.dirname(templates.acbPath), 'CueFile.xml'), 'utf8'),
  ).CueFileData;
  if (!cueTemplate) throw new Error('CueFile.xml 模板无效。');
  let weTagId = -1;
  if (worldsEnd) {
    for (const pkg of [...packages].reverse()) {
      const dirs = (await directories(path.join(pkg, 'music'))).filter(name => /^music8\d{3}$/.test(name));
      for (const dir of dirs) {
        const p = path.join(pkg, 'music', dir, 'Music.xml');
        if (!(await exists(p))) continue;
        const metadata = parser.parse(await readFile(p, 'utf8')).MusicData;
        if (metadata?.worldsEndTagName?.str === weTag) {
          weTagId = Number(metadata.worldsEndTagName.id);
          break;
        }
      }
      if (weTagId >= 0) break;
    }
    if (weTagId < 0) throw new Error(`游戏资源中未找到 WORLD’S END 属性「${weTag}」的登记，无法猜测其 ID。`);
  }
  let unlock: Record<string, any> | undefined,
    eventDirectory = '';
  if (difficulty === 4 || worldsEnd) {
    unlock = await unlockEventTemplate(packages, worldsEnd ? 1 : 2);
    const eventId = 9_100_000 + musicId;
    eventDirectory = `event${String(eventId).padStart(8, '0')}`;
    for (const pkg of packages)
      if (await exists(path.join(pkg, 'event', eventDirectory)))
        throw new Error(`开放事件 ID ${eventId} 已存在，请换一个 Music ID。`);
    Object.assign(unlock, {
      dataName: eventDirectory,
      name: stock(eventId, `Custom ${worldsEnd ? 'WORLD’S END' : 'ULTIMA'} ${musicId}`),
      netOpenName: structuredClone(music.netOpenName),
      alwaysOpen: 'true',
      teamOnly: 'false',
      priority: '0',
    });
    unlock.substances.music.musicNames = { list: { StringID: stock(musicId, project.metadata.title) } };
  }
  await mkdir(outputRoot, { recursive: true });
  const staging = await mkdtemp(path.join(outputRoot, '.chuni-export-'));
  const work = path.join(staging, '.work'),
    opt = path.join(staging, optId),
    musicDir = path.join(opt, 'music', `music${mid}`),
    cueDir = path.join(opt, 'cueFile', `cueFile${String(cueId).padStart(6, '0')}`);
  let instructionsWritten = false;
  try {
    await Promise.all([mkdir(work), mkdir(musicDir, { recursive: true }), mkdir(cueDir, { recursive: true })]);
    onProgress('转换音乐，并编码和解码校验 HCA…');
    const wav = await prepareAudio(
      localPath(project.audio.path),
      path.join(work, 'normalized.wav'),
      project.audio.offset,
    );
    const hcaPath = path.join(work, 'music.hca'),
      audio = await encodeHca(wav, hcaPath);
    // The UI preview range is on the source audio timeline, so shift it with inserted/trimmed audio.
    const previewStart = Math.max(0, project.audio.previewStart + project.audio.offset),
      previewEnd = project.audio.previewEnd + project.audio.offset;
    if (
      !Number.isFinite(previewStart) ||
      !Number.isFinite(previewEnd) ||
      previewEnd <= previewStart ||
      previewEnd > audio.duration + 0.001
    )
      throw new Error(`预览区间须落在 ${audio.duration.toFixed(2)} 秒音频内，且结束晚于开始。`);
    onProgress('生成 ACB/AWB、封面和曲目登记文件…');
    const bank = buildCueBank(
      await readFile(templates.acbPath),
      await readFile(hcaPath),
      `music${cid}`,
      audio,
      previewStart,
      previewEnd,
    );
    await Promise.all([
      writeFile(path.join(cueDir, `music${cid}.acb`), bank.acb),
      writeFile(path.join(cueDir, `music${cid}.awb`), bank.awb),
    ]);
    const image = options.cover
      ? sharp(Buffer.from(options.cover.rgba), {
          raw: { width: options.cover.width, height: options.cover.height, channels: 4 },
        })
      : sharp(localPath(project.coverPath));
    const cover = await image.resize(300, 300, { fit: 'cover' }).ensureAlpha().raw().toBuffer();
    const jacket = `CHU_UI_Jacket_${mid}.dds`,
      c2sName = `${mid}_${String(difficulty).padStart(2, '0')}.c2s`;
    const c2s = options.c2s ?? serializeC2S(project.chart, { designer: project.metadata.designer, difficulty });
    const rereadChart = parseC2S(c2s);
    if (rereadChart.notes.length !== project.chart.notes.length)
      throw new Error('C2S 回验发现音符数不一致，已停止导出。');
    const sourceArtist = xmlMetadata.sourceMusic?.artistName;
    const sourceArtistId =
      sourceArtist && typeof sourceArtist === 'object' && !Array.isArray(sourceArtist) ? Number(sourceArtist.id) : NaN;
    Object.assign(music, {
      dataName: `music${mid}`,
      name: fields(music.name, stock(musicId, project.metadata.title)),
      artistName: fields(
        music.artistName,
        stock(Number.isInteger(sourceArtistId) ? sourceArtistId : musicId, project.metadata.artist),
      ),
      enableUltima: String(difficulty === 4),
      exType: String(worldsEnd ? 2 : 0),
      cueFileName: fields(music.cueFileName, stock(cueId, `music${cid}`)),
      jaketFile: fields(music.jaketFile, { path: jacket }),
      worldsEndTagName: fields(music.worldsEndTagName, stock(worldsEnd ? weTagId : -1, worldsEnd ? weTag : 'Invalid')),
      starDifType: String(worldsEnd ? stars * 2 - 1 : 0),
    });
    if ('jacketFile' in music) music.jacketFile = fields(music.jacketFile, { path: jacket });
    if ('rightsInfoName' in music && !xmlMetadata.sourceMusic) music.rightsInfoName = stock(-1, 'Invalid');
    if ('previewStartTime' in music) music.previewStartTime = String(Math.round(previewStart * 1000));
    if ('previewEndTime' in music) music.previewEndTime = String(Math.round(previewEnd * 1000));
    const levels = project.metadata.level.trim().match(/^(\d{1,2})(?:\.(\d{1,2})|(\+))?$/);
    if (!worldsEnd && !levels) throw new Error('难度应为数字，如 13、13.5 或 13+。');
    const names = ['Basic', 'Advanced', 'Expert', 'Master', 'Ultima', 'WorldsEnd'];
    const previousFumens = list<Record<string, any>>(music.fumens?.MusicFumenData);
    music.fumens = fields(music.fumens, {
      MusicFumenData: names.map((name, i) => {
        const baseFumen = previousFumens.find(fumen => Number(fumen.type?.id) === i) ?? previousFumens[0] ?? {};
        return fields(baseFumen, {
          type: fields(baseFumen.type, stock(i, name, i === 5 ? "WORLD'S END" : name.toUpperCase())),
          enable: String(i === difficulty),
          file: fields(baseFumen.file, { path: i === difficulty ? c2sName : '' }),
          level: i === difficulty && !worldsEnd ? levels![1] : '0',
          levelDecimal:
            i === difficulty && !worldsEnd ? (levels![3] ? '50' : (levels![2] ?? '').padEnd(2, '0') || '0') : '0',
          notesDesigner: i === difficulty ? project.metadata.designer : '',
          defaultBpm: i === difficulty ? String(project.chart.defaultBpm) : '0',
        });
      }),
    });
    sortIds.add(musicId);
    sortTemplate.SerializeSortData.SortList = { StringID: [...sortIds].map(id => stock(id, '')) };
    const cue = mergeXmlNodes(cueTemplate, xmlMetadata.sourceCue ?? {});
    Object.assign(cue, {
      dataName: `cueFile${String(cueId).padStart(6, '0')}`,
      name: fields(cue.name, stock(cueId, `music${cid}`)),
      acbFile: fields(cue.acbFile, { path: `music${cid}.acb` }),
      awbFile: fields(cue.awbFile, { path: `music${cid}.awb` }),
    });
    const cueXml = { CueFileData: cue };
    await Promise.all([
      writeFile(path.join(musicDir, jacket), encodeDdsBc1(cover, 300, 300)),
      writeFile(path.join(musicDir, c2sName), c2s),
      writeFile(path.join(musicDir, 'Music.xml'), xml({ MusicData: music })),
      writeFile(path.join(cueDir, 'CueFile.xml'), xml(cueXml)),
      writeFile(path.join(opt, 'music', 'MusicSort.xml'), xml({ SerializeSortData: sortTemplate.SerializeSortData })),
    ]);
    if (unlock) {
      const eventPath = path.join(opt, 'event', eventDirectory);
      await mkdir(eventPath, { recursive: true });
      await writeFile(path.join(eventPath, 'Event.xml'), xml({ EventData: unlock }));
      const check = parser.parse(await readFile(path.join(eventPath, 'Event.xml'), 'utf8')).EventData;
      if (Number(check?.substances?.music?.musicNames?.list?.StringID?.id) !== musicId || check.alwaysOpen !== 'true')
        throw new Error('开放事件回验：曲目引用不一致。');
    }
    onProgress('重新读取导出文件，校验引用、长度、哈希和预览区间…');
    verifyCueBank(
      await readFile(path.join(cueDir, `music${cid}.acb`)),
      await readFile(path.join(cueDir, `music${cid}.awb`)),
      `music${cid}`,
      audio,
      previewStart,
      previewEnd,
    );
    const checkMusic = parser.parse(await readFile(path.join(musicDir, 'Music.xml'), 'utf8')).MusicData;
    if (
      Number(checkMusic?.name?.id) !== musicId ||
      Number(checkMusic?.cueFileName?.id) !== cueId ||
      checkMusic?.jaketFile?.path !== jacket
    )
      throw new Error('XML 回验：资源引用不一致。');
    const checkCue = parser.parse(await readFile(path.join(cueDir, 'CueFile.xml'), 'utf8')).CueFileData;
    if (
      checkCue?.dataName !== `cueFile${String(cueId).padStart(6, '0')}` ||
      Number(checkCue?.name?.id) !== cueId ||
      checkCue?.name?.str !== `music${cid}` ||
      checkCue?.acbFile?.path !== `music${cid}.acb` ||
      checkCue?.awbFile?.path !== `music${cid}.awb`
    )
      throw new Error('CueFile.xml 回验：音频文件引用不一致。');
    const checkSort = parser.parse(await readFile(path.join(opt, 'music', 'MusicSort.xml'), 'utf8')).SerializeSortData;
    if (!list<Record<string, string>>(checkSort.SortList.StringID).some(row => Number(row.id) === musicId))
      throw new Error('排序表回验：新曲 ID 缺失。');
    warnings.push('已通过文件结构与音频回读校验；尚未在原游戏中验证加载、同步和特殊玩法。');
    await writeFile(instructionsPath, await installationInstructions(project, gameRoot, packages, warnings), {
      flag: 'wx',
    });
    instructionsWritten = true;
    await rename(opt, target);
    const files = [
      'music/MusicSort.xml',
      `music/music${mid}/Music.xml`,
      `music/music${mid}/${c2sName}`,
      `music/music${mid}/${jacket}`,
      `cueFile/cueFile${String(cueId).padStart(6, '0')}/CueFile.xml`,
      `cueFile/cueFile${String(cueId).padStart(6, '0')}/music${cid}.acb`,
      `cueFile/cueFile${String(cueId).padStart(6, '0')}/music${cid}.awb`,
    ];
    if (unlock) files.push(`event/${eventDirectory}/Event.xml`);
    return { optPath: target, files, warnings, structuralVerified: true };
  } catch (error) {
    if (instructionsWritten) await rm(instructionsPath, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
