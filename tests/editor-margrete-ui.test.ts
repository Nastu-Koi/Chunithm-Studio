import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Margrete-style tools and default keys on the real canvas. Run against Vite, with CHUNI_BROWSER when using installed Edge.
test('editor follows Margrete tools and keys: eraser, flip, time scale, curve, left-edge width, mirrored paste and note keys', { skip: !process.env.CHUNI_UI_URL, timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHUNI_BROWSER ? { executablePath: process.env.CHUNI_BROWSER } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__editor_margrete_test__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/editor.css"><style>body{margin:0}#editor{height:100vh}</style></head><body><main id="editor"></main><script type="module">
      import { ChartEditor } from '/src/renderer/editor.ts';
      import { createChart } from '/src/core/model.ts';
      const state = { chart: createChart() };
      const editor = new ChartEditor(document.querySelector('#editor'), {
        onChange(chart) { state.chart = chart; editor.setChart(chart); }, onCursor() {}, onUndo() {}, onRedo() {}
      });
      editor.setChart(state.chart); window.testEditor = { editor, state };
    </script></body></html>` }));
    await page.goto(`${process.env.CHUNI_UI_URL}/__editor_margrete_test__`); await page.waitForFunction(() => Boolean((window as any).testEditor));
    const canvas = page.locator('.editor-viewport canvas'), box = await canvas.boundingBox(); assert.ok(box);
    const left = Number(await canvas.getAttribute('data-track-left')), laneWidth = Number(await canvas.getAttribute('data-lane-width'));
    const zoom = Number(await page.locator('[data-option="zoom"]').inputValue());
    // `lane` is a coordinate across the track: 2.5 is the middle of the third lane, 2 its left edge.
    const point = (tick: number, lane: number) => ({ x: box.x + left + lane * laneWidth, y: box.y + box.height - 30 - tick * zoom });
    const click = async (tick: number, lane: number) => { const p = point(tick, lane); await page.mouse.click(p.x, p.y); };
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); };
    type Row = { type: string; tick: number; lane: number; width: number; duration: number; endLane: number; direction?: string; visible?: boolean };
    const notes = (): Promise<Row[]> => page.evaluate(() => (window as any).testEditor.state.chart.notes.map((n: any) => ({ type: n.type, tick: n.tick, lane: n.lane, width: n.width, duration: n.duration, endLane: n.endLane, direction: n.attributes.direction, visible: n.attributes.visible })));
    const status = () => page.locator('.editor-status').textContent();
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    // Note keys: 1 places TAP; 8 places a downward AIR on the note under the pointer.
    await page.locator('.editor-viewport').focus();
    await page.keyboard.press('1'); await click(96, 2.5);
    await page.keyboard.press('8'); await click(96, 2.5);
    assert.deepEqual((await notes()).map(n => [n.type, n.tick, n.lane, n.width, n.direction]), [['TAP', 96, 2, 2, undefined], ['AIR', 96, 2, 2, 'DW']]);
    // Eraser: one click removes the topmost object; a dragged box removes everything it touches.
    await page.keyboard.press('e'); await frame(); assert.match(String(await status()), /橡皮擦/);
    // The AIR arrow floats above its parent, so it is erased by its own arrow and the TAP stays.
    { const arrow = point(96, 2.5); await page.mouse.click(arrow.x, arrow.y - 11); } assert.deepEqual((await notes()).map(n => n.type), ['TAP']);
    await click(96, 2.5); assert.deepEqual(await notes(), []); await page.keyboard.press('1'); await click(96, 2.5);
    await page.keyboard.press('1'); await click(48, 6.5); await click(144, 10.5);
    await page.keyboard.press('e'); await drag(point(24, 1.2), point(168, 12.8));
    assert.deepEqual(await notes(), []);

    // Front-back flip, time scale and left-right mirror act on the selection.
    await page.keyboard.press('1'); await click(48, 0.5); await click(144, 4.5);
    await page.keyboard.press('s'); await page.keyboard.press('Control+a'); await page.keyboard.press('v');
    assert.deepEqual((await notes()).map(n => [n.lane, n.tick]), [[0, 144], [4, 48]]);
    await page.locator('[data-option="scale"]').fill('2'); await page.locator('[data-action="scale"]').click();
    assert.deepEqual((await notes()).map(n => [n.lane, n.tick]), [[0, 240], [4, 48]]);
    await page.locator('.editor-viewport').focus(); await page.keyboard.press('h');
    assert.deepEqual((await notes()).map(n => [n.lane, n.tick]), [[14, 240], [10, 48]]);
    // The left edge resizes against a fixed right edge.
    await page.keyboard.press('Control+Shift+a'); await frame(); assert.doesNotMatch(String(await status()), /已选/);
    const edge = point(48, 10); await drag({ x: edge.x + 1, y: edge.y }, { x: point(48, 8).x, y: edge.y });
    assert.deepEqual((await notes()).map(n => [n.lane, n.width]), [[14, 2], [8, 4]]);

    // 5 draws a SLIDE whose joints are relay points; R turns the straight segment into a control-point curve.
    await page.keyboard.press('5'); await drag(point(288, 0.5), point(480, 6.5));
    assert.deepEqual((await notes()).filter(n => n.type === 'SLIDE').map(n => [n.tick, n.duration, n.lane, n.endLane, n.visible]), [[288, 192, 0, 6, true]]);
    // R opens the shape panel with a live preview; nothing is written until it is confirmed.
    await page.keyboard.press('r'); await frame();
    assert.equal(await page.locator('.editor-shape-panel').isVisible(), true); assert.equal((await notes()).filter(n => n.type === 'SLIDE').length, 1);
    await page.keyboard.press('Enter');
    const curve = (await notes()).filter(n => n.type === 'SLIDE');
    assert.equal(await page.locator('.editor-shape-panel').isVisible(), false); assert.ok(curve.length >= 3); assert.deepEqual([curve[0].lane, curve.at(-1)!.endLane, curve.at(-1)!.tick + curve.at(-1)!.duration], [0, 6, 480]);
    assert.ok(curve.every((segment, index) => index === 0 || segment.lane === curve[index - 1].endLane && segment.tick === curve[index - 1].tick + curve[index - 1].duration));
    assert.deepEqual(curve.map(segment => segment.visible), [...curve.slice(1).map(() => false), true]);

    // Clicking a joint picks the segment that ends there, so the joint itself is edited; a right click removes it and the path closes up.
    const selectedIds = (): Promise<string[]> => page.evaluate(() => [...(window as any).testEditor.editor.selection]);
    const slideIds = (): Promise<{ id: string; tick: number; duration: number; lane: number; endLane: number }[]> => page.evaluate(() => (window as any).testEditor.state.chart.notes.filter((n: any) => n.type === 'SLIDE').map((n: any) => ({ id: n.id, tick: n.tick, duration: n.duration, lane: n.lane, endLane: n.endLane })));
    await page.keyboard.press('s');
    const made = await slideIds(), joint = made[1], jointAt = point(joint.tick + joint.duration, joint.endLane + 1);
    await page.mouse.click(jointAt.x, jointAt.y); assert.deepEqual(await selectedIds(), [joint.id]);
    await page.mouse.click(jointAt.x, jointAt.y, { button: 'right' });
    const closed = await slideIds();
    assert.equal(closed.length, made.length - 1); assert.deepEqual(closed[1], { ...joint, duration: joint.duration + made[2].duration, endLane: made[2].endLane });
    assert.ok(closed.every((segment, index) => index === 0 || segment.lane === closed[index - 1].endLane && segment.tick === closed[index - 1].tick + closed[index - 1].duration));
    // A picked node is edited as a node: its kind, and a position the segments on both sides follow.
    const first = closed[0], nodeAt = point(first.tick + first.duration, first.endLane + 1);
    await page.mouse.click(nodeAt.x, nodeAt.y); assert.equal(await page.locator('[data-property="type"]').count(), 0);
    await page.locator('[data-property="nodeKind"]').selectOption('normal'); await frame();
    assert.equal((await notes()).find(n => n.type === 'SLIDE')!.visible, true);
    await page.locator('[data-property="endLane"]').fill('9'); await page.locator('[data-property="endLane"]').press('Tab');
    const moved = await slideIds(); assert.deepEqual([moved[0].endLane, moved[1].lane, moved.length], [8, 8, closed.length]);
    // The body picks the segment, which has no node kind of its own, and cannot be deleted: only nodes are.
    const bodyAt = point(moved[1].tick + moved[1].duration / 2, (moved[1].lane + moved[1].endLane) / 2 + 1);
    await page.mouse.click(bodyAt.x, bodyAt.y); assert.deepEqual(await selectedIds(), [moved[1].id]);
    assert.equal(await page.locator('[data-property="nodeKind"]').count(), 0); assert.equal(await page.locator('[data-property="type"]').inputValue(), 'SLIDE');
    await page.mouse.click(bodyAt.x, bodyAt.y, { button: 'right' }); assert.equal((await slideIds()).length, moved.length);
    await page.mouse.click(bodyAt.x, bodyAt.y); await page.keyboard.press('Delete'); assert.equal((await slideIds()).length, moved.length);

    await page.keyboard.press('s'); await click(48, 9.5); await page.keyboard.press('Control+c');
    await click(600, 14.5); await page.keyboard.press('Control+Shift+v');
    assert.deepEqual((({ tick, lane, width }) => [tick, lane, width])((await notes()).at(-1)!), [600, 4, 4]);
    // B inserts a BPM event at the cursor; Shift + wheel steps the quantize division.
    const events = (): Promise<string[]> => page.evaluate(() => (window as any).testEditor.state.chart.events.map((event: any) => event.type));
    const before = (await events()).length; await page.keyboard.press('b');
    assert.equal((await events()).length, before + 1); assert.equal((await events()).at(-1), 'BPM');

    // 7 is AIR up; pressing it again leans the arrow left, then right. The toolbar shows the side group only for AIR.
    await page.keyboard.press('1'); await click(720, 2.5);
    await page.keyboard.press('7'); await page.keyboard.press('7'); await click(720, 2.5);
    assert.deepEqual((await notes()).filter(n => n.tick === 720).map(n => [n.type, n.direction]), [['TAP', undefined], ['AIR', 'UL']]);
    assert.equal(await page.locator('.editor-air-side').isVisible(), true);
    assert.equal(await page.locator('[data-tool="AIR"][data-air="IR"]').evaluate(element => element.classList.contains('editor-active')), true);
    assert.equal(await page.locator('[data-tool="AIR"][data-air="DW"]').evaluate(element => element.classList.contains('editor-active')), false);
    await page.locator('[data-tool="AIR"][data-air="DW"]').click(); await page.locator('[data-action="air-side"][data-side="1"]').click();
    await page.keyboard.press('1'); await click(720, 6.5); await page.keyboard.press('8'); await click(720, 6.5);
    assert.deepEqual((await notes()).filter(n => n.tick === 720 && n.type === 'AIR').map(n => n.direction), ['UL', 'DR']);
    assert.equal(await page.locator('.editor-air-side').isVisible(), true); await page.keyboard.press('1'); assert.equal(await page.locator('.editor-air-side').isVisible(), false);
    // An ExTAP dropped on a SLIDE head makes the whole chain EX instead of stacking a note; a second click undoes it.
    const ex = (): Promise<boolean[]> => page.evaluate(() => (window as any).testEditor.state.chart.notes.filter((n: any) => n.type === 'SLIDE').map((n: any) => Boolean(n.attributes.ex)));
    const count = (await notes()).length;
    await page.keyboard.press('2'); await click(288, 1);
    assert.equal((await notes()).length, count); assert.ok((await ex()).every(Boolean));
    await click(288, 1); assert.ok((await ex()).every(value => !value));
    // Insert-node mode: K, then click a long note's body; no selection or cursor is needed, and it stays on until Esc.
    await page.keyboard.press('5'); await drag(point(576, 11), point(672, 11));
    await page.keyboard.press('k'); await click(624, 11); await click(648, 11);
    assert.deepEqual((await notes()).filter(n => n.type === 'SLIDE' && n.lane === 10).map(n => [n.tick, n.duration]), [[576, 48], [624, 24], [648, 24]]);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.editor-toolrow [data-action="split"]').evaluate(element => element.classList.contains('editor-active')), false);
    await page.mouse.move(point(300, 8).x, point(300, 8).y); await page.keyboard.down('Shift'); await page.mouse.wheel(0, 100); await page.keyboard.up('Shift');
    assert.equal(await page.locator('[data-option="snap"]').inputValue(), '24');

    // HOLD / SLIDE bodies are opaque: the gradient uses the joint texture's colours, and a supplied texture replaces it.
    await page.keyboard.press('6'); await drag(point(672, 12.5), point(864, 12.5));
    await page.keyboard.press('s'); await page.mouse.move(box.x + 40, box.y + 40); await frame();
    const pixel = (tick: number, lane: number): Promise<number[]> => page.evaluate(([x, y]) => {
      const element = document.querySelector<HTMLCanvasElement>('.editor-viewport canvas')!, ratio = element.width / element.getBoundingClientRect().width;
      return [...element.getContext('2d')!.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data];
    }, [point(tick, lane).x - box.x, point(tick, lane).y - box.y]);
    assert.equal(await canvas.getAttribute('data-body-textures'), null);
    const hold = await pixel(768, 12.5), slide = await pixel(384, 5.6);
    assert.ok(hold[0] > 230 && hold[1] > 170 && hold[2] < 40, `HOLD body centre ${hold}`);
    assert.ok(slide[0] < 80 && slide[1] > 170 && slide[2] > 220, `SLIDE body centre ${slide}`);
    await page.evaluate(() => {
      const tile = document.createElement('canvas'); tile.width = tile.height = 4;
      const context = tile.getContext('2d')!; context.fillStyle = '#00ff00'; context.fillRect(0, 0, 4, 4);
      (window as any).testEditor.editor.setBodyTextures({ HoldJoint: { dataUrl: tile.toDataURL() } });
    });
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.editor-viewport canvas')?.dataset.bodyTextures === 'game'); await frame();
    const textured = await pixel(768, 12.5);
    assert.ok(textured[0] < 40 && textured[1] > 230 && textured[2] < 40, `HOLD body with a texture ${textured}`);
    // A right click on the last node takes the segment before it; on the head node it takes the whole long note.
    await page.keyboard.press('s');
    const curved = async () => (await slideIds()).filter(n => n.tick < 480);
    const whole = await curved(), last = whole.at(-1)!, lastAt = point(last.tick + last.duration, last.endLane + 1), headAt = point(whole[0].tick, whole[0].lane + 1);
    await page.mouse.click(lastAt.x, lastAt.y, { button: 'right' }); assert.deepEqual((await curved()).map(n => n.id), whole.slice(0, -1).map(n => n.id));
    await page.mouse.click(headAt.x, headAt.y, { button: 'right' }); assert.deepEqual(await curved(), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
