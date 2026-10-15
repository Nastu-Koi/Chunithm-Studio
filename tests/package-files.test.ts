import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain script module without type declarations
import { findLinks, isPackagedPath, removeEmptyDirectories } from '../scripts/package-files.mjs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('the Windows package holds only what the app loads at run time', () => {
  for (const kept of [
    '',
    '/package.json',
    '/dist',
    '/dist/index.html',
    '/dist-electron/main.cjs',
    '/node_modules',
    '/node_modules/sharp/package.json',
    '/assets/game/manifest.json',
    '/native',
    '/native/win-x64',
    '/native/win-x64/ffmpeg.exe',
  ])
    assert.equal(isPackagedPath(kept), true, kept);
  // Earlier builds live in release/; packaging them again nests every old version inside the new one.
  for (const left of [
    '/release',
    '/release/0.1.22/Chuni Studio-win32-x64/ChuniStudio.exe',
    '/.claude',
    '/.claude/issue/001/issue.md',
    '/.github',
    '/.git',
    '/CONTEXT.md',
    '/CLAUDE.md',
    '/README.md',
    '/tsconfig.json',
    '/vite.config.ts',
    '/index.html',
    // Command links of pruned development packages would dangle and break anything that copies or archives the package.
    '/node_modules/.bin',
    '/node_modules/.bin/asar',
    '/node_modules/sharp/node_gyp_bins/python3',
    '/node_modules/x/build/thing.obj',
    '/node_modules/.package-lock.json',
    '/node_modules/.vite/deps/x.js',
    '/src/core/model.ts',
    '/tests',
    '/docs',
    '/examples',
    '/scripts',
    '/out',
    '/native/Program.cs',
    '/native/VGAudio',
    '/native/bin',
    '/native/obj',
    '/distribution',
    '/package-lock.json',
  ])
    assert.equal(isPackagedPath(left), false, left);
});

test('package clean-up removes nested empty folders, keeps filled ones and finds links without external tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-package-'));
  try {
    await mkdir(path.join(root, 'pruned/lib/deep'), { recursive: true });
    await mkdir(path.join(root, 'kept/empty'), { recursive: true });
    await writeFile(path.join(root, 'kept/index.js'), '');
    await removeEmptyDirectories(root);
    assert.deepEqual(await readdir(root), ['kept']);
    assert.deepEqual(await readdir(path.join(root, 'kept')), ['index.js']);
    assert.deepEqual(await findLinks(root), []);
    await symlink(path.join(root, 'kept'), path.join(root, 'kept/loop'), 'junction');
    assert.deepEqual(await findLinks(root), [path.join(root, 'kept/loop')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
