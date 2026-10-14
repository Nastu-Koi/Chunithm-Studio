import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from '../src/core/model';
import { ProjectStore } from '../src/renderer/project-store';

const titled = (base: Project, title: string): Project => ({ ...base, metadata: { ...base.metadata, title } });

test('commit, undo and redo walk the history; a new commit drops the redo steps', () => {
  const first = createProject(),
    store = new ProjectStore(first);
  assert.deepEqual([store.dirty, store.canUndo, store.canRedo], [false, false, false]);
  const second = titled(first, 'B'),
    third = titled(first, 'C');
  store.commit(second);
  store.commit(third);
  assert.equal(store.project, third);
  assert.equal(store.dirty, true);
  assert.equal(store.undo(), true);
  assert.equal(store.project, second);
  assert.equal(store.canRedo, true);
  assert.equal(store.redo(), true);
  assert.equal(store.project, third);
  assert.equal(store.redo(), false);
  store.undo();
  store.commit(titled(first, 'D'));
  assert.equal(store.canRedo, false);
  assert.equal(store.undo(), true);
  assert.equal(store.project, second);
});

test('the history keeps only the newest steps up to its limit', () => {
  const first = createProject(),
    store = new ProjectStore(first, 3);
  for (const title of ['1', '2', '3', '4', '5']) store.commit(titled(first, title));
  let steps = 0;
  while (store.undo()) steps++;
  assert.equal(steps, 3);
  assert.equal(store.project.metadata.title, '2');
});

test('loading a project starts a clean history; a recovered autosave loads as unsaved', () => {
  const store = new ProjectStore();
  store.commit(titled(store.project, 'edited'));
  const opened = createProject();
  store.load(opened, '/projects/song');
  assert.deepEqual([store.project, store.path, store.dirty, store.canUndo], [opened, '/projects/song', false, false]);
  store.load(opened, null, true);
  assert.equal(store.dirty, true);
});

test('after a save, undo steps follow the copied music and cover instead of the old or deleted files', () => {
  const start = createProject();
  start.audio.path = '/outside/song.wav';
  start.coverPath = '/outside/old.png';
  const store = new ProjectStore(start);
  const replaced = { ...start, coverPath: '/outside/new.png' };
  store.commit(replaced);
  const saved = {
    ...replaced,
    audio: { ...replaced.audio, path: '/projects/song/audio.wav' },
    coverPath: '/projects/song/cover.png',
  };
  store.saved(saved, '/projects/song', ['/outside/old.png']);
  assert.deepEqual([store.project, store.path, store.dirty], [saved, '/projects/song', false]);
  store.undo();
  // The music moved into the folder; the old cover was deleted by the save, so the step uses the saved cover.
  assert.equal(store.project.audio.path, '/projects/song/audio.wav');
  assert.equal(store.project.coverPath, '/projects/song/cover.png');
});
