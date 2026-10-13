import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain script module without type declarations
import { isPackagedPath } from '../scripts/package-files.mjs';

test('the Windows package holds only what the app loads at run time', () => {
  for (const kept of ['', '/package.json', '/dist', '/dist/index.html', '/dist-electron/main.cjs', '/node_modules', '/node_modules/sharp/package.json', '/assets/game/manifest.json', '/native', '/native/win-x64', '/native/win-x64/ffmpeg.exe'])
    assert.equal(isPackagedPath(kept), true, kept);
  // Earlier builds live in release/; packaging them again nests every old version inside the new one.
  for (const left of ['/release', '/release/0.1.22/Chuni Studio-win32-x64/ChuniStudio.exe', '/.claude', '/.claude/issue/001/issue.md', '/.github', '/.git', '/CONTEXT.md', '/CLAUDE.md', '/README.md', '/tsconfig.json', '/vite.config.ts', '/index.html',
    // Command links of pruned development packages would dangle and break anything that copies or archives the package.
    '/node_modules/.bin', '/node_modules/.bin/asar', '/node_modules/sharp/node_gyp_bins/python3', '/node_modules/x/build/thing.obj', '/node_modules/.package-lock.json', '/node_modules/.vite/deps/x.js',
    '/src/core/model.ts', '/tests', '/docs', '/examples', '/scripts', '/out', '/native/Program.cs', '/native/VGAudio', '/native/bin', '/native/obj', '/distribution', '/package-lock.json'])
    assert.equal(isPackagedPath(left), false, left);
});
