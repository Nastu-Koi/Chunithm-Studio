import { getSlideUvSpans, slideUvProgress } from './slide-timing';
import type { Chart, Note } from '../core/model';
import { createChart } from '../core/model';
import { isBundledImageSource, type GameModelTexture, type GameTexture, type GameTextures } from '../core/game-assets';
import { getScrollPosition, getGrid, tickToSeconds, secondsToTick, bpmAtTick, getNoteScrollGroup } from '../core/timing';
import { getPlayerPlaybackPoints } from './playback-points';
import { fitSceneViewport, projectTrackPoint, TRACK_REFERENCE, SCENE_WIDTH, SCENE_HEIGHT } from './player-scene';
import { buildJudgementTimeline, getAutoScoreAtTick, type JudgementTimeline } from '../core/judgement';
import { drawPlayerHud, type HudSprite } from './player-hud';
import { createClassicRingRenderer, type ClassicRingRenderer, type StagePosition } from './classic-stage';
import { sampleStageSkinMatrices, transformStagePoint, type StageAnimation } from '../core/stage-animation';
import { createStageModelSampler, getStageCamera } from '../core/stage-program';
import { stageWorldToAffine, type StageCamera } from './stage-projection';
import { GameMeshRenderer, type MeshPaint } from './game-mesh-renderer';
import { getNativeHeadModel, projectNativeNotePoint, nativeAirBaseHeight, nativeScrollWorldUnit, AIR_LINE_HEIGHT } from './native-notes';
import { getNativeAirSlideUvSpans, nativeAirSlideVAtTick } from './native-air-timing';
import { clipNativeMeshZ } from './clip-native-mesh';
import { NativeHudFont } from './game-font';
import { NativeNoteEffects } from './native-effects';
import { buildNoteEffectEvents, recentNoteEffects, type NoteEffectEvent } from './note-effects';
import { getNativeAirSlideGeometry, getNativeAirCrushGeometry, getNativeAirHoldMaterialColors } from './native-air-geometry';
const colors: Record<Note['type'], string> = { TAP: '#fb4769', EXTAP: '#ffd55c', FLICK: '#74d9ff', HOLD: '#ffbc4a', SLIDE: '#56b9ff', AIR: '#6ef2a0', AIR_HOLD: '#ff72c0', AIR_SLIDE: '#fe8bd5', AIR_CRUSH: '#cd7fff', DAMAGE: '#9e74d3' };
const nativeColors: Record<string, string> = { RED: '#ff566b', ORN: '#ffa158', YEL: '#ffe67c', GRN: '#70f1a6', CYN: '#73eeed', BLU: '#6abaff', PPL: '#be90ff', PNK: '#ff94d1', VLT: '#b195ff', GRY: '#bdc8d8', BLK: '#24283a' };
type Point = { x: number; y: number; scale: number };
type Sprite = HudSprite;
const headModels: Partial<Record<Note['type'], string>> = { TAP: 'NotesTap', EXTAP: 'NotesChara', FLICK: 'NotesFlick', DAMAGE: 'NotesMine', HOLD: 'NotesHold', SLIDE: 'NotesSlide', AIR_HOLD: 'NotesAirHold_Tap' };
/** Only these records contain a complete, inspected head image. AIR records are mesh materials. */
export function getPlayerHeadTextureKey(note: Note, width = note.width): string | undefined {
  if (!Number.isInteger(width) || width < 1 || width > 16) return undefined;
  if (note.attributes.color && note.attributes.color !== 'DEF') return undefined;
  const prefix = note.attributes.ex && ['TAP', 'HOLD', 'SLIDE'].includes(note.type) ? 'NotesChara' : headModels[note.type];
  return prefix ? `${prefix}_${String(width).padStart(2, '0')}` : undefined;
}
export function getPlayerBodyTextureKey(note: Note): string | undefined {
  const color = String(note.attributes.color ?? 'DEF');
  if (color === 'PNK' && ['AIR_HOLD', 'AIR_SLIDE'].includes(note.type)) return 'AirHoldLine_P';
  if (color !== 'DEF') return undefined;
  return ({ HOLD: 'HoldJoint', SLIDE: 'SlideJoint', AIR_HOLD: 'AirHoldLine', AIR_SLIDE: 'SlideJoint_G', AIR_CRUSH: 'AirLadderLine' } as Partial<Record<Note['type'], string>>)[note.type];
}
const bodyKeys = new Set(['HoldJoint', 'SlideJoint', 'AirHoldLine', 'AirHoldLine_P', 'AirHoldLine_S', 'AirHoldJoint', 'AirHoldJoint_P', 'AirHoldJoint_S', 'Field', 'SlideJoint_G', 'AirLadderLine']);
export function getPlayerTextureRectangle(texture: GameTexture, rectangle?: GameModelTexture['rectangle']): { x: number; y: number; width: number; height: number } {
  const rect = rectangle ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
  return { x: rect.u0 * texture.width, y: rect.v0 * texture.height, width: (rect.u1 - rect.u0) * texture.width, height: (rect.v1 - rect.v0) * texture.height };
}
export interface PlayerRibbonSegment { startTick: number; endTick: number; startDistance: number; endDistance: number }
const motionCuts = new WeakMap<Chart, Map<number, number[]>>();
function cutsFor(chart: Chart, note: Note): number[] {
  let groups = motionCuts.get(chart); if (!groups) { groups = new Map(); motionCuts.set(chart, groups); }
  const group = getNoteScrollGroup(chart, note), cached = groups.get(group); if (cached) return cached;
  const cuts = new Set<number>();
  for (const event of chart.events) {
    if (event.type === 'BPM') cuts.add(event.tick);
    else if (event.type === 'STOP' || event.type === 'SCROLL' && group === 0 || event.type === 'GROUP_SCROLL' && (event.group ?? 0) === group) {
      cuts.add(event.tick); cuts.add(event.tick + (event.duration ?? chart.resolution));
    }
  }
  const result = [...cuts].filter(Number.isFinite).sort((a, b) => a - b); groups.set(group, result); return result;
}
function upperBound(values: readonly number[], tick: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= tick) lo = mid + 1; else hi = mid; }
  return lo;
}
export function getPlayerCrushTickIndex(timeline: JudgementTimeline): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const point of timeline.points) if (point.kind === 'crush') {
    const ticks = result.get(point.noteId) ?? []; ticks.push(point.tick); result.set(point.noteId, ticks);
  }
  return result;
}
/** The original ALD renderer uses LadderTop for the first marker of each connected ladder. */
export function getPlayerCrushTopIndex(chart: Chart, ticks: ReadonlyMap<string, readonly number[]>, roots?: Set<string>): Map<string, number> {
  const tails = new Map<string, { first: boolean }[]>(), result = new Map<string, number>();
  const key = (note: Note, end: boolean) => [end ? note.tick + (note.duration ?? 0) : note.tick,
    end ? note.endLane ?? note.lane : note.lane, end ? note.endWidth ?? note.width : note.width,
    end ? note.endHeight ?? note.height ?? 1 : note.height ?? 1, note.attributes.color ?? 'DEF', note.attributes.interval ?? 24].join(':');
  for (const note of chart.notes.filter(note => note.type === 'AIR_CRUSH').sort((a, b) => a.tick - b.tick)) {
    const previous = tails.get(key(note, false))?.shift();
    if (!previous) roots?.add(note.id);
    const state = previous ?? { first: true };
    const markers = ticks.get(note.id);
    if (state.first && markers?.length) { result.set(note.id, markers[0]); state.first = false; }
    const end = key(note, true), waiting = tails.get(end) ?? []; waiting.push(state); tails.set(end, waiting);
  }
  return result;
}
/** Select original judgement ticks with binary searches, without scanning dense/offscreen intervals. */
export function getPlayerCrushMarkerTicks(ticks: readonly number[], ribbon: readonly Pick<PlayerRibbonSegment, 'startTick' | 'endTick'>[], limit = 512): number[] {
  if (!ticks.length || !Number.isFinite(limit) || limit < 1) return [];
  limit = Math.min(512, Math.floor(limit));
  const ranges: { start: number; end: number }[] = [];
  for (const segment of ribbon) {
    let low = 0, high = ticks.length;
    while (low < high) { const middle = (low + high) >>> 1; if (ticks[middle] < segment.startTick) low = middle + 1; else high = middle; }
    const end = upperBound(ticks, segment.endTick);
    if (low < end) ranges.push({ start: low, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const count = merged.reduce((sum, range) => sum + range.end - range.start, 0), wanted = Math.min(count, limit);
  const result: number[] = [];
  let rangeIndex = 0, skipped = 0;
  for (let index = 0; index < wanted; index++) {
    const rank = wanted > 1 ? Math.floor(index * (count - 1) / (wanted - 1)) : 0;
    while (rank >= skipped + merged[rangeIndex].end - merged[rangeIndex].start) { skipped += merged[rangeIndex].end - merged[rangeIndex].start; rangeIndex++; }
    result.push(ticks[merged[rangeIndex].start + rank - skipped]);
  }
  return result;
}
/** Break at every tempo/motion boundary before clipping. Endpoints alone cannot cull a reversing ribbon. */
export function getPlayerRibbonSegments(chart: Chart, note: Note, currentTick: number, far = 12, near = -.18): PlayerRibbonSegment[] {
  if (!(note.duration && note.duration > 0)) return [];
  const firstTick = Math.max(note.tick, currentTick), lastTick = note.tick + note.duration;
  if (firstTick >= lastTick) return [];
  const cuts = cutsFor(chart, note), ticks = [firstTick];
  for (let index = upperBound(cuts, firstTick); index < cuts.length && cuts[index] < lastTick; index++) ticks.push(cuts[index]);
  ticks.push(lastTick);
  const result: PlayerRibbonSegment[] = [];
  let a = ticks[0], da = getScrollPosition(chart, a, currentTick, note);
  for (let index = 1; index < ticks.length; index++) {
    const b = ticks[index], db = getScrollPosition(chart, b, currentTick, note);
    if (Number.isFinite(da) && Number.isFinite(db) && Math.min(da, db) <= far && Math.max(da, db) >= near) {
      const delta = db - da;
      let low = 0, high = 1;
      if (Math.abs(delta) > 1e-12) {
        const edgeA = (near - da) / delta, edgeB = (far - da) / delta;
        low = Math.max(0, Math.min(edgeA, edgeB)); high = Math.min(1, Math.max(edgeA, edgeB));
      }
      if (high >= low) {
        const startTick = a + (b - a) * low, endTick = a + (b - a) * high;
        const startDistance = da + delta * low, endDistance = da + delta * high;
        // Bound each painter primitive's depth span, so overtaking heads are not hidden by one huge quad.
        const pieces = Math.max(1, Math.ceil(Math.abs(endDistance - startDistance) / .75));
        for (let piece = 0; piece < pieces; piece++) {
          const t0 = piece / pieces, t1 = (piece + 1) / pieces;
          result.push({ startTick: startTick + (endTick - startTick) * t0, endTick: startTick + (endTick - startTick) * t1, startDistance: startDistance + (endDistance - startDistance) * t0, endDistance: startDistance + (endDistance - startDistance) * t1 });
        }
      }
    }
    a = b; da = db;
  }
  return result;
}
/** Scroll distance on the near side of the judgement line at which a line at AIR height has left the screen. */
const AIR_HOLD_NEAR = -3;
function noteColor(note: Note): string { return nativeColors[String(note.attributes.color)] ?? colors[note.type]; }
/** Perspective is visual only. Hit timestamps always come from the shared audio timeline. */
export class ChartPlayer {
  private canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private textureLayer?: GameMeshRenderer;
  private nativeModels = new Map<string, { model: GameModelTexture; images: HTMLImageElement[] }>();
  private nativeEffects?: NativeNoteEffects;
  private hudFont?: NativeHudFont;
  private effectEvents: NoteEffectEvent[] = [];
  private slideUvSpans: ReturnType<typeof getSlideUvSpans> = new Map();
  private airUvSpans: ReturnType<typeof getNativeAirSlideUvSpans> = new Map();
  private nativeDiagnostics = new Set<string>();
  private chart: Chart = createChart();
  private scoreTimeline = buildJudgementTimeline(this.chart);
  private crushTicks = new Map<string, number[]>();
  private crushFirst = new Map<string, number>();
  private crushRoots = new Set<string>();
  private width = SCENE_WIDTH; private height = SCENE_HEIGHT;
  private hostWidth = 0; private hostHeight = 0; private dpr = 1;
  private observer: ResizeObserver;
  private sorted: { note: Note; start: number; end: number }[] = [];
  private textureGeneration = 0;
  private modelSprites = new Map<string, Sprite>();
  private bodySprites = new Map<string, Sprite>();
  private hudSprites = new Map<string, Sprite>();
  private sceneMaterials = new Map<string, Sprite>();
  private classicRing?: HTMLCanvasElement;
  private ringRenderer?: ClassicRingRenderer;
  private ringPositions: StagePosition[] = [];
  private stageAnimation?: StageAnimation;
  private stageSampler?: ReturnType<typeof createStageModelSampler>;
  private stageCamera?: StageCamera;
  private stageMode: 'scene' | 'clip' = 'clip';
  private stageClip = 0; private stageFps = 60; private stageOrigin = 0; private lastStageFrame = NaN;
  private cover?: HTMLImageElement; private coverGeneration = 0;
  private frameNumber = 0;
  speed = 6;
  title = ''; artist = ''; difficulty = 'MASTER'; level = '1'; weTag = '改'; stars = 1;
  constructor(private host: HTMLElement) {
    this.canvas.className = 'player-canvas'; this.canvas.setAttribute('aria-label', 'CHUNITHM 透视自动播放预览'); host.append(this.canvas);
    this.canvas.dataset.scoreMode = this.scoreTimeline.status; this.canvas.dataset.scene = 'fallback'; this.canvas.dataset.cover = 'false';
    this.context = this.canvas.getContext('2d')!;
    try { this.textureLayer = new GameMeshRenderer(); } catch { /* Explicit resource diagnostics retain the software fallback. */ }
    this.canvas.dataset.noteRenderer = this.textureLayer ? 'webgl2' : 'canvas2d';
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
  }
  /** Decodes copied assets atomically; replacing/clearing a set invalidates any earlier pending load. */
  async setGameTextures(assets: GameTextures): Promise<{ loaded: number; failed: string[] }> {
    const generation = ++this.textureGeneration, models = new Map<string, Sprite>(), bodies = new Map<string, Sprite>(), hud = new Map<string, Sprite>(), materials = new Map<string, Sprite>();
    const decoded = new Map<string, Promise<HTMLImageElement | undefined>>();
    let loaded = 0; const failed: string[] = [];
    if (!this.textureLayer) failed.push('WebGL 2 未启用，音符使用兼容绘制；请开启硬件加速。');
    const decode = (texture: GameTexture): Promise<HTMLImageElement | undefined> => {
      let pending = decoded.get(texture.dataUrl);
      if (!pending) {
        pending = new Promise(resolve => {
          // Renderer assets are self-contained. Never dereference a path back into the game installation.
          if (!isBundledImageSource(texture.dataUrl)) { resolve(undefined); return; }
          const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => resolve(image); image.onerror = () => resolve(undefined); image.src = texture.dataUrl;
        }); decoded.set(texture.dataUrl, pending);
      }
      return pending;
    };
    const entries: { key: string; texture: GameTexture; rectangle?: GameModelTexture['rectangle']; target: Map<string, Sprite>; layout?: Sprite['layout'] }[] = [];
    for (const [key, model] of Object.entries(assets.models)) if (/^(Notes(Tap|Chara|CharaNoEff|Flick|Mine|Hold|Slide|AirHold_Tap)_\d{2}|GoalLine)$/.test(key) && model.images[0]) entries.push({ key, texture: model.images[0], rectangle: model.rectangle, target: models });
    for (const [key, texture] of Object.entries(assets.textures)) if (bodyKeys.has(key)) entries.push({ key, texture, target: bodies });
    for (const [key, texture] of Object.entries(assets.scene?.materials ?? {})) entries.push({ key, texture, target: materials });
    for (const [key, sprite] of Object.entries(assets.scene?.hud ?? {})) {
      const { rect, image, layout } = sprite;
      entries.push({ key, texture: image, rectangle: { u0: rect.x / image.width, v0: rect.y / image.height, u1: (rect.x + rect.width) / image.width, v1: (rect.y + rect.height) / image.height }, target: hud, layout });
    }
    for (let index = 0; index < entries.length; index += 8) await Promise.all(entries.slice(index, index + 8).map(async ({ key, texture, rectangle, target, layout }) => {
      const image = await decode(texture), rect = getPlayerTextureRectangle(texture, rectangle);
      if (!image || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > image.naturalWidth + .001 || rect.y + rect.height > image.naturalHeight + .001) { failed.push(`${key}: 贴图无法解码或 UV 范围无效`); return; }
      target.set(key, { image, ...rect, layout }); loaded++;
    }));
    const nativeModels = new Map<string, { model: GameModelTexture; images: HTMLImageElement[] }>();
    await Promise.all(Object.entries(assets.models).filter(([, model]) => model.meshes?.length).map(async ([key, model]) => {
      const images = await Promise.all(model.images.map(decode));
      if (images.some(image => !image)) { failed.push(`${key}: 原始模型材质未完整载入`); return; }
      nativeModels.set(key, { model, images: images as HTMLImageElement[] });
    }));
    const font = assets.font ? await NativeHudFont.load(assets.font,decode) : undefined;
    const effects = assets.effectTables && assets.effectPrograms ? await NativeNoteEffects.load(assets, decode) : undefined;
    if (generation === this.textureGeneration) {
      this.nativeModels = nativeModels; this.textureLayer?.clearTextures();
      this.nativeEffects = effects; this.hudFont = font;
      this.canvas.dataset.nativeModels = String(nativeModels.size);
      this.modelSprites = models; this.bodySprites = bodies; this.hudSprites = hud; this.sceneMaterials = materials;
      this.ringRenderer?.dispose();
      this.ringRenderer = undefined; this.classicRing = undefined;
      this.ringPositions = []; this.stageAnimation = undefined;
      this.stageSampler = undefined; this.stageCamera = undefined;
      this.canvas.dataset.stageAnimation = 'none'; this.canvas.dataset.scene = 'black';
    }
    return { loaded, failed };
  }
  clearGameTextures(): void { this.textureGeneration++; this.nativeEffects = undefined; this.hudFont = undefined; this.ringRenderer?.dispose(); this.textureLayer?.clearTextures(); this.nativeModels.clear(); this.modelSprites.clear(); this.bodySprites.clear(); this.hudSprites.clear(); this.sceneMaterials.clear(); this.classicRing = undefined; this.ringRenderer = undefined; this.stageAnimation = undefined; this.stageSampler = undefined; this.stageCamera = undefined; this.ringPositions = []; this.canvas.dataset.stageAnimation = 'none'; this.canvas.dataset.scene = 'fallback'; }
  getResourceDiagnostics(): string[] { return [...this.nativeDiagnostics, ...(this.nativeEffects?.diagnostics ?? [])]; }
  resetStagePosition(): void { this.stageOrigin = 0; this.lastStageFrame = NaN; }
  getStageOptions(): { clips: string[]; clip: number; fps: number; mode: 'scene' | 'clip'; hasProgram: boolean } {
    return { clips: this.stageAnimation?.clips.map(clip => clip.resourceName) ?? [], clip: this.stageClip, fps: this.stageFps, mode: this.stageMode, hasProgram: !!this.stageSampler };
  }
  setStageOptions(clip: number, fps: number, origin: number, mode: 'scene' | 'clip' = 'clip'): void {
    if (!Number.isInteger(clip) || !this.stageAnimation?.clips[clip] || ![30, 60].includes(fps) || !Number.isFinite(origin)) return;
    this.stageMode = mode === 'scene' && this.stageSampler ? 'scene' : 'clip';
    this.canvas.dataset.stageAnimation = this.stageMode === 'scene' ? 'original-scene-preview' : 'original-clip-preview';
    this.stageClip = clip; this.stageFps = fps; this.stageOrigin = origin; this.lastStageFrame = NaN;
  }
  private sampleStage(seconds: number): void {
    const animation = this.stageAnimation;
    const time = Math.max(0, (seconds - this.stageOrigin) * this.stageFps);
    const sample = this.stageMode === 'scene' ? this.stageSampler?.(time) : undefined;
    // Resource 1..10 is the verified AFRC motion table, in the same order as the copied clips.
    const clipIndex = sample ? sample.clipResource - 1 : this.stageClip, clip = animation?.clips[clipIndex];
    if (!animation || !clip || !this.ringRenderer || animation.rig.vertexBones.length !== this.ringPositions.length) return;
    const frame = Math.min(clip.frameCount - 1, sample?.clipFrame ?? time);
    // World transforms keep moving across state resets, even when the local clip frame repeats.
    const cacheTime = sample ? time : frame;
    if (cacheTime === this.lastStageFrame) return;
    const matrices = sampleStageSkinMatrices(animation, clipIndex, frame);
    const positions = this.ringPositions.map((position, index) => transformStagePoint(matrices[animation.rig.vertexBones[index]], position));
    this.classicRing = sample && this.stageCamera
      ? this.ringRenderer.renderWorld(positions, stageWorldToAffine(sample.worldMatrix), this.stageCamera)
      : this.ringRenderer.render(positions);
    this.lastStageFrame = cacheTime;
    this.canvas.dataset.stageClip = String(clipIndex); this.canvas.dataset.stageFrame = String(frame);
    this.canvas.dataset.stageCycle = String(sample?.cycle ?? 0);
    this.canvas.dataset.stageWorld = sample ? JSON.stringify(sample.worldMatrix) : '';
    this.canvas.dataset.stageCamera = sample ? JSON.stringify(this.stageCamera) : '';
    this.canvas.dataset.stagePose = positions.filter((_, i) => i % 113 === 0).map(p => p.map(v => v.toFixed(3)).join(',')).join(';');
  }
  async setCover(dataUrl: string): Promise<void> {
    const generation = ++this.coverGeneration; this.cover = undefined;
    this.canvas.dataset.cover = 'false';
    if (!dataUrl.startsWith('data:image/')) return;
    const image = new Image();
    const loaded = await new Promise<boolean>(resolve => { image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = dataUrl; });
    if (loaded && generation === this.coverGeneration) { this.cover = image; this.canvas.dataset.cover = 'true'; }
  }
  getJudgements(): JudgementTimeline { return this.scoreTimeline; }
  setChart(chart: Chart): void {
    this.scoreTimeline = buildJudgementTimeline(chart);
    this.crushTicks = getPlayerCrushTickIndex(this.scoreTimeline);
    this.crushRoots.clear(); this.crushFirst = getPlayerCrushTopIndex(chart, this.crushTicks, this.crushRoots);
    this.canvas.dataset.scoreMode = this.scoreTimeline.status;
    this.canvas.dataset.judgementTotal = String(this.scoreTimeline.total);
    this.canvas.dataset.judgementCounts = JSON.stringify(this.scoreTimeline.counts);
    this.canvas.dataset.judgementMatched = String(this.scoreTimeline.header.matches);
    this.chart = chart; this.sorted = chart.notes.map(note => ({ note, start: tickToSeconds(chart, note.tick), end: tickToSeconds(chart, note.tick + (note.duration ?? 0)) })).sort((a, b) => b.start - a.start);
    this.effectEvents = buildNoteEffectEvents(chart);
    this.airUvSpans = getNativeAirSlideUvSpans(chart);
    this.slideUvSpans = getSlideUvSpans(chart);
    this.nativeDiagnostics.clear();
  }
  resize(): void {
    const box = this.host.getBoundingClientRect(); this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.hostWidth = box.width; this.hostHeight = box.height;
    this.canvas.width = Math.round(box.width * this.dpr); this.canvas.height = Math.round(box.height * this.dpr);
    this.canvas.style.width = `${box.width}px`; this.canvas.style.height = `${box.height}px`;
    this.canvas.dataset.viewport = JSON.stringify(fitSceneViewport(box.width, box.height));
  }
  private point(lane: number, distance: number, airHeight = 0): Point {
    return projectTrackPoint(lane, distance, this.speed, airHeight);
  }
  private polygon(points: Point[], fill: string, stroke?: string, lineWidth = 1): void {
    if (this.textureLayer?.active) {
      this.textureLayer.polygon(points, fill);
      if (stroke) points.forEach((point, i) => this.textureLayer!.line(point, points[(i + 1) % points.length], stroke, lineWidth));
      return;
    }
    const c = this.context; c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fillStyle = fill; c.fill(); if (stroke) { c.strokeStyle = stroke; c.lineWidth = lineWidth; c.stroke(); }
  }
  private line(a: Point, b: Point, color: string, width: number): void {
    if (this.textureLayer?.active) { this.textureLayer.line(a, b, color, width); return; }
    const c = this.context; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.strokeStyle = color; c.lineWidth = width; c.stroke();
  }
  private nativeModel(key: string, lane: number, distance: number, baseY = 0, scaleX = 1, scaleY = 1,
    projection?: (position: readonly number[]) => ReturnType<typeof projectNativeNotePoint>, clipZ?: [number, number], tint: readonly number[] = [1, 1, 1, 1]): boolean {
    const native = this.nativeModels.get(key), layer = this.textureLayer;
    if (!native?.model.meshes?.length || !layer?.active) return false;
    for (const mesh of native.model.meshes) {
      const geometry = clipZ ? clipNativeMeshZ(mesh, ...clipZ) : mesh;
      const material = mesh.material, [first, second] = material.textures;
      const uv = (vertex: typeof mesh.vertices[number], set = 0) => {
        const value = set === 1 ? vertex.uv2 ?? vertex.uv : vertex.uv, transform = material.textureTransforms?.[set];
        return transform ? [value[0] * transform.scale[0] + transform.offset[0], value[1] * transform.scale[1] + transform.offset[1]] : value;
      };
      layer.mesh(geometry.vertices.map(vertex => ({ ...(projection ? projection(vertex.position) : projectNativeNotePoint(lane, distance,
        [vertex.position[0] * scaleX, vertex.position[1] * scaleY + baseY, vertex.position[2]], this.speed)),
        uv: uv(vertex, first?.uvSet), uv2: uv(vertex, second?.uvSet),
        color: material.vertexColor ? vertex.color : [1, 1, 1, 1] })), geometry.indices,
      { image: first && native.images[first.image], image2: second && native.images[second.image],
        wrap: first && [first.wrapU, first.wrapV], wrap2: second && [second.wrapU, second.wrapV],
        alphaCutoff: Math.max(.0001, material.alphaRef / 255), layer: material.textureLayers?.[0], cullMode: material.cullMode,
        blendOperation: material.blendOperation, blendSource: material.blendSource, blendDestination: material.blendDestination,
        color: [material.diffuse[0] * tint[0], material.diffuse[1] * tint[1], material.diffuse[2] * tint[2], material.diffuse[3] * material.opacity * tint[3]] });
    }
    return true;
  }
  private nativeHead(note: Note, lane: number, width: number, distance: number, height = 1, endpoint = false, scaleY = 1): boolean {
    if (endpoint && (note.type === 'AIR_HOLD' || note.type === 'AIR_SLIDE')) {
      const size = Math.max(1, Math.min(16, Math.round(width))), center = lane + width / 2;
      const base = (note.type === 'AIR_HOLD' ? AIR_LINE_HEIGHT : nativeAirBaseHeight(height)) + .15;
      let drawn = false;
      for (const family of ['Shadow', 'Ring']) {
        const key = `NotesAirHold_${family}_${String(size).padStart(2, '0')}`;
        const nominal = this.nativeModels.get(key)?.model.nominalWidth ?? size;
        const yScale = family === 'Shadow' && note.type === 'AIR_SLIDE' ? base / 15.724 : 1;
        drawn = this.nativeModel(key, center, distance, base, nominal > 0 ? width / nominal : 1, yScale) || drawn;
      }
      return drawn;
    }
    const model = getNativeHeadModel(note, width, endpoint); if (!model) return false;
    const baseY = note.type === 'AIR' ? nativeAirBaseHeight(height)
      : note.type === 'AIR_CRUSH' ? nativeAirBaseHeight(height) + .15 : note.type === 'AIR_SLIDE' ? nativeAirBaseHeight(height) : 0;
    const nominal = this.nativeModels.get(model.key)?.model.nominalWidth;
    return this.nativeModel(model.key, lane + width / 2, distance, baseY, (nominal && nominal > 0 ? width / nominal : 1) * model.mirror, scaleY);
  }
  /** Two clipped affine triangles preserve a texture's colors and alpha on a perspective quad. */
  private texturedQuad(sprite: Sprite, points: [Point, Point, Point, Point], paint: Omit<MeshPaint, 'image'> = {}): void {
    if (this.textureLayer?.active) { this.textureLayer.quad(sprite, points, paint); return; }
    const c = this.context, [a, b, d, e] = points;
    const triangle = (p: Point, q: Point, r: Point, xx: number, xy: number, yx: number, yy: number, x: number, y: number) => {
      if (Math.abs(xx * yy - xy * yx) < .00001) return;
      c.save(); if (paint.blendDestination === 1) c.globalCompositeOperation = 'lighter'; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.lineTo(r.x, r.y); c.closePath(); c.clip();
      c.transform(xx, xy, yx, yy, x, y); c.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height, 0, 0, 1, 1); c.restore();
    };
    triangle(a, b, e, b.x - a.x, b.y - a.y, e.x - a.x, e.y - a.y, a.x, a.y);
    triangle(d, e, b, d.x - e.x, d.y - e.y, d.x - b.x, d.y - b.y, b.x + e.x - d.x, b.y + e.y - d.y);
  }
  private ribbon(note: Note, segment: PlayerRibbonSegment, points: [Point, Point, Point, Point], color: string, airExtent?: [number, number], currentTick = 0, headRiser = false): void {
    if ((note.type === 'AIR_SLIDE' || note.type === 'AIR_CRUSH') && this.textureLayer?.active) {
      const zUnit = nativeScrollWorldUnit(this.speed);
      const at = (tick: number, distance: number) => {
        const t = (tick - note.tick) / note.duration!, width = note.width + ((note.endWidth ?? note.width) - note.width) * t;
        return { centerLane: note.lane + ((note.endLane ?? note.lane) - note.lane) * t + width / 2, width,
          y: nativeAirBaseHeight((note.height ?? 1) + ((note.endHeight ?? note.height ?? 1) - (note.height ?? 1)) * t), z: -distance * zUnit };
      };
      const geometry = note.type === 'AIR_CRUSH' ? getNativeAirCrushGeometry : getNativeAirSlideGeometry;
      const uvSpan = this.airUvSpans.get(note.id);
      const surfaces = geometry(at(segment.startTick, segment.startDistance), at(segment.endTick, segment.endDistance), {
        color: String(note.attributes.color ?? 'DEF'), rootCenterLane: uvSpan?.rootCenterLane ?? note.lane + note.width / 2,
        vStart: uvSpan ? nativeAirSlideVAtTick(this.chart, uvSpan, segment.startTick) : 1,
        vEnd: uvSpan ? nativeAirSlideVAtTick(this.chart, uvSpan, segment.endTick) : 0,
        status: currentTick >= note.tick ? 1 : 0, headRiser: headRiser && currentTick <= note.tick && Math.abs(segment.startTick - note.tick) < 1e-7,
        lineOrientation: note.attributes.effect === 'AxisY' ? 1 : note.attributes.effect === 'AxisZ' ? 2 : note.attributes.effect === 'Trace' ? 3 : 0,
        traceHeadCap: this.crushRoots.has(note.id) && segment.startTick === note.tick && currentTick <= note.tick,
      });
      for (const surface of surfaces) {
        const image = this.bodySprites.get(surface.texture)?.image; if (!image) continue;
        this.textureLayer.mesh(surface.vertices.map(v => ({ ...projectNativeNotePoint(8, -v.position[2] / zUnit, [v.position[0], v.position[1], 0], this.speed), uv: v.uv, color: v.color })),
          surface.indices, { image, wrap: [0, 2] });
      }
      return;
    }
    if (note.type === 'AIR_HOLD' && this.textureLayer?.active) {
      // AirHoldNote stretches only the original roof planes (source z=-4..0).
      // The vertical Line mesh remains at the head; it is not a flat timeline ribbon.
      const suffix = note.attributes.color === 'PNK' ? '_P' : '';
      const size = Math.max(1, Math.min(16, Math.round(note.width)));
      const [near, far] = airExtent ?? [segment.startDistance, segment.endDistance], span = far - near;
      if (Math.abs(span) < 1e-10) return;
      const z0 = -4 * (segment.startDistance - near) / span, z1 = -4 * (segment.endDistance - near) / span;
      const clip: [number, number] = [Math.min(z0, z1) - 1e-7, Math.max(z0, z1) + 1e-7];
      const projected = (position: readonly number[], xScale: number) => {
        const fraction = Math.max(0, Math.min(1, -position[2] / 4));
        return projectNativeNotePoint(note.lane + note.width / 2,
          near + span * fraction,
          [position[0] * xScale, position[1] + nativeAirBaseHeight(note.height ?? 1), 0], this.speed);
      };
      const roof = this.nativeModel(`NotesAirHold_JointRoof_${String(size).padStart(2, '0')}${suffix}`, 0, 0, 0, 1, 1, position => projected(position, note.width / size), clip,
        getNativeAirHoldMaterialColors(currentTick >= note.tick ? 1 : 0).roof);
      const line = this.nativeModel(`NotesAirHold_LineTop${suffix}`, 0, 0, 0, 1, 1, position => projected(position, 1), clip);
      if (roof && line) return;
    }
    const key = getPlayerBodyTextureKey(note), sprite = key && this.bodySprites.get(key);
    if (!sprite) { this.polygon(points, `${color}65`, `${color}b0`, .8); return; }
    // SLC control records share the ordinary-node span instead of restarting its gradient.
    const span = note.type === 'SLIDE' ? this.slideUvSpans?.get(note.id) : undefined;
    const progress = (tick: number) => span ? slideUvProgress(this.chart, span, tick) : (tick - note.tick) / note.duration!;
    const first = progress(segment.startTick), last = progress(segment.endTick);
    this.texturedQuad({ ...sprite, y: sprite.y + sprite.height * (1 - last), height: sprite.height * (last - first) }, [points[3], points[2], points[1], points[0]],
      note.type === 'HOLD' || note.type === 'SLIDE' ? { blendSource: 4, blendDestination: 1, blendOperation: 0 } : {});
  }
  render(seconds: number): void {
    if (!this.hostWidth || !this.hostHeight) return;
    if (this.textureLayer && !this.textureLayer.available) {
      this.textureLayer.destroy(); this.textureLayer = undefined;
      this.canvas.dataset.noteRenderer = 'canvas2d';
    }
    const c = this.context, w = this.width, h = this.height, tick = secondsToTick(this.chart, seconds);
    const score = getAutoScoreAtTick(this.scoreTimeline, tick);
    this.canvas.dataset.frame = String(++this.frameNumber); this.canvas.dataset.score = String(score.score); this.canvas.dataset.combo = String(score.combo);
    this.canvas.dataset.title = this.title; this.canvas.dataset.difficulty = this.difficulty;
    const viewport = fitSceneViewport(this.hostWidth, this.hostHeight);
    // Neutral letterbox: the black 16:9 game screen stays distinct from the space around it.
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.fillStyle = '#161616'; c.fillRect(0, 0, this.hostWidth, this.hostHeight);
    c.save(); c.translate(viewport.x, viewport.y); c.scale(viewport.scale, viewport.scale);
    c.beginPath(); c.rect(0, 0, w, h); c.clip();
    c.fillStyle = '#000000'; c.fillRect(0, 0, w, h);
    this.canvas.dataset.scene = 'black';
    c.save(); c.beginPath(); c.rect(0, TRACK_REFERENCE.topY, w, h - TRACK_REFERENCE.topY); c.clip();
    this.textureLayer?.begin(TRACK_REFERENCE.topY);
    if (this.textureLayer?.active) {
      this.textureLayer.polygon([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], '#000000');

    }
    const far = 12;
    const ground = this.sceneMaterials.get('notesField');
    const groundQuad: [Point, Point, Point, Point] = [this.point(0, far), this.point(16, far), this.point(16, -.055), this.point(0, -.055)];
    this.polygon(groundQuad, '#131313');
    if (ground) this.texturedQuad(ground, groundQuad);
    const side = this.sceneMaterials.get('fieldSide');
    for (const [left, right] of [[-1, 0], [16, 17]]) {
      const points: [Point, Point, Point, Point] = [this.point(left, far), this.point(right, far), this.point(right, -.055), this.point(left, -.055)];
      if (side) this.texturedQuad(side, points); else this.polygon(points, '#867437');
    }
    for (let lane = 0; lane < 16; lane++) {
      // Stage.xml chooses the Orange field lines. Quarter-lane boundaries are visible in the reference.
      if (lane % 4 !== 0) continue;
      this.line(this.point(lane, far), this.point(lane, -.055), '#c5984670', 1.6);
    }
    for (const line of getGrid(this.chart, Math.max(0, tick - 768), tick + 384 * 16, 4)) {
      const distance = getScrollPosition(this.chart, line.tick, tick);
      if (distance < 0 || distance > far) continue;
      this.line(this.point(0, distance), this.point(16, distance), line.major ? '#bed9ff44' : '#bed9ff18', line.major ? 1.5 : 0.7);
    }
    const keeps: { event: NoteEffectEvent; age: number }[] = [];
    const primitives: { depth: number; layer: number; draw(): void }[] = [];
    let crushMarkerBudget = 512;
    for (const { note, start, end } of this.sorted) {
      if (end < seconds - 0.32) continue;
      const points = note.type === 'AIR_CRUSH' ? [] : getPlayerPlaybackPoints(this.chart, note);
      const headPoint = points.find(point => point.position === 'head'), endPoint = points.find(point => point.position === 'end');
      if (note.type === 'SLIDE' && note.duration && start <= seconds && end > seconds) {
        const t = (tick - note.tick) / note.duration;
        keeps.push({ event: { note, time: start, kind: 'Slide', lane: note.lane + ((note.endLane ?? note.lane) - note.lane) * t,
          width: note.width + ((note.endWidth ?? note.width) - note.width) * t, y: 0, seed: 1 }, age: seconds - start });
      }
      if (end < seconds) continue;
      const head = getScrollPosition(this.chart, note.tick, tick, note);
      const tail = getScrollPosition(this.chart, note.tick + (note.duration ?? 0), tick, note);
      const ribbon = getPlayerRibbonSegments(this.chart, note, tick, far);
      // A held AIR HOLD does not end in mid-air above the judgement line: its line runs straight on, out of the bottom of the screen.
      if (note.type === 'AIR_HOLD' && tick > note.tick && ribbon.length && Math.abs(ribbon[0].startTick - tick) < 1e-7) {
        const from = ribbon[0].startDistance, pieces = Math.ceil((from - AIR_HOLD_NEAR) / .75);
        for (let piece = 0; piece < pieces; piece++) ribbon.unshift({ startTick: tick, endTick: tick,
          startDistance: from + (AIR_HOLD_NEAR - from) * (piece + 1) / pieces, endDistance: from + (AIR_HOLD_NEAR - from) * piece / pieces });
      }
      const airExtent: [number, number] | undefined = note.type === 'AIR_HOLD' && ribbon.length
        ? [Math.min(...ribbon.flatMap(s => [s.startDistance, s.endDistance])), Math.max(...ribbon.flatMap(s => [s.startDistance, s.endDistance]))] : undefined;
      const headVisible = head >= -.18 && head <= far, tailVisible = tail >= -.18 && tail <= far;
      if (!headVisible && !tailVisible && !ribbon.length) continue;
      const airborne = note.type.startsWith('AIR'), height = airborne ? note.height ?? (note.type === 'AIR' ? 0.48 : 0.8) : 0;
      const color = noteColor(note);
      const headColor = note.attributes.ex ? colors.EXTAP : color;
      // A clipped active ribbon is already airborne; its new near edge is not a lift.
      const headRiser = !!headPoint && tick <= note.tick && ribbon.length > 0 && Math.abs(ribbon[0].startTick - note.tick) < 1e-7;
      if (note.type === 'AIR_HOLD' && headRiser) {
        const distance = ribbon[0].startDistance;
        primitives.push({ depth: distance, layer: 1, draw: () => {
          this.nativeModel(`NotesAirHold_Line${note.attributes.color === 'PNK' ? '_P' : ''}`, note.lane + note.width / 2,
            distance, nativeAirBaseHeight(note.height ?? 1));
        } });
      }
      if (note.duration && note.duration > 0) {
        for (const segment of ribbon) {
          const at = (atTick: number, distance: number, right: boolean) => {
            const t = (atTick - note.tick) / note.duration!;
            const x = note.lane + ((note.endLane ?? note.lane) - note.lane) * t;
            const width = note.width + ((note.endWidth ?? note.width) - note.width) * t;
            if (note.type === 'AIR_SLIDE' || note.type === 'AIR_CRUSH') {
              const rawHeight = (note.height ?? 1) + ((note.endHeight ?? note.height ?? 1) - (note.height ?? 1)) * t;
              const projected = projectNativeNotePoint(x + (right ? width : 0), distance,
                [0, nativeAirBaseHeight(rawHeight), 0], this.speed);
              return { ...projected, scale: projected.scale ?? 1 };
            }
            return this.point(x + (right ? width : 0), distance, height + ((note.endHeight ?? height) - height) * t);
          };
          primitives.push({ depth: (segment.startDistance + segment.endDistance) / 2, layer: airborne ? 0 : -1, draw: () => this.ribbon(note, segment, [
            at(segment.startTick, segment.startDistance, false), at(segment.startTick, segment.startDistance, true),
            at(segment.endTick, segment.endDistance, true), at(segment.endTick, segment.endDistance, false),
          ], color, airExtent, tick, headRiser) });
        }
      }
      if (note.type === 'AIR_CRUSH' && crushMarkerBudget > 0) {
        const ranges = ribbon.length ? ribbon : tailVisible && tail >= 0 ? [{ startTick: note.tick + (note.duration ?? 0), endTick: note.tick + (note.duration ?? 0) }] : [];
        const marks = getPlayerCrushMarkerTicks(this.crushTicks.get(note.id) ?? [], ranges, crushMarkerBudget);
        for (const atTick of marks) {
          const progress = note.duration ? (atTick - note.tick) / note.duration : 0;
          const x = note.lane + ((note.endLane ?? note.lane) - note.lane) * progress, width = note.width + ((note.endWidth ?? note.width) - note.width) * progress;
          const distance = getScrollPosition(this.chart, atTick, tick, note), high = height + ((note.endHeight ?? height) - height) * progress;
          if (distance < 0 || distance > far) continue;
          crushMarkerBudget--;
          primitives.push({ depth: distance, layer: 2, draw: () => {
            if (!this.nativeHead(note, x, width, distance, (note.height ?? 1) + ((note.endHeight ?? note.height ?? 1) - (note.height ?? 1)) * progress,
              this.crushFirst.get(note.id) === atTick))
              this.bar(this.point(x, distance, high), this.point(x + width, distance, high), color, note.type);
          } });
        }
      }
      if (tailVisible && endPoint && note.type !== 'AIR_CRUSH') {
        const endpoint = { ...note, attributes: { ...note.attributes, ex: false } };
        primitives.push({ depth: tail, layer: airborne ? 2 : 1, draw: () => {
          if (!this.nativeHead(endpoint, endPoint.lane, endPoint.width, tail, note.endHeight ?? note.height ?? 1, true))
            this.bar(this.point(endPoint.lane, tail, endPoint.height ?? height), this.point(endPoint.lane + endPoint.width, tail, endPoint.height ?? height), color, note.type, endpoint, endPoint.width);
        } });
      }
      if (headVisible && start >= seconds && headPoint && note.type !== 'AIR_CRUSH') {
        const displayNote = headPoint.type === note.type ? note : { ...note, type: headPoint.type, attributes: { ...note.attributes, direction: headPoint.direction ?? 'IR' } };
        const displayHeight = headPoint.height ?? height, displayColor = headPoint.type === note.type ? headColor : colors[headPoint.type];
        primitives.push({ depth: head, layer: airborne ? 2 : 1, draw: () => {
          const airSlideHead = note.type === 'AIR_SLIDE' && displayNote.type === 'AIR';
          if (this.nativeHead(displayNote, note.lane, note.width, head, airSlideHead ? 1 : note.height ?? 1,
            false, airSlideHead ? nativeAirBaseHeight(note.height ?? 1) / AIR_LINE_HEIGHT : 1)) return;
          const left = this.point(note.lane, head, displayHeight), right = this.point(note.lane + note.width, head, displayHeight);
          this.bar(left, right, displayColor, displayNote.type, displayNote);
          if (displayNote.type === 'AIR') {
            const direction = String(displayNote.attributes.direction ?? 'IR'); const down = ['DOWN', 'DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR'].includes(direction); const center = (left.x + right.x) / 2;
            const dy = 15 * left.scale * (down ? 1 : -1), dx = ['UL', 'DL'].includes(direction) ? -12 * left.scale : ['UR', 'DR'].includes(direction) ? 12 * left.scale : 0;
            this.line({ ...left, x: center - 12 * left.scale }, { ...left, x: center + dx, y: left.y + dy }, '#d5ffef', Math.max(1.5, 3 * left.scale));
            this.line({ ...left, x: center + dx, y: left.y + dy }, { ...left, x: center + 12 * left.scale }, '#d5ffef', Math.max(1.5, 3 * left.scale));
          }
        } });
      }
    }
    // Flat ground bodies cannot occlude any raised note head, regardless of segment length.
    primitives.sort((a, b) => Number(b.layer === -1) - Number(a.layer === -1) || b.depth - a.depth || a.layer - b.layer);
    for (const primitive of primitives) primitive.draw();
    const judgeLeft = this.point(0, 0), judgeRight = this.point(16, 0);
    const goal = this.modelSprites.get('GoalLine');
    if (this.nativeModel('GoalLine', 8, 0)) { /* Source model includes its own line thickness and material. */ }
    else if (goal) this.texturedQuad(goal, [{ ...judgeLeft, y: judgeLeft.y - 2 }, { ...judgeRight, y: judgeRight.y - 2 }, { ...judgeRight, y: judgeLeft.y - 2 + Math.max(5, h * .008) }, { ...judgeLeft, y: judgeLeft.y - 2 + Math.max(5, h * .008) }]);
    else { c.shadowColor = '#f8d973'; c.shadowBlur = 15; c.fillStyle = '#ffdf80'; c.fillRect(judgeLeft.x, judgeLeft.y, judgeRight.x - judgeLeft.x, 3); c.shadowBlur = 0; }
    let effectPrimitives = 0;
    if (this.textureLayer?.active && this.nativeEffects) {
      const budget = 4096, recent = recentNoteEffects(this.effectEvents, seconds, this.nativeEffects.lifetime);
      for (let i = recent.length - 1; i >= 0 && effectPrimitives < budget; i--)
        effectPrimitives += this.nativeEffects.draw(this.textureLayer, recent[i], seconds - recent[i].time, this.speed, false, budget - effectPrimitives);
      for (const keep of keeps) {
        if (effectPrimitives >= budget) break;
        effectPrimitives += this.nativeEffects.draw(this.textureLayer, keep.event, keep.age, this.speed, true, budget - effectPrimitives);
      }
      if (effectPrimitives >= budget) this.nativeDiagnostics.add('密集片段的打击特效达到每帧 4096 个图元上限，优先保留最近打击；计分、谱面与音频不裁剪。');
    }
    this.canvas.dataset.nativeEffectPrimitives = String(effectPrimitives);
    if (this.textureLayer) c.drawImage(this.textureLayer.finish(), 0, 0, w, h);
    c.restore();
    drawPlayerHud(c, this.hudSprites, { font: this.hudFont, scoreStatus: this.scoreTimeline.status, headerMatched: this.scoreTimeline.header.matches === true, title: this.title, artist: this.artist, difficulty: this.difficulty, level: this.level, weTag: this.weTag, stars: this.stars, cover: this.cover, score: score.score, combo: score.combo, total: score.total, speed: this.speed });
    c.restore();
  }
  private bar(left: Point, right: Point, color: string, type: Note['type'], note?: Note, laneWidth = note?.width): void {
    const key = note && getPlayerHeadTextureKey(note, laneWidth), sprite = key && this.modelSprites.get(key);
    if (sprite) {
      // Inspected ground-head SVOs use z=-4.483716..5.604642, independent of lane width.
      // 125.2 is cross-calibrated against the AFNC camera candidate and measured game frame.
      // It is a preview ground-depth calibration, not a decoded engine camera property.
      // See docs/game-camera-candidate.md. TAP meshes share the track's world units.
      const offset = (point: Point, z: number): Point => {
        const ratio = 1 / (1 + z / 125.2 * point.scale);
        return { x: TRACK_REFERENCE.centerX + (point.x - TRACK_REFERENCE.centerX) * ratio, y: TRACK_REFERENCE.horizonY + (point.y - TRACK_REFERENCE.horizonY) * ratio, scale: point.scale * ratio };
      };
      this.texturedQuad(sprite, [offset(left, 4.483716), offset(right, 4.483716), offset(right, -5.604642), offset(left, -5.604642)]); return;
    }
    const c = this.context, height = Math.max(2, 10 * left.scale), width = Math.max(1, right.x - left.x);
    if (this.textureLayer?.active) {
      this.textureLayer.polygon([{ x: left.x, y: left.y - height / 2 }, { x: right.x, y: right.y - height / 2 }, { x: right.x, y: right.y + height / 2 }, { x: left.x, y: left.y + height / 2 }], color); return;
    }
    c.fillStyle = color; c.fillRect(left.x, left.y - height / 2, width, height);
    c.fillStyle = '#fff9'; c.fillRect(left.x + 1, left.y - height / 2, width - 2, Math.max(1, height * 0.22));
    c.fillStyle = '#0004'; c.fillRect(left.x, left.y + height * 0.2, width, height * 0.3);
    if (type === 'FLICK') { c.fillStyle = '#e5fcff'; c.fillRect(left.x + width / 3, left.y - height / 3, width / 3, height * 0.67); }
    if (type === 'DAMAGE') { c.strokeStyle = '#2d174b'; c.lineWidth = 2; for (let x = left.x + 4; x < right.x; x += Math.max(5, 12 * left.scale)) { c.beginPath(); c.moveTo(x, left.y - height / 2); c.lineTo(x - height / 2, left.y + height / 2); c.stroke(); } }
  }
  destroy(): void { this.clearGameTextures(); this.textureLayer?.destroy(); this.observer.disconnect(); this.canvas.remove(); }
}
