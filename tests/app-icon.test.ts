import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// @ts-expect-error plain script module without type declarations
import { encodeIco, ICO_SIZES } from '../scripts/build-icon.mjs';
import { appTemplate } from '../src/renderer/app-template';

const iconDir = new URL('../assets/icon/', import.meta.url);

test('an .ico bitmap stores rows bottom-up in BGRA and marks fully transparent pixels in its mask', () => {
  // Top row: red, green; bottom row: blue, transparent.
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
  const ico = encodeIco([{ size: 2, rgba, png: Buffer.alloc(0) }]);
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4)], [1, 1]);
  assert.deepEqual([ico[6], ico[7], ico.readUInt16LE(12)], [2, 2, 32]);
  const offset = ico.readUInt32LE(18);
  assert.equal(ico.length - offset, ico.readUInt32LE(14));
  assert.equal(ico.readInt32LE(offset + 8), 4, 'height counts the mask as a second image');
  const pixels = [...ico.subarray(offset + 40, offset + 56)];
  assert.deepEqual(pixels, [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 0, 255, 0, 255]);
  assert.deepEqual([ico[offset + 56], ico[offset + 60]], [0b0100_0000, 0], 'only the transparent pixel is masked');
});

test('the app icon holds every size Windows asks for, with 256 as PNG', async () => {
  const ico = await readFile(new URL('app.ico', iconDir));
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => ico[6 + 16 * i] || 256);
  assert.deepEqual(sizes, ICO_SIZES);
  for (let i = 0; i < count; i++) {
    const length = ico.readUInt32LE(6 + 16 * i + 8),
      offset = ico.readUInt32LE(6 + 16 * i + 12);
    assert.ok(offset + length <= ico.length, `entry ${sizes[i]} lies inside the file`);
    const png = ico.subarray(offset, offset + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(png, sizes[i] === 256, `entry ${sizes[i]} format`);
  }
});

test('the header mark draws the same shapes as the small app icon', async () => {
  const small = await readFile(new URL('app-small.svg', iconDir), 'utf8');
  const mark = appTemplate.match(/<svg class="brand-mark".*?<\/svg>/)?.[0] ?? '';
  for (const shape of ['points="20,212 236,212 172,124 84,124"', 'M80,96 L128,48 L176,96'])
    assert.ok(small.includes(shape), shape);
  assert.ok(mark.includes('points="20,212 236,212 172,124 84,124"'), 'field');
  assert.ok(mark.includes('d="M80,96 128,48 176,96"'), 'AIR arrow');
  assert.ok(mark.includes('aria-hidden="true"'), 'the product name beside it is the accessible text');
});
