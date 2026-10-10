import packager from '@electron/packager';
import { access, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electronChecksums = JSON.parse(await readFile(path.join(root, 'node_modules/electron/checksums.json'), 'utf8'));
const sharpPackage = JSON.parse(await readFile(path.join(root, 'node_modules/sharp/package.json'), 'utf8'));
const sharpVersion = sharpPackage.optionalDependencies['@img/sharp-win32-x64'];
const sharpArchive = path.join(root, 'out', `img-sharp-win32-x64-${sharpVersion}.tgz`);
await access(sharpArchive).catch(() => { throw new Error(`缺少 Windows sharp ${sharpVersion}。先运行 npm pack @img/sharp-win32-x64@${sharpVersion} --pack-destination out。`); });
for (const file of ['ChunithmAudio.exe', 'ffmpeg.exe', 'VGAudio.LICENSE', 'FFmpeg.LICENSE', 'DotNet.LICENSE']) await access(path.join(root, 'native/win-x64', file));
const resourceHashes = JSON.parse(await readFile(path.join(root, 'assets/game/sha256.json'), 'utf8'));
for (const file of Object.keys(resourceHashes)) await access(path.join(root, 'assets/game', file));

const paths = await packager({
  // Each version packages into its own directory so builds never overwrite each other.
  dir: root, out: path.join(root, 'release', version), name: 'Chuni Studio', platform: 'win32', arch: 'x64',
  download: { checksums: electronChecksums },
  overwrite: true, asar: false, prune: true,
  ignore: [/^\/tests/, /^\/docs/, /^\/examples(\/|$)/, /^\/src/, /^\/scripts/, /^\/\.cache/, /^\/out/, /^\/test-results/, /^\/native\/(VGAudio|bin|obj)(\/|$)/],
  executableName: 'ChuniStudio',
});
for (const packagePath of paths) {
  const modules = path.join(packagePath, 'resources/app/node_modules');
  const windowsSharp = path.join(modules, '@img/sharp-win32-x64');
  await mkdir(windowsSharp, { recursive: true });
  execFileSync('tar', ['-xzf', sharpArchive, '--strip-components=1', '-C', windowsSharp], { stdio: 'inherit' });
  const actual = JSON.parse(await readFile(path.join(windowsSharp, 'package.json'), 'utf8'));
  if (actual.version !== sharpVersion) throw new Error(`Windows sharp 版本不匹配：${actual.version} / ${sharpVersion}`);
  // Cross-packaging from Linux must never leave Linux native modules as the only runtime option.
  for (const name of await readdir(path.join(modules, '@img'))) if (/^(sharp|sharp-libvips)-(linux|linuxmusl|darwin)-/.test(name)) await rm(path.join(modules, '@img', name), { recursive: true, force: true });
  await rm(path.join(modules, 'ffmpeg-static/ffmpeg'), { force: true });
  await access(path.join(windowsSharp, 'lib/sharp-win32-x64.node'));
  await access(path.join(packagePath, 'resources/app/native/win-x64/ChunithmAudio.exe'));
  await access(path.join(packagePath, 'resources/app/assets/game/manifest.json'));
  await cp(path.join(root, 'README.md'), path.join(packagePath, 'README.md'));
  await mkdir(path.join(packagePath, 'docs'), { recursive: true });
  for (const document of ['verification.md', 'node-semantics.md', 'margrete-reference.md', 'game-scene-reference.md', 'game-scene-assets.md', 'game-camera-candidate.md', 'native-judgement.md', 'native-judgement-reader.md', 'native-judgement-residuals.md', 'game-animation.md', 'game-camera-decoding.md', 'slide-judgement-research.md', 'judgement-edge-research.md', 'native-note-assets.md', 'native-effects.md', 'native-effect-placement.md', 'performance.md']) await cp(path.join(root, 'docs', document), path.join(packagePath, 'docs', document));
  await cp(path.join(root, 'docs/references'), path.join(packagePath, 'docs/references'), { recursive: true });
  // Only original, movable project examples belong in the portable app. The locally
  // generated OPT uses installation-specific metadata and is delivered separately.
  await mkdir(path.join(packagePath, 'examples'), { recursive: true });
  for (const name of ['calibration.chuni.json', 'calibration.assets', 'sevenths.chuni.json', 'sevenths.assets', '校准说明.txt']) {
    await cp(path.join(root, 'examples', name), path.join(packagePath, 'examples', name), { recursive: true });
  }
  console.log(`Windows runtime ready: ${packagePath}`);
}
