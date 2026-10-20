import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Run after editing assets/icon/*.svg: renders app.png (window icon outside Windows) and app.ico (executable and
// window icon on Windows). Both outputs are committed so building and packaging never need this step.

// The sizes Windows picks from an .ico for its small, medium and large views at 100–200 % display scaling.
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// Up to this size the lane lines and the note blur into the field, so app-small.svg is drawn instead.
const SMALL_MAX = 32;

/**
 * Pack square images into an .ico file. Sizes below 256 are stored as 32-bit bitmaps, which every Windows
 * version reads; 256 is stored as PNG, the form Windows expects at that size.
 * @param {{ size: number, rgba: Buffer, png: Buffer }[]} images
 */
export function encodeIco(images) {
  const bodies = images.map(({ size, rgba, png }) => (size >= 256 ? png : bitmap(size, rgba)));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bodies[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bodies[i].length;
  });
  return Buffer.concat([header, ...bodies]);
}

/** A BITMAPINFOHEADER image as .ico stores it: doubled height, rows bottom-up in BGRA, then a 1-bit transparency mask. */
function bitmap(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + size * maskRow);
  out.writeUInt32LE(40, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8);
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  out.writeUInt32LE(size * size * 4 + size * maskRow, 20);
  const mask = 40 + size * size * 4;
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4,
        to = 40 + (row * size + x) * 4;
      out[to] = rgba[from + 2];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from];
      out[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) out[mask + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** Rasterise a 256-unit SVG straight at the target size, so the vector edges are antialiased for that size. */
async function render(svg, size) {
  const image = sharp(svg, { density: (72 * size) / 256 }).resize(size, size);
  return {
    size,
    rgba: await image.clone().ensureAlpha().raw().toBuffer(),
    png: await image.png({ compressionLevel: 9 }).toBuffer(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/icon');
  const [full, small] = await Promise.all(['app.svg', 'app-small.svg'].map(name => readFile(path.join(dir, name))));
  const images = await Promise.all(ICO_SIZES.map(size => render(size <= SMALL_MAX ? small : full, size)));
  await writeFile(path.join(dir, 'app.ico'), encodeIco(images));
  await writeFile(path.join(dir, 'app.png'), (await render(full, 512)).png);
  console.log(`assets/icon: app.ico (${ICO_SIZES.join(', ')}), app.png (512)`);
}
