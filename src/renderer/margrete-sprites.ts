import type { Note, NoteType } from '../core/model';
const rows: Record<NoteType, number> = {
  TAP: 0,
  EXTAP: 4,
  SLIDE: 8,
  HOLD: 16,
  AIR_HOLD: 24,
  AIR_SLIDE: 28,
  AIR_CRUSH: 32,
  FLICK: 36,
  DAMAGE: 40,
  AIR: 48,
};
/** Green bar under the arrows: the action node of an AIR HOLD / AIR SLIDE. */
const AIR_ACTION_ROW = 44;
/** Height of a ground note bar; an AIR arrow floats this far above its parent so the parent stays readable. */
export const NOTE_BAR_HEIGHT = 6;
const AIR_GAP = 2;
/** The arrow grows with wide notes (12 to 20 px) so its chevron stays readable instead of flattening. */
export const airArrowHeight = (width: number) => Math.max(12, Math.min(20, width * 0.2));
/** Distance from a note's time line up to the centre of its AIR arrow. */
export const airArrowLift = (width: number) => NOTE_BAR_HEIGHT / 2 + AIR_GAP + airArrowHeight(width) / 2;
/** -1 left, 0 straight, 1 right. `IR` (straight up) also ends in R, so compare whole tokens. */
export const airSide = (direction: unknown): -1 | 0 | 1 =>
  direction === 'UL' || direction === 'DL' ? -1 : direction === 'UR' || direction === 'DR' ? 1 : 0;
export const airDown = (direction: unknown) => String(direction ?? '').startsWith('D');
/** How far the tip of a diagonal arrow leans away from the base. */
export const airLean = (width: number) => Math.min(width * 0.3, airArrowHeight(width) * 1.5);
/** Original 32×64 note_icons.png from the official Margrete 1.8.0 package. */
export class MargreteNoteSprites {
  private image?: HTMLImageElement;
  load(ready: () => void): void {
    const image = new Image();
    image.onload = () => {
      this.image = image;
      ready();
    };
    image.src = new URL('./assets/margrete-note-icons.png', import.meta.url).href;
  }
  /** `y` is the centre of the sprite; AIR callers pass the lifted arrow centre. */
  draw(c: CanvasRenderingContext2D, note: Note, end: boolean, x: number, y: number, width: number): boolean {
    if (!this.image || width <= 0) return false;
    const type = !end && note.attributes.ex ? 'EXTAP' : note.type;
    c.save();
    c.imageSmoothingEnabled = false;
    if (type === 'AIR') this.arrow(c, String(note.attributes.direction ?? 'IR'), x, y, width);
    else
      this.bar(
        c,
        end && (type === 'AIR_HOLD' || type === 'AIR_SLIDE')
          ? AIR_ACTION_ROW
          : rows[type] + (end && (type === 'SLIDE' || type === 'HOLD') ? 4 : 0),
        x,
        y,
        width,
      );
    c.restore();
    return true;
  }
  /** Green for the up family, magenta for the down family; diagonals shear the same sprite about its centre. */
  drawArrow(c: CanvasRenderingContext2D, direction: string, x: number, y: number, width: number): boolean {
    if (!this.image || width <= 0) return false;
    c.save();
    c.imageSmoothingEnabled = false;
    this.arrow(c, direction, x, y, width);
    c.restore();
    return true;
  }
  private arrow(c: CanvasRenderingContext2D, direction: string, x: number, y: number, width: number): void {
    const down = airDown(direction),
      height = airArrowHeight(width);
    // Screen-space shear: the tip (top for up, bottom for down) moves toward the side, the base moves the other way.
    c.translate(x + width / 2, y);
    c.transform(1, 0, ((down ? 1 : -1) * airSide(direction) * airLean(width)) / height, 1, 0, 0);
    if (down) c.scale(1, -1);
    c.drawImage(this.image!, 0, down ? 56 : 48, 12, 8, -width / 2, -height / 2, width, height);
  }
  private bar(c: CanvasRenderingContext2D, row: number, x: number, y: number, width: number): void {
    const height = NOTE_BAR_HEIGHT,
      cap = Math.min(3, width / 2),
      middle = width - cap * 2;
    c.drawImage(this.image!, 0, row, 2, 4, x, y - height / 2, cap, height);
    if (middle > 0) c.drawImage(this.image!, 2, row, 6, 4, x + cap, y - height / 2, middle, height);
    c.drawImage(this.image!, 8, row, 2, 4, x + width - cap, y - height / 2, cap, height);
  }
}
