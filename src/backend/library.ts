import { readFile, readdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { LibraryEntry } from '../bridge';
import type { Difficulty } from '../core/model';
import { validateXmlNode, xmlMetadataFromSource, type XmlMetadata, type XmlNode } from '../core/xml-metadata';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const difficulties: Difficulty[] = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'ULTIMA', 'WORLD’S END'];
const array = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
async function dirs(root: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => path.join(root, e.name)).sort(); }
  catch { return []; }
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function isFile(filename: string): Promise<boolean> { try { return (await stat(filename)).isFile(); } catch { return false; } }
export async function resourceRoots(gamePath: string): Promise<string[]> {
  const roots = [...await dirs(path.join(gamePath, 'data')), ...await dirs(path.join(gamePath, 'bin', 'option')), ...await dirs(path.join(gamePath, 'option'))];
  if (await exists(path.join(gamePath, 'music'))) roots.unshift(gamePath);
  return [...new Set(roots)];
}
export async function scanLibrary(gamePath: string): Promise<LibraryEntry[]> {
  const roots = await resourceRoots(gamePath);
  if (!roots.length) throw new Error('未找到 data 或 option 资源目录，请选择 CHUNITHM 游戏根目录。');
  const songs = new Map<number, { data: any; root: string; folder: string }>();
  const cues = new Map<number, string[]>();
  const musicFoldersByRoot = new Map<string, Set<string>>();
  for (const root of roots) {
    for (const folder of await dirs(path.join(root, 'cueFile'))) {
      const id = Number(path.basename(folder).replace(/^cueFile/, ''));
      if (Number.isFinite(id)) cues.set(id, [...(cues.get(id) ?? []), folder]);
    }
    const musicFolders = await dirs(path.join(root, 'music'));
    musicFoldersByRoot.set(root, new Set(musicFolders.map(folder => path.basename(folder))));
    // Bounded batches keep library scanning responsive without opening thousands of files at once.
    for (let i = 0; i < musicFolders.length; i += 24) {
      await Promise.all(musicFolders.slice(i, i + 24).map(async folder => {
        try {
          const data = parser.parse(await readFile(path.join(folder, 'Music.xml'), 'utf8')).MusicData;
          const id = Number(data?.name?.id);
          if (data && Number.isFinite(id)) songs.set(id, { data, root, folder });
        } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      }));
    }
  }
  const reverseRoots = roots.slice().reverse();
  const cueAssets = new Map<number, { acbPath: string; awbPath: string; cueXmlPath?: string }>();
  async function musicAsset(folder: string, relativeName: string): Promise<string> {
    const filename = relativeName.replace(/[\\/]/g, path.sep);
    for (const candidate of reverseRoots) {
      if (!musicFoldersByRoot.get(candidate)?.has(path.basename(folder))) continue;
      const inherited = path.join(candidate, 'music', path.basename(folder), filename);
      if (await isFile(inherited)) return inherited;
    }
    return '';
  }
  const result: LibraryEntry[] = [];
  for (const [id, { data, root, folder }] of songs) {
    const cueId = Number(data.cueFileName?.id ?? 0);
    let audio = cueAssets.get(cueId);
    if (!audio) {
      audio = { acbPath: '', awbPath: '' };
      let acbName = '', awbName = '';
      const cueFolders = (cues.get(cueId) ?? []).slice().reverse();
      for (const cueFolder of cueFolders) {
        const cueXmlPath = path.join(cueFolder, 'CueFile.xml');
        if (!await isFile(cueXmlPath)) continue;
        const cue = parser.parse(await readFile(cueXmlPath, 'utf8')).CueFileData;
        if (cue) {
          audio.cueXmlPath = cueXmlPath;
          acbName = String(cue.acbFile?.path ?? ''); awbName = String(cue.awbFile?.path ?? '');
          break;
        }
      }
      for (const cueFolder of cueFolders) {
        try {
          const files = (await readdir(cueFolder, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort();
          const acb = files.find(filename => acbName ? filename.toLowerCase() === acbName.toLowerCase() : filename.toLowerCase().endsWith('.acb'));
          const awb = files.find(filename => awbName ? filename.toLowerCase() === awbName.toLowerCase() : filename.toLowerCase().endsWith('.awb'));
          if (!audio.acbPath && acb) audio.acbPath = path.join(cueFolder, acb);
          if (!audio.awbPath && awb) audio.awbPath = path.join(cueFolder, awb);
          if (audio.acbPath && audio.awbPath) break;
        } catch { /* Missing assets can be inherited from lower-priority packs. */ }
      }
      cueAssets.set(cueId, audio);
    }
    const { acbPath, awbPath, cueXmlPath } = audio;
    const jacket = data.jaketFile?.path || data.jacketFile?.path;
    const coverPath = jacket ? await musicAsset(folder, String(jacket)) : '';
    for (const [index, fumen] of array<any>(data.fumens?.MusicFumenData).entries()) {
      if (String(fumen.enable).toLowerCase() !== 'true' || !fumen.file?.path) continue;
      const difficultyId = Number(fumen.type?.id ?? index);
      const difficulty = difficulties[difficultyId];
      if (!difficulty) continue;
      const chartPath = await musicAsset(folder, String(fumen.file.path)) || path.join(folder, fumen.file.path);
      const level = Number(fumen.level ?? 0), decimal = Number(fumen.levelDecimal ?? 0);
      const levelText = `${level}${decimal === 50 ? '+' : decimal > 0 ? `.${String(decimal).padStart(2, '0').replace(/0$/, '')}` : ''}`;
      result.push({ key: `${id}:${difficultyId}`, musicId: id, title: String(data.name?.str ?? id), artist: String(data.artistName?.str ?? ''),
        difficulty, level: levelText, notesDesigner: String(fumen.notesDesigner ?? ''), chartPath,
        coverPath, cueId, acbPath, awbPath, musicXmlPath: path.join(folder, 'Music.xml'), cueXmlPath,
        pack: path.basename(root), weTag: String(data.worldsEndTagName?.str ?? '改'), stars: Math.max(1, Math.min(5, (Number(data.starDifType ?? 1) + 1) / 2)) });
    }
  }
  return result.sort((a, b) => a.musicId - b.musicId || difficulties.indexOf(a.difficulty) - difficulties.indexOf(b.difficulty));
}

/** XML paths point at the winning metadata overlay, independently of inherited chart/audio assets. */
export async function readLibraryXmlMetadata(entry: LibraryEntry): Promise<XmlMetadata> {
  async function source(filename: string, rootName: string): Promise<XmlNode> {
    const contents = await readFile(filename, 'utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(contents)) throw new Error('曲目 XML 不支持 DTD 或实体声明。');
    const root = parser.parse(contents)[rootName]; validateXmlNode(root, rootName); return root;
  }
  const music = await source(entry.musicXmlPath ?? path.join(path.dirname(entry.chartPath), 'Music.xml'), 'MusicData');
  const cue = entry.cueXmlPath ? await source(entry.cueXmlPath, 'CueFileData') : undefined;
  return xmlMetadataFromSource(music, cue);
}
