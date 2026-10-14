import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Uses real canvas pointer coordinates. Run against Vite, with CHUNI_BROWSER when using installed Edge.
test(
  'editor track is drawn at a fixed fitted width and keeps chart coordinates and the AIR pane',
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
      await page.route('**/__editor_width_test__', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
      import { ChartEditor } from '/src/renderer/editor.ts';
      import { createChart, createNote } from '/src/core/model.ts';
      import { serializeC2S } from '/src/core/c2s.ts';
      const air = { ...createNote('AIR_SLIDE', 192, 2, 2), id: 'air', height: 1, endHeight: 2, duration: 96 };
      const state = { chart: { ...createChart(), notes: [air] }, changes: [] };
      const editor = new ChartEditor(document.querySelector('#editor'), {
        onChange(chart, label) { state.chart = chart; state.changes.push(label); editor.setChart(chart); },
        onCursor() {}, onUndo() {}, onRedo() {}
      });
      editor.setChart(state.chart); window.testEditor = { editor, state, serializeC2S };
    </script></body></html>`,
        }),
      );
      const url = `${process.env.CHUNI_UI_URL}/__editor_width_test__`;
      await page.goto(url);
      await page.waitForFunction(() => Boolean((window as any).testEditor));
      const canvas = page.locator('.editor-viewport canvas');
      const state = () => page.evaluate(() => (window as any).testEditor.state.chart);
      const raw = () =>
        page.evaluate(() => {
          const t = (window as any).testEditor;
          return t.serializeC2S(t.state.chart);
        });
      const layout = () =>
        canvas.evaluate(element => ({
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          left: Number(element.dataset.trackLeft),
          right: Number(element.dataset.trackRight),
          trackWidth: Number(element.dataset.trackWidth),
          laneWidth: Number(element.dataset.laneWidth),
          airLeft: Number(element.dataset.airHeightLeft),
          airWidth: Number(element.dataset.airHeightWidth),
        }));
      const point = async (tick: number, lane: number) => {
        const box = await canvas.boundingBox();
        assert.ok(box);
        const l = await layout(),
          zoom = Number(await page.locator('[data-option="zoom"]').inputValue());
        return { x: box.x + l.left + (lane + 0.5) * l.laneWidth, y: box.y + box.height - 30 - tick * zoom };
      };
      const click = async (tick: number, lane: number) => {
        const p = await point(tick, lane);
        await page.mouse.click(p.x, p.y);
      };
      const original = await raw(),
        initial = await layout();
      // Each lane is 15 px wide, narrower only when the canvas has no room for 16 of them; there is no control to change it.
      const fitted = (l: { width: number; left: number }) => Math.min(l.width - l.left - 18, 240);
      assert.equal(initial.trackWidth, fitted(initial));
      assert.equal(initial.laneWidth, fitted(initial) / 16);
      assert.equal(initial.right, initial.left + fitted(initial));
      assert.equal(
        await page
          .locator('[data-option="track-width"], [data-action="fit-track-width"], [data-option="track-pan"]')
          .count(),
        0,
      );
      await page.locator('[data-tool="TAP"]').click();
      await click(96, 2);
      assert.equal((await state()).notes.at(-1).lane, 2);
      assert.equal((await state()).notes.at(-1).width, 2);
      await page.locator('[data-tool="select"]').click();
      const box = await canvas.boundingBox();
      assert.ok(box);
      const firstPoint = await point(96, 2);
      await page.mouse.move(box.x + initial.left + 4 * initial.laneWidth - 2, firstPoint.y);
      await page.mouse.down();
      await page.mouse.move(box.x + initial.left + 6 * initial.laneWidth, firstPoint.y, { steps: 6 });
      await page.mouse.up();
      assert.equal(
        (await state()).notes.at(-1).width,
        4,
        'Dragging an edge must edit an integer count of native lanes.',
      );
      await page.locator('[data-tool="TAP"]').click();
      await click(144, 14);
      assert.equal((await state()).notes.at(-1).lane, 14);
      await page.locator('[data-tool="select"]').click();
      const from = await point(144, 14),
        to = await point(168, 12);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 6 });
      await page.mouse.up();
      assert.equal((await state()).notes.at(-1).lane, 12);
      assert.equal((await state()).notes.at(-1).tick, 168);
      // Height handles stay in the fixed left pane.
      const zoom = Number(await page.locator('[data-option="zoom"]').inputValue());
      const airY = box.y + box.height - 30 - 192 * zoom;
      await page.mouse.move(box.x + initial.airLeft + initial.airWidth / 5, airY);
      await page.mouse.down();
      await page.mouse.move(box.x + initial.airLeft + (initial.airWidth * 3) / 5, airY, { steps: 6 });
      await page.mouse.up();
      assert.equal((await state()).notes[0].height, 3);
      assert.equal((await state()).notes[0].lane, 2);
      await page.locator('[data-tool="TAP"]').click();
      const count = (await state()).notes.length;
      await page.mouse.click(box.x + initial.right + 25, box.y + initial.height - 30 - 240 * zoom);
      assert.equal((await state()).notes.length, count, 'Blank space beside the track must not create lane-16 notes.');
      await click(240, 10);
      assert.equal((await state()).notes.at(-1).lane, 10);
      assert.notEqual(await raw(), original);
      // A stored width from an older version is ignored, and a small window keeps the same lanes.
      await page.evaluate(() => localStorage.setItem('chuni-editor-track-scale', '3'));
      await page.reload();
      await page.waitForFunction(() => Boolean((window as any).testEditor));
      await page.setViewportSize({ width: 800, height: 760 });
      const resized = await layout();
      assert.equal(resized.trackWidth, fitted(resized));
      assert.equal(resized.airLeft, initial.airLeft);
      await page.locator('[data-tool="TAP"]').click();
      await click(96, 14);
      assert.equal((await state()).notes.at(-1).lane, 14);
      assert.deepEqual(errors, []);
      if (process.env.CHUNI_EDITOR_WIDTH_SCREENSHOT)
        await page.screenshot({ path: process.env.CHUNI_EDITOR_WIDTH_SCREENSHOT });
    } finally {
      await browser.close();
    }
  },
);
