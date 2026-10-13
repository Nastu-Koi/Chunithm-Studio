import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRfz } from '../src/backend/game-font';
import { loadBundledGameResources } from '../src/backend/bundled-assets';
import { displayGameLevel } from '../src/renderer/player-hud';
test('RFZ rejects invalid and truncated input', () => {
  for(const buffer of [Buffer.alloc(0),Buffer.from('YS\x02\x00\x00'),Buffer.from('YS\x03\x00\x00')]) assert.throws(()=>decodeRfz(buffer));
});
test('copied font and combo contain original glyph metrics and self-contained pages', async () => {
  const assets=await loadBundledGameResources('assets/game');
  const font=assets.textures.font!;
  assert.equal(font.height,24); assert.equal(Object.keys(font.glyphs).length,7161); assert.equal(font.pages.length,2);
  assert.equal(font.glyphs['33'].advance,10); assert.equal(font.glyphs['33'].originY,16);
  for(const page of font.pages) assert.ok(page.dataUrl.startsWith('data:image/png;base64,'));
  for(let i=0;i<10;i++) assert.ok(assets.textures.scene!.hud[`mainComboDigit${i}`]);
});
test('HUD formats displayed level without changing decimal metadata',()=>{
  for(const [input,expected] of [['15.2','15'],['15.50','15+'],['14.9','14+'],['15+','15+'],['10','10']]) assert.equal(displayGameLevel(input),expected);
});
