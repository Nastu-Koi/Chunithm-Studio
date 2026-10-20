import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// The top-down chart image, drawn in a real browser canvas with the game's textures: each note family lands at its
// layout position wearing the texture the resource copy provides for it, and a missing model is reported. Runs
// against Vite; the textures here are solid-colour stand-ins keyed like the real copy.
test(
  'chart image draws notes with the resource copy textures at their layout positions and reports missing models',
  { skip: !process.env.CHUNI_UI_URL, timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHUNI_BROWSER ? { executablePath: process.env.CHUNI_BROWSER } : {}),
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/__chart_image_test__', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
      import { renderChartImage, chartImagePng, CHART_IMAGE_HEADER_HEIGHT } from '/src/renderer/chart-image.ts';
      import { layoutChartImage, chartImageLocate, chartImageLaneX } from '/src/core/chart-image.ts';
      import { createProject, createNote } from '/src/core/model.ts';
      const tile = color => { const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 8, 8); return c.toDataURL(); };
      const image = color => ({ dataUrl: tile(color), width: 8, height: 8, sourcePath: '', sourceName: '', sourceOffset: 0 });
      const colors = { NotesTap_04: '#ff0000', NotesChara_04: '#ffff00', NotesHold_04: '#ff8800', NotesHold_04_point: '#ff8800', NotesSlide_04: '#0000ff', NotesSlide_04_point: '#0000ff', NotesAirU_04: '#00ff00', NotesAirD_04: '#ff00ff', NotesAirHold_Ring_04: '#00ffaa', NotesTap_02: '#ff0000' };
      const models = Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, { images: [image(color)], nominalWidth: Number(key.match(/_(\\d\\d)/)[1]) }]));
      const textures = { HoldJoint: image('#8800ff'), SlideJoint: image('#00ffff'), AirHoldLine: image('#00ff00'), AirHoldJoint: image('#00ff00'), AirLadderLine: image('#ffffff') };
      const copy = { gameRoot: '', models, textures, effects: {}, warnings: [] };
      const project = createProject();
      project.metadata.title = 'Chart Image Test'; project.metadata.artist = 'Tester'; project.metadata.level = '13+';
      const chart = project.chart;
      const tap = createNote('TAP', 384, 0, 4), extap = createNote('EXTAP', 480, 4, 4), hold = createNote('HOLD', 384, 8, 4);
      hold.duration = 384;
      const air = createNote('AIR', 384, 0, 4); air.attributes = { ...air.attributes, direction: 'IR', parent: tap.id };
      const slide = createNote('SLIDE', 768, 0, 4); slide.duration = 384; slide.endLane = 8;
      const down = createNote('AIR', 1152, 12, 4); down.attributes = { ...down.attributes, direction: 'DW', parent: extap.id };
      const downTap = createNote('TAP', 1152, 12, 4);
      const flick = createNote('FLICK', 1152, 4, 4);
      const far = createNote('TAP', 384 * 6, 2, 2);
      const airHold = createNote('AIR_HOLD', 1536, 12, 4); airHold.duration = 192; airHold.attributes = { ...airHold.attributes, parent: downTap.id };
      // An EX SLIDE head with a TAP on it, the TAP recorded later: the EX head is still drawn on top.
      const stackSlide = createNote('SLIDE', 1920, 0, 4); stackSlide.attributes = { ...stackSlide.attributes, ex: true };
      const stackTap = createNote('TAP', 1920, 0, 4);
      chart.notes = [tap, extap, hold, air, slide, downTap, down, flick, far, airHold, stackSlide, stackTap];
      const { canvas, missing } = await renderChartImage(project, copy);
      document.body.appendChild(canvas);
      const layout = layoutChartImage(chart), top = CHART_IMAGE_HEADER_HEIGHT;
      const at = tick => { const l = chartImageLocate(chart, layout, tick); return { x: lane => chartImageLaneX(layout, l.column, lane), y: Math.round(l.y) + top, column: l.column.index }; };
      const ctx = canvas.getContext('2d');
      const px = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
      const brightest = (x0, y0, x1, y1) => { let best = [0,0,0,0]; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const p = px(x, y); if (p[0]+p[1]+p[2] > best[0]+best[1]+best[2]) best = p; } return best; };
      const a = at(384), b = at(480), c = at(576), d = at(1152), e = at(384 * 6), f = at(1536 + 16);
      const bytes = await chartImagePng(canvas);
      window.chartImageTest = {
        size: [canvas.width, canvas.height], columns: layout.columns.length, farColumn: e.column, missing,
        tap: px(a.x(2), a.y), extap: px(b.x(6), b.y), holdBody: px(c.x(10) + 3, c.y), holdBright: px(at(400).x(10) + 3, at(400).y), holdCap: px(a.x(10), a.y - 2),
        airUp: brightest(a.x(0), a.y - 20, a.x(4), a.y - 8), airDown: brightest(d.x(12), d.y - 20, d.x(16), d.y - 8),
        slideBody: px(at(960).x(6) + 3, at(960).y), slideEnd: px(at(1152).x(12) - 10, at(1152).y - 2), airHoldLine: px(f.x(14), f.y),
        stacked: px(at(1920).x(2), at(1920).y),
        measureLine: px(a.x(14) + 3, a.y), header: brightest(24, 30, 400, 52), farTap: px(e.x(3), e.y),
        pngHead: [...bytes.slice(0, 8)], pngSize: bytes.length,
      };
    </script></body></html>`,
        }),
      );
      await page.goto(`${process.env.CHUNI_UI_URL}/__chart_image_test__`);
      await page.waitForFunction(() => Boolean((window as any).chartImageTest));
      const r = await page.evaluate(() => (window as any).chartImageTest);
      assert.deepEqual(errors, []);
      assert.equal(r.columns, 2);
      assert.equal(r.farColumn, 1);
      assert.equal(r.size[0], 720);
      const near = (actual: number[], expected: number[]) =>
        actual.slice(0, 3).every((v, i) => Math.abs(v - expected[i]) <= 12);
      // Each note family wears its own texture: the stand-in colours come straight back from the pixels.
      assert.ok(near(r.tap, [255, 0, 0]), `TAP texture ${r.tap}`);
      assert.ok(near(r.extap, [255, 255, 0]), `ExTAP texture ${r.extap}`);
      assert.ok(near(r.farTap, [255, 0, 0]), `2-lane TAP in the second column ${r.farTap}`);
      assert.ok(near(r.stacked, [255, 255, 0]), `EX SLIDE head over the TAP on it ${r.stacked}`);
      // A body is full brightness for a twelfth note from its start, then dimmed to 40%.
      assert.ok(near(r.holdBright, [136, 0, 255]), `HOLD body near its start ${r.holdBright}`);
      assert.ok(near(r.holdBody, [54, 0, 102]), `HOLD body later on, dimmed ${r.holdBody}`);
      assert.ok(near(r.holdCap, [255, 136, 0]), `HOLD head texture ${r.holdCap}`);
      assert.ok(near(r.airUp, [0, 255, 0]), `up AIR texture ${r.airUp}`);
      assert.ok(near(r.airDown, [255, 0, 255]), `down AIR texture ${r.airDown}`);
      assert.ok(near(r.slideBody, [0, 102, 102]), `SLIDE body texture, dimmed past the start ${r.slideBody}`);
      assert.ok(near(r.slideEnd, [0, 0, 255]), `SLIDE end node texture ${r.slideEnd}`);
      assert.ok(r.airHoldLine[1] > 150 && r.airHoldLine[0] < 100, `AIR HOLD line texture ${r.airHoldLine}`);
      assert.ok(
        Math.abs(r.measureLine[0] - 85) <= 6 && r.measureLine[0] === r.measureLine[1],
        `measure line grey ${r.measureLine}`,
      );
      assert.ok(r.header[0] > 180, `header title drawn ${r.header}`);
      assert.deepEqual(r.missing, ['NotesFlick_04']);
      assert.deepEqual(r.pngHead, [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(r.pngSize > 1000);
      if (process.env.CHUNI_SCREENSHOT_PATH)
        await page.screenshot({ path: process.env.CHUNI_SCREENSHOT_PATH, fullPage: true });
    } finally {
      await browser.close();
    }
  },
);
