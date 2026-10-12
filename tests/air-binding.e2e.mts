import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__air_binding_test__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style><main id="editor"></main><script type="module">
    import { ChartEditor } from '/src/renderer/editor.ts';
    import { createChart, createNote } from '/src/core/model.ts';
    import { getNativeAirBindings } from '/src/core/judgement.ts';
    import { validateChart } from '/src/core/validation.ts';
    import { parseC2S, serializeC2S } from '/src/core/c2s.ts';
    const state = {chart:createChart()};
    const editor = new ChartEditor(document.querySelector('#editor'), {onChange(chart){state.chart=chart;editor.setChart(chart)},onCursor(){},onUndo(){},onRedo(){}});
    editor.setChart(state.chart); window.test={state,editor,createNote,createChart,getNativeAirBindings,validateChart,parseC2S,serializeC2S};
  </script>` }));
  await page.goto(`${process.env.CHUNI_UI_URL || 'http://127.0.0.1:5173'}/__air_binding_test__`);
  await page.waitForFunction(() => Boolean((window as any).test));
  const box = (await page.locator('canvas').boundingBox())!;
  const trackLeft = Number(await page.locator('canvas').getAttribute('data-track-left')), laneWidth = Number(await page.locator('canvas').getAttribute('data-lane-width'));
  // lane may be fractional: 2.5 is the middle of lane 2, 6 the boundary between lanes 5 and 6.
  const point = (tick: number, lane: number) => ({ x: box.x + trackLeft + lane * laneWidth, y: box.y + box.height - 30 - tick * .75 });
  const click = async (tick: number, lane: number, options: Parameters<typeof page.mouse.click>[2] = {}) => { const p = point(tick, lane); await page.mouse.click(p.x, p.y, options); };
  const drag = async (from: [number, number], to: [number, number]) => {
    const a = point(...from), b = point(...to);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
  };
  const tool = (name: string) => page.locator(`[data-tool="${name}"]`).click();
  type Row = { type: string; tick: number; lane: number; width: number; duration?: number; parent?: string };
  const notes = (type?: string): Promise<Row[]> => page.evaluate(type => (window as any).test.state.chart.notes.filter((n: any) => !type || n.type === type).map((n: any) => ({ type: n.type, tick: n.tick, lane: n.lane, width: n.width, ...(n.duration === undefined ? {} : { duration: n.duration }), parent: n.attributes.parent })), type);
  const hint = () => page.locator('.editor-hint').textContent();
  const orphans = () => page.evaluate(() => { const t = (window as any).test; return t.getNativeAirBindings(t.state.chart).orphans.length; });
  const passed: string[] = [];

  await page.evaluate(() => {
    const t = (window as any).test, chart = t.createChart();
    const hold = t.createNote('HOLD', 96, 8, 3); hold.duration = 192;
    chart.notes = [t.createNote('TAP', 96, 2, 4), hold];
    t.state.chart = chart; t.editor.setChart(chart);
  });

  // 1. An AIR cannot be dropped on empty track.
  await tool('AIR'); await click(384, 12.5);
  assert.equal((await notes('AIR')).length, 0); assert.match((await hint())!, /必须绑定在地面音符上/);
  passed.push('AIR on empty track is refused');

  // 2. Clicking the TAP seats the AIR on it, wherever inside the note the pointer is.
  await click(96, 5.5);
  assert.deepEqual(await notes('AIR'), [{ type: 'AIR', tick: 96, lane: 2, width: 4, parent: 'TAP' }]);
  // 3. The same ground note takes no second AIR (Alt reaches under the AIR already there).
  await page.keyboard.down('Alt'); await click(96, 3.5); await page.keyboard.up('Alt');
  assert.equal((await notes('AIR')).length, 1); assert.match((await hint())!, /已带有 AIR/);
  passed.push('AIR snaps onto a TAP; a second one is refused');

  // 4. AIR-HOLD drawn from the HOLD's body starts at the HOLD's end and keeps the dragged length.
  await tool('AIR_HOLD'); await drag([192, 9.5], [480, 9.5]);
  assert.deepEqual(await notes('AIR_HOLD'), [{ type: 'AIR_HOLD', tick: 288, lane: 8, width: 3, duration: 192, parent: 'HLD' }]);
  passed.push('AIR-HOLD attaches to the HOLD tail');

  // 5. Dragging the stacked AIR drags its TAP with it.
  await tool('select'); await drag([96, 3.5], [144, 5.5]);
  assert.deepEqual((await notes()).filter(n => n.type === 'TAP' || n.type === 'AIR').map(n => [n.type, n.tick, n.lane, n.width]), [['TAP', 144, 4, 4], ['AIR', 144, 4, 4]]);
  passed.push('TAP and AIR move as one');

  // 6. The right edge of the stack resizes the TAP; the AIR follows.
  await drag([144, 8], [144, 10]);
  assert.deepEqual((await notes()).filter(n => n.type === 'TAP' || n.type === 'AIR').map(n => [n.type, n.lane, n.width]), [['TAP', 4, 6], ['AIR', 4, 6]]);
  passed.push('width handle resizes parent and AIR');
  await page.screenshot({ path: process.env.CHUNI_SHOT || 'air-binding.png' });

  // 7. Lengthening the HOLD in the inspector carries the AIR-HOLD to the new end.
  await click(96, 9.5);
  await page.locator('[data-property="duration"]').fill('288'); await page.locator('[data-property="duration"]').press('Enter');
  assert.deepEqual((await notes('AIR_HOLD')).map(n => [n.tick, n.duration]), [[384, 192]]);
  passed.push('HOLD length edit carries the AIR-HOLD');

  // 8. A bound AIR's own position fields are locked.
  await click(144, 6.5);
  assert.match((await page.locator('.editor-inspector').textContent())!, /已绑定在地面音符的尾端/);
  await page.locator('[data-property="tick"]').fill('0'); await page.locator('[data-property="tick"]').press('Enter');
  assert.deepEqual((await notes('AIR')).map(n => n.tick), [144]); assert.match((await hint())!, /跟随父音符/);
  passed.push('bound AIR position is locked in the inspector');

  // 9. Every step so far is a chart the game would read.
  assert.equal(await orphans(), 0);
  assert.deepEqual(await page.evaluate(() => { const t = (window as any).test, native = t.parseC2S(t.serializeC2S(t.state.chart)); return [t.validateChart(t.state.chart).filter((i: any) => i.severity === 'error').length, t.getNativeAirBindings(native).parentOf.size, t.getNativeAirBindings(native).orphans.length]; }), [0, 2, 0]);
  passed.push('exported C2S keeps both bindings');

  // 10. Right-click removes the AIR on top first and leaves the TAP; deleting the HOLD takes its AIR-HOLD along.
  await click(144, 6.5, { button: 'right' });
  assert.deepEqual((await notes()).map(n => n.type).sort(), ['AIR_HOLD', 'HOLD', 'TAP']);
  await click(96, 9.5, { button: 'right' });
  assert.deepEqual((await notes()).map(n => n.type), ['TAP']);
  passed.push('deleting AIR keeps the parent; deleting the parent removes its AIR');

  // 11. SLIDE joints, AIR-SLIDE, copy / paste and mirror.
  await page.evaluate(() => {
    const t = (window as any).test, chart = t.createChart();
    const first = t.createNote('SLIDE', 48, 2, 2); first.endLane = 6;
    const second = t.createNote('SLIDE', 144, 6, 2); second.attributes.parent = 'SLD';
    chart.notes = [first, second, t.createNote('FLICK', 48, 12, 3)];
    t.state.chart = chart; t.editor.setChart(chart);
  });
  await tool('AIR'); await click(96, 5);
  assert.deepEqual(await notes('AIR'), [{ type: 'AIR', tick: 144, lane: 6, width: 2, parent: 'SLD' }]);
  assert.equal(await orphans(), 0);
  // The SLIDE root already owns that AIR: its final end takes no other.
  await click(192, 7);
  assert.equal((await notes('AIR')).length, 1); assert.match((await hint())!, /已带有 AIR/);
  passed.push('AIR binds to a mid-chain SLIDE joint; the chain takes only one');
  await tool('AIR_SLIDE'); await drag([48, 13.5], [240, 9.5]);
  const airSlide = async () => page.evaluate(() => (window as any).test.state.chart.notes.filter((n: any) => n.type === 'AIR_SLIDE').map((n: any) => [n.tick, n.lane, n.width, n.duration, n.endLane, n.attributes.parent]));
  assert.deepEqual(await airSlide(), [[48, 12, 3, 192, 9, 'FLK']]);
  passed.push('AIR-SLIDE starts on the FLICK and slides away');
  await tool('select'); await click(48, 13.5); await page.keyboard.press('Control+c');
  await page.evaluate(() => (window as any).test.editor.setCursor(480)); await page.keyboard.press('Control+v');
  assert.deepEqual((await notes('FLICK')).map(n => [n.tick, n.lane]), [[48, 12], [480, 12]]);
  assert.deepEqual(await airSlide(), [[48, 12, 3, 192, 9, 'FLK'], [480, 12, 3, 192, 9, 'FLK']]);
  await page.keyboard.press('h');
  assert.deepEqual((await notes('FLICK')).map(n => [n.tick, n.lane]), [[48, 12], [480, 1]]);
  assert.deepEqual(await airSlide(), [[48, 12, 3, 192, 9, 'FLK'], [480, 1, 3, 192, 4, 'FLK']]);
  assert.equal(await orphans(), 0);
  passed.push('copying the AIR copies its parent; paste and mirror keep the binding');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, rendererErrors: errors }));
} finally { await browser.close(); }
