/** Pixel regression for the actual player texture mapping; runs in the Windows Chromium renderer. */
import { _electron as electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.argv[2];
if (!runtime) throw new Error('Pass the Windows runtime directory');
const directory =
  process.argv.find(value => value.startsWith('--data='))?.slice(7) ??
  path.resolve(runtime, '..', 'desktop-ribbon-0.1.8');
await mkdir(directory, { recursive: true });
const env = { ...process.env, CHUNI_USER_DATA_DIR: directory, CHUNI_DEV_URL: '' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.join(runtime, 'ChuniStudio.exe'),
  cwd: runtime,
  env,
  args: [`--user-data-dir=${directory}`],
});
try {
  const page = await app.firstWindow();
  await page.goto('about:blank');
  await page.addScriptTag({ path: path.join(root, 'out/ribbon-repro.bundle.js') });
  const mode = process.argv.find(value => value.startsWith('--probe='))?.slice(8) ?? 'normal';
  const results = await page.evaluate(mode => {
    const fixtures = [
      {
        name: 'opaque-single',
        alpha: 1,
        segments: [
          [
            { x: 120, y: 80, scale: 0.4 },
            { x: 360, y: 80, scale: 0.4 },
            { x: 620, y: 540, scale: 1.3 },
            { x: 20, y: 540, scale: 1.3 },
          ],
        ],
      },
      {
        name: 'translucent-single',
        alpha: 0.5,
        segments: [
          [
            { x: 120, y: 80, scale: 0.4 },
            { x: 360, y: 80, scale: 0.4 },
            { x: 620, y: 540, scale: 1.3 },
            { x: 20, y: 540, scale: 1.3 },
          ],
        ],
      },
      {
        name: 'translucent-connected-width-change',
        alpha: 0.5,
        segments: [
          [
            { x: 220, y: 80, scale: 0.4 },
            { x: 350, y: 80, scale: 0.4 },
            { x: 460, y: 285, scale: 0.8 },
            { x: 110, y: 285, scale: 0.8 },
          ],
          [
            { x: 110, y: 285, scale: 0.8 },
            { x: 460, y: 285, scale: 0.8 },
            { x: 690, y: 540, scale: 1.35 },
            { x: 70, y: 540, scale: 1.35 },
          ],
        ],
      },
    ];
    return fixtures.map(fixture => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      c.fillStyle = '#000';
      c.fillRect(0, 0, 800, 600);
      if (mode === 'no-smoothing') c.imageSmoothingEnabled = false;
      if (mode === 'no-clip') c.clip = () => {};
      if (mode === 'additive') c.globalCompositeOperation = 'lighter';
      const texture = document.createElement('canvas');
      texture.width = texture.height = 64;
      const source = texture.getContext('2d');
      source.fillStyle = `rgba(255,128,128,${fixture.alpha})`;
      source.fillRect(0, 0, 64, 64);
      const player = Object.create(FixturePlayer.ChartPlayer.prototype);
      player.context = c;
      if (FixturePlayer.GameMeshRenderer) {
        player.textureLayer = new FixturePlayer.GameMeshRenderer(800, 600);
        player.textureLayer.begin();
      }
      for (const points of fixture.segments)
        player.texturedQuad({ image: texture, x: 0, y: 0, width: 64, height: 64 }, points);
      if (player.textureLayer) c.drawImage(player.textureLayer.finish(), 0, 0);
      const pixels = c.getImageData(0, 0, 800, 600).data,
        expectedRed = Math.round(255 * fixture.alpha),
        checked = new Set(),
        seam = [];
      const scan = (a, b, label) => {
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        // Skip endpoint anti-aliasing on the exterior silhouette. Every sampled point is inside the union.
        for (let step = 8; step < length - 8; step++) {
          const t = step / length,
            cx = Math.round(a.x + (b.x - a.x) * t),
            cy = Math.round(a.y + (b.y - a.y) * t);
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const x = cx + ox,
                y = cy + oy,
                key = y * 800 + x;
              if (checked.has(key)) continue;
              checked.add(key);
              const red = pixels[key * 4];
              if (Math.abs(red - expectedRed) > 3) seam.push({ x, y, red, label });
            }
        }
      };
      fixture.segments.forEach(points => scan(points[1], points[3], 'internal-triangle'));
      for (let i = 1; i < fixture.segments.length; i++)
        scan(fixture.segments[i][0], fixture.segments[i][1], 'connected-segment');
      player.textureLayer?.destroy();
      return {
        name: fixture.name,
        expectedRed,
        checkedPixels: checked.size,
        darkPixels: seam.filter(p => p.red < expectedRed).length,
        brightPixels: seam.filter(p => p.red > expectedRed).length,
        minimumRed: Math.min(expectedRed, ...seam.map(p => p.red)),
        maximumRed: Math.max(expectedRed, ...seam.map(p => p.red)),
        samples: seam.slice(0, 8),
        screenshot: canvas.toDataURL(),
      };
    });
  }, mode);
  const reports = [];
  for (const result of results) {
    const { screenshot, ...report } = result;
    reports.push(report);
    await writeFile(
      path.join(root, `out/ribbon-pixels-${result.name}.png`),
      Buffer.from(screenshot.split(',')[1], 'base64'),
    );
  }
  await writeFile(path.join(root, `out/ribbon-pixels-${mode}.json`), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
  if (mode === 'normal')
    for (const result of results) {
      assert.equal(result.darkPixels, 0, `${result.name}: internal triangle and segment edges must have no dark seam.`);
      assert.equal(result.brightPixels, 0, `${result.name}: translucent shared edges must not be double blended.`);
    }
} finally {
  await app.close();
}
