import { createProject, type Project } from '../core/model';

/**
 * The open project, its folder, whether it has unsaved changes, and its undo history.
 * Projects are immutable: every edit replaces the current one, which is kept for undo.
 */
export class ProjectStore {
  private current: Project;
  private folder: string | null = null;
  private unsaved = false;
  private history: Project[] = [];
  private future: Project[] = [];

  constructor(
    project: Project = createProject(),
    /** Undo steps kept; the oldest are dropped first. */
    private readonly limit = 80,
  ) {
    this.current = project;
  }

  get project(): Project {
    return this.current;
  }
  /** The project folder, or null for a project that has never been saved. */
  get path(): string | null {
    return this.folder;
  }
  get dirty(): boolean {
    return this.unsaved;
  }
  get canUndo(): boolean {
    return this.history.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Replace the project with an edited one. */
  commit(next: Project): void {
    this.history.push(this.current);
    if (this.history.length > this.limit) this.history.shift();
    this.future = [];
    this.current = next;
    this.unsaved = true;
  }
  /** Step back; false when there is nothing to undo. */
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.future.push(this.current);
    this.current = previous;
    this.unsaved = true;
    return true;
  }
  /** Step forward again; false when there is nothing to redo. */
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.history.push(this.current);
    this.current = next;
    this.unsaved = true;
    return true;
  }
  /** Open another project: the history starts over. A recovered autosave is loaded as unsaved. */
  load(project: Project, path: string | null, dirty = false): void {
    this.current = project;
    this.folder = path;
    this.history = [];
    this.future = [];
    this.unsaved = dirty;
  }
  /** Mark the current project as having unsaved changes without an undo step. */
  markDirty(): void {
    this.unsaved = true;
  }
  /**
   * Take the result of a save. Saving moves the music and cover into the project folder and deletes replaced ones;
   * undo steps follow the saved copies, so an undo neither reloads the same music from its old place nor points at a
   * deleted file. `saved` is the project as written, `removed` the files the save deleted, and `before` the project
   * that was handed to the save.
   */
  saved(saved: Project, path: string | null, removed: readonly string[] = [], before: Project = this.current): void {
    const gone = new Set(removed);
    const follow = (project: Project): Project => {
      const audioPath =
        project.audio.path === before.audio.path || gone.has(project.audio.path)
          ? saved.audio.path
          : project.audio.path;
      const coverPath =
        project.coverPath === before.coverPath || gone.has(project.coverPath) ? saved.coverPath : project.coverPath;
      return audioPath === project.audio.path && coverPath === project.coverPath
        ? project
        : { ...project, audio: { ...project.audio, path: audioPath }, coverPath };
    };
    this.history = this.history.map(follow);
    this.future = this.future.map(follow);
    this.current = saved;
    this.folder = path;
    this.unsaved = false;
  }
}
