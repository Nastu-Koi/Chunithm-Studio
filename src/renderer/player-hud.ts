import type { NativeHudFont } from './game-font';
export interface HudSprite {
  image: HTMLImageElement; x: number; y: number; width: number; height: number;
  /** Static placement of the original SRD cast at 1920×1080, when the copy records one. */
  layout?: { x: number; y: number; width: number; height: number };
}
export interface HudMetadata {
  title: string; artist: string; difficulty: string; level: string; weTag: string; stars: number;
  scoreStatus: 'native' | 'estimated' | 'unsupported'; headerMatched: boolean;
  cover?: HTMLImageElement; score: number; combo: number; total: number; speed: number; font?: NativeHudFont;
}
type Drawable = { image: CanvasImageSource; x: number; y: number; width: number; height: number };
const difficultyKeys: Record<string, string> = { BASIC: 'Basic', ADVANCED: 'Advanced', EXPERT: 'Expert', MASTER: 'Master', ULTIMA: 'Ultima', 'WORLD’S END': 'WorldsEnd' };
const difficultyColors: Record<string, string> = { BASIC: '#00a87c', ADVANCED: '#ef8000', EXPERT: '#e62c34', MASTER: '#821ad0', ULTIMA: '#211c24', 'WORLD’S END': '#ca299c' };
function image(c: CanvasRenderingContext2D, sprite: Drawable | undefined, x: number, y: number, w?: number, h?: number): boolean {
  if (!sprite) return false;
  c.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height, x, y, w ?? sprite.width, h ?? sprite.height); return true;
}
/** Draws a sprite at the static placement of its original SRD cast. */
function placed(c: CanvasRenderingContext2D, sprite: HudSprite | undefined, offsetX = 0): boolean {
  return !!sprite?.layout && image(c, sprite, sprite.layout.x + offsetX, sprite.layout.y, sprite.layout.width, sprite.layout.height);
}
const tints = new WeakMap<HTMLImageElement, Map<string, HTMLCanvasElement>>();
/** Cast colour multiplied into a white atlas sprite, cached as a small tile. */
function tinted(sprite: HudSprite, color: string): Drawable {
  let tiles = tints.get(sprite.image);
  if (!tiles) { tiles = new Map(); tints.set(sprite.image, tiles); }
  const key = `${color}:${sprite.x}:${sprite.y}:${sprite.width}:${sprite.height}`;
  let tile = tiles.get(key);
  if (!tile) {
    tile = document.createElement('canvas'); tile.width = Math.round(sprite.width); tile.height = Math.round(sprite.height);
    const t = tile.getContext('2d')!, draw = () => t.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height, 0, 0, tile!.width, tile!.height);
    draw(); t.globalCompositeOperation = 'multiply'; t.fillStyle = color; t.fillRect(0, 0, tile.width, tile.height);
    t.globalCompositeOperation = 'destination-in'; draw(); tiles.set(key, tile);
  }
  return { image: tile, x: 0, y: 0, width: tile.width, height: tile.height };
}
function fitText(c: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, font?: NativeHudFont): void {
  let output = text;
  while (output.length > 1 && (font ? font.measure(c, output) : c.measureText(output).width) > width) output = output.slice(0, -2) + '…';
  if(font) font.draw(c, output, x, y); else c.fillText(output, x, y);
}
/** Cell sizes and spacing of an original CNUM cast; `symbol` is its comma or decimal point, bottom-aligned to the cell and lowered by `drop`. */
interface NumberCast { digit: string; cell: [width: number, height: number]; spacing: number; symbol?: [key: string, width: number, height: number, spacing: number, drop: number]; scale?: number; color?: string }
const numbers = {
  combo: { digit: 'comboDigit', cell: [24, 32], spacing: -4, scale: .9 },
  score: { digit: 'scoreDigit', cell: [24, 32], spacing: -4, symbol: ['scoreComma', 12, 32, -4, 7], scale: .9 },
  judge: { digit: 'judgeDigit', cell: [12, 14], spacing: -2 },
  speed: { digit: 'judgeDigit', cell: [12, 14], spacing: -2, symbol: ['speedDot', 6, 8, 0, 4], color: '#c8c8c8' },
  level: { digit: 'levelDigit', cell: [28, 42], spacing: -4 },
  mainCombo: { digit: 'mainComboDigit', cell: [204.8, 128], spacing: 0, scale: .62 },
} satisfies Record<string, NumberCast>;
/** Fixed digit cells with the original overlap. `anchor` 0.5 centres the number on x, 0 starts it there. */
function number(c: CanvasRenderingContext2D, sprites: ReadonlyMap<string, HudSprite>, cast: NumberCast, text: string, x: number, centerY: number, anchor = .5): boolean {
  const scale = cast.scale ?? 1;
  const glyphs = [...text].map(ch => /\d/.test(ch) ? { sprite: sprites.get(cast.digit + ch), width: cast.cell[0], height: cast.cell[1], spacing: cast.spacing, drop: 0 }
    : { sprite: cast.symbol && sprites.get(cast.symbol[0]), width: cast.symbol?.[1] ?? 0, height: cast.symbol?.[2] ?? 0, spacing: cast.symbol?.[3] ?? 0, drop: cast.symbol?.[4] ?? 0 });
  if (!glyphs.length || glyphs.some(glyph => !glyph.sprite)) return false;
  const width = glyphs.reduce((total, glyph, index) => total + glyph.width + (index ? glyphs[index - 1].spacing : 0), 0) * scale;
  let pen = x - width * anchor;
  for (const glyph of glyphs) {
    image(c, cast.color ? tinted(glyph.sprite!, cast.color) : glyph.sprite, pen, centerY + (cast.cell[1] / 2 - glyph.height + glyph.drop) * scale, glyph.width * scale, glyph.height * scale);
    pen += (glyph.width + glyph.spacing) * scale;
  }
  return true;
}
/** Fixed game-space HUD. Sprite placements are the static SRD casts listed in docs/game-scene-assets.md. */
export function drawPlayerHud(c: CanvasRenderingContext2D, sprites: ReadonlyMap<string, HudSprite>, data: HudMetadata): void {
  const text = (value: string, x: number, y: number, maxWidth?: number) => data.font ? data.font.draw(c,value,x,y,maxWidth) : c.fillText(value,x,y,maxWidth);
  c.save(); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  const key = difficultyKeys[data.difficulty] ?? 'Master', color = difficultyColors[data.difficulty] ?? '#821ad0';

  // L_Playing_difficulty: left banner, judgement strip and the shadow slice behind the frame.
  if (!image(c, sprites.get(`banner${key}`), 0, 0, 586, 182)) { c.fillStyle = color; c.fillRect(0, 0, 586, 182); }
  const strip = placed(c, sprites.get('judgeHeader'));
  if (!strip) { c.fillStyle = '#171c20'; c.fillRect(578, 0, 764, 36); }
  const [shadowLeft, shadowCenter, shadowRight] = ['Left', 'Center', 'Right'].map(side => sprites.get(`frameShadow${side}`));
  if (shadowLeft?.layout && shadowCenter && shadowRight) {
    const { x, y, width, height } = shadowLeft.layout;
    image(c, shadowLeft, x, y, shadowLeft.width, height); image(c, shadowCenter, x + shadowLeft.width, y, width - shadowLeft.width - shadowRight.width, height);
    image(c, shadowRight, x + width - shadowRight.width, y, shadowRight.width, height);
  }
  // NUM_jctirical / NUM_ctirical / NUM_attack / NUM_miss: cast centre and colour. Autoplay judges everything JC.
  const judges = [['JUSTICE CRITICAL', data.combo, 802, '#f0ca22'], ['JUSTICE', 0, 968, '#fb8500'], ['ATTACK', 0, 1135, '#03d308'], ['MISS', 0, 1286, '#95a4a9']] as const;
  c.font = '15px sans-serif'; c.textAlign = 'center';
  judges.forEach(([label, count, centerX, judgeColor], i) => {
    if (strip && number(c, sprites, { ...numbers.judge, color: judgeColor }, String(count), centerX, 20)) return;
    c.fillStyle = judgeColor; text(strip ? String(count) : `${label} : ${count}`, strip ? centerX : 588 + 738 / 4 * (i + .5), 25, 176);
  });
  drawPlate(c, sprites, text);

  // L_Playing_music: original difficulty card; text and jacket are supplied by the current project.
  const cardX = 1334, cardY = 0;
  if (!image(c, sprites.get(`music${key}`), cardX, cardY, 586, 182)) {
    c.fillStyle = color; c.fillRect(cardX, cardY, 586, 182); c.fillStyle = '#fff'; c.font = 'bold 34px "Segoe UI",sans-serif'; c.textAlign = 'left'; text(data.difficulty, cardX + 151, 103);
    c.fillStyle = '#fff'; c.fillRect(cardX + 4, 116, 578, 63);
  }
  const coverX = 1373, coverY = 51;
  if (data.cover) c.drawImage(data.cover, coverX, coverY, 116, 116);
  else { c.fillStyle = '#dedfd9'; c.fillRect(coverX, coverY, 116, 116); c.fillStyle = '#737777'; c.font = '48px "Segoe UI",sans-serif'; c.textAlign = 'center'; text('♪', coverX + 58, coverY + 78); }
  image(c, sprites.get('musicOptions'), 1362, 0, 489, 36);
  // NUM_speed starts at the left of its 48×14 box; PAT_mirror pattern 0 is OFF. Both casts are tinted #c8c8c8.
  c.fillStyle = '#c8c8c8'; c.font = '14px "Segoe UI",sans-serif'; c.textAlign = 'center';
  if (!number(c, sprites, numbers.speed, data.speed.toFixed(2), 1508, 20, 0)) text(data.speed.toFixed(2), 1532, 25);
  const mirror = sprites.get('mirrorOff');
  if (!mirror?.layout || !image(c, tinted(mirror, '#c8c8c8'), mirror.layout.x, mirror.layout.y, mirror.layout.width, mirror.layout.height)) text('OFF', 1786, 25);
  c.fillStyle = '#fff'; c.font = 'bold 18px "Segoe UI",sans-serif';
  if (!image(c, sprites.get('trackDigit1'), 1572, 47, 14, 18)) text('1', 1572, 65);
  c.fillStyle = data.difficulty === 'WORLD’S END' ? '#242b2e' : '#fff'; c.font = 'bold 33px "Segoe UI","Microsoft YaHei",sans-serif'; c.textAlign = 'center';
  if (data.difficulty === 'WORLD’S END') text(data.weTag,1798,99,76);
  else {
    // C_music_level_normal_num is centred on (1798,93); C_plus keeps its own fixed 18×18 box.
    const level = displayGameLevel(data.level);
    if (!number(c, sprites, numbers.level, level.replace('+', ''), 1798, 93)) text(level,1798,105,76);
    else if (level.endsWith('+')) image(c, sprites.get('levelPlus'), 1820, 65, 18, 18);
  }
  // T_music_title is the 24pt face scaled 0.9 in a 340×24 box ending at y=139; T_music_artist the 14pt face ending at y=159.
  c.textAlign = 'left'; c.fillStyle = '#283232'; c.font = 'bold 21.6px "Segoe UI","Microsoft YaHei",sans-serif'; fitText(c, data.title || '新建乐曲', 1502, 136, 340, data.font);
  c.fillStyle = '#505a5a'; c.font = '14px "Segoe UI","Microsoft YaHei",sans-serif'; fitText(c, data.artist, 1502, 157, 340, data.font);
  if (data.difficulty === 'WORLD’S END') {
    const stars = Math.max(1, Math.min(5, Math.ceil(data.stars)));
    if (!image(c, sprites.get(`stars${stars}`), 1765, 44)) { c.fillStyle = '#fff3a0'; c.textAlign = 'left'; c.font = '16px "Segoe UI",sans-serif'; text('★'.repeat(stars), 1765, 60); }
  }

  // L_Playing_gauge: grey base and gauge body lie under the frame, whose transparent window shows them.
  const frame = sprites.get('frame'), gauge = sprites.get('gaugeBlue');
  // Skills and gauge stock are not simulated: the body follows judged / total and every stock box stays empty.
  const progress = data.total ? Math.max(0, Math.min(1, data.combo / data.total)) : 0, fill = 544 * progress;
  if (!frame?.layout) {
    c.fillStyle = '#ffcf1e'; c.fillRect(578, 36, 764, 140);
    c.fillStyle = '#213b50'; c.font = 'bold 22px "Segoe UI",sans-serif'; c.textAlign = 'left'; text('MAX COMBO :', 684, 68); text('SCORE :', 981, 68);
  }
  c.save(); c.beginPath(); c.rect(689, 80, 544, 40); if (!frame?.layout) c.clip();
  c.fillStyle = '#1e1e1e'; c.fillRect(660, 60, 600, 80);
  if (gauge) c.drawImage(gauge.image, gauge.x, gauge.y, gauge.width * progress, gauge.height, 689, 70, fill, 58);
  else { const gradient = c.createLinearGradient(689, 0, 1233, 0); gradient.addColorStop(0, '#116cd8'); gradient.addColorStop(1, '#0bd8c6'); c.fillStyle = gradient; c.fillRect(689, 70, fill, 58); }
  // C_gauge_eff_00: additive #ffff5d edge, 83 wide, kept at the head of a moving gauge.
  const edge = sprites.get('gaugeEdge'), edgeWidth = Math.min(83, fill);
  if (edge && progress < 1 && edgeWidth > 0) {
    const glow = tinted(edge, '#ffff5d'), part = edgeWidth / 83;
    c.globalCompositeOperation = 'lighter';
    c.drawImage(glow.image, glow.width * (1 - part), 0, glow.width * part, glow.height, 689 + fill - edgeWidth, 70, edgeWidth, 58);
  }
  c.restore();
  placed(c, frame);
  // Twelve C_gauge_stock_ref boxes are visible in the static layout, 37 px apart.
  for (let box = 0; box < 12; box++) placed(c, sprites.get('stockEmpty'), 37 * box);
  // C_combo_num and C_score_num: 24×32 cells overlapping 4 px, parent scale 0.9.
  c.fillStyle = '#213b50'; c.font = 'bold 26px "Segoe UI",sans-serif'; c.textAlign = 'center';
  const score = data.score.toLocaleString('en-US');
  if (!number(c, sprites, numbers.combo, String(data.combo), 905, 56)) text(String(data.combo), 905, 68);
  if (!number(c, sprites, numbers.score, score, 1150, 56)) text(score, 1150, 68);

  if (data.combo > 0) {
    c.textAlign = 'center'; c.strokeStyle = '#34313a'; c.lineWidth = 5; c.fillStyle = '#fff'; c.font = 'italic 700 49px "Arial",sans-serif';
    if (!image(c, sprites.get('comboLabel'), 774, 486, 372, 46.5)) { c.strokeText('COMBO', 960, 532); text('COMBO', 960, 532); }
    c.font = '84px sans-serif'; if (!number(c, sprites, numbers.mainCombo, String(data.combo), 960, 589)) text(String(data.combo),960,626);
  }
  c.restore();
}
/**
 * common/playerData plate at the screen origin. A preview has no player profile, so level and rating use the
 * original hidden-value casts; the trophy bar and the eight full-width name cells identify the autoplay.
 */
function drawPlate(c: CanvasRenderingContext2D, sprites: ReadonlyMap<string, HudSprite>, text: (value: string, x: number, y: number, maxWidth?: number) => void): void {
  if (!placed(c, sprites.get('namePlate'))) { c.fillStyle = '#f5f5ec'; c.fillRect(70, 3, 485, 174); }
  for (const key of ['nameBase', 'trophyBase', 'charaBase', 'levelLabel', 'levelHidden', 'ratingLabel', 'ratingHidden']) placed(c, sprites.get(key));
  placed(c, sprites.get('levelHidden'), 21);
  // T_player_character_title: 21px in the bar scaled 0.7, centred 5 px above the bar centre, soft white shadow.
  c.textAlign = 'center'; c.font = '14.7px "Segoe UI","Microsoft YaHei",sans-serif';
  c.fillStyle = '#ffffffa0'; text('CHUNI STUDIO', 348, 67.4); c.fillStyle = '#000000'; text('CHUNI STUDIO', 348, 66);
  // T_player_name: 28px cells in a 226×50 box whose bottom-left is (229,127), 1 px white shadow.
  c.textAlign = 'left'; c.font = '28px "Segoe UI","Microsoft YaHei",sans-serif';
  c.fillStyle = '#ffffff'; text('ＡＵＴＯＰＬＡＹ', 229, 124.5, 226); c.fillStyle = '#010000'; text('ＡＵＴＯＰＬＡＹ', 229, 123.5, 226);
}

/** Music.xml levelDecimal is hundredths; installed game uses .50 as the plus boundary. */
export function displayGameLevel(value: string): string {
  if (/^\d+\+$/.test(value.trim())) return value.trim();
  const match=/^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return '?';
  return String(Number(match[1])) + (Number(`0.${match[2] ?? '0'}`) >= .5 ? '+' : '');
}
