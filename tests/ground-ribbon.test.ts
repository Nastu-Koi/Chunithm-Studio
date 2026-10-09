import test from 'node:test';
import assert from 'node:assert/strict';
import { ChartPlayer } from '../src/renderer/player';
import { createNote } from '../src/core/model';
for (const type of ['HOLD', 'SLIDE'] as const) test(`${type} overlap uses native additive blending and unchanged longitudinal UV`, () => {
  const calls: any[] = [];
  const image = { width: 128, height: 128 };
  const player: any = { textureLayer: { active: true, quad: (sprite: any, points: any, paint: any) => calls.push({sprite,points,paint}) },
    bodySprites: new Map([[type === 'HOLD' ? 'HoldJoint' : 'SlideJoint', { image, x:0,y:0,width:128,height:128 }]]),
    texturedQuad: (ChartPlayer.prototype as any).texturedQuad };
  const note = createNote(type, 96, 4, 4); note.duration = 384;
  const points = [{x:0,y:100,scale:1},{x:100,y:100,scale:1},{x:75,y:0,scale:.5},{x:25,y:0,scale:.5}];
  (ChartPlayer.prototype as any).ribbon.call(player,note,{startTick:192,endTick:384,startDistance:0,endDistance:2},points,'#ff0');
  assert.equal(calls[0].paint?.blendSource,4,'native source factor is SRC_ALPHA');
  assert.equal(calls[0].paint?.blendDestination,1,'overlaps must add, not erase the previous ribbon');
  assert.equal(calls[0].paint?.blendOperation,0);
  assert.equal(calls[0].sprite.y,32); assert.equal(calls[0].sprite.height,64);
  assert.deepEqual(calls[0].points,[points[3],points[2],points[1],points[0]]);
});
