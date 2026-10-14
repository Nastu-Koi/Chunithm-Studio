import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Interaction modes are exclusive: entering one leaves the other. Run against Vite: CHUNI_UI_URL=http://127.0.0.1:5173
test(
  'editor modes: align, insert-node and the shape panel replace one another',
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
      await page.route('**/__editor_mode_test__', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
      import { ChartEditor } from '/src/renderer/editor.ts';
      import { createChart, createNote } from '/src/core/model.ts';
      const chart = createChart();
      chart.notes = [{ ...createNote('SLIDE', 0, 4, 4), duration: 384, endLane: 4, endWidth: 4 }];
      const editor = new ChartEditor(document.querySelector('#editor'), {
        onChange(next) { editor.setChart(next); }, onCursor() {}, onUndo() {}, onRedo() {}, onOffset() {}
      });
      editor.setChart(chart);
      editor.setWaveform(new Float32Array(64), 10, 0, { data: new Float32Array(48000), sampleRate: 48000 });
      window.testEditor = editor;
    </script></body></html>`,
        }),
      );
      await page.goto(`${process.env.CHUNI_UI_URL}/__editor_mode_test__`);
      await page.waitForFunction(() => Boolean((window as any).testEditor));
      // The align button is unique; split also appears in the inspector, so take the toolbar one.
      const button = (action: string) =>
        page.locator(action === 'align' ? '[data-action="align"]' : `.editor-toolrow [data-action="${action}"]`);
      const active = (action: string) => button(action).evaluate(item => item.classList.contains('editor-active'));
      const alignControls = page.locator('.editor-align-controls');
      const shapePanel = page.locator('.editor-shape-panel');

      await button('align').click();
      assert.equal(await active('align'), true);
      assert.equal(await alignControls.isHidden(), false);

      await page.keyboard.press('k');
      assert.equal(await active('split'), true);
      assert.equal(await active('align'), false);
      assert.equal(await alignControls.isHidden(), true);

      await page.evaluate(() => (window as any).testEditor.selectAll());
      await page.keyboard.press('r');
      assert.equal(await shapePanel.isHidden(), false);
      assert.equal(await active('split'), false);

      await button('split').click();
      assert.equal(await shapePanel.isHidden(), true);
      assert.equal(await active('split'), true);

      await page.keyboard.press('Escape');
      assert.equal(await active('split'), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
