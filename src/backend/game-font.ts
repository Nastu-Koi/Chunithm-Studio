import { parseYabx } from './game-animation';
import { findEmbeddedDDS } from './game-textures';
import { decodeDDS } from './dds-preview';
import sharp from 'sharp';
import type { GameBitmapFont } from '../core/game-assets';

/** Yabukita RFZ: MSB LZW, early width change and implicit reset at 4094. */
export function decodeRfz(bytes: Buffer): Buffer {
  if (bytes.length < 5 || bytes.toString('ascii', 0, 2) !== 'YS' || bytes[2] !== 2 || bytes[3] !== 0)
    throw new Error('RFZ 头无效');
  let offset = 4,
    bits = 9,
    pending = 0,
    count = 0,
    previous: Buffer | undefined;
  let dictionary = Array.from({ length: 256 }, (_, i) => Buffer.from([i]));
  const chunks: Buffer[] = [];
  let length = 0;
  while (offset < bytes.length || count >= bits) {
    while (count < bits && offset < bytes.length) {
      pending = pending * 256 + bytes[offset++];
      count += 8;
    }
    if (count < bits) break;
    count -= bits;
    const code = pending >>> count;
    pending &= (1 << count) - 1;
    if (code > dictionary.length || (!previous && code >= 256)) throw new Error('RFZ LZW 码无效');
    const chunk = dictionary[code] ?? Buffer.concat([previous!, previous!.subarray(0, 1)]);
    chunks.push(chunk);
    length += chunk.length;
    if (length > 128 * 1024 * 1024) throw new Error('RFZ 解压体积超限');
    if (!previous) {
      previous = chunk;
      continue;
    }
    if (dictionary.length === 4094) {
      dictionary = dictionary.slice(0, 256);
      bits = 9;
      previous = undefined;
      continue;
    }
    const old = dictionary.length;
    dictionary.push(Buffer.concat([previous, chunk.subarray(0, 1)]));
    previous = chunk;
    if (old + 2 === 1 << bits) bits++;
  }
  const data = Buffer.concat(chunks, length);
  if (data.length < 16 || data.toString('ascii', 0, 4) !== 'YABX' || data.readUInt32LE(8) + 16 !== data.length)
    throw new Error('RFZ 数据不完整');
  return data;
}
export async function decodeGameFont(bytes: Buffer, sourcePath: string): Promise<GameBitmapFont> {
  const data = decodeRfz(bytes),
    document = parseYabx(data, ['ruhuna::TextureResource']),
    root = document.objects[0];
  if (root.className !== 'ruhuna::Database') throw new Error('RFZ 根类型无效');
  const value = (key: string) => root.fields[key].data.readUInt16LE();
  const font: GameBitmapFont = {
    name: document.name,
    height: value('max_ascent') + value('max_descent'),
    ascent: value('max_ascent'),
    pages: [],
    glyphs: {},
  };
  for (const entry of findEmbeddedDDS(data)) {
    const decoded = decodeDDS(entry.data),
      png = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } })
        .png()
        .toBuffer();
    font.pages.push({
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: decoded.width,
      height: decoded.height,
      sourcePath,
      sourceName: `${document.name}-page${font.pages.length}`,
      sourceOffset: entry.offset,
    });
  }
  for (const object of document.objects.filter(o => o.className === 'ruhuna::Glyph')) {
    const v = (key: string) => object.fields[key].data.readUInt16LE();
    const page = v('page'),
      x = v('box_x1'),
      y = v('box_y1'),
      width = v('box_x2') - x,
      height = v('box_y2') - y;
    if (
      page !== 65535 &&
      (!font.pages[page] || x + width > font.pages[page].width || y + height > font.pages[page].height)
    )
      throw new Error('RFZ 字形越界');
    font.glyphs[String(v('code'))] = {
      advance: v('cell_inc_x'),
      page,
      originX: object.fields.origin_x.data.readInt16LE(),
      originY: object.fields.origin_y.data.readInt16LE(),
      x,
      y,
      width,
      height,
    };
  }
  if (Object.keys(font.glyphs).length !== value('glyph_cnt') || font.pages.length !== value('tex_page'))
    throw new Error('RFZ 字形或页数不一致');
  return font;
}
