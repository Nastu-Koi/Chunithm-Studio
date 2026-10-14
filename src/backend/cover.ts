import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decodeDDS } from './dds-preview';

/** A cover image file as a sharp pipeline; DDS jackets from the game are decoded first. */
async function coverImage(file: string): Promise<sharp.Sharp> {
  const bytes = await readFile(file);
  if (path.extname(file).toLowerCase() !== '.dds') return sharp(bytes);
  const decoded = decodeDDS(bytes);
  return sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
}

/** The cover for display: a PNG data URL that fits within 512 × 512. */
export async function coverPreview(file: string): Promise<string> {
  const image = await coverImage(file);
  return (
    'data:image/png;base64,' + (await image.resize(512, 512, { fit: 'inside' }).png().toBuffer()).toString('base64')
  );
}

/** The cover for export: 512 × 512 RGBA pixels. */
export async function coverRgba(file: string): Promise<{ rgba: Buffer; width: number; height: number }> {
  const image = await coverImage(file);
  const { data, info } = await image.resize(512, 512).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, width: info.width, height: info.height };
}
