import { contextBridge, ipcRenderer } from 'electron';
import type { StudioBridge } from '../bridge';
const bridge: StudioBridge = {
  platform: process.platform,
  loadGameResources: () => ipcRenderer.invoke('resources:load'),
  openProject: directory => ipcRenderer.invoke('project:open', directory), listRecentProjects: () => ipcRenderer.invoke('project:recent'),
  importC2s: () => ipcRenderer.invoke('chart:import'),
  saveProject: (p, file, saveAs) => ipcRenderer.invoke('project:save', p, file, saveAs),
  exportC2s: (p, quantize) => ipcRenderer.invoke('chart:export', p, quantize),
  pickAudio: () => ipcRenderer.invoke('audio:pick'), pickCover: () => ipcRenderer.invoke('cover:pick'),
  readAudio: file => ipcRenderer.invoke('audio:read', file), readCover: file => ipcRenderer.invoke('cover:read', file),
  chooseGamePath: () => ipcRenderer.invoke('library:choose'), scanLibrary: (root, force) => ipcRenderer.invoke('library:scan', root, force),
  loadLibraryChart: entry => ipcRenderer.invoke('library:load', entry),
  exportOpt: (p, root, quantize) => ipcRenderer.invoke('opt:export', p, root, quantize),
  autosave: (p, file) => ipcRenderer.invoke('project:autosave', p, file), getRecovery: () => ipcRenderer.invoke('project:recovery'),
  revealPath: file => ipcRenderer.invoke('path:reveal', file),
  onProgress: callback => { const fn = (_: unknown, value: string) => callback(value); ipcRenderer.on('progress', fn); return () => ipcRenderer.removeListener('progress', fn); },
};
contextBridge.exposeInMainWorld('studio', bridge);
