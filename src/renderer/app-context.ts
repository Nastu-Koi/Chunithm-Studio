import type { GameTextures } from '../core/game-assets';
import type { Project } from '../core/model';
import type { StudioBridge, LibraryEntry, LoadedProject } from '../bridge';
import type { Transport } from './transport';
import type { ChartPlayer } from './player';
import type { ChartEditor } from './editor';

/** What dialogs may read and do. State lives in main.ts; mutable fields are accessors there. */
export interface AppContext {
  readonly bridge: StudioBridge;
  readonly transport: Transport;
  readonly player: ChartPlayer;
  readonly editor: ChartEditor;
  readonly modal: HTMLDialogElement;
  readonly project: Project;
  gamePath: string;
  library: LibraryEntry[];
  readonly coverUrl: string;
  readonly resources: { description: string; warnings: string[] };
  /** The loaded resource copy, for drawing with the game's textures outside the player; undefined until it loads. */
  readonly gameTextures: GameTextures | undefined;
  commit(next: Project, label?: string): void;
  showModal(title: string, content: string): void;
  message(text: string, error?: boolean): void;
  run(action: () => Promise<void>): Promise<void>;
  load(loaded: LoadedProject): Promise<void>;
  loadCover(): Promise<void>;
  discardAllowed(): boolean;
  /** Ask for a project folder, or open the given recent one, and load it. */
  openProject(directory?: string): Promise<void>;
  switchView(view: 'edit' | 'player'): void;
  playbackDuration(): number;
  /** Move the shared cursor and audio position to a tick and show it in the editor. */
  seekTick(tick: number): void;
  syncPlayerChart(): void;
}
