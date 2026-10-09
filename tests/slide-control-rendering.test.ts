import test from 'node:test';
import assert from 'node:assert/strict';
import { parseC2S } from '../src/core/c2s';
import { ChartPlayer } from '../src/renderer/player';
import { getPlayerPlaybackPoints } from '../src/renderer/playback-points';
function capture(firstTag: string) {
  const chart=parseC2S(`VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 120\n${firstTag} 0 0 0 4 96 4 4 SLD\nSLD 0 96 4 4 96 0 4 SLD\n`);
  const calls:any[]=[];
  const player:any=Object.create(ChartPlayer.prototype);
  Object.assign(player,{canvas:{dataset:{}},crushRoots:new Set(),nativeDiagnostics:new Set(),textureLayer:{active:true,quad:(sprite:any)=>calls.push(sprite)},
    bodySprites:new Map([['SlideJoint',{image:{width:128,height:128},x:0,y:0,width:128,height:128}]])});
  player.setChart(chart);
  const points=[{x:0,y:100,scale:1},{x:100,y:100,scale:1},{x:75,y:0,scale:.5},{x:25,y:0,scale:.5}];
  for(const note of chart.notes) player.ribbon(note,{startTick:note.tick,endTick:note.tick+note.duration!,startDistance:0,endDistance:1},points,'#00f');
  return {chart,calls};
}
test('SLC bends the slide without restarting the ribbon texture or drawing a separator',()=>{
  const {chart,calls}=capture('SLC');
  assert.ok(!getPlayerPlaybackPoints(chart,chart.notes[0]).some(p=>p.position==='end'));
  assert.equal(calls[0].y,calls[1].y+calls[1].height,'both sides of the control joint must sample the same native texture row');
  assert.equal(calls[0].height,64);assert.equal(calls[1].height,64);
});
test('SLD retains its bar and restarts the ribbon texture at the normal joint',()=>{
  const {chart,calls}=capture('SLD');
  assert.ok(getPlayerPlaybackPoints(chart,chart.notes[0]).some(p=>p.position==='end'));
  assert.equal(calls[0].y,0);assert.equal(calls[0].height,128);
  assert.equal(calls[1].y,0);assert.equal(calls[1].height,128);
});

import { getSlideUvSpans, slideUvProgress } from '../src/renderer/slide-timing';
test('BPM, reverse scroll, invisible terminal and repeated controls keep one finite phase',()=>{
  const chart=parseC2S('VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 120\nSLC 0 0 0 4 96 4 4 SLD\nBPM 0 96 240\nSFL 0 0 192 -2\nSLC 0 96 4 4 96 0 4 SLD\n');
  const spans=getSlideUvSpans(chart), [a,b]=chart.notes, span=spans.get(a.id)!;
  assert.strictEqual(span,spans.get(b.id)); assert.ok(Math.abs(slideUvProgress(chart,span,96)-2/3)<1e-12);
  assert.equal(slideUvProgress(chart,span,192),1);
  const edited={...chart,notes:chart.notes.map(n=>({...n,attributes:{...n.attributes,visible:true}}))};
  assert.notStrictEqual(getSlideUvSpans(edited).get(a.id),getSlideUvSpans(edited).get(b.id));
});
test('coincident branches consume one current tail in native record order, NCL stays separate',()=>{
  const chart=parseC2S('VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 120\nSLC 0 0 0 4 96 4 4 SLD\nSLC 0 0 8 4 96 4 4 SLD\nSLC 0 0 4 4 96 4 4 NCL\nSLD 0 96 4 4 96 8 4 SLD\nSLD 0 96 4 4 192 0 4 SLD\nSLD 0 96 4 4 288 4 4 NCL\n');
  const [a,b,c,d,e,f]=chart.notes,s=getSlideUvSpans(chart);
  assert.strictEqual(s.get(a.id),s.get(d.id));assert.strictEqual(s.get(b.id),s.get(e.id));assert.strictEqual(s.get(c.id),s.get(f.id));
  assert.notStrictEqual(s.get(a.id),s.get(b.id));assert.notStrictEqual(s.get(b.id),s.get(c.id));
});
