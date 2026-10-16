import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { canvasGeometry } from './editor-canvas';

// Stacked notes on the real canvas. Run against Vite: CHUNI_UI_URL=http://127.0.0.1:5173 node --import tsx tests/editor-stack-ui.test.ts
test(
  'editor: repeated clicks walk through stacked notes, and an ExTAP dragged onto a long head becomes its EX',
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
      await page.route('**/__editor_stack_test__', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
      import { ChartEditor } from '/src/renderer/editor.ts';
      import { createChart, createNote } from '/src/core/model.ts';
      const chart = createChart();
      chart.notes = [{ ...createNote('SLIDE', 96, 2, 4), duration: 96, endLane: 2, endWidth: 4, attributes: { visible: true } }, createNote('TAP', 96, 2, 4)];
      const state = { chart };
      const editor = new ChartEditor(document.querySelector('#editor'), {
        onChange(chart) { state.chart = chart; editor.setChart(chart); }, onCursor() {}, onUndo() {}, onRedo() {}
      });
      editor.setChart(state.chart); window.testEditor = { editor, state };
    </script></body></html>`,
        }),
      );
      await page.goto(`${process.env.CHUNI_UI_URL}/__editor_stack_test__`);
      await page.waitForFunction(() => Boolean((window as any).testEditor));
      const point = async (tick: number, lane: number) => {
        const { box, trackLeft, laneWidth, zoom } = await canvasGeometry(page);
        return { x: box.x + trackLeft + lane * laneWidth, y: box.y + box.height - 30 - tick * zoom };
      };
      const click = async (tick: number, lane: number) => {
        const p = await point(tick, lane);
        await page.mouse.click(p.x, p.y);
      };
      const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
      };
      const notes = (): Promise<[string, number, number, boolean][]> =>
        page.evaluate(() =>
          (window as any).testEditor.state.chart.notes.map((n: any) => [
            n.type,
            n.tick,
            n.lane,
            Boolean(n.attributes.ex),
          ]),
        );
      const status = async () => String(await page.locator('.editor-hint').textContent());
      const selectedType = () => page.locator('.editor-inspector').textContent();

      await page.locator('.editor-viewport').focus();
      await page.keyboard.press('s');
      // The TAP lies on top; a second click on the same spot takes the SLIDE under it, a third comes back round.
      await click(96, 4);
      assert.doesNotMatch(await status(), /叠放 \d/);
      await click(96, 4);
      assert.match(await status(), /叠放 2\/2：SLIDE/);
      await click(96, 4);
      assert.match(await status(), /叠放 1\/2：TAP/);
      await click(96, 4);
      assert.match(await status(), /叠放 2\/2：SLIDE/);
      await page.keyboard.press('Delete');
      assert.deepEqual(await notes(), [['TAP', 96, 2, false]], 'Delete removes the SLIDE the clicks ended on');
      // A press that turns into a drag moves the selected note and does not switch.
      await page.evaluate(() => {
        const { editor, state } = (window as any).testEditor;
        state.chart = {
          ...state.chart,
          notes: [
            {
              id: 'slide',
              type: 'SLIDE',
              tick: 96,
              lane: 2,
              width: 4,
              duration: 96,
              endLane: 2,
              endWidth: 4,
              attributes: { visible: true },
            },
            ...state.chart.notes,
          ],
        };
        editor.setChart(state.chart);
      });
      await click(96, 4);
      await drag(await point(96, 4), await point(96, 9));
      assert.deepEqual(await notes(), [
        ['SLIDE', 96, 2, false],
        ['TAP', 96, 7, false],
      ]);
      // An ExTAP placed elsewhere and dragged exactly onto the SLIDE head is absorbed.
      await page.keyboard.press('2');
      await click(48, 4);
      await page.keyboard.press('s');
      const placed = await page.evaluate(() => {
        const note = (window as any).testEditor.state.chart.notes.find((n: any) => n.type === 'EXTAP');
        return { lane: note.lane, width: note.width };
      });
      // The head must match the ExTAP's width, so the SLIDE takes the width the tool placed.
      await page.evaluate(width => {
        const { editor, state } = (window as any).testEditor;
        state.chart = {
          ...state.chart,
          notes: state.chart.notes.map((n: any) => (n.type === 'SLIDE' ? { ...n, width, endWidth: width } : n)),
        };
        editor.setChart(state.chart);
      }, placed.width);
      await drag(await point(48, placed.lane + placed.width / 2), await point(96, 2 + placed.width / 2));
      assert.deepEqual(await notes(), [
        ['SLIDE', 96, 2, true],
        ['TAP', 96, 7, false],
      ]);
      assert.match(await status(), /并入/);
      assert.ok(await selectedType());
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
