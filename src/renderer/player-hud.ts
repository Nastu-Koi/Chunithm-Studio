import type { NativeHudFont } from './game-font';
export interface HudSprite { image: HTMLImageElement; x: number; y: number; width: number; height: number }
export interface HudMetadata {
  title: string; artist: string; difficulty: string; level: string; weTag: string; stars: number;
  scoreStatus: 'native' | 'estimated' | 'unsupported'; headerMatched: boolean;
  cover?: HTMLImageElement; score: number; combo: number; total: number; speed: number; playing: boolean; font?: NativeHudFont;
}
const difficultyKeys: Record<string, string> = { BASIC: 'Basic', ADVANCED: 'Advanced', EXPERT: 'Expert', MASTER: 'Master', ULTIMA: 'Ultima', 'WORLD’S END': 'WorldsEnd' };
const difficultyColors: Record<string, string> = { BASIC: '#00a87c', ADVANCED: '#ef8000', EXPERT: '#e62c34', MASTER: '#821ad0', ULTIMA: '#211c24', 'WORLD’S END': '#ca299c' };
function image(c: CanvasRenderingContext2D, sprite: HudSprite | undefined, x: number, y: number, w?: number, h?: number): boolean {
  if (!sprite) return false;
  c.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height, x, y, w ?? sprite.width, h ?? sprite.height); return true;
}
function fitText(c: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, font?: NativeHudFont): void {
  let output = text;
  while (output.length > 1 && (font ? font.measure(c, output) : c.measureText(output).width) > width) output = output.slice(0, -2) + '…';
  if(font) font.draw(c, output, x, y); else c.fillText(output, x, y);
}
function number(c: CanvasRenderingContext2D, sprites: ReadonlyMap<string, HudSprite>, prefix: string, value: number, centerX: number, centerY: number, scale = .9): boolean {
  const text = String(value);
  if (![...text].every(digit => sprites.has(prefix + digit))) return false;
  const width = [...text].reduce((total, digit) => total + sprites.get(prefix + digit)!.width * scale, 0);
  let x = centerX - width / 2;
  for (const digit of text) { const sprite = sprites.get(prefix + digit)!; image(c, sprite, x, centerY - sprite.height * scale / 2, sprite.width * scale, sprite.height * scale); x += sprite.width * scale; }
  return true;
}
/** Fixed game-space HUD. Coordinates are sourced/compared in docs/game-scene-reference.md. */
export function drawPlayerHud(c: CanvasRenderingContext2D, sprites: ReadonlyMap<string, HudSprite>, data: HudMetadata): void {
  const text = (value: string, x: number, y: number, maxWidth?: number) => data.font ? data.font.draw(c,value,x,y,maxWidth) : c.fillText(value,x,y,maxWidth);
  c.save(); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  const key = difficultyKeys[data.difficulty] ?? 'Master', color = difficultyColors[data.difficulty] ?? '#821ad0';
  // The editor has no player card or selected skill: this panel identifies the actual autoplay mode.
  c.fillStyle = '#f9faf3'; c.fillRect(0, 0, 566, 177);
  if (!image(c, sprites.get(`banner${key}`), 0, 0, 586, 182)) { c.fillStyle = color; c.fillRect(0, 0, 586, 182); }
  c.fillStyle = '#f5f5ec'; c.fillRect(62, 13, 461, 144); c.strokeStyle = '#c5c6c3'; c.lineWidth = 2; c.strokeRect(62, 13, 461, 144);
  c.fillStyle = '#303b43'; c.font = '700 20px "Segoe UI",sans-serif'; text('AUTOPLAY', 90, 44);
  c.font = '700 34px "Segoe UI",sans-serif'; text('CHUNI STUDIO', 90, 89);
  c.font = '18px "Microsoft YaHei",sans-serif'; text('AUTO PLAY', 90, 133);

  // Central SCORE / MAX COMBO placement follows Sega's official gameplay capture.
  c.fillStyle = '#ffcf1e'; c.fillRect(578, 0, 758, 176);
  c.save(); c.beginPath(); c.rect(578, 0, 758, 176); c.clip(); c.strokeStyle = '#ffec85'; c.lineWidth = 5;
  for (let x = 390; x < 1450; x += 22) { c.beginPath(); c.moveTo(x, 176); c.lineTo(x + 176, 0); c.stroke(); } c.restore();
  c.fillStyle = '#171c20'; c.fillRect(588, 0, 738, 32);
  c.font = '15px sans-serif'; c.textAlign = 'center';
  const judges = [['JUSTICE CRITICAL', data.combo, '#ffea55'], ['JUSTICE',0,'#ffac32'], ['ATTACK',0,'#1bff41'], ['MISS',0,'#d2dadc']] as const;
  judges.forEach(([label, count, color], i) => { c.fillStyle=color; text(`${label} : ${count}`, 588 + 738 / 4 * (i + .5), 22, 176); });
  c.textAlign = 'left';
  c.fillStyle = '#213b50'; c.font = 'bold 22px "Segoe UI",sans-serif'; text('MAX COMBO', 684, 68); text('SCORE', 981, 68);
  c.font = 'bold 26px "Segoe UI",sans-serif'; c.textAlign = 'center';
  if (!number(c, sprites, 'comboDigit', data.combo, 905, 56)) text(String(data.combo), 905, 68);
  if (!number(c, sprites, 'scoreDigit', data.score, 1150, 56)) text(data.score.toLocaleString('en-US'), 1150, 68);
  c.textAlign = 'left';
  c.fillStyle = '#203e4e'; c.fillRect(674, 85, 581, 35); c.fillStyle = '#ebf3e5'; c.fillRect(680, 91, 569, 23);
  const progress = data.total ? data.combo / data.total : 0;
  const gradient = c.createLinearGradient(680, 0, 1249, 0); gradient.addColorStop(0, '#116cd8'); gradient.addColorStop(1, '#0bd8c6');
  c.fillStyle = gradient; c.fillRect(680, 91, 569 * progress, 23);
  c.fillStyle = '#303a3e'; c.font = 'bold 20px "Microsoft YaHei",sans-serif'; text('AUTO JC', 695, 151);
  c.textAlign = 'right'; c.font = '18px "Segoe UI",sans-serif'; text(`${data.speed.toFixed(1)} SPEED`, 1250, 151);

  // Original difficulty/card sprite; text and jacket are supplied by the current project.
  const cardX = 1334, cardY = 0;
  if (!image(c, sprites.get(`music${key}`), cardX, cardY, 586, 182)) {
    c.fillStyle = color; c.fillRect(cardX, cardY, 586, 182); c.fillStyle = '#fff'; c.font = 'bold 34px "Segoe UI",sans-serif'; c.textAlign = 'left'; text(data.difficulty, cardX + 151, 103);
    c.fillStyle = '#fff'; c.fillRect(cardX + 4, 116, 578, 63);
  }
  const coverX = 1373, coverY = 51;
  if (data.cover) c.drawImage(data.cover, coverX, coverY, 116, 116);
  else { c.fillStyle = '#dedfd9'; c.fillRect(coverX, coverY, 116, 116); c.fillStyle = '#737777'; c.font = '48px "Segoe UI",sans-serif'; c.textAlign = 'center'; text('♪', coverX + 58, coverY + 78); }
  image(c, sprites.get('musicOptions'), 1362, 0, 489, 36);
  c.fillStyle = '#fff'; c.font = '14px "Segoe UI",sans-serif'; c.textAlign = 'center'; text(data.speed.toFixed(1), 1541, 23); text('OFF', 1820, 23);
  c.font = 'bold 18px "Segoe UI",sans-serif';
  if (!image(c, sprites.get('trackDigit1'), 1572, 47, 14, 18)) text('1', 1572, 65);
  c.fillStyle = data.difficulty === 'WORLD’S END' ? '#242b2e' : '#fff'; c.font = 'bold 33px "Segoe UI","Microsoft YaHei",sans-serif'; c.textAlign = 'center';
  if (data.difficulty === 'WORLD’S END') text(data.weTag,1798,99,76);
  else {
    const level = displayGameLevel(data.level), glyphs = [...level].map(ch => sprites.get(ch === '+' ? 'levelPlus' : `levelDigit${ch}`));
    if (glyphs.every(Boolean)) {
      const scale = Math.min(1, 80 / glyphs.reduce((n,g) => n+g!.width,0)), width=glyphs.reduce((n,g)=>n+g!.width*scale,0); let x=1798-width/2;
      for(const glyph of glyphs) { image(c,glyph,x,87-glyph!.height*scale/2,glyph!.width*scale,glyph!.height*scale); x+=glyph!.width*scale; }
    } else text(level,1798,105,76);
  }
  c.textAlign = 'left'; c.fillStyle = '#192425'; c.font = 'bold 21px "Segoe UI","Microsoft YaHei",sans-serif'; fitText(c, data.title || '新建乐曲', 1502, 139, 396, data.font);
  c.fillStyle = '#505b5e'; c.font = '13px "Segoe UI","Microsoft YaHei",sans-serif'; fitText(c, data.artist, 1502, 159, 396, data.font);
  if (data.difficulty === 'WORLD’S END') {
    const stars = Math.max(1, Math.min(5, Math.ceil(data.stars)));
    if (!image(c, sprites.get(`stars${stars}`), 1765, 44)) { c.fillStyle = '#fff3a0'; c.textAlign = 'left'; c.font = '16px "Segoe UI",sans-serif'; text('★'.repeat(stars), 1765, 60); }
  }

  if (data.combo > 0) {
    c.textAlign = 'center'; c.strokeStyle = '#34313a'; c.lineWidth = 5; c.fillStyle = '#fff'; c.font = 'italic 700 49px "Arial",sans-serif';
    if (!image(c, sprites.get('comboLabel'), 774, 486, 372, 46.5)) { c.strokeText('COMBO', 960, 532); text('COMBO', 960, 532); }
    c.font = '84px sans-serif'; if (!number(c,sprites,'mainComboDigit',data.combo,960,589,.62)) text(String(data.combo),960,626);
  }
  c.textAlign = 'right'; c.fillStyle = '#fff'; c.font = '18px "Segoe UI","Microsoft YaHei",sans-serif';
  text(data.playing ? 'AUTO PLAY' : 'PAUSE', 1889, 1061);
  c.restore();
}

/** Music.xml levelDecimal is hundredths; installed game uses .50 as the plus boundary. */
export function displayGameLevel(value: string): string {
  if (/^\d+\+$/.test(value.trim())) return value.trim();
  const match=/^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return '?';
  return String(Number(match[1])) + (Number(`0.${match[2] ?? '0'}`) >= .5 ? '+' : '');
}
