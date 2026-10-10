/** Requires Vite and the copied assets/game bundle; never reads the game installation. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { loadBundledGameResources } from '../src/backend/bundled-assets';

const url = process.env.CHUNI_UI_URL || 'http://127.0.0.1:5173';
const assets = (await loadBundledGameResources(path.resolve('assets/game'))).textures;
const screenshot = process.env.CHUNI_SCREENSHOT_PATH || path.join(tmpdir(), 'chuni-player-textures-proof.png');
const browser = await chromium.launch({ headless: true, ...(process.env.CHUNI_BROWSER ? { executablePath: process.env.CHUNI_BROWSER } : {}), args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [], forbiddenRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/file:|[dD]:[\\/]|\/mnt\/d\//.test(request.url())) forbiddenRequests.push(request.url()); });
  await page.route('**/__player_textures_assets__', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(assets) }));
  await page.route('**/__player_textures_test__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>body{margin:0}#player{height:100vh}</style><main id="player"></main><script type="module">
    import { ChartPlayer } from '/src/renderer/player.ts'; import { createChart,createNote } from '/src/core/model.ts';
    const assets=await(await fetch('/__player_textures_assets__')).json(),player=new ChartPlayer(document.querySelector('#player'));
    const result=await player.setGameTextures(assets),chart=createChart();
    chart.notes=['TAP','EXTAP','FLICK','DAMAGE'].map((type,i)=>createNote(type,48,i*4,4));
    const hold=createNote('HOLD',144,0,4),slide=createNote('SLIDE',144,6,4),air=createNote('AIR_HOLD',192,10,4);
    hold.duration=192;slide.duration=288;slide.endLane=1;slide.endWidth=8;air.duration=192;
    chart.notes.push(hold,slide,air,createNote('TAP',192,5,1),createNote('TAP',432,0,16));
    player.setChart(chart);player.title='原版资源副本 · 音符 / 长条 / 判定线';
    const c=player.canvas.getContext('2d'),draw=c.drawImage.bind(c),used=new Set();c.drawImage=(image,...rest)=>{used.add(image.src);draw(image,...rest)};
    player.render(0); const sources=[...used];
    const required=['NotesTap_01','NotesTap_04','NotesTap_16','NotesChara_04','NotesFlick_04','NotesMine_04','NotesHold_04','NotesSlide_04','NotesAirHold_Tap_04','GoalLine'];
    const drawn=required.filter(key=>sources.includes(assets.models[key].images[0].dataUrl));
    const bodies=['HoldJoint','SlideJoint','AirHoldLine'].filter(key=>sources.includes(assets.textures[key].dataUrl));
    player.clearGameTextures();used.clear();player.render(0);const clearedCalls=used.size;
    const pending=player.setGameTextures(assets);player.clearGameTextures();await pending;used.clear();player.render(0);const staleCalls=used.size;
    const damaged={...assets,models:{NotesTap_04:{images:[{...assets.models.NotesTap_04.images[0],dataUrl:'data:image/png;base64,broken'}]},NotesFlick_04:assets.models.NotesFlick_04},textures:{},effects:{}};
    const missing=await player.setGameTextures(damaged);used.clear();player.render(0);const fallbackHasFlick=used.has(assets.models.NotesFlick_04.images[0].dataUrl);
    await player.setGameTextures(assets);
    const we=createChart(),reverse=createNote('SLIDE',3840,0,4),crush=createNote('AIR_CRUSH',3840,8,4);
    reverse.duration=7680;reverse.endLane=12;crush.duration=7680;crush.endLane=2;crush.attributes.interval=24;
    we.notes=[reverse,crush];we.events=[{id:'reverse',type:'SCROLL',tick:3840,duration:1920,value:-3},{id:'stop',type:'STOP',tick:4800,duration:192,value:0},{id:'bpm',type:'BPM',tick:4860,value:180},{id:'group',type:'GROUP_SCROLL',tick:3840,duration:1920,value:-3,group:2},{id:'assign',type:'SCROLL_ASSIGNMENT',tick:3840,duration:7680,lane:8,width:4,value:2,group:2}];
    player.setChart(we);used.clear();const before=performance.now();for(let i=0;i<180;i++)player.render(i/6);const elapsed=performance.now()-before;
    const weBodies=['SlideJoint','AirLadderLine'].filter(key=>used.has(assets.textures[key].dataUrl));
    player.setChart(chart);window.textureTest={result,drawn,bodies,clearedCalls,staleCalls,missing,fallbackHasFlick,weBodies,elapsed,player};
  </script>` }));
  await page.goto(`${url}/__player_textures_test__`);
  await page.waitForFunction(() => Boolean((window as any).textureTest), undefined, { timeout: 30000 });
  const result = await page.evaluate(() => { const { player, ...result } = (window as any).textureTest; return result; });
  assert.ok(result.result.loaded >= 100); assert.deepEqual(result.result.failed, []);
  assert.equal(result.drawn.length, 10); assert.deepEqual(result.bodies, ['HoldJoint', 'SlideJoint', 'AirHoldLine']);
  assert.equal(result.clearedCalls, 0); assert.equal(result.staleCalls, 0);
  assert.equal(result.missing.loaded, 1); assert.equal(result.missing.failed.length, 1); assert.match(result.missing.failed[0], /NotesTap_04/); assert.equal(result.fallbackHasFlick, true);
  assert.deepEqual(result.weBodies, ['SlideJoint', 'AirLadderLine']);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => { (window as any).textureTest.player.render(0); resolve(); })));
  await page.screenshot({ path: screenshot });
  assert.deepEqual(errors, []); assert.deepEqual(forbiddenRequests, []);
  console.log(JSON.stringify({ ...result, meanMs: result.elapsed / 180, screenshot, errors, forbiddenRequests }));
} finally { await browser.close(); }
