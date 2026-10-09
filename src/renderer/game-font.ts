import type { GameBitmapFont, GameTexture } from '../core/game-assets';
/** Draw the copied RFZ glyphs; no system-font substitution for existing glyphs. */
export class NativeHudFont {
  private tinted = new Map<string, HTMLCanvasElement>();
  private constructor(private font: GameBitmapFont, private pages: HTMLImageElement[]) {}
  static async load(font: GameBitmapFont, decode: (texture: GameTexture) => Promise<HTMLImageElement | undefined>): Promise<NativeHudFont | undefined> {
    const pages = await Promise.all(font.pages.map(decode));
    return pages.every(Boolean) ? new NativeHudFont(font, pages as HTMLImageElement[]) : undefined;
  }
  private scale(c: CanvasRenderingContext2D): number { return Number(c.font.match(/([\d.]+)px/)?.[1] ?? 24) / this.font.height; }
  measure(c: CanvasRenderingContext2D, text: string): number {
    return [...text].reduce((w, ch) => w + (this.font.glyphs[String(ch.codePointAt(0))]?.advance ?? this.font.glyphs['63'].advance), 0) * this.scale(c);
  }
  draw(c: CanvasRenderingContext2D, text: string, x: number, baseline: number, maxWidth = Infinity): void {
    const size = this.scale(c), width = this.measure(c,text), sx = size * Math.min(1,maxWidth / Math.max(1,width)), actualWidth = width * sx / size;
    let pen = x - (c.textAlign === 'center' ? actualWidth/2 : c.textAlign === 'right' || c.textAlign === 'end' ? actualWidth : 0);
    const color = typeof c.fillStyle === 'string' ? c.fillStyle : '#fff';
    for (const ch of text) {
      const code = this.font.glyphs[String(ch.codePointAt(0))] ? String(ch.codePointAt(0)) : '63';
      const glyph = this.font.glyphs[code];
      if (glyph.page !== 65535 && glyph.width > 0 && glyph.height > 0) {
        const key = `${color}:${code}`;
        let tile = this.tinted.get(key);
        if (!tile) {
          // Cache small glyph tiles, never a multi-megabyte atlas per text color.
          tile = document.createElement('canvas'); tile.width = glyph.width; tile.height = glyph.height;
          const ctx = tile.getContext('2d')!;
          ctx.drawImage(this.pages[glyph.page], glyph.x, glyph.y, glyph.width, glyph.height, 0, 0, glyph.width, glyph.height);
          ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = color; ctx.fillRect(0, 0, tile.width, tile.height);
          if (this.tinted.size >= 1024) this.tinted.delete(this.tinted.keys().next().value!);
        } else this.tinted.delete(key);
        this.tinted.set(key, tile);
        c.drawImage(tile, pen + glyph.originX * sx, baseline - glyph.originY * size, glyph.width * sx, glyph.height * size);
      }
      pen += glyph.advance * sx;
    }
  }
}
