import { _electron as electron } from 'playwright';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';

if (process.platform !== 'win32') throw new Error('Run this integration test with the Windows Node executable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const release = option('runtime') ?? path.join(root, 'release', JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, 'Chuni Studio-win32-x64');
const packagedApp = path.join(release, 'resources', 'app');
const out = option('data') ?? path.join(root, 'out', 'windows-test');
const reports = path.join(root, 'out', 'windows-test');
const screenshots = path.join(root, 'out', 'screenshots');
await mkdir(out, { recursive: true }); await mkdir(reports, { recursive: true }); await mkdir(screenshots, { recursive: true });
// Test the latest reviewed compiled app in an already-packaged, matching Windows runtime.
const runtimePackage = JSON.parse(await readFile(path.join(packagedApp, 'package.json'), 'utf8'));
assert.equal(runtimePackage.name, 'chunithm-studio');
assert.equal(runtimePackage.version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
await rm(path.join(packagedApp, 'dist'), { recursive: true, force: true });
await rm(path.join(packagedApp, 'dist-electron'), { recursive: true, force: true });
await cp(path.join(root, 'dist'), path.join(packagedApp, 'dist'), { recursive: true });
await cp(path.join(root, 'dist-electron'), path.join(packagedApp, 'dist-electron'), { recursive: true });
const profile = path.join(out, 'profile'); await mkdir(profile, { recursive: true });
const errors = [], consoleMessages = [], evidence = { platform: process.platform, executable: path.join(release, 'ChuniStudio.exe'), screenshots: [] };
const env = { ...process.env, CHUNI_USER_DATA_DIR: profile, CHUNI_DEV_URL: '', ELECTRON_ENABLE_LOGGING: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  const args = [`--user-data-dir=${profile}`, '--no-first-run'];
  if (process.env.CHUNI_TEST_SOFTWARE_GPU === '1' || process.argv.includes('--software-gpu')) args.push('--disable-gpu', '--in-process-gpu');
  evidence.launchArgs = args;
  app = await electron.launch({ executablePath: evidence.executable, args, cwd: release, env, timeout: 60000 });
  app.process().stderr?.on('data', data => consoleMessages.push(data.toString().slice(-2000)));
  app.process().on('exit', (code, signal) => { evidence.processExit = { code, signal }; });
  const page = await app.firstWindow();
  page.on('crash', () => errors.push('Renderer process crashed'));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.waitForFunction(()=>document.querySelector('.editor-viewport canvas')?.dataset.noteSprites==='margrete-1.8.0');
  await page.evaluate(()=>{
    window.__margreteDraws=0;
    const original=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(image,...args){if(image.naturalWidth===32&&image.naturalHeight===64)window.__margreteDraws++;return original.call(this,image,...args)};
  });
  const sceneCanvas = page.locator('.player-canvas');
  const readScene = () => sceneCanvas.evaluate(canvas => {
    const box = canvas.getBoundingClientRect(), data = canvas.dataset;
    return { scene: data.scene, scoreMode: data.scoreMode, judgementTotal: Number(data.judgementTotal), judgementCounts: JSON.parse(data.judgementCounts), judgementMatched: data.judgementMatched, stageAnimation: data.stageAnimation, stageClip: Number(data.stageClip), stageFrame: Number(data.stageFrame), stagePose: data.stagePose, stageCycle: Number(data.stageCycle), stageWorld: data.stageWorld, stageCamera: data.stageCamera, score: Number(data.score), combo: Number(data.combo),
      title: data.title, difficulty: data.difficulty, cover: data.cover, frame: Number(data.frame),
      viewport: JSON.parse(data.viewport), canvas: { width: box.width, height: box.height } };
  });
  const checkScene = async expected => {
    await page.waitForFunction(expected => {
      const canvas = document.querySelector('.player-canvas'), data = canvas?.dataset;
      return data?.scene === 'black' && ['native', 'estimated', 'unsupported'].includes(data.scoreMode) && Number(data.frame) > 0 && data.viewport
        && Object.entries(expected).every(([key, value]) => data[key] === value);
    }, expected, { timeout: 30000 });
    const state = await readScene(), { viewport: v, canvas: box } = state;
    assert.ok(v.width > 0 && v.height > 0 && v.scale > 0, 'A rendered scene needs a positive viewport.');
    assert.ok(Math.abs(v.width / v.height - 16 / 9) < 1e-6, 'The scene must retain its 16:9 aspect ratio.');
    assert.ok(v.x >= -.5 && v.y >= -.5 && v.x + v.width <= box.width + .5 && v.y + v.height <= box.height + .5, 'Keep the complete game frame inside the canvas.');
    assert.ok(Math.abs(2 * v.x + v.width - box.width) < 1 && Math.abs(2 * v.y + v.height - box.height) < 1, 'Center the scene within its letterboxing.');
    assert.ok(Math.abs(v.width - 1920 * v.scale) < 1 && Math.abs(v.height - 1080 * v.scale) < 1, 'Scale both axes from the same 1920×1080 reference.');
    assert.ok(Number.isSafeInteger(state.score) && state.score >= 0 && state.score <= 1010000);
    assert.ok(Number.isSafeInteger(state.combo) && state.combo >= 0);
    return state;
  };
  const captureScene = async name => {
    // Inspect real rendered pixels as well as the renderer's layout diagnostics.
    const image = await sceneCanvas.screenshot(), sharp = createRequire(path.join(packagedApp, 'package.json'))('sharp');
    const pixels = await sharp(image).resize(96, 54).removeAlpha().raw().toBuffer();
    const colors = new Set(); let bright = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      colors.add(`${pixels[i] >> 4}:${pixels[i + 1] >> 4}:${pixels[i + 2] >> 4}`);
      if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 80) bright++;
    }
    assert.ok(colors.size > 24 && bright > 96, 'The game frame must contain visible scene/HUD pixels, not an empty canvas.');
    const filename = path.join(screenshots, name); await page.screenshot({ path: filename }); evidence.screenshots.push(filename);
    return { path: filename, sampledColors: colors.size, visiblePixels: bright };
  };
  await page.waitForSelector('#project-title', { timeout: 30000 });
  evidence.runtime = await page.evaluate(() => ({ bridge: window.studio?.platform, url: location.href }));
  assert.equal(evidence.runtime.bridge, 'win32', 'The desktop must use its real preload bridge.');
  assert.ok(evidence.runtime.url.startsWith('file:'), 'Load the packaged renderer, not a Vite development server.');
  evidence.userData = await app.evaluate(({ app }) => app.getPath('userData'));
  evidence.versions = await app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node }));
  evidence.appVersion = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(evidence.appVersion, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  evidence.build = Object.fromEntries(await Promise.all(['dist-electron/main.cjs', 'dist/index.html', 'assets/game/manifest.json'].map(async file => [file, createHash('sha256').update(await readFile(path.join(packagedApp, file))).digest('hex')])));
  assert.equal(evidence.userData.toLowerCase(), profile.toLowerCase());
  const startShot = path.join(screenshots, 'windows-start.png'); await page.screenshot({ path: startShot }); evidence.screenshots.push(startShot);

  await page.waitForFunction(() => document.querySelector('#resource-status')?.dataset.loaded === 'true', { timeout: 30000 });
  evidence.copiedResources = await page.locator('#resource-status').evaluate(button => ({ textures: Number(button.dataset.textures), sounds: Number(button.dataset.sounds), label: button.textContent }));
  assert.ok(evidence.copiedResources.textures >= 64); assert.equal(evidence.copiedResources.sounds, 8);
  // Deny original-game reads during a fresh asset load and sample reads. The user
  // requested independent copies; never rename or alter the user's D: directory.
  await app.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('fs/promises'), nodePath = process.getBuiltinModule('path');
    globalThis.__assetReadGuardRoot = nodePath.join(app.getAppPath(), 'assets', 'game').toLowerCase() + nodePath.sep;
    globalThis.__assetReadGuard = { original: fs.readFile, reads: [], blocked: [] };
    fs.readFile = async (file, ...args) => {
      const value = String(file), guard = globalThis.__assetReadGuard; guard.reads.push(value);
      if (/^d:[\\/]chunithm([\\/]|$)/i.test(value)) { guard.blocked.push(value); throw new Error('Original game is inaccessible in this asset-copy test'); }
      return guard.original(file, ...args);
    };
  });
  try {
    const copied = await page.evaluate(async () => {
      const assets = await window.studio.loadGameResources(), paths = new Set();
      for (const model of Object.values(assets.textures.models)) for (const image of model.images) paths.add(image.sourcePath);
      for (const image of Object.values(assets.textures.textures)) paths.add(image.sourcePath);
      for (const images of Object.values(assets.textures.effects)) for (const image of images) paths.add(image.sourcePath);
      const scene = assets.textures.scene;
      if (!scene) throw new Error('Copied game scene resources are missing');
      for (const image of Object.values(scene.materials)) paths.add(image.sourcePath);
      for (const sprite of Object.values(scene.hud)) paths.add(sprite.image.sourcePath);
      let soundFiles = 0;
      for (const sound of Object.values(assets.sounds.sounds)) for (const layer of sound.layers) {
        soundFiles++; const bytes = await window.studio.readAudio(layer.path);
        if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') throw new Error('Copied sound is not WAV');
        paths.add(layer.path);
      }
      // Images arrive as chuni-asset:// URLs and are only read by the main process when the renderer decodes them.
      const urls = new Set([...Object.values(assets.textures.models).flatMap(model => model.images), ...Object.values(assets.textures.textures), ...Object.values(assets.textures.effects).flat(),
        ...Object.values(scene.materials), ...Object.values(scene.hud).map(sprite => sprite.image), ...(assets.textures.font?.pages ?? [])].map(image => image.dataUrl));
      let decodedImages = 0;
      for (const url of urls) {
        if (!url.startsWith('chuni-asset://game/')) throw new Error(`Unexpected image source ${url.slice(0, 40)}`);
        const image = new Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error(`Bundled image failed to load: ${url}`)); image.src = url; });
        if (!(image.naturalWidth > 0)) throw new Error(`Bundled image decoded empty: ${url}`); decodedImages++;
      }
      return { files: [...paths], decodedImages, soundFiles, scene: { stage: scene.stage, materials: Object.keys(scene.materials).length, hud: Object.keys(scene.hud).length, clips: scene.animation?.clips.length, bones: scene.animation?.rig.bones.length, vertexBones: scene.animation?.rig.vertexBones.length } };
    });
    evidence.copiedResources.files = copied.files; evidence.copiedResources.scene = copied.scene;
    assert.ok(copied.scene.materials > 0 && copied.scene.hud > 0, 'The copied bundle must contain both scene materials and HUD assets.');
    assert.equal(copied.scene.clips, 10); assert.equal(copied.scene.bones, 40); assert.equal(copied.scene.vertexBones, 4008);
    const copyRoot = path.join(packagedApp, 'assets/game').toLowerCase() + path.sep;
    for (const file of evidence.copiedResources.files) assert.ok(file.toLowerCase().startsWith(copyRoot), file);
    evidence.copiedResources.decodedImages = copied.decodedImages; assert.ok(copied.decodedImages >= 64, 'Bundled images must decode through the asset scheme.');
    evidence.copiedResources.readGuard = await app.evaluate(() => ({ count: globalThis.__assetReadGuard.reads.length, blocked: globalThis.__assetReadGuard.blocked, outside: globalThis.__assetReadGuard.reads.filter(file => !file.toLowerCase().startsWith(globalThis.__assetReadGuardRoot)) }));
    // Chromium caches immutable asset responses, so images decoded at start-up may not reach the handler again here.
    assert.ok(evidence.copiedResources.readGuard.count >= copied.soundFiles + 1, 'The read guard must observe the manifest and every copied sound.');
    assert.deepEqual(evidence.copiedResources.readGuard.outside, [], 'Every asset read during loading must come from the bundled copy.');
    assert.deepEqual(evidence.copiedResources.readGuard.blocked, []);
  } finally {
    await app.evaluate(() => { process.getBuiltinModule('fs/promises').readFile = globalThis.__assetReadGuard.original; delete globalThis.__assetReadGuard; delete globalThis.__assetReadGuardRoot; });
  }

  // Real IPC and Windows sharp exercise, using a game DDS only as read-only input.
  const dds = 'D:\\chunithm\\data\\A000\\music\\music2927\\CHU_UI_Jacket_2927.dds';
  // The main process only serves paths it handed out: an unsolicited read is refused, a picked file is allowed.
  await page.evaluate(async filename => { try { await window.studio.readCover(filename); } catch (error) { return String(error); } throw new Error('Unauthorized cover read was not refused'); }, dds);
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, dds);
  assert.equal(await page.evaluate(() => window.studio.pickCover()), dds);
  evidence.ddsPreview = await page.evaluate(async filename => { const result = await window.studio.readCover(filename); return { prefix: result.slice(0, 22), bytes: result.length }; }, dds);
  assert.ok(evidence.ddsPreview.prefix.startsWith('data:image/png;base64,'));

  await page.locator('[data-action="library"]').click();
  await page.locator('#game-path').fill('D:\\chunithm');
  await page.locator('#game-scan').click();
  await page.waitForSelector('.library-song', { timeout: 90000 });
  evidence.librarySummary = await page.locator('#library-results .modal-description').first().textContent();
  await page.locator('#library-search').fill('2892');
  const matching = page.locator('[data-library="2892:3"]');
  await matching.waitFor({ state: 'visible' });
  await matching.click();
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#audio-label').textContent.endsWith('.wav'), { timeout: 60000 });
  evidence.loadedSong = await page.locator('#project-title').textContent();
  evidence.audioLabel = await page.locator('#audio-label').textContent();
  await page.locator('#seek').evaluate(input => { input.value = '20'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const editorShot = path.join(screenshots, 'windows-editor.png'); await page.screenshot({ path: editorShot }); evidence.screenshots.push(editorShot);
  await page.locator('#play-tab').click();
  const originalScene = await checkScene({ title: evidence.loadedSong, difficulty: 'MASTER', cover: 'true' });
  await page.locator('#play-button').click();
  await page.waitForFunction(before => Number(document.querySelector('#seek').value) > 20.25 && Number(document.querySelector('.player-canvas')?.dataset.score) > before,
    originalScene.score, { timeout: 10000 });
  evidence.playbackTime = await page.locator('#time-current').textContent();
  await page.locator('#play-button').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  evidence.gameScene = { initial: originalScene, played: await checkScene({ title: evidence.loadedSong, difficulty: 'MASTER', cover: 'true' }) };
  assert.ok(evidence.gameScene.played.score > originalScene.score, 'Position-derived score must advance during actual playback.');
  assert.ok(evidence.gameScene.played.combo > originalScene.combo, 'Position-derived combo must advance during actual playback.');
  evidence.gameScene.screenshot = await captureScene('windows-player.png');
  const seekScene = async seconds => {
    await page.locator('#seek').evaluate((input, seconds) => { input.value = String(seconds); input.dispatchEvent(new Event('input', { bubbles: true })); }, seconds);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return readScene();
  };
  await page.locator('#judgement-status').click();
  evidence.judgements = { description: await page.locator('#modal-content').innerText(), rows: await page.locator('.judgement-table tbody tr').allTextContents() };
  assert.ok(evidence.judgements.description.includes('2055'), 'The real chart statistics must be shown to the user.');
  await page.locator('#modal-close').click();
  const backgroundAt = async seconds => {
    await seekScene(seconds);
    return sceneCanvas.evaluate(canvas => {
      const v=JSON.parse(canvas.dataset.viewport), x=Math.floor(v.x+100*v.scale), y=Math.floor(v.y+500*v.scale);
      return [...canvas.getContext('2d').getImageData(x,y,1,1).data];
    });
  };
  assert.deepEqual(await backgroundAt(0),[0,0,0,255]);
  assert.deepEqual(await backgroundAt(20),[0,0,0,255]);
  assert.equal((await readScene()).stageAnimation,'none');
  evidence.stageAnimation = { disabled: true, blackBackground: true };

  const originalWindow = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; return { bounds: window.getBounds(), maximized: window.isMaximized() };
  });
  try {
    const beforeResize = evidence.gameScene.played;
    evidence.gameScene.resizedWindow = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (window.isMaximized()) window.unmaximize();
      window.setSize(1180, 880); return window.getBounds();
    });
    await page.waitForFunction(before => {
      const canvas = document.querySelector('.player-canvas'), box = canvas.getBoundingClientRect();
      return Number(canvas.dataset.frame) > before.frame && (Math.abs(box.width - before.canvas.width) > 1 || Math.abs(box.height - before.canvas.height) > 1);
    }, beforeResize, { timeout: 10000 });
    evidence.gameScene.resized = await checkScene({ title: evidence.loadedSong, difficulty: 'MASTER', cover: 'true' });
    evidence.gameScene.resizedScreenshot = await captureScene('windows-player-resized.png');
  } finally {
    await app.evaluate(({ BrowserWindow }, original) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setBounds(original.bounds); if (original.maximized) window.maximize();
    }, originalWindow);
  }
  await page.waitForFunction(before => {
    const box = document.querySelector('.player-canvas').getBoundingClientRect();
    return Math.abs(box.width - before.canvas.width) < 1 && Math.abs(box.height - before.canvas.height) < 1;
  }, originalScene, { timeout: 10000 });
  evidence.gameScene.restored = await checkScene({ title: evidence.loadedSong, difficulty: 'MASTER', cover: 'true' });
  await page.locator('[data-action="xml"]').click();
  assert.equal(await page.locator('#xml-settings-form [name="sortName"]').inputValue(), 'KALEIDOSCOPE');
  assert.equal(await page.locator('#xml-settings-form [name="releaseTagName.id"]').inputValue(), '19');
  evidence.importedXml = { sortName: await page.locator('[name="sortName"]').inputValue(), releaseDate: await page.locator('[name="releaseDate"]').inputValue() };
  await page.locator('#modal-close').click();

  // Synthetic audio and cover make the export test independent of any copied game content.
  const wav = Buffer.alloc(44 + 96000 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(384000, 40);
  for (let i = 0; i < 96000; i++) { const sample = Math.round(12000 * Math.sin(i * Math.PI * 880 / 48000)); wav.writeInt16LE(sample, 44 + i * 4); wav.writeInt16LE(sample, 46 + i * 4); }
  const audioPath = path.join(out, 'synthetic.wav'), coverPath = path.join(out, 'synthetic.png'); await writeFile(audioPath, wav);
  const requireApp = createRequire(path.join(packagedApp, 'package.json')), sharp = requireApp('sharp');
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 65, g: 205, b: 186, alpha: 1 } } }).png().toFile(coverPath);
  evidence.sharp = sharp.versions;
  const exportDirectory = path.join(out, 'export'); await mkdir(exportDirectory, { recursive: true }); await rm(path.join(exportDirectory, 'AZ01'), { recursive: true, force: true });
  await rm(path.join(exportDirectory, 'AZ01-安装说明.txt'), { force: true });
  await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, exportDirectory);
  const project = {
    format: 'chunithm-studio', formatVersion: 1, id: 'windows-integration',
    metadata: { title: 'Windows Integration 自制曲', artist: 'Synthetic tone', designer: 'Local test', difficulty: 'WORLD’S END', level: '1' },
    audio: { path: audioPath, offset: 0, previewStart: 0.25, previewEnd: 1.25 }, coverPath,
    exportSettings: { optId: 'AZ01', musicId: 7000, cueId: 7000, weTag: '止', stars: 3 },
    chart: { version: '1.13.00', resolution: 384, defaultBpm: 120, notes: [{ id: 'tap', type: 'TAP', tick: 96, lane: 4, width: 4, attributes: {} }], events: [], headerRecords: [], unknownRecords: [] },
  };
  // A project is a folder holding project.chuni.json. Once any project is known, "open" lists recent projects first.
  const writeProjectFolder = async (name, data) => { const directory = path.join(out, name); await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'project.chuni.json'), JSON.stringify(data)); return directory; };
  const openProjectFolder = async directory => {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, directory);
    const recent = await page.evaluate(() => window.studio.listRecentProjects());
    await page.locator('[data-action="open"]').click();
    if (recent.length) await page.locator('#recent-browse').click();
  };
  // Save As asks for a parent folder and creates a folder named after the title inside it.
  const saveProjectAs = async name => {
    const parent = path.join(out, name); await rm(parent, { recursive: true, force: true }); await mkdir(parent, { recursive: true });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, parent);
    const title = await page.locator('#project-title').textContent();
    await page.keyboard.press('Control+Shift+s');
    await page.waitForFunction(() => document.querySelector('#dirty-indicator').textContent === '');
    return path.join(parent, title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim());
  };
  const xmlFixture = await writeProjectFolder('xml-input', project);
  await openProjectFolder(xmlFixture);
  await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'Windows Integration 自制曲');
  evidence.gameScene.synthetic = await checkScene({ title: project.metadata.title, difficulty: 'WORLD’S END', cover: 'true' });
  evidence.gameScene.syntheticScreenshot = await captureScene('windows-player-synthetic-cover.png');
  await page.locator('[data-action="xml"]').click();
  const xmlForm = page.locator('#xml-settings-form');
  await xmlForm.locator('[name="title"]').fill('Windows XML <&> 自制曲');
  await xmlForm.locator('[name="designer"]').fill('XML Designer');
  await xmlForm.locator('[name="sortName"]').fill('XML SORT TEST');
  await xmlForm.locator('[name="releaseDate"]').fill('20260231');
  await xmlForm.locator('button[type="submit"]').click();
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), true);
  assert.match(await page.locator('#toast').textContent(), /releaseDate/);
  await xmlForm.locator('[name="releaseDate"]').fill('20261009');
  await xmlForm.locator('[name="priority"]').fill('37');
  await xmlForm.locator('[name="isGiftMusic"]').check();
  await xmlForm.locator('[name="releaseTagName.id"]').fill('19');
  await xmlForm.locator('[name="releaseTagName.str"]').fill('v2 2.40.00');
  await xmlForm.locator('[name="netOpenName.id"]').fill('2900');
  await xmlForm.locator('[name="netOpenName.str"]').fill('v2_50 00_0');
  await xmlForm.locator('[name="cueId"]').fill('7001');
  assert.match(await page.locator('#xml-resource-preview').textContent(), /cueFile007001[\s\S]*music7001\.acb/);
  await page.locator('#modal').evaluate(dialog => { dialog.scrollTop = 0; });
  const xmlShot = path.join(screenshots, 'windows-xml-settings.png'); await page.screenshot({ path: xmlShot }); evidence.screenshots.push(xmlShot);
  await xmlForm.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#project-title').textContent === 'Windows XML <&> 自制曲');
  evidence.gameScene.renamed = await checkScene({ title: 'Windows XML <&> 自制曲', difficulty: 'WORLD’S END', cover: 'true' });
  const xmlSaved = await saveProjectAs('xml-edited');
  const saved = JSON.parse(await readFile(path.join(xmlSaved, 'project.chuni.json'), 'utf8'));
  assert.match(saved.audio.path, /^audio\.[a-z0-9]+$/); await access(path.join(xmlSaved, saved.audio.path)); await access(path.join(xmlSaved, saved.coverPath));
  assert.equal(saved.xmlMetadata.music.releaseDate, '20261009'); assert.equal(saved.xmlMetadata.music.priority, 37);
  assert.equal(saved.exportSettings.cueId, 7001);
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, xmlSaved);
  const editedProject = (await page.evaluate(async () => window.studio.openProject())).project;
  await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, exportDirectory);
  evidence.export = await page.evaluate(async data => window.studio.exportOpt(data, 'D:\\chunithm'), editedProject);
  assert.equal(evidence.export.structuralVerified, true);
  assert.ok(evidence.export.files.some(file => file.endsWith('/Event.xml')));
  for (const file of evidence.export.files) await access(path.join(evidence.export.optPath, file));
  const instructions = await readFile(path.join(exportDirectory, 'AZ01-安装说明.txt'), 'utf8');
  assert.ok(instructions.includes('D:\\chunithm\\bin\\option\\AZ01'));
  assert.ok(instructions.includes('结构校验通过不等于已经通过原游戏验证'));
  evidence.instructions = path.join(exportDirectory, 'AZ01-安装说明.txt');
  const metadata = await readFile(path.join(evidence.export.optPath, 'music/music7000/Music.xml'), 'utf8');
  assert.match(metadata, /<starDifType>5<\/starDifType>/, 'Three visible stars must encode as the native enum 5.');
  const xmlParser = new XMLParser({ parseTagValue: false });
  const musicXml = xmlParser.parse(metadata).MusicData;
  const cueXml = xmlParser.parse(await readFile(path.join(evidence.export.optPath, 'cueFile/cueFile007001/CueFile.xml'), 'utf8')).CueFileData;
  assert.equal(musicXml.name.str, 'Windows XML <&> 自制曲'); assert.equal(musicXml.sortName, 'XML SORT TEST');
  assert.equal(musicXml.releaseDate, '20261009'); assert.equal(musicXml.priority, '37'); assert.equal(musicXml.isGiftMusic, 'true');
  assert.equal(musicXml.releaseTagName.id, '19'); assert.equal(musicXml.netOpenName.id, '2900');
  assert.equal(musicXml.cueFileName.id, '7001'); assert.equal(cueXml.name.id, '7001'); assert.equal(cueXml.acbFile.path, 'music7001.acb');
  const activeFumen = musicXml.fumens.MusicFumenData.find(fumen => fumen.enable === 'true');
  assert.equal(activeFumen.notesDesigner, 'XML Designer'); assert.equal(Number(activeFumen.defaultBpm), 120);
  evidence.xmlEditing = { savedProject: xmlSaved, title: musicXml.name.str, sortName: musicXml.sortName, releaseDate: musicXml.releaseDate, priority: musicXml.priority, musicId: musicXml.name.id, cueId: cueXml.name.id, designer: activeFumen.notesDesigner };
  const c2s = await readFile(path.join(evidence.export.optPath, 'music/music7000/7000_05.c2s'), 'utf8');
  assert.match(c2s, /^DIFFICULT\t05\r?$/m, 'The current WORLD’S END difficulty must appear in the native chart header.');
  const calibration = path.join(release, 'examples', 'calibration');
  await openProjectFolder(calibration);
  await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'Chuni Studio Calibration' && document.querySelector('#audio-label').textContent === 'audio.wav');
  evidence.portableExample = { path: calibration, title: await page.locator('#project-title').textContent(), duration: await page.locator('#time-total').textContent() };
  await page.locator('#seek').evaluate(input => { input.value = '12.8'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#play-button').click();
  await page.waitForFunction(() => Number(document.querySelector('#seek').value) > 13.05);
  evidence.portableExample.playbackTime = await page.locator('#time-current').textContent();
  await page.locator('#play-button').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const calibrationShot = path.join(screenshots, 'windows-calibration.png'); await page.screenshot({ path: calibrationShot }); evidence.screenshots.push(calibrationShot);

  // A real chart with 4/4 -> 3/4 -> 7/8 and a BPM change checks measure numbers
  // against musical bar lengths, rather than treating every 384 ticks as a bar.
  const measureProject = JSON.parse(await readFile(calibration, 'utf8'));
  measureProject.metadata.title = 'Measure navigation 4/4 → 3/4 → 7/8';
  measureProject.audio.path = path.resolve(path.dirname(calibration), measureProject.audio.path);
  measureProject.coverPath = path.resolve(path.dirname(calibration), measureProject.coverPath);
  measureProject.chart = { version: '1.15.00', resolution: 384, defaultBpm: 120, headerRecords: [], unknownRecords: [], notes: [{ id: 'last', type: 'TAP', tick: 6000, lane: 4, width: 4, attributes: {} }], events: [
    { id: 'meter3', type: 'METER', tick: 768, value: .75, numerator: 3, denominator: 4 },
    { id: 'tempo', type: 'BPM', tick: 1056, value: 180 },
    { id: 'meter7', type: 'METER', tick: 1344, value: .875, numerator: 7, denominator: 8 },
  ] };
  await openProjectFolder(await writeProjectFolder('measure-test', measureProject));
  await page.waitForFunction(() => document.querySelector('#project-title').textContent.startsWith('Measure navigation') && document.querySelector('#audio-label').textContent === 'audio.wav');
  await page.locator('#edit-tab').click(); await page.locator('#measure-button').click();
  await page.locator('#start-measure').fill('5');
  assert.match(await page.locator('#measure-preview').textContent(), /00:06\.500/);
  const navigationShot = path.join(screenshots, 'windows-measure-navigation.png'); await page.screenshot({ path: navigationShot }); evidence.screenshots.push(navigationShot);
  await page.locator('#measure-locate').click();
  await page.waitForFunction(() => document.querySelector('#position-label').textContent.startsWith('第 005 小节'));
  assert.equal(await page.locator('#time-current').textContent(), '00:06.500');
  assert.equal(await page.locator('#play-button').getAttribute('data-playing'), 'false');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measureShot = path.join(screenshots, 'windows-measures-editor.png'); await page.screenshot({ path: measureShot }); evidence.screenshots.push(measureShot);
  await page.locator('#measure-button').click(); await page.locator('#start-measure').fill('200000'); await page.locator('#measure-play').click();
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), true);
  assert.match(await page.locator('#toast').textContent(), /超出/);
  await page.locator('#modal-close').click();
  await page.locator('#loop-button').click(); await page.locator('[name="start"]').fill('0'); await page.locator('[name="end"]').fill('1'); await page.locator('#loop-form button.primary').click();
  await page.locator('#playback-rate').selectOption('0.25');
  await page.locator('#measure-button').click(); await page.locator('#start-measure').fill('6'); await page.locator('#measure-play').click();
  await page.waitForFunction(() => !document.querySelector('#player-view').hidden && document.querySelector('#play-button').dataset.playing === 'true');
  assert.equal(await page.locator('#loop-button').evaluate(button => button.classList.contains('active')), false);
  const startSeconds = Number(await page.locator('#seek').inputValue()); assert.ok(startSeconds >= 7.666 && startSeconds < 8.1);
  evidence.measureNavigation = { fifthMeasureSeconds: 6.5, sixthMeasureStart: startSeconds, rates: [] };
  for (const rate of ['0.25', '0.5', '0.75', '1', '2']) {
    await page.locator('#playback-rate').selectOption(rate);
    const result = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const start = performance.now(), position = Number(document.querySelector('#seek').value);
      const sample = () => { const now = performance.now(); if (now - start < 450) { requestAnimationFrame(sample); return; }
        resolve({ measured: (Number(document.querySelector('#seek').value) - position) / ((now - start) / 1000), playing: document.querySelector('#play-button').dataset.playing === 'true' }); };
      requestAnimationFrame(sample);
    }))));
    assert.equal(result.playing, true); assert.ok(Math.abs(result.measured - Number(rate)) < .08, `${rate}x measured ${result.measured}`);
    evidence.measureNavigation.rates.push({ selected: Number(rate), ...result });
  }
  await page.locator('#play-button').click();
  // 150 BPM round-trips the eighth bar's tick just below its exact boundary.
  // The paused label and the next navigation default must still say bar eight.
  measureProject.metadata.title = 'Measure navigation boundary at 150 BPM';
  measureProject.chart.defaultBpm = 150; measureProject.chart.events = [];
  await openProjectFolder(await writeProjectFolder('measure-test', measureProject));
  await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'Measure navigation boundary at 150 BPM');
  await page.locator('#measure-button').click(); await page.locator('#start-measure').fill('8'); await page.locator('#measure-locate').click();
  await page.waitForFunction(() => document.querySelector('#position-label').textContent.startsWith('第 008 小节'));
  assert.equal(await page.locator('#time-current').textContent(), '00:11.200');
  await page.keyboard.press('Control+g');
  assert.equal(await page.locator('#start-measure').inputValue(), '8');
  evidence.measureNavigation.boundary150Bpm = { measure: 8, time: '00:11.200', reopenedDefault: 8 };
  await page.locator('#modal-close').click();

  // Node kinds belong to segment ends. Splitting must preserve the old end on
  // the second segment and apply the chosen control kind at the inserted point.
  const nodeProject = structuredClone(measureProject);
  nodeProject.metadata.title = 'Node endpoints SLD/SLC AHD/AHX ASD/ASC';
  nodeProject.chart.defaultBpm = 120; nodeProject.chart.events = [];
  nodeProject.chart.notes = [
    { id: 'slide', type: 'SLIDE', tick: 96, duration: 192, lane: 0, width: 2, endLane: 4, endWidth: 2, attributes: { visible: true, parent: 'SLD' } },
    { id: 'air-hold-base', type: 'TAP', tick: 96, lane: 6, width: 2, attributes: {} },
    { id: 'air-hold', type: 'AIR_HOLD', tick: 96, duration: 192, lane: 6, width: 2, endLane: 6, endWidth: 2, attributes: { visible: true, parent: 'TAP' } },
    { id: 'air-slide-base', type: 'TAP', tick: 96, lane: 10, width: 2, attributes: {} },
    { id: 'air-slide', type: 'AIR_SLIDE', tick: 96, duration: 192, lane: 10, width: 2, endLane: 12, endWidth: 2, height: 1, endHeight: 2, attributes: { visible: true, parent: 'TAP' } },
  ];
  await openProjectFolder(await writeProjectFolder('node-input', nodeProject));
  await page.waitForFunction(() => document.querySelector('#project-title').textContent.startsWith('Node endpoints'));
  await page.locator('#edit-tab').click(); await page.locator('[data-tool="select"]').click();
  await page.keyboard.press('Home');
  const canvas = page.locator('.editor-viewport canvas'), box = await canvas.boundingBox(); assert.ok(box);
  const trackLeft = Number(await canvas.getAttribute('data-track-left')), laneWidth = Number(await canvas.getAttribute('data-lane-width'));
  const zoom = Number(await page.locator('[data-option="zoom"]').inputValue());
  const point = (tick, lane) => ({ x: box.x + trackLeft + (lane + .5) * laneWidth, y: box.y + box.height - 30 - tick * zoom });
  for (const [type, lane, endLane] of [['SLIDE', 1.2, 4.5], ['AIR_HOLD', 6.4, 6.5], ['AIR_SLIDE', 10.7, 12.5]]) {
    // The node kind is edited on the picked node; the body picks the segment, which has none.
    const node = point(288, endLane); await page.mouse.click(node.x, node.y);
    await page.locator('[data-property="nodeKind"]').selectOption('control');
    assert.equal(await page.locator('[data-property="nodeKind"]').inputValue(), 'control');
    await page.locator('[data-property="nodeKind"]').selectOption('normal');
    const p = point(168, lane); await page.mouse.click(p.x, p.y);
    assert.equal(await page.locator('[data-property="type"]').inputValue(), type);
    assert.equal(await page.locator('[data-property="nodeKind"]').count(), 0);
    await page.locator('[data-option="node-kind"]').selectOption('control');
    await page.mouse.click(box.x + 15, point(192, 0).y);
    await page.locator('.editor-options [data-action="split"]').click();
  }
  // The separate Margrete-style AIR pane edits one shared connection height.
  const airLeft = Number(await canvas.getAttribute('data-air-height-left')), airWidth = Number(await canvas.getAttribute('data-air-height-width'));
  const heightY = point(192, 0).y;
  // The split above commits asynchronously to the inspector and canvas; drag only once the joint height is shown.
  await page.waitForFunction(() => document.querySelector('[data-property="type"]')?.value === 'AIR_SLIDE' && document.querySelector('[data-property="endHeight"]')?.value === '1.5');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.move(box.x + airLeft + airWidth * 1.5 / 5, heightY);
  await page.mouse.down();
  await page.mouse.move(box.x + airLeft + airWidth * 2.5 / 5, heightY, { steps: 5 });
  await page.mouse.up();
  await page.locator('.editor-viewport').focus();
  const nodeSaved = await saveProjectAs('node-edited');
  const savedNodes = JSON.parse(await readFile(path.join(nodeSaved, 'project.chuni.json'), 'utf8'));
  for (const type of ['SLIDE', 'AIR_HOLD', 'AIR_SLIDE']) {
    const segments = savedNodes.chart.notes.filter(note => note.type === type).sort((a, b) => a.tick - b.tick);
    assert.equal(segments.length, 2, type); assert.equal(segments[0].attributes.visible, false, type);
    assert.equal(segments[1].attributes.visible, true, type); assert.equal(segments[0].tick + segments[0].duration, segments[1].tick);
  }
  const airSegments = savedNodes.chart.notes.filter(note => note.type === 'AIR_SLIDE').sort((a, b) => a.tick - b.tick);
  assert.equal(airSegments[0].endHeight, 2.5); assert.equal(airSegments[1].height, 2.5);
  assert.equal(airSegments[0].height, 1); assert.equal(airSegments[1].endHeight, 2);
  const nodeShot = path.join(screenshots, 'windows-node-editor.png'); await page.screenshot({ path: nodeShot }); evidence.screenshots.push(nodeShot);
  const nodeC2s = path.join(out, 'node-kinds.c2s');
  await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, nodeC2s);
  await page.evaluate(async data => window.studio.exportC2s(data), savedNodes);
  const nodeText = await readFile(nodeC2s, 'utf8');
  for (const tag of ['SLD', 'SLC', 'AHD', 'AHX', 'ASD', 'ASC']) assert.match(nodeText, new RegExp(`^${tag}\\t`, 'm'));
  evidence.nodeEditing = { savedProject: nodeSaved, c2s: nodeC2s, endNodePairs: ['SLD/SLC', 'AHD/AHX', 'ASD/ASC'], preserveOriginalEndAfterSplit: true, airHeightLinked: true };
  const crushProject = JSON.parse(await readFile(calibration, 'utf8'));
  crushProject.metadata.title = 'CRUSH continuous phase'; crushProject.metadata.difficulty = 'WORLD’S END';
  crushProject.audio.path = path.resolve(path.dirname(calibration), crushProject.audio.path);
  crushProject.coverPath = path.resolve(path.dirname(calibration), crushProject.coverPath);
  crushProject.chart = { version: '1.15.00', resolution: 384, defaultBpm: 120, events: [], headerRecords: [], unknownRecords: [], notes: [
    { id: 'crush-a', type: 'AIR_CRUSH', tick: 384, duration: 70, lane: 2, width: 2, endLane: 6, endWidth: 2, height: 1, endHeight: 2, attributes: { interval: 48 } },
    { id: 'crush-b', type: 'AIR_CRUSH', tick: 454, duration: 74, lane: 6, width: 2, endLane: 10, endWidth: 2, height: 2, endHeight: 3, attributes: { interval: 48 } },
  ] };
  await openProjectFolder(await writeProjectFolder('crush-continuous', crushProject)); await page.waitForFunction(() => document.querySelector('#project-title').textContent === 'CRUSH continuous phase');
  await page.locator('#play-tab').click(); await seekScene(2.375);
  const crushMiddle = await checkScene({ title: 'CRUSH continuous phase', difficulty: 'WORLD’S END', cover: 'true' });
  assert.equal(crushMiddle.judgementTotal, 4); assert.equal(crushMiddle.combo, 2); assert.equal(crushMiddle.score, 505000);
  const crushFinish = await seekScene(2.75); assert.equal(crushFinish.combo, 4); assert.equal(crushFinish.score, 1010000);
  const crushRewind = await seekScene(2.2); assert.equal(crushRewind.combo, 1); assert.equal(crushRewind.score, 252500);
  evidence.crushPlayback = { total: 4, middleCombo: crushMiddle.combo, finishScore: crushFinish.score, rewindCombo: crushRewind.combo };
  evidence.crushPlayback.screenshot = await captureScene('windows-crush-continuous.png');
  await page.locator('#playback-rate').selectOption('1');
  const liveBefore = await readScene(), liveStarted = performance.now();
  await page.locator('#play-button').click();
  await page.waitForFunction(() => Number(document.querySelector('#seek').value) >= 3.2, undefined, { timeout: 10000 });
  await page.locator('#play-button').click();
  const liveAfter = await readScene(), liveElapsed = (performance.now() - liveStarted) / 1000;
  assert.ok(liveAfter.frame > liveBefore.frame, 'Preview must continue drawing during playback.');
  assert.equal(liveAfter.scene, 'black');
  assert.equal(liveAfter.combo, 4);
  evidence.stageAnimation.playbackWorksWithBlackBackground = true;
  evidence.stageAnimation.observedFramesPerSecond = (liveAfter.frame - liveBefore.frame) / liveElapsed;

  evidence.editorSprites={source:'Margrete 1.8.0 data/note_icons.png',draws:await page.evaluate(()=>window.__margreteDraws)};
  assert.ok(evidence.editorSprites.draws>0,'Copied Margrete atlas must actually draw in the editor');
  evidence.errors = errors; evidence.consoleMessages = consoleMessages;
  assert.deepEqual(errors, [], 'The packaged renderer must not emit runtime errors.');
  await writeFile(path.join(reports, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await rm(path.join(reports, 'failure.json'), { force: true });
  console.log(JSON.stringify({ ok: true, bridge: evidence.runtime.bridge, loadedSong: evidence.loadedSong, audioLabel: evidence.audioLabel, exportFiles: evidence.export.files.length, screenshots: evidence.screenshots, evidence: path.join(reports, 'evidence.json') }, null, 2));
} catch (error) {
  evidence.failure = String(error.stack ?? error); evidence.errors = errors; evidence.consoleMessages = consoleMessages;
  try { if (app) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(screenshots, 'windows-failure.png') }); } } catch {}
  await writeFile(path.join(reports, 'failure.json'), JSON.stringify(evidence, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  if (app) { try { await app.evaluate(({ app }) => app.exit(0)); } catch {} try { await app.close(); } catch {} }
}
