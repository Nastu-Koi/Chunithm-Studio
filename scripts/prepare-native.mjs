// Builds native/win-x64 from pinned upstream sources instead of keeping ~155 MB of
// Windows binaries in git. Run before `npm run package:win`; safe to re-run.
//
//   node scripts/prepare-native.mjs            # skips work whose inputs are unchanged
//   node scripts/prepare-native.mjs --force    # rebuilds everything
//
// Requirements: network access to GitHub, `git`, and the .NET SDK (`dotnet`).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const target = path.join(root, 'native', 'win-x64');
const cache = path.join(root, '.cache', 'native');
const stampFile = path.join(target, '.prepared.json');
const force = process.argv.includes('--force');

/** ffmpeg.exe: the unmodified gyan.dev 6.1.1 essentials build redistributed by ffmpeg-static (GPL v3). */
const FFMPEG = {
  release: 'b6.1.1',
  base: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1',
  sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
};
/** VGAudio source compiled into the audio helper, pinned to the commit documented in native/README.md (MIT). */
const VGAUDIO = {
  repository: 'https://github.com/Thealexbarney/VGAudio',
  commit: '9d8f6ea04c83cccccb3dd7851a631bbd53a8dbbe',
};
/** Self-contained runtime published with the helper; its license files are copied from the matching NuGet package. */
const DOTNET_RUNTIME = '9.0.20';

const sha256 = async file =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const exists = file =>
  access(file).then(
    () => true,
    () => false,
  );
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

async function download(url, file, attempts = 3) {
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
      return;
    } catch (error) {
      await rm(file, { force: true });
      if (attempt >= attempts) throw new Error(`下载失败：${url}（${error instanceof Error ? error.message : error}）`);
      console.warn(`下载失败，重试 ${attempt}/${attempts - 1}：${url}`);
    }
  }
}

async function prepareFfmpeg() {
  const exe = path.join(target, 'ffmpeg.exe');
  if (!force && (await exists(exe)) && (await sha256(exe)) === FFMPEG.sha256) {
    console.log('ffmpeg.exe 已存在且哈希匹配，跳过。');
    return;
  }
  const archive = path.join(cache, `ffmpeg-win32-x64-${FFMPEG.release}.gz`);
  if (force || !(await exists(archive))) {
    console.log(`下载 ${FFMPEG.base}/ffmpeg-win32-x64.gz …`);
    await download(`${FFMPEG.base}/ffmpeg-win32-x64.gz`, archive);
  }
  for (const name of ['README', 'LICENSE']) {
    const cached = path.join(cache, `win32-x64-${FFMPEG.release}.${name}`);
    if (force || !(await exists(cached))) await download(`${FFMPEG.base}/win32-x64.${name}`, cached);
  }
  await mkdir(target, { recursive: true });
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(archive), createGunzip(), createWriteStream(exe));
  const actual = await sha256(exe);
  if (actual !== FFMPEG.sha256) {
    await rm(exe, { force: true });
    throw new Error(`ffmpeg.exe 哈希不匹配：${actual}，预期 ${FFMPEG.sha256}。上游文件可能已变化，请核对后更新脚本。`);
  }
  await copyFile(path.join(cache, `win32-x64-${FFMPEG.release}.README`), path.join(target, 'FFmpeg.README'));
  await copyFile(path.join(cache, `win32-x64-${FFMPEG.release}.LICENSE`), path.join(target, 'FFmpeg.LICENSE'));
  console.log('ffmpeg.exe 就绪。');
}

async function prepareVgAudio() {
  const source = path.join(root, 'native', 'VGAudio');
  if (!(await exists(path.join(source, '.git')))) {
    console.log(`克隆 ${VGAUDIO.repository} …`);
    run('git', ['clone', '--quiet', '--no-checkout', VGAUDIO.repository, source]);
  }
  let head = '';
  try {
    head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    head = '';
  }
  if (head !== VGAUDIO.commit) run('git', ['-C', source, 'fetch', '--quiet', 'origin', VGAUDIO.commit]);
  // Always materialise the tree: a --no-checkout clone whose HEAD already equals the pinned commit has no files yet.
  run('git', ['-C', source, 'checkout', '--quiet', '--detach', VGAUDIO.commit]);
  if (!(await exists(path.join(source, 'src', 'VGAudio', 'Codecs', 'CriHca', 'CriHcaKey.cs'))))
    throw new Error(`VGAudio 源码未就绪：${source}`);
  return source;
}

async function helperInputs(source) {
  const hash = createHash('sha256');
  for (const file of ['native/AudioHelper.csproj', 'native/Program.cs'])
    hash.update(await readFile(path.join(root, file)));
  return {
    vgaudio: VGAUDIO.commit,
    dotnetRuntime: DOTNET_RUNTIME,
    helperSources: hash.digest('hex'),
    vgaudioPath: source,
  };
}

async function prepareHelper(source) {
  const inputs = await helperInputs(source);
  const stamp = (await exists(stampFile)) ? JSON.parse(await readFile(stampFile, 'utf8')) : null;
  const unchanged =
    stamp &&
    stamp.vgaudio === inputs.vgaudio &&
    stamp.dotnetRuntime === inputs.dotnetRuntime &&
    stamp.helperSources === inputs.helperSources;
  if (!force && unchanged && (await exists(path.join(target, 'ChunithmAudio.exe')))) {
    console.log('ChunithmAudio.exe 的输入未变化，跳过发布。');
    return;
  }
  // Publish into a clean directory, then keep only the helper output beside ffmpeg.
  const staging = path.join(cache, 'publish-win-x64');
  await rm(staging, { recursive: true, force: true });
  console.log('dotnet publish win-x64 自包含程序 …');
  run('dotnet', [
    'publish',
    path.join(root, 'native', 'AudioHelper.csproj'),
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-o',
    staging,
    `-p:RuntimeFrameworkVersion=${DOTNET_RUNTIME}`,
    '-nologo',
    '-v',
    'quiet',
  ]);
  for (const name of await readdir(target).catch(() => []))
    if (!/^(ffmpeg\.exe|FFmpeg\.(README|LICENSE))$/.test(name))
      await rm(path.join(target, name), { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const name of await readdir(staging)) await copyFile(path.join(staging, name), path.join(target, name));
  const nuget = process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
  const runtimePackage = path.join(nuget, 'microsoft.netcore.app.runtime.win-x64', DOTNET_RUNTIME);
  await copyFile(path.join(runtimePackage, 'LICENSE.TXT'), path.join(target, 'DotNet.LICENSE'));
  await copyFile(path.join(runtimePackage, 'THIRD-PARTY-NOTICES.TXT'), path.join(target, 'DotNet.THIRD-PARTY-NOTICES'));
  await copyFile(path.join(source, 'LICENSE'), path.join(target, 'VGAudio.LICENSE'));
  await writeFile(
    stampFile,
    JSON.stringify(
      { ...inputs, vgaudioPath: undefined, ffmpegRelease: FFMPEG.release, preparedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  console.log('ChunithmAudio.exe 就绪。');
}

await mkdir(cache, { recursive: true });
await prepareFfmpeg();
await prepareHelper(await prepareVgAudio());
for (const file of [
  'ChunithmAudio.exe',
  'ffmpeg.exe',
  'VGAudio.LICENSE',
  'FFmpeg.LICENSE',
  'FFmpeg.README',
  'DotNet.LICENSE',
  'DotNet.THIRD-PARTY-NOTICES',
]) {
  if (!(await exists(path.join(target, file)))) throw new Error(`缺少 ${file}`);
}
console.log(`native/win-x64 已准备好：${(await readdir(target)).length} 个文件。`);
