import { readFile, writeFile, rename, mkdir, copyFile, access, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../core/model';
import type { RecentProject } from '../bridge';
import { getXmlMetadata, validateXmlMetadata } from '../core/xml-metadata';
export function validateProjectDocument(value: unknown): asserts value is Project {
  const p = value as Project;
  if (!p || p.format !== 'chunithm-studio' || p.formatVersion !== 1 || !p.metadata || !p.audio || !p.exportSettings || !p.chart || !Array.isArray(p.chart.notes) || !Array.isArray(p.chart.events)) throw new Error('不是受支持的 Chuni Studio 工程文件。');
  if (!Number.isFinite(p.chart.resolution) || p.chart.resolution <= 0 || !Number.isFinite(p.chart.defaultBpm) || p.chart.defaultBpm <= 0) throw new Error('工程时间轴数据无效。');
  for (const n of p.chart.notes) if (!n.id || !Number.isFinite(n.tick) || !Number.isFinite(n.lane) || !Number.isFinite(n.width)) throw new Error('工程包含无效音符数据。');
  validateXmlMetadata(getXmlMetadata(p));
}
/** A project is one folder: this file plus `audio.<ext>` and `cover.<ext>` beside it. */
export const PROJECT_FILE = 'project.chuni.json';
export const projectFile = (directory: string) => path.join(directory, PROJECT_FILE);
const ASSET_KINDS = ['audio', 'cover'] as const;
const exists = (file: string) => access(file).then(() => true, () => false);
export async function readProject(directory: string): Promise<Project> {
  let text: string;
  try { text = await readFile(projectFile(directory), 'utf8'); }
  catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Error('不是 Chuni Studio 项目文件夹。'); throw e; }
  const p: unknown = JSON.parse(text);
  validateProjectDocument(p);
  if (p.audio.path && !path.isAbsolute(p.audio.path)) p.audio.path = path.resolve(directory, p.audio.path);
  if (p.coverPath && !path.isAbsolute(p.coverPath)) p.coverPath = path.resolve(directory, p.coverPath);
  return p;
}
/** Open a project folder. A missing asset does not block the chart: its path is cleared and reported. */
export async function openProject(directory: string): Promise<{ project: Project; warnings: string[] }> {
  const project = await readProject(directory), warnings: string[] = [];
  if (project.audio.path && !(await exists(project.audio.path))) { warnings.push(`项目中的音乐文件 ${path.basename(project.audio.path)} 已丢失，请重新导入音乐。`); project.audio.path = ''; }
  if (project.coverPath && !(await exists(project.coverPath))) { warnings.push(`项目中的封面文件 ${path.basename(project.coverPath)} 已丢失，请重新选择封面。`); project.coverPath = ''; }
  return { project, warnings };
}
export async function atomicJson(filename: string, data: unknown, backup = false): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  if (backup) { try { await copyFile(filename, `${filename}.bak`); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
  await rename(temporary, filename);
}
/**
 * Write the project into its folder. Assets are copied in as `audio.<ext>` / `cover.<ext>`, and
 * replaced ones are deleted only after the new document is on disk, so the folder is always self-consistent.
 * `removed` lists the deleted files.
 */
export async function saveProject(directory: string, project: Project): Promise<{ project: Project; removed: string[] }> {
  validateProjectDocument(project);
  const copy = structuredClone(project), keep = new Set<string>();
  for (const kind of ASSET_KINDS) {
    const source = kind === 'audio' ? copy.audio.path : copy.coverPath;
    if (!source) continue;
    await access(source);
    await mkdir(directory, { recursive: true });
    const name = `${kind}${path.extname(source).toLowerCase()}`, destination = path.join(directory, name);
    if (path.resolve(source) !== path.resolve(destination)) await copyFile(source, destination);
    keep.add(name.toLowerCase());
    if (kind === 'audio') copy.audio.path = destination; else copy.coverPath = destination;
  }
  const disk = structuredClone(copy);
  if (disk.audio.path) disk.audio.path = path.basename(disk.audio.path);
  if (disk.coverPath) disk.coverPath = path.basename(disk.coverPath);
  await atomicJson(projectFile(directory), disk, true);
  const removed: string[] = [];
  for (const name of await readdir(directory)) {
    if (!/^(audio|cover)\.[^.]+$/i.test(name) || keep.has(name.toLowerCase())) continue;
    await rm(path.join(directory, name), { force: true }); removed.push(path.join(directory, name));
  }
  return { project: copy, removed };
}
/** Folder name for a new project: the title with characters Windows rejects replaced. */
export function projectFolderName(title: string): string {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return name && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? name : '未命名项目';
}
/** Create `<parent>/<title>` and save into it. An existing folder of that name is never reused. */
export async function createProjectFolder(parent: string, project: Project): Promise<{ directory: string; project: Project }> {
  validateProjectDocument(project);
  const directory = path.join(parent, projectFolderName(project.metadata.title));
  try { await mkdir(directory); }
  catch (e: any) { if (e.code === 'EEXIST') throw new Error(`“${path.basename(directory)}”已存在。请在乐曲设置中修改曲名，或选择其他位置。`); throw e; }
  try { return { directory, project: (await saveProject(directory, project)).project }; }
  catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
}
const RECENT_LIMIT = 10;
async function readRecent(file: string): Promise<RecentProject[]> {
  try { const list: unknown = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(list) ? list.filter(item => item && typeof item.path === 'string') : []; }
  catch { return []; }
}
/** Recent project folders, newest first. Folders that no longer hold a project are dropped. */
export async function listRecentProjects(file: string): Promise<RecentProject[]> {
  const output: RecentProject[] = [];
  for (const item of await readRecent(file)) {
    try { output.push({ path: item.path, title: String(item.title ?? ''), artist: String(item.artist ?? ''), modified: (await stat(projectFile(item.path))).mtimeMs }); }
    catch { /* Moved or deleted. */ }
  }
  return output;
}
export async function rememberRecentProject(file: string, directory: string, project: Project): Promise<void> {
  const key = (value: string) => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const others = (await readRecent(file)).filter(item => key(item.path) !== key(directory));
  await atomicJson(file, [{ path: directory, title: project.metadata.title, artist: project.metadata.artist }, ...others].slice(0, RECENT_LIMIT));
}
