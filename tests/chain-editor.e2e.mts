import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__chain_editor_test__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style><main id="editor"></main><script type="module">
    import { ChartEditor } from '/src/renderer/editor.ts';
    import { createChart, createNote } from '/src/core/model.ts';
    import { getNoteScrollGroup } from '/src/core/timing.ts';
    import { parseC2S, serializeC2S } from '/src/core/c2s.ts';
    const state = {chart:createChart()};
    const editor = new ChartEditor(document.querySelector('#editor'), {onChange(chart){state.chart=chart;editor.setChart(chart)},onCursor(){},onUndo(){},onRedo(){}});
    editor.setChart(state.chart); window.test={state,editor,createNote,createChart,getNoteScrollGroup,parseC2S,serializeC2S};
  </script>` }));
  await page.goto(`${process.env.CHUNI_UI_URL || 'http://127.0.0.1:5173'}/__chain_editor_test__`);
  await page.waitForFunction(() => Boolean((window as any).test));
  const box = (await page.locator('canvas').boundingBox())!;
  const trackLeft = Number(await page.locator('canvas').getAttribute('data-track-left'));
  const point = (tick: number, lane: number) => ({ x: box.x + trackLeft + (lane + .5) * (box.width - trackLeft - 18) / 16, y: box.y + box.height - 30 - tick * .75 });
  const click = async (tick: number, lane: number) => { const p = point(tick, lane); await page.mouse.click(p.x, p.y); };
  await page.evaluate(() => {
    const t = (window as any).test, chart = t.createChart();
    const tap = t.createNote('TAP', 48, 0, 2), hold = t.createNote('AIR_HOLD', 48, 0, 2);
    hold.duration = 192; hold.attributes.parent = 'TAP'; chart.notes = [tap, hold];
    t.state.chart = chart; t.editor.setChart(chart); t.editor.setCursor(144);
  });
  await click(96, 0); await page.locator('.editor-options [data-action="split"]').click();
  assert.deepEqual(await page.evaluate(() => (window as any).test.state.chart.notes.filter((n: any) => n.type === 'AIR_HOLD').map((n: any) => n.attributes.parent)), ['TAP', 'AHD']);
  await click(192, 0); await page.locator('.editor-options [data-action="connect"]').click(); await click(336, 0); await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => { const t = (window as any).test; return t.parseC2S(t.serializeC2S(t.state.chart)).notes.filter((n: any) => n.type === 'AIR_HOLD').map((n: any) => n.attributes.parent); }), ['TAP', 'AHD', 'AHD']);
  await page.evaluate(() => {
    const t = (window as any).test, chart = t.createChart();
    chart.notes = [t.createNote('SLIDE', 48, 4, 2), t.createNote('SLIDE', 144, 4, 2)];
    chart.events = [{id:'assign',type:'SCROLL_ASSIGNMENT',tick:48,lane:4,width:2,duration:192,group:2,value:2},{id:'speed',type:'GROUP_SCROLL',tick:0,duration:1000,group:2,value:2}];
    t.state.chart = chart; t.editor.setChart(chart); t.editor.setCursor(0);
  });
  await click(192, 4); await page.locator('.editor-options [data-action="connect"]').click(); await click(336, 8); await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => { const t = (window as any).test; return t.state.chart.notes.map((n: any) => t.getNoteScrollGroup(t.state.chart, n)); }), [2, 2, 2]);
  await click(192, 4); await page.keyboard.press('Control+c');
  await page.evaluate(() => (window as any).test.editor.setCursor(480)); await page.keyboard.press('Control+v');
  const pasted = await page.evaluate(() => { const t = (window as any).test, native = t.parseC2S(t.serializeC2S(t.state.chart)); return native.notes.map((n: any) => ({ tick:n.tick, group:t.getNoteScrollGroup(native,n) })); });
  assert.equal(pasted.length, 4); assert.deepEqual(pasted.at(-1), { tick:480, group:2 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['AIR-HOLD split and continuation parent', 'continued slide SLA span', 'copied grouped middle segment', 'native export preserves associations'], rendererErrors: errors }));
} finally { await browser.close(); }
