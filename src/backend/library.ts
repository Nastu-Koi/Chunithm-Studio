import { readFile, readdir, access, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { LibraryEntry } from '../bridge';
import { DIFFICULTIES, type Difficulty } from '../core/model';
import { validateXmlNode, xmlMetadataFromSource, type XmlMetadata, type XmlNode } from '../core/xml-metadata';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const array = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** Concurrent file-system work per batch; bounded so a large library never opens thousands of files at once. */
const BATCH = 32;
/** Bump when LibraryEntry changes shape, so older caches are ignored. */
const CACHE_FORMAT = 1;
export interface ScanOptions {
  /** Called with a human-readable status line as phases complete. */
  onProgress?: (message: string) => void;
  /** JSON file holding the previous scan; reused when the library's folders are unchanged. */
  cacheFile?: string;
  /** Ignore the cache and rescan. */
  force?: boolean;
}
interface LibraryCache {
  format: number;
  gamePath: string;
  signature: string;
  entries: LibraryEntry[];
}
async function dirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => path.join(root, e.name))
      .sort();
  } catch {
    return [];
  }
}
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
async function isFile(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}
async function mtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}
async function batched<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  onBatch?: (done: number) => void,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += BATCH) {
    results.push(...(await Promise.all(items.slice(index, index + BATCH).map(work))));
    onBatch?.(Math.min(items.length, index + BATCH));
  }
  return results;
}
export async function resourceRoots(gamePath: string): Promise<string[]> {
  const roots = [
    ...(await dirs(path.join(gamePath, 'data'))),
    ...(await dirs(path.join(gamePath, 'bin', 'option'))),
    ...(await dirs(path.join(gamePath, 'option'))),
  ];
  if (await exists(path.join(gamePath, 'music'))) roots.unshift(gamePath);
  return [...new Set(roots)];
}
/**
 * Fingerprint of what a scan reads: every resource root's music and cueFile folders with their mtimes.
 * Adding, removing or renaming a song or cue folder changes it; editing a file inside an existing folder does not,
 * which is why the library dialog also offers a forced rescan.
 */
export async function librarySignature(roots: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const root of roots)
    for (const kind of ['music', 'cueFile']) {
      const container = path.join(root, kind),
        folders = await dirs(container);
      const times = await batched(folders, mtime);
      hash.update(
        `${root}\0${kind}\0${await mtime(container)}\0${folders.map((folder, index) => `${path.basename(folder)}=${times[index]}`).join(',')}\n`,
      );
    }
  return hash.digest('hex');
}
async function readCache(file: string, gamePath: string, signature: string): Promise<LibraryEntry[] | null> {
  try {
    const cached = JSON.parse(await readFile(file, 'utf8')) as LibraryCache;
    return cached.format === CACHE_FORMAT &&
      cached.gamePath === gamePath &&
      cached.signature === signature &&
      Array.isArray(cached.entries)
      ? cached.entries
      : null;
  } catch {
    return null;
  }
}
export async function scanLibrary(gamePath: string, options: ScanOptions = {}): Promise<LibraryEntry[]> {
  const progress = options.onProgress ?? (() => {});
  const roots = await resourceRoots(gamePath);
  if (!roots.length) throw new Error('未找到 data 或 option 资源目录，请选择 CHUNITHM 游戏根目录。');
  const signature = options.cacheFile ? await librarySignature(roots) : '';
  if (options.cacheFile && !options.force) {
    const cached = await readCache(options.cacheFile, gamePath, signature);
    if (cached) {
      progress(`曲库目录未变化，使用上次扫描的 ${cached.length} 张谱面`);
      return cached;
    }
  }
  // Phase 1: collect cue folders and parse every Music.xml, later packs overriding earlier ones.
  const songs = new Map<number, { data: any; root: string; folder: string }>();
  const cues = new Map<number, string[]>();
  const musicFoldersByRoot = new Map<string, Set<string>>();
  const musicFolders: { root: string; folder: string }[] = [];
  for (const root of roots) {
    for (const folder of await dirs(path.join(root, 'cueFile'))) {
      const id = Number(path.basename(folder).replace(/^cueFile/, ''));
      if (Number.isFinite(id)) cues.set(id, [...(cues.get(id) ?? []), folder]);
    }
    const folders = await dirs(path.join(root, 'music'));
    musicFoldersByRoot.set(root, new Set(folders.map(folder => path.basename(folder))));
    musicFolders.push(...folders.map(folder => ({ root, folder })));
  }
  const parsed = await batched(
    musicFolders,
    async ({ root, folder }) => {
      try {
        const data = parser.parse(await readFile(path.join(folder, 'Music.xml'), 'utf8')).MusicData;
        const id = Number(data?.name?.id);
        return data && Number.isFinite(id) ? { id, data, root, folder } : null;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        return null;
      }
    },
    done => progress(`正在读取曲目信息 ${done}/${musicFolders.length}…`),
  );
  // Roots are ordered from base to highest-priority pack; a later Music.xml replaces an earlier one.
  for (const song of parsed) if (song) songs.set(song.id, { data: song.data, root: song.root, folder: song.folder });
  // Phase 2: resolve audio once per cue id.
  const reverseRoots = roots.slice().reverse();
  async function resolveCue(cueId: number): Promise<{ acbPath: string; awbPath: string; cueXmlPath?: string }> {
    const audio: { acbPath: string; awbPath: string; cueXmlPath?: string } = { acbPath: '', awbPath: '' };
    let acbName = '',
      awbName = '';
    const cueFolders = (cues.get(cueId) ?? []).slice().reverse();
    for (const cueFolder of cueFolders) {
      const cueXmlPath = path.join(cueFolder, 'CueFile.xml');
      if (!(await isFile(cueXmlPath))) continue;
      const cue = parser.parse(await readFile(cueXmlPath, 'utf8')).CueFileData;
      if (cue) {
        audio.cueXmlPath = cueXmlPath;
        acbName = String(cue.acbFile?.path ?? '');
        awbName = String(cue.awbFile?.path ?? '');
        break;
      }
    }
    for (const cueFolder of cueFolders) {
      try {
        const files = (await readdir(cueFolder, { withFileTypes: true }))
          .filter(entry => entry.isFile())
          .map(entry => entry.name)
          .sort();
        const acb = files.find(filename =>
          acbName ? filename.toLowerCase() === acbName.toLowerCase() : filename.toLowerCase().endsWith('.acb'),
        );
        const awb = files.find(filename =>
          awbName ? filename.toLowerCase() === awbName.toLowerCase() : filename.toLowerCase().endsWith('.awb'),
        );
        if (!audio.acbPath && acb) audio.acbPath = path.join(cueFolder, acb);
        if (!audio.awbPath && awb) audio.awbPath = path.join(cueFolder, awb);
        if (audio.acbPath && audio.awbPath) break;
      } catch {
        /* Missing assets can be inherited from lower-priority packs. */
      }
    }
    return audio;
  }
  const cueIds = [...new Set([...songs.values()].map(({ data }) => Number(data.cueFileName?.id ?? 0)))];
  const cueAssets = new Map(
    await batched(
      cueIds,
      async cueId => [cueId, await resolveCue(cueId)] as const,
      done => progress(`正在定位音乐文件 ${done}/${cueIds.length}…`),
    ),
  );
  // Phase 3: per song, inherit the chart and cover from the highest pack that ships them.
  async function musicAsset(folder: string, relativeName: string): Promise<string> {
    const filename = relativeName.replace(/[\\/]/g, path.sep);
    for (const candidate of reverseRoots) {
      if (!musicFoldersByRoot.get(candidate)?.has(path.basename(folder))) continue;
      const inherited = path.join(candidate, 'music', path.basename(folder), filename);
      if (await isFile(inherited)) return inherited;
    }
    return '';
  }
  const songList = [...songs.entries()];
  const resolved = await batched(
    songList,
    async ([id, { data, root, folder }]) => {
      const cueId = Number(data.cueFileName?.id ?? 0);
      const { acbPath, awbPath, cueXmlPath } = cueAssets.get(cueId) ?? { acbPath: '', awbPath: '' };
      const jacket = data.jaketFile?.path || data.jacketFile?.path;
      const coverPath = jacket ? await musicAsset(folder, String(jacket)) : '';
      const entries: LibraryEntry[] = [];
      for (const [index, fumen] of array<any>(data.fumens?.MusicFumenData).entries()) {
        if (String(fumen.enable).toLowerCase() !== 'true' || !fumen.file?.path) continue;
        const difficultyId = Number(fumen.type?.id ?? index);
        const difficulty = DIFFICULTIES[difficultyId];
        if (!difficulty) continue;
        const chartPath = (await musicAsset(folder, String(fumen.file.path))) || path.join(folder, fumen.file.path);
        const level = Number(fumen.level ?? 0),
          decimal = Number(fumen.levelDecimal ?? 0);
        const levelText = `${level}${decimal === 50 ? '+' : decimal > 0 ? `.${String(decimal).padStart(2, '0').replace(/0$/, '')}` : ''}`;
        entries.push({
          key: `${id}:${difficultyId}`,
          musicId: id,
          title: String(data.name?.str ?? id),
          artist: String(data.artistName?.str ?? ''),
          difficulty,
          level: levelText,
          notesDesigner: String(fumen.notesDesigner ?? ''),
          chartPath,
          coverPath,
          cueId,
          acbPath,
          awbPath,
          musicXmlPath: path.join(folder, 'Music.xml'),
          ...(cueXmlPath ? { cueXmlPath } : {}),
          pack: path.basename(root),
          weTag: String(data.worldsEndTagName?.str ?? '改'),
          stars: Math.max(1, Math.min(5, (Number(data.starDifType ?? 1) + 1) / 2)),
        });
      }
      return entries;
    },
    done => progress(`正在整理谱面 ${done}/${songList.length}…`),
  );
  const result = resolved
    .flat()
    .sort((a, b) => a.musicId - b.musicId || DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty));
  if (options.cacheFile) {
    const cache: LibraryCache = { format: CACHE_FORMAT, gamePath, signature, entries: result };
    try {
      await mkdir(path.dirname(options.cacheFile), { recursive: true });
      await writeFile(options.cacheFile, JSON.stringify(cache));
    } catch {
      /* A missing cache only costs the next scan. */
    }
  }
  return result;
}

/** XML paths point at the winning metadata overlay, independently of inherited chart/audio assets. */
export async function readLibraryXmlMetadata(entry: LibraryEntry): Promise<XmlMetadata> {
  async function source(filename: string, rootName: string): Promise<XmlNode> {
    const contents = await readFile(filename, 'utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(contents)) throw new Error('曲目 XML 不支持 DTD 或实体声明。');
    const root = parser.parse(contents)[rootName];
    validateXmlNode(root, rootName);
    return root;
  }
  const music = await source(entry.musicXmlPath ?? path.join(path.dirname(entry.chartPath), 'Music.xml'), 'MusicData');
  const cue = entry.cueXmlPath ? await source(entry.cueXmlPath, 'CueFileData') : undefined;
  return xmlMetadataFromSource(music, cue);
}
