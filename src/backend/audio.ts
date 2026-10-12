import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { extractMusicHca, type CueAudioInfo } from './cri';

let runtime: { nativeDirectory?: string; ffmpegPath?: string } = {};
export function configureAudioRuntime(options: typeof runtime): void { runtime = { ...runtime, ...options }; }
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function run(executable: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 32_000) stderr = stderr.slice(-32_000); });
    child.once('error', error => reject(new Error(`无法启动本地音频工具：${error.message}`)));
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`音频处理失败（${code}）：${stderr.trim().slice(-1500)}`)));
  });
}
async function helper(mode: 'encode' | 'decode' | 'decode-adx', input: string, output: string): Promise<CueAudioInfo> {
  const native = runtime.nativeDirectory ?? path.resolve(process.cwd(), 'native');
  const exe = process.platform === 'win32' ? 'ChunithmAudio.exe' : 'ChunithmAudio';
  const published = path.join(native, process.platform === 'win32' ? 'win-x64' : 'linux-x64', exe);
  let text: string;
  if (await exists(published)) text = await run(published, [mode, input, output]);
  else {
    const dll = path.join(native, 'bin', 'Release', 'net9.0', 'ChunithmAudio.dll');
    if (!await exists(dll)) throw new Error('音频引擎尚未构建。请先运行 dotnet build native/AudioHelper.csproj -c Release。');
    text = await run('dotnet', [dll, mode, input, output]);
  }
  const info = JSON.parse(text.trim().split(/\r?\n/).at(-1) ?? '{}') as CueAudioInfo;
  if (!(info.sampleCount > 0) || !(info.sampleRate > 0) || !(info.channels > 0)) throw new Error('音频引擎返回了无效的音频信息。');
  return info;
}

/** Sample rate of every normalized WAV; offsets are applied in whole samples at this rate. */
export const AUDIO_SAMPLE_RATE = 48000;
/** Normalize common input formats to a real, local PCM16 WAV. Positive offset adds silence, negative offset trims the start. */
export async function prepareAudio(inputPath: string, outputWavPath: string, offsetSeconds = 0): Promise<string> {
  if (path.resolve(inputPath) === path.resolve(outputWavPath)) throw new Error('转换目标不能覆盖输入音频。');
  if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 600) throw new Error('音频偏移超出支持范围。');
  const bundledFfmpeg = path.join(runtime.nativeDirectory ?? path.resolve(process.cwd(), 'native'), 'win-x64', 'ffmpeg.exe');
  const executable = runtime.ffmpegPath ?? (process.platform === 'win32' && await exists(bundledFfmpeg) ? bundledFfmpeg : ffmpegStatic);
  if (!executable || !await exists(executable)) throw new Error('缺少 FFmpeg 音频转换工具。');
  await mkdir(path.dirname(outputWavPath), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath, '-map', '0:a:0', '-vn'];
  // Resample first, then shift by a whole number of output samples, so the exported start matches the editor to 1/48000 s.
  const shift = Math.round(Math.abs(offsetSeconds) * AUDIO_SAMPLE_RATE);
  if (offsetSeconds > 0 && shift) args.push('-af', `aresample=${AUDIO_SAMPLE_RATE},adelay=${shift}S:all=1`);
  else if (offsetSeconds < 0 && shift) args.push('-af', `aresample=${AUDIO_SAMPLE_RATE},atrim=start_sample=${shift},asetpts=PTS-STARTPTS`);
  args.push('-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', outputWavPath);
  await run(executable, args);
  return outputWavPath;
}
export async function encodeHca(wavPath: string, hcaPath: string): Promise<CueAudioInfo> {
  if (path.resolve(wavPath) === path.resolve(hcaPath)) throw new Error('编码目标不能覆盖输入音频。');
  await mkdir(path.dirname(hcaPath), { recursive: true });
  return helper('encode', wavPath, hcaPath);
}
/** Decrypt ADX9 inside the licensed native engine before any PCM/resampling stage. */
export async function decodeAdx(adxPath: string, outputWavPath: string): Promise<CueAudioInfo> {
  if (path.resolve(adxPath) === path.resolve(outputWavPath)) throw new Error('解码目标不能覆盖输入音频。');
  await mkdir(path.dirname(outputWavPath), { recursive: true });
  return helper('decode-adx', adxPath, outputWavPath);
}
export async function decodeGameAudio(acbPath: string, awbPath: string, outputWavPath: string): Promise<string> {
  if ([acbPath, awbPath].some(p => path.resolve(p) === path.resolve(outputWavPath))) throw new Error('解码目标不能覆盖游戏音频。');
  const [acb, awb] = await Promise.all([readFile(acbPath), readFile(awbPath)]);
  const hca = extractMusicHca(acb, awb);
  await mkdir(path.dirname(outputWavPath), { recursive: true });
  const temporary = `${outputWavPath}.${process.pid}.${Date.now()}.hca`;
  try { await writeFile(temporary, hca, { flag: 'wx' }); await helper('decode', temporary, outputWavPath); return outputWavPath; }
  finally { await rm(temporary, { force: true }); }
}
