import type { Note, NoteType } from '../core/model';
const rows: Record<NoteType, number> = { TAP:0, EXTAP:4, SLIDE:8, HOLD:16, AIR_HOLD:24, AIR_SLIDE:28, AIR_CRUSH:32, FLICK:36, DAMAGE:40, AIR:48 };
/** Original 32×64 note_icons.png from the official Margrete 1.8.0 package. */
export class MargreteNoteSprites {
  private image?: HTMLImageElement;
  load(ready: () => void): void {
    const image = new Image();
    image.onload = () => { this.image = image; ready(); };
    image.src = new URL('./assets/margrete-note-icons.png', import.meta.url).href;
  }
  draw(c: CanvasRenderingContext2D, note: Note, end: boolean, x: number, y: number, width: number): boolean {
    if (!this.image || width <= 0) return false;
    const type = !end && note.attributes.ex ? 'EXTAP' : note.type;
    const row = rows[type] + (end && (type === 'SLIDE' || type === 'HOLD') ? 4 : 0);
    c.save(); c.imageSmoothingEnabled = false;
    if (type === 'AIR') {
      const down = String(note.attributes.direction ?? '').startsWith('D');
      c.translate(x,y); if (down) c.scale(1,-1);
      c.drawImage(this.image,0,48,12,8,0,-6,width,12);
    } else {
      const height=6, cap=Math.min(3,width/2), middle=width-cap*2;
      c.drawImage(this.image,0,row,2,4,x,y-height/2,cap,height);
      if (middle>0) c.drawImage(this.image,2,row,6,4,x+cap,y-height/2,middle,height);
      c.drawImage(this.image,8,row,2,4,x+width-cap,y-height/2,cap,height);
    }
    c.restore(); return true;
  }
}
