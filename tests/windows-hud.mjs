// Renders the play HUD from the current source inside the packaged runtime and checks the copied native casts.
// Build out/native-notes-entry.ts into out/native-notes.bundle.js as an IIFE named NativeNotes with the host esbuild first.
import { _electron as electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadBundledGameResources } from '../src/backend/bundled-assets.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), runtime = process.argv[2];
const output = path.join(root, 'out/screenshots'); await mkdir(output, { recursive: true });
const data = await mkdtemp(path.join(tmpdir(), 'chuni-hud-'));
const env = { ...process.env, CHUNI_USER_DATA_DIR: data, CHUNI_DEV_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
const resources = await loadBundledGameResources(path.join(root, 'assets/game'));
const cover = `data:image/png;base64,${(await readFile(path.join(root, 'examples/calibration.assets/cover.png'))).toString('base64')}`;
const app = await electron.launch({ executablePath: path.join(runtime, 'ChuniStudio.exe'), cwd: runtime, env, args: [`--user-data-dir=${data}`] });
const errors = [];
try {
  const page = await app.firstWindow(); await page.goto('about:blank');
  page.on('pageerror', e => errors.push(e.message));
  await page.addScriptTag({ path: path.join(root, 'out/native-notes.bundle.js') });
  await page.evaluate(async serialized => {
    document.body.style.cssText = 'margin:0;background:#111';
    window.assets = JSON.parse(serialized); window.players = {};
    for (const kind of ['native', 'fallback']) {
      const host = document.createElement('div'); host.style.cssText = 'width:1920px;height:1080px'; document.body.append(host);
      const player = window.players[kind] = new NativeNotes.ChartPlayer(host);
      // Record which copied images the 2D HUD pass actually draws.
      const c = player.canvas.getContext('2d'), draw = c.drawImage.bind(c); player.drawn = new Set();
      c.drawImage = (image, ...rest) => { if (image.src) player.drawn.add(image.src); draw(image, ...rest); };
    }
    window.loaded = await window.players.native.setGameTextures(window.assets);
  }, JSON.stringify(resources.textures));
  const scenes = [
    { name: 'master', kind: 'native', difficulty: 'MASTER', level: '15.2', title: 'Kaleidoscope', artist: 'Lycoris in the parterre', seconds: 6.2, speed: 6, cover: true },
    { name: 'basic-start', kind: 'native', difficulty: 'BASIC', level: '2', title: 'テリトリーバトル', artist: 'ショコ', seconds: 0, speed: 4, cover: true },
    { name: 'expert-end', kind: 'native', difficulty: 'EXPERT', level: '12.7', title: 'A title long enough to leave the original 340 px text box', artist: 'Artist', seconds: 60, speed: 9.5, cover: false },
    { name: 'worlds-end', kind: 'native', difficulty: 'WORLD’S END', level: '0', title: 'WORLD’S END', artist: 'Chuni Studio', seconds: 4, speed: 6, cover: true },
    { name: 'ultima', kind: 'native', difficulty: 'ULTIMA', level: '14.9', title: 'ULTIMA', artist: 'Chuni Studio', seconds: 9, speed: 12, cover: true },
    { name: 'fallback', kind: 'fallback', difficulty: 'MASTER', level: '13', title: 'Fallback', artist: 'No copied assets', seconds: 6.2, speed: 6, cover: false },
  ];
  const report = {};
  for (const scene of scenes) {
    const result = await page.evaluate(async ([scene, cover]) => {
      const player = window.players[scene.kind], chart = NativeNotes.createChart();
      for (let i = 0; i < 96; i++) chart.notes.push(NativeNotes.createNote(i % 7 === 0 ? 'EXTAP' : i % 5 === 0 ? 'FLICK' : 'TAP', 384 + i * 96, (i * 3) % 13, 4));
      const hold = NativeNotes.createNote('HOLD', 2400, 1, 4), slide = NativeNotes.createNote('SLIDE', 2400, 10, 4);
      hold.duration = 768; slide.duration = 768; slide.endLane = 6; chart.notes.push(hold, slide);
      player.setChart(chart); Object.assign(player, { title: scene.title, artist: scene.artist, difficulty: scene.difficulty, level: scene.level, speed: scene.speed, stars: 4, weTag: '狂' });
      await player.setCover(scene.cover ? cover : ''); player.drawn.clear(); player.render(scene.seconds);
      const canvas = player.canvas, ratio = canvas.width / 1920, c = canvas.getContext('2d');
      const pixel = (x, y) => [...c.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data];
      const hud = Object.fromEntries(Object.entries(window.assets.scene.hud).map(([key, sprite]) => [key, player.drawn.has(sprite.image.dataUrl)]));
      return { png: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, combo: Number(canvas.dataset.combo), score: Number(canvas.dataset.score), hud,
        frame: pixel(960, 38.5), gaugeStart: pixel(700, 98), gaugeEnd: pixel(1200, 98), plate: pixel(300, 20), strip: pixel(590, 30) };
    }, [scene, cover]);
    await writeFile(path.join(output, `hud-${scene.name}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
    assert.equal(result.width / result.height, 16 / 9);
    if (scene.kind === 'native') {
      // One key per copied image: frame, plate, rating atlas, trophy atlas, common atlas and the play atlas.
      for (const key of ['frame', 'namePlate', 'nameBase', 'trophyBase', 'levelLabel', 'judgeHeader']) assert.ok(result.hud[key], `${scene.name}: ${key} must be drawn from its copied image`);
      // Frame 1 is opaque yellow above its gauge window; the plate and judgement strip keep their original colours.
      assert.ok(result.frame[0] > 240 && result.frame[1] > 180 && result.frame[2] < 80, `${scene.name}: frame colour ${result.frame}`);
      assert.ok(result.plate.slice(0, 3).every(value => value > 200), `${scene.name}: name plate colour ${result.plate}`);
      assert.ok(result.strip.slice(0, 3).every(value => value < 40), `${scene.name}: judgement strip colour ${result.strip}`);
    }
    // The gauge follows judged / total: empty before the first judgement, full after the last one.
    const lit = colour => colour[2] > 120;
    if (scene.name === 'basic-start') { assert.equal(result.combo, 0); assert.ok(!lit(result.gaugeStart)); }
    if (scene.name === 'expert-end') { assert.equal(result.score, 1010000); assert.ok(lit(result.gaugeStart) && lit(result.gaugeEnd)); }
    if (scene.name === 'master') { assert.ok(result.combo > 0); assert.ok(lit(result.gaugeStart) && !lit(result.gaugeEnd)); }
    report[scene.name] = { ...result, png: undefined, hud: Object.values(result.hud).filter(Boolean).length };
  }
  assert.deepEqual(await page.evaluate(() => window.loaded.failed), []); assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); await rm(data, { recursive: true, force: true }).catch(() => {}); }
