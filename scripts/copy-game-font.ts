import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { decodeGameFont } from '../src/backend/game-font';
import { findEmbeddedDDS } from '../src/backend/game-textures';
import { decodeDDS } from '../src/backend/dds-preview';
import { parseGameEffectProgram } from '../src/backend/game-effects';
import type { GameResourceManifest, StoredGameTexture } from '../src/backend/bundled-assets';
import type { GameTexture } from '../src/core/game-assets';
const root = path.resolve('assets/game'),
  source = '/mnt/d/chunithm/data';
const manifest: GameResourceManifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const hashes: Record<string, string> = JSON.parse(await readFile(path.join(root, 'sha256.json'), 'utf8'));
async function copy(image: GameTexture): Promise<StoredGameTexture> {
  const { dataUrl, ...rest } = image,
    bytes = Buffer.from(dataUrl.split(',')[1], 'base64'),
    hash = createHash('sha256').update(bytes).digest('hex'),
    file = `images/${hash.slice(0, 24)}.png`;
  await writeFile(path.join(root, file), bytes);
  hashes[file] = hash;
  return { ...rest, file };
}
const fontPath = 'A000/font/RFO_SEGAKAKUGOTHIC_DB_24pt.rfz';
const font = await decodeGameFont(await readFile(path.join(source, fontPath)), `data/${fontPath}`);
manifest.textures.font = { ...font, pages: await Promise.all(font.pages.map(copy)) };
const comboSource = 'data/acroarts/chu_count_combo.afb',
  bytes = await readFile(path.join(source, 'acroarts/chu_count_combo.afb'));
const texture = findEmbeddedDDS(bytes)[0],
  decoded = decodeDDS(texture.data),
  png = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } })
    .png()
    .toBuffer();
const image = await copy({
  dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  width: decoded.width,
  height: decoded.height,
  sourcePath: comboSource,
  sourceName: 'chu_count_combo digits',
  sourceOffset: texture.offset,
});
const effect = parseGameEffectProgram(bytes, 'chu_count_combo');
const uvs = effect.extraCommands.filter(c => c.kind === 402).slice(0, 10);
for (let i = 0; i < 10; i++) {
  const words = uvs[i].descriptor.words,
    f = (j: number) => {
      const b = Buffer.alloc(4);
      b.writeInt32LE(words[j]);
      return b.readFloatLE();
    };
  manifest.textures.scene!.hud[`mainComboDigit${i}`] = {
    image,
    rect: {
      x: f(2) * image.width,
      y: f(3) * image.height,
      width: (f(4) - f(2)) * image.width,
      height: (f(5) - f(3)) * image.height,
    },
    sourceLayout: comboSource,
    sourceOffset: uvs[i].offset,
  };
}
await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
hashes['manifest.json'] = createHash('sha256')
  .update(await readFile(path.join(root, 'manifest.json')))
  .digest('hex');
await writeFile(path.join(root, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log({
  font: font.name,
  glyphs: Object.keys(font.glyphs).length,
  pages: font.pages.length,
  comboDigits: uvs.length,
});
