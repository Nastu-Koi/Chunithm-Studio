import { app, BrowserWindow, dialog, ipcMain, shell, Menu, protocol } from 'electron';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type Project, DIFFICULTIES } from '../core/model';
import { serializeC2S } from '../core/c2s';
import { validateChart } from '../core/validation';
import {
  openProject,
  saveProject,
  createProjectFolder,
  listRecentProjects,
  rememberRecentProject,
  atomicJson,
  validateProjectDocument,
  importC2sProject,
} from './projects';
import { scanLibrary, loadLibraryProject, resourceRoots } from './library';
import { coverPreview, coverRgba } from './cover';
import { configureAudioRuntime, previewAudio } from './audio';
import ffmpegPath from 'ffmpeg-static';
import { exportOpt } from './export';
import { loadBundledGameResources, bundledAssetUrl, resolveBundledAsset } from './bundled-assets';
import { BUNDLED_ASSET_SCHEME } from '../core/game-assets';
import { IPC_CHANNELS, PROGRESS_CHANNEL, type BridgeCall, type StudioBridge } from '../bridge';

let win: BrowserWindow;
const bundledAssetRoot = () => path.join(app.getAppPath(), 'assets', 'game');
// Bundled textures are served over a dedicated scheme so the renderer loads PNG files directly instead of receiving ~20 MB of base64 over IPC.
// corsEnabled lets the file:// page load these images with crossOrigin="anonymous", which WebGL requires for cross-origin textures.
protocol.registerSchemesAsPrivileged([
  { scheme: BUNDLED_ASSET_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } },
]);
async function serveBundledAsset(request: Request): Promise<Response> {
  const asset = resolveBundledAsset(bundledAssetRoot(), request.url);
  if (!asset) return new Response('not found', { status: 404 });
  // The page runs on file:// (an opaque origin); WebGL only accepts images from another origin with CORS headers.
  try {
    return new Response(await readFile(asset.file), {
      headers: {
        'content-type': asset.type,
        'cache-control': 'max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
if (process.env.CHUNI_USER_DATA_DIR) {
  app.setPath('userData', process.env.CHUNI_USER_DATA_DIR);
  app.setPath('sessionData', process.env.CHUNI_USER_DATA_DIR);
}
const progress = (text: string) => win?.webContents.send(PROGRESS_CHANNEL, text);
const cacheFile = (source: string, extension = '.wav') =>
  path.join(
    app.getPath('userData'),
    'cache',
    createHash('sha256').update(source).digest('hex').slice(0, 24) + extension,
  );
const recoveryFile = () => path.join(app.getPath('userData'), 'recovery.json');
const recentFile = () => path.join(app.getPath('userData'), 'recent-projects.json');
// The renderer may only read files the main process handed out (dialogs, projects, library scans) or that live under trusted roots.
const readableFiles = new Set<string>(),
  readableRoots = new Set<string>();
const pathKey = (file: string) => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const allowRead = (file: string | undefined) => {
  if (file) readableFiles.add(pathKey(file));
};
const allowRoot = (directory: string) => readableRoots.add(pathKey(directory));
function assertReadable(file: string): string {
  if (typeof file !== 'string' || !file) throw new Error('文件路径无效。');
  const key = pathKey(file);
  if (readableFiles.has(key)) return file;
  for (const root of readableRoots) if (key === root || key.startsWith(root + path.sep)) return file;
  throw new Error('渲染进程请求的文件不在已授权的位置。');
}
const allowProjectAssets = (p: Project) => {
  allowRead(p.audio.path);
  allowRead(p.coverPath);
};
// Saving in place deletes replaced assets, so it is limited to folders this session opened, created or recovered.
const projectFolders = new Set<string>();
async function selectDirectory(title: string): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}
const difficultyId = (p: Project) => DIFFICULTIES.indexOf(p.metadata.difficulty);
function exportChart(p: Project, allowQuantization: boolean): string {
  const errors = validateChart(p.chart).filter(issue => issue.severity === 'error');
  if (errors.length)
    throw new Error(
      `请先修正谱面错误：${errors
        .slice(0, 5)
        .map(issue => issue.message)
        .join(' ')}`,
    );
  return serializeC2S(p.chart, {
    designer: p.metadata.designer,
    difficulty: difficultyId(p),
    omitStaleStatistics: true,
    quantization: allowQuantization ? 'nearest' : 'reject',
  });
}
async function selectFile(title: string, extensions: string[]): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters: [{ name: title, extensions }],
  });
  return r.canceled ? null : r.filePaths[0];
}
/** Register the main-process side of a bridge operation; its arguments and result are checked against `StudioBridge`. */
function handle<K extends BridgeCall>(
  name: K,
  handler: (...args: Parameters<StudioBridge[K]>) => ReturnType<StudioBridge[K]> | Awaited<ReturnType<StudioBridge[K]>>,
): void {
  ipcMain.handle(IPC_CHANNELS[name], (_event, ...args) => handler(...(args as Parameters<StudioBridge[K]>)));
}
function attachHandlers() {
  handle('loadGameResources', () => loadBundledGameResources(bundledAssetRoot(), { imageUrl: bundledAssetUrl }));
  handle('listRecentProjects', () => listRecentProjects(recentFile()));
  handle('openProject', async recent => {
    if (recent !== undefined && !(await listRecentProjects(recentFile())).some(item => item.path === recent))
      throw new Error('该项目不在最近打开的列表中。');
    const directory = recent ?? (await selectDirectory('打开项目文件夹'));
    if (!directory) return null;
    const { project, warnings } = await openProject(directory);
    allowProjectAssets(project);
    projectFolders.add(pathKey(directory));
    await rememberRecentProject(recentFile(), directory, project);
    return { project, path: directory, warnings };
  });
  handle('importC2s', async () => {
    const file = await selectFile('导入原生 C2S 谱面', ['c2s']);
    if (!file) return null;
    return { project: importC2sProject(await readFile(file, 'utf8'), file), path: null };
  });
  handle('saveProject', async (project, directory, saveAs) => {
    validateProjectDocument(project);
    if (project.audio.path) assertReadable(project.audio.path);
    if (project.coverPath) assertReadable(project.coverPath);
    let removed: string[] = [];
    if (!directory || saveAs) {
      const parent = await selectDirectory('选择保存位置（将在其中新建以曲名命名的项目文件夹）');
      if (!parent) return null;
      ({ directory, project } = await createProjectFolder(parent, project));
    } else {
      if (!projectFolders.has(pathKey(directory))) throw new Error('项目文件夹不是由本程序打开的。');
      ({ project, removed } = await saveProject(directory, project));
    }
    allowProjectAssets(project);
    projectFolders.add(pathKey(directory));
    await rememberRecentProject(recentFile(), directory, project);
    await rm(recoveryFile(), { force: true });
    return { project, path: directory, removed };
  });
  handle('exportC2s', async (p, allowQuantization = false) => {
    validateProjectDocument(p);
    const text = exportChart(p, allowQuantization);
    const r = await dialog.showSaveDialog(win, {
      title: '导出 C2S 谱面',
      defaultPath: `${p.exportSettings.musicId}_${String(difficultyId(p)).padStart(2, '0')}.c2s`,
      filters: [{ name: 'C2S 谱面', extensions: ['c2s'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, text, 'utf8');
    return r.filePath;
  });
  handle('saveImage', async (defaultName, png) => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出俯视图片',
      defaultPath: defaultName.replace(/[\\/:*?"<>|]+/g, '_'),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    return r.filePath;
  });
  handle('pickAudio', async () => {
    const file = await selectFile('选择音乐', ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac']);
    allowRead(file ?? undefined);
    return file;
  });
  handle('pickCover', async () => {
    const file = await selectFile('选择封面', ['png', 'jpg', 'jpeg', 'webp', 'dds']);
    allowRead(file ?? undefined);
    return file;
  });
  handle('readAudio', filename => previewAudio(assertReadable(filename), source => cacheFile(source)));
  handle('readCover', filename => coverPreview(assertReadable(filename)));
  handle('chooseGamePath', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 CHUNITHM 游戏目录',
      properties: ['openDirectory'],
      defaultPath: process.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm',
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('scanLibrary', async (root, force = false) => {
    progress('正在读取本地曲库…');
    const list = await scanLibrary(root, {
      onProgress: progress,
      force,
      cacheFile: path.join(app.getPath('userData'), 'library-cache.json'),
    });
    // Library entries only point into the resource roots, so those are made readable rather than the whole folder.
    for (const resourceRoot of await resourceRoots(root)) allowRoot(resourceRoot);
    progress(`已读取 ${list.length} 张谱面`);
    return list;
  });
  handle('loadLibraryChart', async entry => {
    for (const file of [
      entry.chartPath,
      entry.acbPath,
      entry.awbPath,
      entry.coverPath,
      entry.musicXmlPath,
      entry.cueXmlPath,
    ])
      if (file) assertReadable(file);
    return loadLibraryProject(entry, { audioCache: cacheFile(entry.awbPath), onProgress: progress });
  });
  handle('exportOpt', async (p, gamePath, allowQuantization = false) => {
    validateProjectDocument(p);
    const c2s = exportChart(p, allowQuantization);
    const r = await dialog.showOpenDialog(win, {
      title: '选择 OPT 输出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled) return null;
    const cover = p.coverPath ? await coverRgba(assertReadable(p.coverPath)) : undefined;
    const result = await exportOpt(p, { gamePath, outputDirectory: r.filePaths[0], cover, c2s }, progress);
    allowRead(result.optPath);
    return result;
  });
  handle('autosave', async (p, filename) => {
    if (p) {
      validateProjectDocument(p);
      await atomicJson(recoveryFile(), { project: p, path: filename });
    } else await rm(recoveryFile(), { force: true });
  });
  handle('getRecovery', async () => {
    try {
      const saved = JSON.parse(await readFile(recoveryFile(), 'utf8'));
      validateProjectDocument(saved.project);
      allowProjectAssets(saved.project);
      // A recovered project keeps its folder only while that folder still exists; otherwise it is saved as a new one.
      if (typeof saved.path === 'string') {
        try {
          await access(saved.path);
          projectFolders.add(pathKey(saved.path));
        } catch {
          saved.path = null;
        }
      } else saved.path = null;
      return { project: saved.project, path: saved.path };
    } catch {
      return null;
    }
  });
  handle('revealPath', async filename => shell.showItemInFolder(assertReadable(filename)));
}
app.whenReady().then(() => {
  configureAudioRuntime({
    nativeDirectory: path.join(app.getAppPath(), 'native'),
    ...(process.platform !== 'win32' && ffmpegPath ? { ffmpegPath } : {}),
  });
  protocol.handle(BUNDLED_ASSET_SCHEME, serveBundledAsset);
  allowRoot(app.getPath('userData'));
  allowRoot(bundledAssetRoot());
  Menu.setApplicationMenu(null);
  attachHandlers();
  win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#1e1e1e',
    title: 'Chuni Studio',
    show: false,
    // No native title bar: the app header is the top strip and Windows draws its three buttons over its right end
    // (colours match --bg-1 / --text-2 in src/renderer/tokens.css, height matches .app-header).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1e1e1e', symbolColor: '#a6a6a6', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['继续编辑', '退出'],
      defaultId: 0,
      cancelId: 0,
      title: '工程尚未保存',
      message: '当前工程尚未保存。退出后可以通过自动保存恢复。',
    });
    if (response === 1) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  const dev = process.env.CHUNI_DEV_URL;
  if (dev?.startsWith('http://127.0.0.1:')) void win.loadURL(dev);
  else void win.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
