import { _electron as electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadBundledGameResources } from '../src/backend/bundled-assets.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), runtime = process.argv[2];
const output = path.join(root, 'out/screenshots'); await mkdir(output, { recursive: true });
const data = path.resolve(runtime, '..', 'desktop-native-notes-0.1.10'); await mkdir(data, { recursive: true });
const env = { ...process.env, CHUNI_USER_DATA_DIR: data, CHUNI_DEV_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
const resources = await loadBundledGameResources(path.join(root, 'assets/game'));
const app = await electron.launch({ executablePath: path.join(runtime, 'ChuniStudio.exe'), cwd: runtime, env, args: [`--user-data-dir=${data}`] });
const errors = [];
try {
  const page = await app.firstWindow(); await page.goto('about:blank');
  page.on('pageerror', e => errors.push(e.message));
  await page.addScriptTag({ path: path.join(root, 'out/native-notes.bundle.js') });
  await page.evaluate(async serialized => {
    const assets = JSON.parse(serialized);
    document.body.style.cssText = 'margin:0;background:#111';
    const host = document.createElement('div'); host.style.cssText = 'width:1600px;height:900px'; document.body.append(host);
    window.fixturePlayer = new NativeNotes.ChartPlayer(host); await window.fixturePlayer.setGameTextures(assets);
    const original = fixturePlayer.nativeModel.bind(fixturePlayer); window.drawnModels = new Set();
    fixturePlayer.nativeModel = (...args) => { const result = original(...args); if (result) drawnModels.add(args[0]); return result; };
  }, JSON.stringify(resources.textures));
  const scenes = {
    slcVsSld: ['SLC','SLD'].flatMap((kind,side)=>Array.from({length:6},(_,i)=>({
      type:'SLIDE',tick:48+i*48,duration:48,lane:side*8+(i%2)*2,width:3,endLane:side*8+((i+1)%2)*2,
      attributes:{visible:kind==='SLD'||i===5,parent:'SLD'},
    }))),
    overlapping: [
      {type:'HOLD',lane:3,width:6,tick:0,duration:768,attributes:{}},
      {type:'HOLD',lane:6,width:6,tick:96,duration:576,attributes:{}},
      {type:'SLIDE',lane:0,width:4,endLane:12,tick:0,duration:576,attributes:{}},
      {type:'SLIDE',lane:12,width:4,endLane:0,tick:0,duration:576,attributes:{}},
      {type:'TAP',lane:5,width:6,tick:288,attributes:{}},
    ],
    air: ['IR', 'UL', 'UR', 'DW', 'DL', 'DR'].map((direction, i) => ({ type: 'AIR', lane: i * 2.5, width: 2, tick: 96, attributes: { direction } })),
    heads: ['TAP', 'EXTAP', 'FLICK', 'DAMAGE', 'HOLD', 'SLIDE'].map((type, i) => ({ type, lane: i * 2.5, width: 2, tick: 96, duration: ['HOLD', 'SLIDE'].includes(type) ? 192 : undefined, attributes: {} })),
    airChains: [
      { type: 'AIR_HOLD', lane: 0, width: 4, tick: 96, duration: 384, attributes: {} },
      { type: 'AIR_SLIDE', lane: 5, width: 3, endLane: 8, endWidth: 3, height: 5, endHeight: 6, tick: 96, duration: 384, attributes: {} },
      { type: 'AIR_CRUSH', lane: 11, width: 4, height: 5, endHeight: 5, tick: 96, duration: 384, attributes: { interval: 48 } },
    ],
  };
  const report = {};
  for (const [name, notes] of Object.entries(scenes)) {
    report[name] = await page.evaluate(notes => {
      const chart = NativeNotes.createChart(); chart.notes = notes.map((n, i) => ({ ...NativeNotes.createNote(n.type, n.tick, n.lane, n.width), ...n, id: `native-${i}` }));
      drawnModels.clear(); fixturePlayer.setChart(chart); fixturePlayer.render(0, false);
      const canvas = document.querySelector('.player-canvas'); return { renderer: canvas.dataset.noteRenderer, models: Number(canvas.dataset.nativeModels), width: canvas.width, height: canvas.height, drawn: [...drawnModels] };
    }, notes);
    assert.equal(report[name].renderer, 'webgl2'); assert.ok(report[name].models >= 407); assert.ok(report[name].drawn.length > 1, 'Original model meshes must actually draw');
    await page.locator('.player-canvas').screenshot({ path: path.join(output, `native-${name}.png`) });
  }
  report.controlContinuity = await page.evaluate(notes => {
    const chart=NativeNotes.createChart();chart.notes=notes.map((n,i)=>({...NativeNotes.createNote(n.type,n.tick,n.lane,n.width),...n,id:`joint-${i}`}));
    const quads=[], heads=[], draw=fixturePlayer.texturedQuad.bind(fixturePlayer), head=fixturePlayer.nativeHead.bind(fixturePlayer);
    fixturePlayer.texturedQuad=(sprite,...args)=>{if(sprite.image===fixturePlayer.bodySprites.get('SlideJoint').image)quads.push({y:sprite.y,height:sprite.height});return draw(sprite,...args)};
    fixturePlayer.nativeHead=(note,...args)=>{heads.push(note.id);return head(note,...args)};
    fixturePlayer.setChart(chart);fixturePlayer.render(0,false);
    fixturePlayer.texturedQuad=draw;fixturePlayer.nativeHead=head;
    return {quads,heads};
  }, scenes.slcVsSld);
  for(let i=0;i<5;i++) assert.ok(!report.controlContinuity.heads.includes(`joint-${i}`)||i===0,'SLC has no separator head');
  assert.equal(report.controlContinuity.heads.filter(id=>Number(id.split('-')[1])<6).length,2,'SLC chain has only first and final bars');
  assert.equal(report.controlContinuity.heads.filter(id=>Number(id.split('-')[1])>=6).length,7,'SLD chain retains each ordinary bar');
  assert.ok(report.controlContinuity.quads.some(q=>q.height<128/5),'SLC spans share the original texture');
  await page.locator('.player-canvas').screenshot({path:path.join(output,'native-slc-vs-sld.png')});
  report.overlapOrder = await page.evaluate(notes => {
    const chart=NativeNotes.createChart(); chart.notes=notes.map((n,i)=>({...NativeNotes.createNote(n.type,n.tick,n.lane,n.width),...n,id:`overlap-${i}`}));
    chart.events.push({type:'BPM',tick:192,value:180,id:'overlap-bpm'});
    const body=fixturePlayer.ribbon.bind(fixturePlayer), head=fixturePlayer.nativeHead.bind(fixturePlayer), order=[];
    fixturePlayer.ribbon=(...args)=>{order.push('body');return body(...args)};
    fixturePlayer.nativeHead=(...args)=>{order.push('head');return head(...args)};
    fixturePlayer.setChart(chart); fixturePlayer.title='神威';fixturePlayer.level='15.2';fixturePlayer.render(0,false);
    fixturePlayer.ribbon=body;fixturePlayer.nativeHead=head;
    return {order,fontGlyphs:Object.keys(fixturePlayer.hudFont.font.glyphs).length, cachedTiles:fixturePlayer.hudFont.tinted.size};
  }, scenes.overlapping);
  assert.ok(report.overlapOrder.order.lastIndexOf('body') < report.overlapOrder.order.indexOf('head'),'Overlapping ground bodies must all draw before heads');
  assert.equal(report.overlapOrder.fontGlyphs,7161); assert.ok(report.overlapOrder.cachedTiles<1024);
  await page.locator('.player-canvas').screenshot({path:path.join(output,'native-overlapping-bpm.png')});
  report.effects = await page.evaluate(() => {
    const chart = NativeNotes.createChart(); chart.notes = ['TAP', 'EXTAP', 'FLICK', 'HOLD', 'SLIDE', 'AIR', 'AIR_HOLD', 'AIR_SLIDE', 'AIR_CRUSH'].map((type, i) => ({ ...NativeNotes.createNote(type, 96, i % 4 * 4, 4), id: `effect-${i}` }));
    fixturePlayer.setChart(chart); fixturePlayer.render(.58, false);
    return { primitives: Number(document.querySelector('.player-canvas').dataset.nativeEffectPrimitives), diagnostics: fixturePlayer.getResourceDiagnostics() };
  });
  assert.ok(report.effects.primitives > 0, 'Original effect programs must draw visible primitives');
  await page.locator('.player-canvas').screenshot({ path: path.join(output, 'native-effects.png') });
  report.denseEffects = await page.evaluate(() => {
    const chart = NativeNotes.createChart(); chart.notes = Array.from({ length: 128 }, (_, i) => ({ ...NativeNotes.createNote('TAP', 96, i % 4 * 4, 4), id: `dense-${i}` }));
    fixturePlayer.setChart(chart); fixturePlayer.render(.58, false);
    return { primitives: Number(document.querySelector('.player-canvas').dataset.nativeEffectPrimitives), total: fixturePlayer.getJudgements().total };
  });
  assert.equal(report.denseEffects.primitives, 4096, 'Dense effects must share one frame budget');
  assert.equal(report.denseEffects.total, 128, 'The effect budget must not cut scoring');
  assert.deepEqual(errors, []); await writeFile(path.join(root, 'out/native-note-rendering.json'), JSON.stringify({ report, errors }, null, 2));
  console.log(JSON.stringify({ report, errors }));
} finally { await app.close(); }
