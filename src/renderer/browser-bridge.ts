import type { StudioBridge, LoadedProject } from '../bridge';
import { createProject, DIFFICULTIES } from '../core/model';
import { parseC2S, serializeC2S } from '../core/c2s';
import { validateChart } from '../core/validation';
const files = new Map<string, File>();
const desktopOnly = () => {
  throw new Error('此功能需要在 Windows 桌面程序中使用。浏览器当前用于界面开发与验证。');
};
function pick(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
function download(data: string | Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function asset(accept: string): Promise<string | null> {
  const f = await pick(accept);
  if (!f) return null;
  const key = `browser:${f.name}:${f.lastModified}`;
  files.set(key, f);
  return key;
}
export const browserBridge: StudioBridge = {
  platform: 'browser',
  loadGameResources: async () => desktopOnly(),
  async openProject() {
    const f = await pick('.json');
    if (!f) return null;
    const project = JSON.parse(await f.text());
    if (project.format !== 'chunithm-studio') throw new Error('不是 Chuni Studio 工程');
    return { project, path: f.name };
  },
  listRecentProjects: async () => [],
  async importC2s() {
    const f = await pick('.c2s');
    if (!f) return null;
    const project = createProject();
    project.metadata.title = f.name.replace(/\.c2s$/i, '');
    project.chart = parseC2S(await f.text());
    return { project, path: null };
  },
  async saveProject(project) {
    download(JSON.stringify(project, null, 2), `${project.metadata.title}.chuni.json`);
    return { project, path: `${project.metadata.title}.chuni.json` };
  },
  async exportC2s(project, allowQuantization) {
    const errors = validateChart(project.chart).filter(issue => issue.severity === 'error');
    if (errors.length) throw new Error(`请先修正谱面错误：${errors[0].message}`);
    const difficulty = DIFFICULTIES.indexOf(project.metadata.difficulty);
    const filename = `${project.exportSettings.musicId}_${String(difficulty).padStart(2, '0')}.c2s`;
    download(
      serializeC2S(project.chart, {
        designer: project.metadata.designer,
        difficulty,
        quantization: allowQuantization ? 'nearest' : 'reject',
      }),
      filename,
    );
    return filename;
  },
  async saveImage(defaultName, png) {
    download(png, defaultName);
    return defaultName;
  },
  pickAudio: () => asset('audio/*'),
  pickCover: () => asset('image/*'),
  async readAudio(key) {
    const f = files.get(key);
    if (!f) throw new Error('请重新选择音乐文件。');
    return new Uint8Array(await f.arrayBuffer());
  },
  async readCover(key) {
    const f = files.get(key);
    if (!f) throw new Error('请重新选择封面。');
    return URL.createObjectURL(f);
  },
  chooseGamePath: async () => desktopOnly(),
  scanLibrary: async () => desktopOnly(),
  loadLibraryChart: async () => desktopOnly(),
  exportOpt: async () => desktopOnly(),
  revealPath: async () => desktopOnly(),
  async autosave(project, path) {
    if (project) localStorage.setItem('chuni-recovery', JSON.stringify({ project, path }));
    else localStorage.removeItem('chuni-recovery');
  },
  async getRecovery() {
    const value = localStorage.getItem('chuni-recovery');
    return value ? (JSON.parse(value) as LoadedProject) : null;
  },
  onProgress: () => () => {},
};
