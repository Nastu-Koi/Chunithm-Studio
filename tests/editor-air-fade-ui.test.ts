import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { canvasGeometry } from './editor-canvas';

// The editor shows what the game camera does with AIR height: bodies fade from height 5 to 15, and the AIR-height column
// marks the height above which nothing is on screen. Run against Vite, with CHUNI_BROWSER when using installed Edge.
test(
  'editor fades AIR SLIDE / CRUSH bodies by height and marks the visible limit in the AIR-height column',
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
      await page.route('**/__editor_air_fade_test__', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
      import { ChartEditor } from '/src/renderer/editor.ts';
      import { createChart, createNote } from '/src/core/model.ts';
      const chart = createChart();
      const slide = (lane, height) => {
        const tap = createNote('TAP', 96, lane, 2);
        const air = { ...createNote('AIR_SLIDE', 96, lane, 2), duration: 192, height, endHeight: height };
        air.attributes = { ...air.attributes, parent: tap.id };
        return [tap, air];
      };
      chart.notes = [...slide(1, 5), ...slide(6, 15), ...slide(11, 20)];
      const state = { chart };
      const editor = new ChartEditor(document.querySelector('#editor'), {
        onChange(next) { state.chart = next; editor.setChart(next); }, onCursor() {}, onUndo() {}, onRedo() {}
      });
      editor.setChart(state.chart); window.testEditor = { editor, state };
    </script></body></html>`,
        }),
      );
      await page.goto(`${process.env.CHUNI_UI_URL}/__editor_air_fade_test__`);
      await page.waitForFunction(() => Boolean((window as any).testEditor));
      const geometry = async () => {
        const { box, trackLeft, laneWidth, zoom } = await canvasGeometry(page);
        const air = await page.locator('.editor-viewport canvas').evaluate(element => ({
          left: Number((element as HTMLCanvasElement).dataset.airHeightLeft),
          width: Number((element as HTMLCanvasElement).dataset.airHeightWidth),
        }));
        return { box, trackLeft, laneWidth, zoom, air };
      };
      // A pixel in canvas coordinates; the ratio handles device pixel scaling.
      const pixel = async (x: number, y: number): Promise<number[]> =>
        page.evaluate(
          ([px, py]) => {
            const element = document.querySelector<HTMLCanvasElement>('.editor-viewport canvas')!,
              ratio = element.width / element.getBoundingClientRect().width;
            return [
              ...element.getContext('2d')!.getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1).data,
            ];
          },
          [x, y],
        );
      const { box, trackLeft, laneWidth, zoom, air } = await geometry();
      // Inside each body, off its centre line and side lines, on a tick that is not a grid line. The track background
      // alternates by sensor group, so each sample is taken against the same column above the body's end.
      const brightness = (rgba: number[]) => rgba[0] + rgba[1] + rgba[2];
      const bodyAt = async (lane: number) => {
        const x = trackLeft + (lane + 0.6) * laneWidth;
        return (
          brightness(await pixel(x, box.height - 30 - 150 * zoom)) -
          brightness(await pixel(x, box.height - 30 - 400 * zoom))
        );
      };
      const normal = await bodyAt(1),
        hidden = await bodyAt(6),
        beyond = await bodyAt(11);
      assert.ok(normal > 40, `a height-5 body is drawn (${normal})`);
      assert.ok(hidden > 0 && hidden < normal * 0.5, `a height-15 body is much fainter (${hidden} vs ${normal})`);
      assert.ok(Math.abs(beyond - hidden) <= 6, `above 15 the fade does not go on (${beyond} vs ${hidden})`);
      // The column now spans 0..20, so the limit line at 15 sits three quarters across; its first dash starts at the top.
      const limit = Math.round(air.left + (15 / 20) * air.width);
      const line = await pixel(limit, 2);
      assert.ok(line[0] > 100 && line[1] < 100 && line[2] < 100, `visible-limit line is drawn in red (${line})`);
      const beside = await pixel(limit - 6, 2);
      assert.ok(beside[0] < 60, `the column left of the limit stays dark (${beside})`);
      if (process.env.CHUNI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CHUNI_SCREENSHOT_PATH });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
