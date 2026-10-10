/** Run with a Vite server: CHUNI_UI_URL=http://127.0.0.1:5173 node --import tsx tests/player-we.e2e.mts */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const url = process.env.CHUNI_UI_URL || 'http://127.0.0.1:5173';
const screenshot = process.env.CHUNI_SCREENSHOT_PATH || join(tmpdir(), 'chuni-player-we-proof.png');
const browser = await chromium.launch({ headless: true, ...(process.env.CHUNI_BROWSER ? { executablePath: process.env.CHUNI_BROWSER } : {}), args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__player_we_test__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#player{height:100vh}</style></head><body><main id="player"></main><script type="module">
    import { ChartPlayer } from '/src/renderer/player.ts'; import { createChart, createNote } from '/src/core/model.ts';
    const player=new ChartPlayer(document.querySelector('#player'));
    const chart=createChart(); const first=createNote('TAP',96,0,4), second=createNote('EXTAP',192,0,4);
    chart.notes=[first,second]; chart.events=[{id:'fast',type:'NOTE_SPEED',tick:96,duration:1,value:3},{id:'slow',type:'NOTE_SPEED',tick:192,duration:1,value:.5}];
    player.setChart(chart); const order=[]; const bar=player.bar.bind(player); player.bar=(left,right,color,type)=>{order.push((1/left.scale-1)/1.8);bar(left,right,color,type)};
    player.render(0); player.bar=bar;
    const we=createChart(), slide=createNote('SLIDE',3840,0,4), crush=createNote('AIR_CRUSH',3840,8,4);
    slide.duration=7680;slide.endLane=12;crush.duration=7680;crush.endLane=2;crush.endWidth=8;crush.height=.5;crush.endHeight=1.2;crush.attributes={interval:24,color:'PNK'};
    const decoration=createNote('AIR_CRUSH',96,5,3);decoration.duration=768;decoration.attributes={interval:0,color:'DEF'};
    we.notes=[slide,crush,decoration,...['IR','UL','UR','DW','DL','DR'].map((direction,i)=>({...createNote('AIR',144+i*48,i*2,2),attributes:{direction,parent:'TAP'}}))];
    we.events=[{id:'reverse',type:'SCROLL',tick:3840,duration:1920,value:-3},{id:'bpm',type:'BPM',tick:4860,value:180},{id:'stop',type:'STOP',tick:4800,duration:192,value:0},{id:'group',type:'GROUP_SCROLL',tick:3840,duration:1920,value:-3,group:2},{id:'assign',type:'SCROLL_ASSIGNMENT',tick:3840,duration:7680,lane:8,width:4,value:2,group:2}];
    player.setChart(we);player.title='WE · 停止 / 折返 / 分组 / AIR CRUSH';player.difficulty='WORLD’S END';
    const before=performance.now();for(let i=0;i<180;i++)player.render(i/6);const elapsed=performance.now()-before;
    window.weTest={order,elapsed,frames:180,player};
  </script></body></html>` }));
  await page.goto(`${url}/__player_we_test__`);
  await page.waitForFunction(() => Boolean((window as any).weTest), undefined, { timeout: 15000 });
  const result = await page.evaluate(() => { const { order, elapsed, frames } = (window as any).weTest; return { order, elapsed, frames }; });
  assert.ok(Math.abs(result.order[0] - 1.5) < 1e-8 && Math.abs(result.order[1] - .5) < 1e-8, 'heads must draw far-to-near according to visual distance');
  // ResizeObserver clears the canvas; paint once more after layout before inspecting pixels.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => { (window as any).weTest.player.render(0); resolve(); })));
  const pixel = await page.locator('canvas').evaluate(canvas => [...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(20, 20, 1, 1).data]);
  assert.equal(pixel[3], 255, 'player should have painted an opaque background');
  await page.screenshot({ path: screenshot });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: 'passed', ...result, meanMs: result.elapsed / result.frames, screenshot, errors }));
} finally { await browser.close(); }
