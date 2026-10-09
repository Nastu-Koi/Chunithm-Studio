import { readFile, writeFile, rename, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../core/model';
import { getXmlMetadata, validateXmlMetadata } from '../core/xml-metadata';
export function validateProjectDocument(value: unknown): asserts value is Project {
  const p = value as Project;
  if (!p || p.format !== 'chunithm-studio' || p.formatVersion !== 1 || !p.metadata || !p.audio || !p.exportSettings || !p.chart || !Array.isArray(p.chart.notes) || !Array.isArray(p.chart.events)) throw new Error('不是受支持的 Chuni Studio 工程文件。');
  if (!Number.isFinite(p.chart.resolution) || p.chart.resolution <= 0 || !Number.isFinite(p.chart.defaultBpm) || p.chart.defaultBpm <= 0) throw new Error('工程时间轴数据无效。');
  for (const n of p.chart.notes) if (!n.id || !Number.isFinite(n.tick) || !Number.isFinite(n.lane) || !Number.isFinite(n.width)) throw new Error('工程包含无效音符数据。');
  validateXmlMetadata(getXmlMetadata(p));
}
export async function readProject(filename: string): Promise<Project> {
  const p: unknown = JSON.parse(await readFile(filename, 'utf8'));
  validateProjectDocument(p);
  for (const key of ['path'] as const) if (p.audio[key] && !path.isAbsolute(p.audio[key])) p.audio[key] = path.resolve(path.dirname(filename), p.audio[key]);
  if (p.coverPath && !path.isAbsolute(p.coverPath)) p.coverPath = path.resolve(path.dirname(filename), p.coverPath);
  return p;
}
export async function atomicJson(filename: string, data: unknown, backup = false): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  if (backup) { try { await copyFile(filename, `${filename}.bak`); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
  await rename(temporary, filename);
}
export async function saveProject(filename: string, project: Project): Promise<Project> {
  validateProjectDocument(project);
  const copy = structuredClone(project);
  const assetDirectory = `${filename.replace(/\.chuni\.json$/i, '')}.assets`;
  for (const [kind, source] of [['audio', copy.audio.path], ['cover', copy.coverPath]] as const) {
    if (!source) continue;
    await access(source);
    await mkdir(assetDirectory, { recursive: true });
    const destination = path.join(assetDirectory, `${kind}${path.extname(source)}`);
    if (path.resolve(source) !== path.resolve(destination)) await copyFile(source, destination);
    if (kind === 'audio') copy.audio.path = destination; else copy.coverPath = destination;
  }
  const disk = structuredClone(copy);
  if (disk.audio.path) disk.audio.path = path.relative(path.dirname(filename), disk.audio.path);
  if (disk.coverPath) disk.coverPath = path.relative(path.dirname(filename), disk.coverPath);
  await atomicJson(filename, disk, true);
  return copy;
}
