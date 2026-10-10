import { app, BrowserWindow, dialog, ipcMain, shell, Menu, protocol } from 'electron';
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createProject, type Project } from '../core/model';
import { parseC2S, serializeC2S } from '../core/c2s';
import { validateChart } from '../core/validation';
import { readProject, saveProject, atomicJson, validateProjectDocument } from './projects';
import { scanLibrary, readLibraryXmlMetadata } from './library';
import { decodeDDS } from './dds-preview';
import { configureAudioRuntime, prepareAudio, decodeGameAudio } from './audio';
import ffmpegPath from 'ffmpeg-static';
import { exportOpt } from './export';
import { loadBundledGameResources, bundledAssetUrl, resolveBundledAsset } from './bundled-assets';
import { BUNDLED_ASSET_SCHEME } from '../core/game-assets';
import type { LibraryEntry } from '../bridge';

let win: BrowserWindow;
const bundledAssetRoot = () => path.join(app.getAppPath(), 'assets', 'game');
// Bundled textures are served over a dedicated scheme so the renderer loads PNG files directly instead of receiving ~20 MB of base64 over IPC.
// corsEnabled lets the file:// page load these images with crossOrigin="anonymous", which WebGL requires for cross-origin textures.
protocol.registerSchemesAsPrivileged([{ scheme: BUNDLED_ASSET_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } }]);
async function serveBundledAsset(request: Request): Promise<Response> {
  const asset = resolveBundledAsset(bundledAssetRoot(), request.url);
  if (!asset) return new Response('not found', { status: 404 });
  // The page runs on file:// (an opaque origin); WebGL only accepts images from another origin with CORS headers.
  try { return new Response(await readFile(asset.file), { headers: { 'content-type': asset.type, 'cache-control': 'max-age=31536000, immutable', 'access-control-allow-origin': '*' } }); }
  catch { return new Response('not found', { status: 404 }); }
}
if (process.env.CHUNI_USER_DATA_DIR) {
  app.setPath('userData', process.env.CHUNI_USER_DATA_DIR);
  app.setPath('sessionData', process.env.CHUNI_USER_DATA_DIR);
}
const progress = (text: string) => win?.webContents.send('progress', text);
const cacheFile = (source: string, extension = '.wav') => path.join(app.getPath('userData'), 'cache', createHash('sha256').update(source).digest('hex').slice(0, 24) + extension);
const recoveryFile = () => path.join(app.getPath('userData'), 'recovery.json');
// The renderer may only read files the main process handed out (dialogs, projects, library scans) or that live under trusted roots.
const readableFiles = new Set<string>(), readableRoots = new Set<string>();
const pathKey = (file: string) => { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const allowRead = (file: string | undefined) => { if (file) readableFiles.add(pathKey(file)); };
const allowRoot = (directory: string) => readableRoots.add(pathKey(directory));
function assertReadable(file: string): string {
  if (typeof file !== 'string' || !file) throw new Error('文件路径无效。');
  const key = pathKey(file);
  if (readableFiles.has(key)) return file;
  for (const root of readableRoots) if (key === root || key.startsWith(root + path.sep)) return file;
  throw new Error('渲染进程请求的文件不在已授权的位置。');
}
const allowProjectAssets = (p: Project) => { allowRead(p.audio.path); allowRead(p.coverPath); };
const difficultyId = (p: Project) => ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'ULTIMA', 'WORLD’S END'].indexOf(p.metadata.difficulty);
function exportChart(p: Project, allowQuantization: boolean): string {
  const errors = validateChart(p.chart).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(`请先修正谱面错误：${errors.slice(0, 5).map(issue => issue.message).join(' ')}`);
  return serializeC2S(p.chart, { designer: p.metadata.designer, difficulty: difficultyId(p), omitStaleStatistics: true, quantization: allowQuantization ? 'nearest' : 'reject' });
}
async function selectFile(title: string, extensions: string[]): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: title, extensions }] }); return r.canceled ? null : r.filePaths[0];
}
async function previewAudio(file: string): Promise<Buffer> {
  const ext = path.extname(file).toLowerCase();
  if (['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'].includes(ext)) return readFile(file);
  const target = cacheFile(file); await mkdir(path.dirname(target), { recursive: true });
  await prepareAudio(file, target); return readFile(target);
}
function attachHandlers() {
  ipcMain.handle('resources:load', () => loadBundledGameResources(bundledAssetRoot(), { imageUrl: bundledAssetUrl }));
  ipcMain.handle('project:open', async () => { const file = await selectFile('打开工程', ['json']); if (!file) return null; const project = await readProject(file); allowProjectAssets(project); return { project, path: file }; });
  ipcMain.handle('chart:import', async () => {
    const file = await selectFile('导入原生 C2S 谱面', ['c2s']); if (!file) return null;
    const p = createProject(); p.metadata.title = path.basename(file, '.c2s'); p.chart = parseC2S(await readFile(file, 'utf8'));
    const creator = p.chart.headerRecords.find(r => r.tag === 'CREATOR'); if (creator) p.metadata.designer = creator.raw.split(/\t/).slice(1).join(' ').trim();
    return { project: p, path: null };
  });
  ipcMain.handle('project:save', async (_, project: Project, filename: string | null, saveAs: boolean) => {
    validateProjectDocument(project);
    if (project.audio.path) assertReadable(project.audio.path); if (project.coverPath) assertReadable(project.coverPath);
    if (!filename || saveAs) { const r = await dialog.showSaveDialog(win, { title: '保存工程', defaultPath: `${project.metadata.title.replace(/[<>:"/\\|?*]/g, '_')}.chuni.json`, filters: [{ name: 'Chuni Studio 工程', extensions: ['chuni.json'] }] }); if (r.canceled || !r.filePath) return null; filename = r.filePath; }
    const saved = await saveProject(filename, project); allowProjectAssets(saved); await rm(recoveryFile(), { force: true }); return { project: saved, path: filename };
  });
  ipcMain.handle('chart:export', async (_, p: Project, allowQuantization = false) => {
    validateProjectDocument(p);
    const text = exportChart(p, allowQuantization);
    const r = await dialog.showSaveDialog(win, { title: '导出 C2S 谱面', defaultPath: `${p.exportSettings.musicId}_${String(difficultyId(p)).padStart(2, '0')}.c2s`, filters: [{ name: 'C2S 谱面', extensions: ['c2s'] }] });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, text, 'utf8'); return r.filePath;
  });
  ipcMain.handle('audio:pick', async () => { const file = await selectFile('选择音乐', ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac']); allowRead(file ?? undefined); return file; });
  ipcMain.handle('cover:pick', async () => { const file = await selectFile('选择封面', ['png', 'jpg', 'jpeg', 'webp', 'dds']); allowRead(file ?? undefined); return file; });
  ipcMain.handle('audio:read', (_, filename: string) => previewAudio(assertReadable(filename)));
  ipcMain.handle('cover:read', async (_, filename: string) => {
    const bytes = await readFile(assertReadable(filename)); let image;
    if (path.extname(filename).toLowerCase() === '.dds') { const d = decodeDDS(bytes); image = sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }); }
    else image = sharp(bytes);
    return 'data:image/png;base64,' + (await image.resize(512, 512, { fit: 'inside' }).png().toBuffer()).toString('base64');
  });
  ipcMain.handle('library:choose', async () => { const r = await dialog.showOpenDialog(win, { title: '选择 CHUNITHM 游戏目录', properties: ['openDirectory'], defaultPath: process.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm' }); return r.canceled ? null : r.filePaths[0]; });
  ipcMain.handle('library:scan', async (_, root: string, force = false) => {
    progress('正在读取本地曲库…');
    const list = await scanLibrary(root, { onProgress: progress, force, cacheFile: path.join(app.getPath('userData'), 'library-cache.json') });
    allowRoot(root); progress(`已读取 ${list.length} 张谱面`); return list;
  });
  ipcMain.handle('library:load', async (_, entry: LibraryEntry) => {
    for (const file of [entry.chartPath, entry.acbPath, entry.awbPath, entry.coverPath, entry.musicXmlPath, entry.cueXmlPath]) if (file) assertReadable(file);
    const p = createProject(); p.chart = parseC2S(await readFile(entry.chartPath, 'utf8'));
    const warnings: string[] = [];
    p.metadata = { title: entry.title, artist: entry.artist, designer: p.chart.headerRecords.find(r => r.tag === 'CREATOR')?.raw.split('\t').slice(1).join(' ').trim() || entry.notesDesigner || '', difficulty: entry.difficulty, level: entry.level };
    p.coverPath = entry.coverPath; p.exportSettings.weTag = entry.weTag; p.exportSettings.stars = entry.stars;
    try { p.xmlMetadata = await readLibraryXmlMetadata(entry); }
    catch (error) { warnings.push(`XML 元数据未能完整载入，将使用新曲默认设置：${error instanceof Error ? error.message : error}`); }
    // Imported songs are saved as independent projects with new export identifiers.
    if (entry.acbPath && entry.awbPath) {
      progress('正在解码原曲音乐…'); const target = cacheFile(entry.awbPath); await mkdir(path.dirname(target), { recursive: true });
      try { try { await access(target); } catch { await decodeGameAudio(entry.acbPath, entry.awbPath, target); } p.audio.path = target; }
      catch (error) { warnings.push(`音乐解码失败，可在编辑器中重新选择音乐：${error instanceof Error ? error.message : error}`); }
    } else warnings.push('没有找到配套音乐，谱面已载入，可手动导入音乐。');
    progress(`已载入 ${p.metadata.title}`); return { project: p, path: null, warnings };
  });
  ipcMain.handle('opt:export', async (_, p: Project, gamePath: string, allowQuantization = false) => {
    validateProjectDocument(p);
    const c2s = exportChart(p, allowQuantization);
    const r = await dialog.showOpenDialog(win, { title: '选择 OPT 输出目录', properties: ['openDirectory', 'createDirectory'] }); if (r.canceled) return null;
    let cover;
    if (p.coverPath) {
      const bytes = await readFile(assertReadable(p.coverPath));
      const d = path.extname(p.coverPath).toLowerCase() === '.dds' ? decodeDDS(bytes) : null;
      const s = d ? sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }) : sharp(bytes);
      const { data, info } = await s.resize(512, 512).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      cover = { rgba: data, width: info.width, height: info.height };
    }
    const result = await exportOpt(p, { gamePath, outputDirectory: r.filePaths[0], cover, c2s }, progress);
    allowRead(result.optPath); return result;
  });
  ipcMain.handle('project:autosave', async (_, p: Project | null, filename: string | null) => { if (p) { validateProjectDocument(p); await atomicJson(recoveryFile(), { project: p, path: filename }); } else await rm(recoveryFile(), { force: true }); });
  ipcMain.handle('project:recovery', async () => { try { const saved = JSON.parse(await readFile(recoveryFile(), 'utf8')); validateProjectDocument(saved.project); allowProjectAssets(saved.project); return saved; } catch { return null; } });
  ipcMain.handle('path:reveal', (_, filename: string) => shell.showItemInFolder(assertReadable(filename)));
}
app.whenReady().then(() => {
  configureAudioRuntime({ nativeDirectory: path.join(app.getAppPath(), 'native'), ...(process.platform !== 'win32' && ffmpegPath ? { ffmpegPath } : {}) });
  protocol.handle(BUNDLED_ASSET_SCHEME, serveBundledAsset);
  allowRoot(app.getPath('userData')); allowRoot(bundledAssetRoot());
  Menu.setApplicationMenu(null); attachHandlers();
  win = new BrowserWindow({ width: 1480, height: 960, minWidth: 1050, minHeight: 700, backgroundColor: '#0a0f19', title: 'Chuni Studio', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['继续编辑', '退出'], defaultId: 0, cancelId: 0, title: '工程尚未保存', message: '当前工程尚未保存。退出后可以通过自动保存恢复。' });
    if (response === 1) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  const dev = process.env.CHUNI_DEV_URL;
  if (dev?.startsWith('http://127.0.0.1:')) void win.loadURL(dev); else void win.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
