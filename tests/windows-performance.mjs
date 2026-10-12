/** Isolated, real Windows Electron frame-time reproduction; never rewrites a runtime or game file. */
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.platform !== 'win32') throw new Error('Use the Windows Node runtime.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = option('runtime'); if (!runtime) throw new Error('--runtime is required');
const data = option('data'); if (!data) throw new Error('--data is required');
const label = option('label') ?? 'baseline', scenario = option('scenario') ?? 'calibration';
const renderer = option('renderer');
const mode = option('mode') ?? 'baseline', duration = Number(option('duration') ?? 8000);
const out = path.join(root, 'out', 'performance'); await mkdir(out, { recursive: true }); await mkdir(data, { recursive: true });
const env = { ...process.env, CHUNI_USER_DATA_DIR: data, CHUNI_DEV_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
const errors = []; let app;
try {
  app = await electron.launch({ executablePath: path.join(runtime, 'ChuniStudio.exe'), args: [`--user-data-dir=${data}`, '--no-first-run'], cwd: runtime, env, timeout: 60000 });
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__perfAudio = [];
    const Original = window.AudioContext;
    window.AudioContext = class extends Original { constructor(...args) { super(...args); window.__perfAudio.push(this); } };
  });
  if (renderer) await app.evaluate(async ({ BrowserWindow }, filename) => { await BrowserWindow.getAllWindows()[0].loadFile(filename); }, path.resolve(renderer));
  else await page.reload();
  await page.waitForFunction(() => document.querySelector('#resource-status')?.dataset.loaded === 'true', { timeout: 60000 });
  if (scenario === 'calibration') {
    const file = path.join(runtime, 'examples', 'calibration');
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, file);
    await page.locator('[data-action="open"]').click();
    await page.waitForFunction(() => document.querySelector('#audio-label')?.textContent.endsWith('.wav'), { timeout: 60000 });
  } else await page.locator('[data-action="demo"]').click();
  await page.locator('#play-tab').click();
  await page.evaluate(mode => {
    const proto = CanvasRenderingContext2D.prototype, records = new WeakMap(); let serial = 0;
    const p = window.__perf = { mode, stages: [], canvasCalls: {}, raf: [], longtasks: [], clocks: [], collecting: false };
    const meta = c => { let v = records.get(c.canvas); if (!v) { v = { id: ++serial, fill: 0, drawCalls: 0, triangles: 0, start: 0 }; records.set(c.canvas, v); } return v; };
    const clear = proto.clearRect, fill = proto.fill, image = proto.drawImage;
    proto.clearRect = function (...args) { const m = meta(this); m.start = performance.now(); m.fill = 0; return clear.apply(this, args); };
    proto.fill = function (...args) { const m = meta(this); m.fill++; if (mode === 'no-stage-paint' && !this.canvas.isConnected && this.canvas.width === 1920 && this.canvas.height === 1080) return; return fill.apply(this, args); };
    // Only the stage canvas is tagged. The note GPU layer must not enter these counters.
    const gpu = WebGLRenderingContext.prototype, upload = gpu.bufferSubData, draw = gpu.drawArrays;
    gpu.bufferSubData = function (...args) {
      if (this.canvas.dataset?.stageRenderer === 'webgl') { const m = meta(this); m.start = performance.now(); m.drawCalls = m.triangles = 0; }
      return upload.apply(this, args);
    };
    gpu.drawArrays = function (...args) {
      if (this.canvas.dataset?.stageRenderer === 'webgl') {
        const m = meta(this); m.drawCalls++; m.triangles += args[2] / 3;
        if (mode === 'no-stage-paint') return;
      }
      return draw.apply(this, args);
    };
    proto.drawImage = function (source, ...args) {
      if (p.collecting && source instanceof HTMLCanvasElement) {
        const m = records.get(source);
        if (m && (m.fill > 100 || m.drawCalls > 0) && m.start > 0) p.stages.push({ ms: performance.now() - m.start, fills: m.fill, drawCalls: m.drawCalls, triangles: m.triangles, backend: source.dataset.stageRenderer ?? 'canvas2d', width: source.width, height: source.height, id: m.id });
      }
      return image.call(this, source, ...args);
    };
    new PerformanceObserver(list => { if (p.collecting) p.longtasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))); }).observe({ entryTypes: ['longtask'] });
  }, mode);
  await page.locator('#play-button').click();
  // Warm-up to finish the first animation/audio allocations. This is one completion wait, not polling logs.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1800)));
  const cdp = await page.context().newCDPSession(page);
  const frames = await page.evaluate(duration => new Promise(resolve => {
    const p = window.__perf, canvas = document.querySelector('.player-canvas'); p.collecting = true; const start = performance.now(); let last = start, lastAudio = window.__perfAudio[0]?.currentTime ?? 0;
    const frame = now => {
      const audio = window.__perfAudio[0]?.currentTime ?? 0;
      p.raf.push(now - last); p.clocks.push({ wall: now - start, audio, seek: Number(document.querySelector('#seek').value), audioDelta: audio - lastAudio, effectPrimitives: Number(canvas.dataset.nativeEffectPrimitives ?? 0) }); last = now; lastAudio = audio;
      if (now - start < duration) requestAnimationFrame(frame);
      else { p.collecting = false; resolve({ ...p, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, canvas: { width: canvas.width, height: canvas.height }, nativeModels: Number(canvas.dataset.nativeModels ?? 0), title: document.querySelector('#project-title').textContent, clockStates: window.__perfAudio.map(c => ({ state: c.state, sampleRate: c.sampleRate })) }); }
    }; requestAnimationFrame(frame);
  }), duration);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 3000)));
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(path.join(out, `${label}.cpuprofile`), JSON.stringify(profile));
  const percentile = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] ?? 0;
  const summarize = a => ({ count: a.length, mean: a.reduce((s, x) => s + x, 0) / Math.max(1, a.length), p50: percentile(a, .5), p95: percentile(a, .95), p99: percentile(a, .99), max: Math.max(0, ...a) });
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), self = new Map();
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
  const cpu = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, us]) => ({ ms: us / 1000, ...nodes.get(id).callFrame }));
  const first = frames.clocks[0], last = frames.clocks.at(-1);
  const result = { label, mode, scenario, runtime, renderer, versions: await app.evaluate(() => process.versions), errors, title: frames.title, viewport: frames.viewport, canvas: frames.canvas, frame: summarize(frames.raf.slice(1)), over25ms: frames.raf.filter(t => t > 25).length, over50ms: frames.raf.filter(t => t > 50).length, stage: summarize(frames.stages.map(x => x.ms)), stageFills: summarize(frames.stages.map(x => x.fills)), stageDrawCalls: summarize(frames.stages.map(x => x.drawCalls)), stageTriangles: summarize(frames.stages.map(x => x.triangles)), stageBackend: [...new Set(frames.stages.map(x => x.backend))], longtasks: summarize(frames.longtasks.map(x => x.duration)), clockRate: (last.audio - first.audio) / ((last.wall - first.wall) / 1000), seekRate: (last.seek - first.seek) / ((last.wall - first.wall) / 1000), clockStates: frames.clockStates, cpu, raw: frames };
  result.nativeModels = frames.nativeModels;
  result.effectPrimitives = summarize(frames.clocks.map(frame => frame.effectPrimitives));
  await writeFile(path.join(out, `${label}.json`), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(out, `${label}.png`) });
  const { raw, cpu: _cpu, versions: _versions, ...brief } = result; console.log(JSON.stringify(brief, null, 2));
  if (process.argv.includes('--assert-smooth') && (result.frame.p99 > 25 || result.over50ms > 2)) process.exitCode = 1;
} finally { if (app) await app.close(); }
