import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Uses real canvas pointer coordinates. Run against Vite, with CHUNI_BROWSER when using installed Edge.
test('editor track width preserves chart coordinates, fixed AIR controls and the saved display preference', { skip: !process.env.CHUNI_UI_URL, timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHUNI_BROWSER ? { executablePath: process.env.CHUNI_BROWSER } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__editor_width_test__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
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
    </script></body></html>` }));
    const url = `${process.env.CHUNI_UI_URL}/__editor_width_test__`;
    await page.goto(url); await page.waitForFunction(() => Boolean((window as any).testEditor));
    const canvas = page.locator('.editor-viewport canvas'), widthControl = page.locator('[data-option="track-width"]'), panControl = page.locator('[data-option="track-pan"]');
    const state = () => page.evaluate(() => (window as any).testEditor.state.chart);
    const raw = () => page.evaluate(() => { const t = (window as any).testEditor; return t.serializeC2S(t.state.chart); });
    const layout = () => canvas.evaluate(element => ({
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
      left: Number(element.dataset.trackLeft), right: Number(element.dataset.trackRight),
      trackWidth: Number(element.dataset.trackWidth), laneWidth: Number(element.dataset.laneWidth), offset: Number(element.dataset.trackOffset),
      airLeft: Number(element.dataset.airHeightLeft), airWidth: Number(element.dataset.airHeightWidth),
    }));
    const point = async (tick: number, lane: number) => {
      const box = await canvas.boundingBox(); assert.ok(box);
      const l = await layout(), zoom = Number(await page.locator('[data-option="zoom"]').inputValue());
      return { x: box.x + l.left + (lane + .5) * l.laneWidth - l.offset, y: box.y + box.height - 30 - tick * zoom };
    };
    const click = async (tick: number, lane: number) => { const p = await point(tick, lane); await page.mouse.click(p.x, p.y); };
    const original = await raw(), initial = await layout();
    await widthControl.focus(); await widthControl.press('End');
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.trackScale === '2');
    const wide = await layout();
    assert.equal(wide.trackWidth, initial.trackWidth * 2); assert.equal(wide.airLeft, initial.airLeft); assert.equal(wide.airWidth, initial.airWidth);
    assert.equal(await raw(), original, 'Display width must not alter the native chart.');
    assert.equal(await panControl.isVisible(), true);
    await panControl.focus(); await panControl.press('Home');
    await page.locator('[data-tool="TAP"]').click(); await click(96, 2);
    assert.equal((await state()).notes.at(-1).lane, 2); assert.equal((await state()).notes.at(-1).width, 2);
    await page.locator('[data-tool="select"]').click();
    const leftBox = await canvas.boundingBox(); assert.ok(leftBox);
    const firstPoint = await point(96, 2);
    await page.mouse.move(leftBox.x + wide.left + 4 * wide.laneWidth - 2, firstPoint.y); await page.mouse.down();
    await page.mouse.move(leftBox.x + wide.left + 6 * wide.laneWidth, firstPoint.y, { steps: 6 }); await page.mouse.up();
    assert.equal((await state()).notes.at(-1).width, 4, 'Dragging a scaled edge must still edit an integer count of native lanes.');
    await page.locator('[data-tool="TAP"]').click();
    await panControl.focus(); await panControl.press('End');
    await click(144, 14);
    assert.equal((await state()).notes.at(-1).lane, 14); assert.equal((await state()).notes.at(-1).width, 2);
    await page.locator('[data-tool="select"]').click();
    const from = await point(144, 14), to = await point(168, 12);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
    assert.equal((await state()).notes.at(-1).lane, 12); assert.equal((await state()).notes.at(-1).tick, 168);
    // Height handles remain in the fixed left pane even when lane zero is offscreen.
    const box = await canvas.boundingBox(); assert.ok(box);
    const zoom = Number(await page.locator('[data-option="zoom"]').inputValue());
    const airY = box.y + box.height - 30 - 192 * zoom;
    await page.mouse.move(box.x + wide.airLeft + wide.airWidth / 5, airY); await page.mouse.down();
    await page.mouse.move(box.x + wide.airLeft + wide.airWidth * 3 / 5, airY, { steps: 6 }); await page.mouse.up();
    assert.equal((await state()).notes[0].height, 3); assert.equal((await state()).notes[0].lane, 2);
    if (process.env.CHUNI_EDITOR_WIDTH_SCREENSHOT) await page.screenshot({ path: process.env.CHUNI_EDITOR_WIDTH_SCREENSHOT });
    const beforeShrink = await raw();
    await widthControl.focus(); await widthControl.press('Home');
    assert.equal(await panControl.isVisible(), false); assert.equal(await raw(), beforeShrink);
    await page.locator('[data-tool="TAP"]').click();
    const narrow = await layout(), narrowBox = await canvas.boundingBox(); assert.ok(narrowBox);
    const count = (await state()).notes.length;
    await page.mouse.click(narrowBox.x + narrow.right + 25, narrowBox.y + narrow.height - 30 - 240 * zoom);
    assert.equal((await state()).notes.length, count, 'Blank space beside a narrow track must not create lane-16 notes.');
    await click(240, 10); assert.equal((await state()).notes.at(-1).lane, 10);
    const preference = await page.evaluate(() => localStorage.getItem('chuni-editor-track-scale'));
    assert.equal(preference, '0.5');
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).testEditor));
    assert.equal(await widthControl.inputValue(), '50');
    await page.locator('[data-action="fit-track-width"]').click();
    assert.equal(await widthControl.inputValue(), '100'); assert.equal(await panControl.isVisible(), false);
    // A smaller host still exposes all 16 lanes at fit width, without moving the AIR pane.
    await page.setViewportSize({ width: 960, height: 760 });
    await page.waitForFunction(previous => Number(document.querySelector('canvas')?.dataset.trackRight) < previous - 100, initial.right);
    const resized = await layout(); assert.equal(resized.offset, 0); assert.equal(resized.right, resized.width - 18); assert.equal(resized.airLeft, initial.airLeft);
    await page.locator('[data-tool="TAP"]').click(); await click(96, 14); assert.equal((await state()).notes.at(-1).lane, 14);
    assert.deepEqual(errors, []);
    if (process.env.CHUNI_EDITOR_WIDTH_SCREENSHOT) await page.screenshot({ path: process.env.CHUNI_EDITOR_WIDTH_SCREENSHOT.replace(/\.png$/, '-fit.png') });
  } finally { await browser.close(); }
});
