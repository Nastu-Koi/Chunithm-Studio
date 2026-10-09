import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createProject, createNote } from '../src/core/model.ts';
import { parseC2S } from '../src/core/c2s.ts';
import { tickToSeconds } from '../src/core/timing.ts';

await mkdir('out/screenshots', { recursive: true });
const project = createProject();
project.metadata.title = '七等分与分段 BPM'; project.metadata.difficulty = 'WORLD’S END';
project.chart.events = [
  { id: 'bpm1', type: 'BPM', tick: 0, value: 120 },
  { id: 'bpm2', type: 'BPM', tick: 384 / 7, value: 210 },
  { id: 'bpm3', type: 'BPM', tick: 384, value: 150 },
];
project.chart.notes = [
  createNote('TAP', 384 / 7, 1, 2),
  { ...createNote('AIR_CRUSH', 384, 6, 4), duration: 384, attributes: { interval: 384 / 7 } },
];
await writeFile('out/sevenths.chuni.json', JSON.stringify(project));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.CHUNI_UI_URL || 'http://127.0.0.1:5173/');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-action="open"]').click(); await (await chooser).setFiles('out/sevenths.chuni.json');
  await page.waitForFunction(() => document.querySelector('#project-title')?.textContent === '七等分与分段 BPM');
  await page.locator('#play-tab').click();
  for (const [tick, bpm] of [[10, 120], [100, 210], [400, 150]]) {
    await page.locator('#seek').fill(String(Number(tickToSeconds(project.chart, tick).toFixed(3))));
    await page.waitForFunction(value => document.querySelector('#position-label')?.textContent.endsWith(`BPM ${value.toFixed(1)}`), bpm);
  }
  await page.locator('[data-action="export"]').click();
  assert.match(await page.locator('.quantization-report').innerText(), /内部判定点数量会变化/);
  const downloads = []; page.on('download', value => downloads.push(value));
  await page.locator('#export-c2s').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('请先查看并接受'));
  assert.equal(downloads.length, 0, 'Fractional positions require explicit acceptance');
  await page.locator('.quantization-report details').evaluate(element => { element.open = true; });
  await page.screenshot({ path: 'out/screenshots/sevenths-export.png' });
  await page.locator('#accept-quantization').check();
  const exported = page.waitForEvent('download'); await page.locator('#export-c2s').click();
  const c2sDownload = await exported;
  assert.equal(c2sDownload.suggestedFilename(), '7000_05.c2s');
  const c2s = await readFile(await c2sDownload.path(), 'utf8');
  assert.match(c2s, /DIFFICULT\s+05/);
  assert.equal(parseC2S(c2s).notes[0].tick, 55);
  await page.locator('#modal-close').click();
  const saved = page.waitForEvent('download'); await page.locator('[data-action="save"]').click();
  const roundTrip = JSON.parse(await readFile(await (await saved).path(), 'utf8'));
  assert.equal(roundTrip.chart.notes[0].tick, 384 / 7, 'Native export must not quantize the editable project');
  assert.equal(roundTrip.chart.events[1].tick, 384 / 7);
  assert.equal(roundTrip.chart.notes[1].attributes.interval, 384 / 7);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['segmented BPM in playback', 'explicit quantization consent', 'AIR-CRUSH count warning', 'WE native difficulty', 'fractional project persistence'], screenshot: 'out/screenshots/sevenths-export.png' }, null, 2));
} finally { await browser.close(); }
