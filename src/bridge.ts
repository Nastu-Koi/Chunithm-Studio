import type { Project, Difficulty } from './core/model';
import type { GameTextures } from './core/game-assets';
import type { GameHitSounds } from './core/game-sounds';
export interface LibraryEntry {
  key: string; musicId: number; title: string; artist: string; difficulty: Difficulty;
  level: string; chartPath: string; coverPath: string; cueId: number; pack: string;
  acbPath: string; awbPath: string; weTag: string; stars: number;
  musicXmlPath?: string; cueXmlPath?: string;
  notesDesigner?: string;
}
/** `path` is the project folder, or null for a project that has never been saved. `removed` lists replaced assets a save deleted. */
export interface LoadedProject { project: Project; path: string | null; warnings?: string[]; removed?: string[] }
export interface RecentProject { path: string; title: string; artist: string; modified: number }
export interface ExportResult { optPath: string; files: string[]; warnings: string[]; structuralVerified: boolean }
export interface StudioBridge {
  loadGameResources(): Promise<{ textures: GameTextures; sounds: GameHitSounds }>;
  /** Open a recent project folder, or ask for one when no folder is given. */
  openProject(directory?: string): Promise<LoadedProject | null>;
  listRecentProjects(): Promise<RecentProject[]>;
  importC2s(): Promise<LoadedProject | null>;
  saveProject(project: Project, path: string | null, saveAs?: boolean): Promise<LoadedProject | null>;
  exportC2s(project: Project, allowQuantization?: boolean): Promise<string | null>;
  pickAudio(): Promise<string | null>;
  pickCover(): Promise<string | null>;
  readAudio(path: string): Promise<Uint8Array>;
  readCover(path: string): Promise<string>;
  chooseGamePath(): Promise<string | null>;
  /** `force` ignores the cached result of the previous scan. */
  scanLibrary(gamePath: string, force?: boolean): Promise<LibraryEntry[]>;
  loadLibraryChart(entry: LibraryEntry): Promise<LoadedProject>;
  exportOpt(project: Project, gamePath: string, allowQuantization?: boolean): Promise<ExportResult | null>;
  autosave(project: Project | null, path: string | null): Promise<void>;
  getRecovery(): Promise<LoadedProject | null>;
  revealPath(path: string): Promise<void>;
  onProgress(callback: (message: string) => void): () => void;
  platform: string;
}
declare global { interface Window { studio?: StudioBridge } }
