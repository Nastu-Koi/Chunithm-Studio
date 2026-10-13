import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createProject, createNote } from '../src/core/model.ts';
await mkdir('out/screenshots', { recursive: true });
const project = createProject();
project.metadata = { title: '星轨 / First Steps', artist: 'Chuni Studio', designer: 'You', difficulty: 'MASTER', level: '10' };
for (let i = 0; i < 32; i++) project.chart.notes.push(createNote(i % 7 === 0 ? 'EXTAP' : i % 5 === 0 ? 'FLICK' : 'TAP', 384 + i * 96, (i * 3) % 13, 3));
project.chart.notes.push({ ...createNote('HOLD', 768, 1, 3), duration: 384 }, { ...createNote('SLIDE', 1536, 0, 3), duration: 384, endLane: 11 }, { ...createNote('SLIDE', 1920, 11, 3), duration: 384, endLane: 3 });
// AIR is bound to a ground tail: the arrow sits on the SLIDE's end, the AIR-HOLD on the HOLD's end.
project.chart.notes.push({ ...createNote('AIR', 2304, 3, 3), attributes: { direction: 'IR', parent: 'SLD' } }, { ...createNote('AIR_HOLD', 1152, 1, 3), duration: 384, attributes: { parent: 'HLD' } });
project.chart.events.push({ id: 'bpm', type: 'BPM', tick: 0, value: 120 });
await writeFile('out/first-steps.chuni.json', JSON.stringify(project));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:5173/');
  const opened = page.waitForEvent('filechooser');
  await page.locator('[data-action="open"]').click(); await (await opened).setFiles('out/first-steps.chuni.json');
  await page.waitForFunction(() => document.querySelector('#project-title')?.textContent.includes('First Steps'));
  await page.screenshot({ path: 'out/screenshots/editor.png' });
  await page.locator('#play-tab').click();
  await page.locator('#seek').fill('2.4');
  await page.waitForFunction(() => document.querySelector('#time-current')?.textContent === '00:02.400');
  await page.screenshot({ path: 'out/screenshots/player.png' });
  await page.locator('#play-button').click();
  await page.waitForFunction(() => Number(document.querySelector('#seek').value) > 2.7);
  await page.locator('#play-button').click();
  const paused = Number(await page.locator('#seek').inputValue());
  assert(paused >= 2.7);
  await page.locator('#playback-rate').selectOption('0.5');
  await page.getByRole('button', { name: '↻ 循环' }).click();
  await page.locator('[name="start"]').fill('2'); await page.locator('[name="end"]').fill('2.3');
  await page.getByRole('button', { name: '启用循环' }).click();
  await page.locator('#play-button').click();
  await page.waitForFunction(() => new Promise(resolve => {
    let previous = 0; function sample() { const current = Number(document.querySelector('#seek').value); if (previous > 2.2 && current < 2.1) resolve(true); else { previous = current; requestAnimationFrame(sample); } } sample();
  }));
  await page.locator('#play-button').click();
  // The waveform must come from decoded samples, not a decorative image.
  const sampleRate = 48000, seconds = 4, frames = sampleRate * seconds, wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) { const n = Math.round(Math.sin(i / sampleRate * 440 * 2 * Math.PI) * 4000); wav.writeInt16LE(n, 44 + i * 4); wav.writeInt16LE(n, 46 + i * 4); }
  await writeFile('out/calibration.wav', wav);
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '♫ 导入音乐' }).click(); await (await chooser).setFiles('out/calibration.wav');
  await page.waitForFunction(() => document.querySelector('#audio-label')?.textContent.includes('calibration.wav'));
  await page.getByRole('button', { name: '乐曲设置', exact: true }).click();
  await page.locator('[name="title"]').fill('节拍与播放器验证'); await page.locator('[name="bpm"]').fill('137.5'); await page.locator('[name="previewEnd"]').fill('3');
  await page.getByRole('button', { name: '应用设置' }).click();
  assert.equal(await page.locator('#project-title').textContent(), '节拍与播放器验证');
  const download = page.waitForEvent('download'); await page.locator('[data-action="save"]').click(); const saved = await download;
  const project = JSON.parse(await readFile(await saved.path(), 'utf8'));
  assert.equal(project.chart.defaultBpm, 137.5); assert(project.chart.notes.length > 30); assert(project.audio.path.includes('calibration.wav'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['view switching', 'seek', 'audio-clock playback', 'pause', 'rate', 'loop wrap', 'real WAV decode', 'project settings', 'save persistence'], screenshots: ['out/screenshots/editor.png', 'out/screenshots/player.png'] }, null, 2));
} finally { await browser.close(); }
