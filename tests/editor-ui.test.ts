import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { canvasGeometry } from './editor-canvas';

// Run against the real Vite modules: CHUNI_UI_URL=http://127.0.0.1:5173 node --import tsx tests/editor-ui.test.ts
test(
  'real canvas editor: mouse editing, keyboard history, connected nodes and native events',
  { skip: !process.env.CHUNI_UI_URL, timeout: 90_000 },
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
      page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.route('**/__editor_test__', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
      import { ChartEditor } from '/src/renderer/editor.ts';
      import { createChart } from '/src/core/model.ts';
      const state = { chart: createChart(), history: [], future: [], cursor: 0, changes: [] };
      const editor = new ChartEditor(document.querySelector('#editor'), {
        onChange(chart, label) { state.history.push(state.chart); state.future=[]; state.chart=chart; state.changes.push(label); editor.setChart(chart); },
        onCursor(tick) { state.cursor=tick; },
        onUndo() { const prior=state.history.pop(); if(prior) {state.future.push(state.chart);state.chart=prior;editor.setChart(prior);} },
        onRedo() { const next=state.future.pop(); if(next) {state.history.push(state.chart);state.chart=next;editor.setChart(next);} }
      });
      editor.setChart(state.chart); window.testEditor = { editor, state, createChart };
    </script></body></html>`,
        }),
      );
      await page.goto(`${process.env.CHUNI_UI_URL}/__editor_test__`);
      await page
        .waitForFunction(() => Boolean((window as any).testEditor), undefined, { timeout: 10_000 })
        .catch(error => {
          throw new Error(`${error.message}\nBrowser errors: ${errors.join('\n')}`);
        });
      // Fractional lane offsets from the track's left edge, e.g. 6 is the boundary between lanes 5 and 6.
      const trackPoint = async (tick: number, laneOffset: number) => {
        const { box, trackLeft, laneWidth, zoom } = await canvasGeometry(page);
        return { x: box.x + trackLeft + laneOffset * laneWidth, y: box.y + box.height - 30 - tick * zoom };
      };
      const point = (tick: number, lane: number) => trackPoint(tick, lane + 0.5);
      const state = () => page.evaluate(() => (window as any).testEditor.state.chart);
      const click = async (tick: number, lane: number) => {
        const p = await point(tick, lane);
        await page.mouse.click(p.x, p.y);
      };
      const drag = async (fromTick: number, fromLane: number, toTick: number, toLane: number) => {
        const start = await point(fromTick, fromLane),
          end = await point(toTick, toLane);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        await page.mouse.up();
      };
      await page.locator('[data-tool="TAP"]').click();
      await click(96, 2);
      assert.equal((await state()).notes.length, 1);
      await page.locator('[data-tool="select"]').click();
      await drag(96, 2, 144, 4);
      assert.equal((await state()).notes[0].tick, 144);
      assert.equal((await state()).notes[0].lane, 4);
      const rightEdge = await trackPoint(144, 6),
        widened = await trackPoint(144, 8);
      await page.mouse.move(rightEdge.x - 2, rightEdge.y);
      await page.mouse.down();
      await page.mouse.move(widened.x, widened.y, { steps: 8 });
      await page.mouse.up();
      assert.equal((await state()).notes[0].width, 4);
      await page.keyboard.press('Control+c');
      await page.mouse.click((await canvasGeometry(page)).box.x + 15, (await point(240, 0)).y);
      await page.keyboard.press('Control+v');
      assert.equal((await state()).notes.length, 2);
      assert.equal((await state()).notes[1].tick, 240);
      await page.keyboard.press('Control+z');
      assert.equal((await state()).notes.length, 1);
      await page.keyboard.press('Control+Shift+z');
      assert.equal((await state()).notes.length, 2);
      await page.locator('[data-tool="SLIDE"]').click();
      await drag(48, 0, 288, 8);
      let slides = (await state()).notes.filter((note: any) => note.type === 'SLIDE');
      assert.equal(slides.length, 1);
      assert.equal(slides[0].duration, 240);
      assert.equal(slides[0].endLane, 8);
      await page.locator('.editor-toolrow [data-action="connect"]').click();
      await click(432, 4);
      await page.keyboard.press('Escape');
      slides = (await state()).notes.filter((note: any) => note.type === 'SLIDE');
      assert.equal(slides.length, 2);
      assert.equal(slides[0].tick + slides[0].duration, slides[1].tick);
      // Insert-node mode splits the long note under the pointer; the slide passes lane 4 halfway up.
      await page.locator('.editor-toolrow [data-action="split"]').click();
      await click(168, 4);
      await page.keyboard.press('Escape');
      slides = (await state()).notes.filter((note: any) => note.type === 'SLIDE');
      assert.equal(slides.length, 3);
      const boundary = await point(168, slides[0].endLane);
      const destination = await point(192, slides[0].endLane + 1);
      await page.mouse.move(boundary.x, boundary.y);
      await page.mouse.down();
      await page.mouse.move(destination.x, destination.y, { steps: 8 });
      await page.mouse.up();
      slides = (await state()).notes.filter((note: any) => note.type === 'SLIDE');
      assert.equal(slides[0].tick + slides[0].duration, slides[1].tick);
      assert.equal(slides[0].endLane, slides[1].lane);
      await page.locator('[data-event="BPM"]').click();
      await page.locator('[data-property="value"]').fill('150');
      await page.locator('[data-property="value"]').press('Tab');
      assert.equal((await state()).events.find((event: any) => event.type === 'BPM').value, 150);
      await page.locator('[data-event="SCROLL"]').click();
      await page.locator('[data-property="value"]').fill('0');
      await page.locator('[data-property="value"]').press('Tab');
      assert.equal((await state()).events.find((event: any) => event.type === 'SCROLL').value, 0);
      await page.locator('[data-event="GROUP_SCROLL"]').click();
      await page.locator('[data-property="value"]').fill('-1');
      await page.locator('[data-property="value"]').press('Tab');
      await page.locator('[data-property="group"]').fill('2');
      await page.locator('[data-property="group"]').press('Tab');
      await click(48, 0);
      await page.locator('[data-event="SCROLL_ASSIGNMENT"]').click();
      await page.locator('[data-property="group"]').fill('2');
      await page.locator('[data-property="group"]').press('Tab');
      let assignment = (await state()).events.find((event: any) => event.type === 'SCROLL_ASSIGNMENT');
      assert.equal(assignment.tick, 48);
      assert.equal(assignment.lane, 0);
      assert.equal(assignment.duration, 384);
      assert.equal(assignment.group, 2);
      await click(48, 0);
      await page.keyboard.press('ArrowRight');
      assignment = (await state()).events.find((event: any) => event.type === 'SCROLL_ASSIGNMENT');
      assert.equal(assignment.lane, 1);
      await page.evaluate(() => {
        const peaks = new Float32Array(1000);
        for (let i = 0; i < peaks.length; i++) peaks[i] = 0.25 + 0.6 * Math.abs(Math.sin(i * 0.11));
        (window as any).testEditor.editor.setWaveform(peaks, 12, 0.1);
      });
      await page.screenshot({ path: '/tmp/chuni-editor-ui.png' });
      await page.evaluate(() => {
        const test = (window as any).testEditor;
        test.state.chart = test.createChart();
        test.state.history = [];
        test.state.future = [];
        test.editor.setChart(test.state.chart);
        test.editor.setCursor(0);
      });
      await page.locator('[data-option="snap"]').fill('7');
      await page.locator('[data-option="snap"]').press('Tab');
      await page.locator('[data-tool="TAP"]').click();
      await click(384 / 7, 2);
      assert.ok(Math.abs((await state()).notes[0].tick - 384 / 7) < 1e-9);
      await page.locator('[data-event="BPM"]').click();
      await page.locator('[data-property="value"]').fill('210');
      await page.locator('[data-property="value"]').press('Tab');
      await page.mouse.click((await canvasGeometry(page)).box.x + 15, (await point((384 * 2) / 7, 0)).y);
      await page.locator('[data-event="BPM"]').click();
      await page.locator('[data-property="value"]').fill('150');
      await page.locator('[data-property="value"]').press('Tab');
      assert.deepEqual(
        (await state()).events.map((event: any) => event.value),
        [210, 150],
      );
      await page.locator('[data-tool="select"]').click();
      await drag(384 / 7, 2, (384 * 3) / 7, 4);
      assert.ok(Math.abs((await state()).notes[0].tick - (384 * 3) / 7) < 1e-9);
      await page.locator('[data-tool="SLIDE"]').click();
      await drag(384 / 7, 0, (384 * 4) / 7, 8);
      await page.locator('[data-property="durationFraction"]').fill('1/7');
      await page.locator('[data-property="durationFraction"]').press('Tab');
      assert.ok(Math.abs((await state()).notes.find((note: any) => note.type === 'SLIDE').duration - 384 / 7) < 1e-9);
      await page.locator('[data-option="snap"]').fill('28');
      await page.locator('[data-option="snap"]').press('Tab');
      await page.locator('[data-tool="TAP"]').click();
      await click((384 * 5) / 28, 12);
      assert.ok(Math.abs((await state()).notes.at(-1).tick - (384 * 5) / 28) < 1e-9);
      await page.screenshot({ path: '/tmp/chuni-editor-sevenths.png' });
      await page.evaluate(() => {
        const test = (window as any).testEditor;
        test.state.chart = test.createChart();
        test.editor.setChart(test.state.chart);
      });
      await page.locator('[data-option="snap"]').fill('16');
      await page.locator('[data-option="snap"]').press('Tab');
      const types = ['TAP', 'EXTAP', 'FLICK', 'HOLD', 'SLIDE', 'AIR', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH', 'DAMAGE'];
      for (let i = 0; i < types.length; i++) {
        await page.locator(`[data-tool="${types[i]}"]`).first().click();
        // AIR, AIR HOLD and AIR SLIDE bind to a ground note: drop them on the TAP, ExTAP and FLICK placed first.
        const at = ['AIR', 'AIR_HOLD', 'AIR_SLIDE'].includes(types[i]) ? i - 5 : i;
        await page.keyboard.down('Alt');
        await click(48 + at * 48, at);
        await page.keyboard.up('Alt');
      }
      // A bound AIR is stored right after its parent, so compare the set of placed types.
      assert.deepEqual((await state()).notes.map((note: any) => note.type).sort(), [...types].sort());
      await page.evaluate(() => {
        const test = (window as any).testEditor;
        test.state.chart = test.createChart();
        test.editor.setChart(test.state.chart);
      });
      await page.locator('.editor-advanced-controls > summary').click();
      await page.locator('[data-option="out-of-lane"]').check();
      assert.equal((await state()).allowOutOfLane, true);
      await page.locator('.editor-advanced-controls > summary').click();
      const offstagePoint = async (tick: number, lane: number) => {
        const start = Number(await page.locator('[data-option="view-start"]').inputValue());
        const end = Number(await page.locator('[data-option="view-end"]').inputValue());
        const { box, trackLeft, laneWidth: wideLane, zoom } = await canvasGeometry(page);
        // Lanes outside the stage extend the track; the lane width only shrinks when the canvas runs out of room.
        assert.equal(wideLane, Math.min(15, (box.width - trackLeft - 18) / (end - start)));
        return { x: box.x + trackLeft + (lane - start + 0.5) * wideLane, y: box.y + box.height - 30 - tick * zoom };
      };
      await page.locator('[data-tool="TAP"]').click();
      let outside = await offstagePoint(96, -1);
      await page.mouse.click(outside.x, outside.y);
      assert.equal((await state()).notes[0].lane, -1);
      await page.locator('[data-property="lane"]').fill('-16');
      await page.locator('[data-property="lane"]').press('Tab');
      await page.locator('[data-property="width"]').fill('32');
      await page.locator('[data-property="width"]').press('Tab');
      assert.equal((await state()).notes[0].lane, -16);
      assert.equal((await state()).notes[0].width, 32);
      assert.ok(Number(await page.locator('[data-option="view-start"]').inputValue()) <= -16);
      await page.locator('[data-event="SCROLL_ASSIGNMENT"]').click();
      await page.locator('[data-property="lane"]').fill('-24');
      await page.locator('[data-property="lane"]').press('Tab');
      await page.locator('[data-property="width"]').fill('64');
      await page.locator('[data-property="width"]').press('Tab');
      assert.equal((await state()).events[0].lane, -24);
      assert.equal((await state()).events[0].width, 64);
      await page.locator('[data-tool="SLIDE"]').click();
      const outsideStart = await offstagePoint(240, -8),
        outsideEnd = await offstagePoint(480, 24);
      await page.mouse.move(outsideStart.x, outsideStart.y);
      await page.mouse.down();
      await page.mouse.move(outsideEnd.x, outsideEnd.y, { steps: 8 });
      await page.mouse.up();
      const outsideSlide = (await state()).notes.find((note: any) => note.type === 'SLIDE');
      assert.equal(outsideSlide.lane, -8);
      assert.equal(outsideSlide.endLane, 24);
      await page.keyboard.press('ArrowUp');
      assert.equal((await state()).notes.find((note: any) => note.type === 'SLIDE').lane, -8);
      await page.locator('[data-property="endLane"]').fill('64');
      await page.locator('[data-property="endLane"]').press('Tab');
      await page.locator('[data-property="endWidth"]').fill('128');
      await page.locator('[data-property="endWidth"]').press('Tab');
      assert.equal((await state()).notes.find((note: any) => note.type === 'SLIDE').endWidth, 128);
      assert.equal(Number(await page.locator('[data-option="view-end"]').inputValue()), 192);
      await page.screenshot({ path: '/tmp/chuni-editor-offstage.png' });
      const originalNotes = (await state()).notes;
      await page.locator('.editor-advanced-controls > summary').click();
      await page.locator('[data-option="out-of-lane"]').uncheck();
      assert.equal((await state()).allowOutOfLane, false);
      assert.deepEqual((await state()).notes, originalNotes);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
