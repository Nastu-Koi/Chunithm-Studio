import { MargreteNoteSprites, NOTE_BAR_HEIGHT, airArrowHeight, airArrowLift, airDown, airLean, airSide } from './margrete-sprites';
import { createChart, createNote, LANES, makeId, NOTE_TYPES, type Chart, type ChartEvent, type EventType, type Note, type NoteAttributes, type NoteType, type Scalar } from '../core/model';
import { getChartEndTick, getGrid, secondsToTick, tickToSeconds, getNoteScrollGroup, getNotePlaybackPoints } from '../core/timing';
import { isBundledImageSource, type GameTexture } from '../core/game-assets';
import { getNativeNoteTag } from '../core/c2s';
import { getSlideUvSpans, slideUvProgress } from './slide-timing';
import { editorTemplate, COLOR, LABEL, noteColor } from './editor-template';
import { LONG, AIR, CHAIN, clamp, endLane, endWidth, endTick, sameTick, formatTick, long, copyNote, hasNodeKind, limitLane, limitWidth, selectionWithAssignments, alignAssignments,
  appendEditorNote, attachEditorAir, editorChain, nextEditorSegment, removeEditorJoint, boundEditorParent, copyEditorSelection, flipEditorSelection, inferEditorParent, mirrorEditorSelection, moveEditorSelection, parseEditorFraction, scaleEditorSelection, selectionWithBoundAir, setEditorAirHeight, setEditorEx, setEditorNodeKind, shapeEditorSlide, splitEditorNote, syncEditorAirBindings, type Clipboard, type EditorNodeKind, type SlideShape, type SlideShapeResult } from './editor-operations';
export { appendEditorNote, attachEditorAir, editorChain, nextEditorSegment, removeEditorJoint, boundEditorParent, copyEditorSelection, flipEditorSelection, inferEditorParent, mirrorEditorSelection, moveEditorSelection, parseEditorFraction, scaleEditorSelection, selectionWithBoundAir, setEditorAirHeight, setEditorEx, setEditorNodeKind, shapeEditorSlide, splitEditorNote, syncEditorAirBindings, type EditorNodeKind, type SlideShape, type SlideShapeResult } from './editor-operations';

type Callbacks = { onChange(chart: Chart, label: string): void; onCursor(tick: number): void; onUndo(): void; onRedo(): void; onOffset(seconds: number, label: string): void };
type AudioSamples = { data: Float32Array; sampleRate: number };
/** `lane` is the lane under the pointer; `laneAt` is the same place as a fractional lane coordinate. */
type Position = { x: number; y: number; tick: number; lane: number; laneAt: number };
type DragKind = 'move' | 'end' | 'width' | 'widthLeft' | 'endWidth' | 'height' | 'endHeight' | 'box' | 'draw' | 'seek' | 'pan';
type Tool = NoteType | 'select' | 'erase';
type Drag = { kind: DragKind; start: Position; current: Position; chart: Chart; id?: string; before: Set<string>; moved: boolean; scroll: number; pointerId: number };
const EVENT_LABEL: Record<EventType, string> = { BPM: 'BPM', METER: '拍号', SCROLL: '谱面滚速', NOTE_SPEED: '音符速度', GROUP_SCROLL: '分组滚速', SCROLL_ASSIGNMENT: '滚速分组', STOP: '旧版停止' };
const TRACK_SCALE_KEY = 'chuni-editor-track-scale';
/** Lane width at 100% track scale. A host too narrow for it still fits every visible lane. */
const STANDARD_LANE_WIDTH = 30;
const EVENT_COLOR: Record<EventType, string> = { BPM: '#65cf69', METER: '#d4a46b', SCROLL: '#e2575f', NOTE_SPEED: '#b9b9b9', GROUP_SCROLL: '#e88bb0', SCROLL_ASSIGNMENT: '#a897d8', STOP: '#e2575f' };
/** Game joint textures for ground long-note bodies, and their centre colours sampled from start (0) to end (1) as the fallback gradient. */
const BODY_TEXTURE: Partial<Record<NoteType, string>> = { SLIDE: 'SlideJoint', HOLD: 'HoldJoint' };
const BODY_STOPS: Partial<Record<NoteType, [number, string][]>> = {
  SLIDE: [[0, '#8242be'], [.06, '#7357c7'], [.25, '#30b3ec'], [.5, '#0ee2ff'], [.75, '#49b9e8'], [.94, '#bf68bb'], [1, '#dd53af']],
  HOLD: [[0, '#8641ba'], [.06, '#9653a2'], [.25, '#dba036'], [.5, '#fec700'], [.75, '#f5a632'], [.94, '#e26496'], [1, '#dd53af']],
};
function eventText(event: ChartEvent): string {
  switch (event.type) {
    case 'BPM': return formatTick(event.value);
    case 'METER': return `${event.numerator ?? 4}/${event.denominator ?? 4}`;
    case 'SCROLL': return `×${formatTick(event.value)}`;
    case 'NOTE_SPEED': return `♪×${formatTick(event.value)}`;
    case 'GROUP_SCROLL': return `G${event.group ?? 0} ×${formatTick(event.value)}`;
    case 'SCROLL_ASSIGNMENT': return `→G${event.group ?? event.value}`;
    case 'STOP': return 'STOP';
  }
}
function readTrackScale(): number {
  try {
    const value = Number(window.localStorage.getItem(TRACK_SCALE_KEY));
    return Number.isFinite(value) && value >= .5 && value <= 3 ? value : 1;
  } catch { return 1; }
}
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function fractionLabel(value: number): string {
  for (let denominator = 1; denominator <= 4096; denominator++) {
    const numerator = Math.round(value * denominator);
    if (Math.abs(numerator / denominator - value) < 1e-9) return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
  }
  return formatTick(value);
}
export class ChartEditor {
  private readonly noteSprites = new MargreteNoteSprites();
  private chart: Chart = createChart();
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly viewport: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly status: HTMLElement;
  private readonly minimap: HTMLInputElement;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private selection = new Set<string>();
  private tool: Tool = 'select';
  private penTool: NoteType = 'TAP';
  private airVertical: 'IR' | 'DW' = 'IR';
  private airLean: -1 | 0 | 1 = 0;
  /** Insert-node mode: clicks split the long note under the pointer instead of placing or selecting. */
  private inserting = false;
  /** Segment whose end node was picked rather than its body; the highlight and the inspector then show that node alone. */
  private pickedJoint?: string;
  /** First segment of a SLIDE / AIR chain whose head node was picked; deleting it takes the whole long note. */
  private pickedHead?: string;
  /** Segment being reshaped while the shape panel is open; `preview` then holds the candidate path. */
  private shapeId?: string;
  private readonly shapePanel: HTMLFormElement;
  private snap = 16;
  private snapBase: 'whole' | 'beat' = 'whole';
  private width = 2;
  private nodeKind: EditorNodeKind | 'inherit' = 'inherit';
  private zoom = .75;
  private trackScale = readTrackScale();
  private trackPan = 0;
  private viewStart = 0;
  private viewEnd = LANES;
  private scroll = 0;
  private cursor = 0;
  private canvasWidth = 1;
  private canvasHeight = 1;
  private drag?: Drag;
  private preview?: Chart;
  private clipboard?: Clipboard;
  private hover?: Position;
  private continuing = false;
  private peaks: Float32Array = new Float32Array();
  private audioDuration = 0;
  private audioOffset = 0;
  private samples?: AudioSamples;
  /** Alignment mode: clicks set the cursor or the music offset and never edit notes. */
  private aligning = false;
  private readonly alignWidth = 120;
  private pendingDraw = 0;
  private inspectorKey = '';
  private bodyTextures: Partial<Record<NoteType, HTMLImageElement>> = {};
  private bodyTextureGeneration = 0;
  private readonly airLeft = 9;
  private readonly airWidth = 98;
  private readonly rulerLeft = 116;
  private readonly rulerWidth = 68;
  private readonly eventLeft = 186;
  private readonly waveformLeft = 219;
  private readonly left = 250;
  private readonly bottom = 30;

  constructor(private readonly host: HTMLElement, private readonly callbacks: Callbacks) {
    host.classList.add('editor-root');
    host.innerHTML = editorTemplate({ zoom: this.zoom, trackScale: this.trackScale });
    this.canvas = host.querySelector('canvas')!;
    this.canvas.dataset.trackLeft = String(this.left);
    this.canvas.dataset.airHeightLeft = String(this.airLeft);
    this.canvas.dataset.airHeightWidth = String(this.airWidth);
    host.style.setProperty('--editor-track-left', `${this.left}px`);
    this.context = this.canvas.getContext('2d')!;
    this.viewport = host.querySelector('.editor-viewport')!;
    this.inspector = host.querySelector('.editor-inspector')!;
    this.shapePanel = host.querySelector('.editor-shape-panel')!;
    this.status = host.querySelector('.editor-status')!;
    this.minimap = host.querySelector('.editor-navigation input')!;
    const signal = this.abort.signal;
    host.addEventListener('click', event => this.onClick(event), { signal });
    this.shapePanel.addEventListener('submit', event => { event.preventDefault(); this.closeShape(true); }, { signal });
    this.shapePanel.addEventListener('input', () => this.previewShape(), { signal });
    this.shapePanel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); this.closeShape(false); } }, { signal });
    host.addEventListener('change', event => this.onChange(event), { signal });
    host.addEventListener('input', event => this.onInput(event), { signal });
    this.canvas.addEventListener('pointerdown', event => this.pointerDown(event), { signal });
    this.canvas.addEventListener('pointermove', event => this.pointerMove(event), { signal });
    this.canvas.addEventListener('pointerup', event => this.pointerUp(event), { signal });
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag(), { signal });
    this.canvas.addEventListener('lostpointercapture', () => { if (this.drag) this.cancelDrag(); }, { signal });
    this.canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = undefined; this.draw(); } }, { signal });
    this.canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    this.canvas.addEventListener('dblclick', event => this.doubleClick(event), { signal });
    this.viewport.addEventListener('wheel', event => this.wheel(event), { passive: false, signal });
    window.addEventListener('keydown', event => this.keyDown(event), { signal });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.viewport);
    this.renderInspector();
    this.resize();
    this.noteSprites.load(() => { this.canvas.dataset.noteSprites = 'margrete-1.8.0'; this.draw(); });
  }

  setChart(chart: Chart): void {
    const changedMode = Boolean(this.chart.allowOutOfLane) !== Boolean(chart.allowOutOfLane);
    // A candidate shape belongs to the chart it was computed from.
    if (chart !== this.chart && !this.shapePanel.hidden) { this.shapePanel.hidden = true; this.shapeId = undefined; this.preview = undefined; }
    this.chart = chart;
    const ids = new Set([...chart.notes, ...chart.events].map(item => item.id));
    this.selection = new Set([...this.selection].filter(id => ids.has(id)));
    if (!chart.allowOutOfLane) { this.viewStart = 0; this.viewEnd = LANES; }
    else if (changedMode) this.fitLaneRange(true);
    else this.fitLaneRange(false);
    this.syncAdvancedControls();
    this.inspectorKey = '';
    this.renderInspector();
    this.updateNavigation();
    this.draw();
  }

  setCursor(tick: number, follow = false): void {
    if (this.cursor === Math.max(0, tick) && !follow) return;
    this.cursor = Math.max(0, tick);
    const visible = (this.canvasHeight - this.bottom) / this.zoom;
    if (follow && (tick < this.scroll || tick > this.scroll + visible * .8)) this.scroll = Math.max(0, tick - visible * .2);
    this.updateNavigation();
    this.draw();
  }

  /** Use the copied game joint textures for HOLD / SLIDE bodies; without them the bodies keep the matching gradient. */
  setBodyTextures(textures: Readonly<Record<string, GameTexture>> | undefined): void {
    const generation = ++this.bodyTextureGeneration; this.bodyTextures = {}; this.canvas.dataset.bodyTextures = 'gradient';
    for (const [type, key] of Object.entries(BODY_TEXTURE) as [NoteType, string][]) {
      const source = textures?.[key]?.dataUrl;
      if (!source || !isBundledImageSource(source)) continue;
      const image = new Image(); image.crossOrigin = 'anonymous';
      image.onload = () => { if (generation !== this.bodyTextureGeneration) return; this.bodyTextures[type] = image; this.canvas.dataset.bodyTextures = 'game'; this.draw(); };
      image.src = source;
    }
    this.draw();
  }
  /** `samples` is the decoded first channel; alignment mode draws it at pixel precision. */
  setWaveform(peaks: Float32Array, duration: number, offset: number, samples?: AudioSamples | null): void {
    this.peaks = peaks;
    this.audioDuration = duration;
    this.audioOffset = offset;
    this.samples = samples ?? undefined;
    if (this.aligning && !this.samples) this.setAligning(false);
    this.host.querySelector('[data-align-offset]')!.textContent = `${(offset * 1000).toFixed(1)} ms`;
    this.updateNavigation();
    this.draw();
  }

  resize(): void {
    const bounds = this.viewport.getBoundingClientRect();
    this.canvasWidth = Math.max(1, bounds.width);
    this.canvasHeight = Math.max(1, bounds.height);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvasWidth * dpr);
    this.canvas.height = Math.round(this.canvasHeight * dpr);
    this.canvas.style.width = `${this.canvasWidth}px`;
    this.canvas.style.height = `${this.canvasHeight}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.syncTrackControls();
    this.draw();
  }

  destroy(): void { this.abort.abort(); this.observer.disconnect(); cancelAnimationFrame(this.pendingDraw); this.host.innerHTML = ''; }
  getSelection(): string[] { return [...this.selection]; }
  selectAll(): void { this.selection = new Set([...this.chart.notes, ...this.chart.events].map(item => item.id)); this.refreshSelection(); }
  copySelection(): void {
    const copied = copyEditorSelection(this.chart, this.selection); if (!copied) return;
    this.clipboard = copied;
    this.setHint(`已复制 ${copied.notes.length + copied.events.length} 项；移动光标后 Ctrl+V 粘贴`);
  }
  pasteSelection(mirrored = false): void {
    if (!this.clipboard) { this.setHint('请先选中并复制音符或事件'); return; }
    const dt = this.quantize(this.cursor) - this.clipboard.firstTick;
    const notes = this.clipboard.notes.map(note => { const item = { ...copyNote(note), id: makeId('note'), tick: note.tick + dt }; delete item.native; return item; });
    const events = this.clipboard.events.map(event => { const item = { ...event, id: makeId('event'), tick: event.tick + dt }; delete item.native; return item; });
    this.selection = new Set([...notes, ...events].map(item => item.id));
    const pasted = { ...this.chart, notes: [...this.chart.notes, ...notes], events: [...this.chart.events, ...events] };
    this.commit(mirrored ? mirrorEditorSelection(pasted, this.selection) : pasted, `${mirrored ? '左右镜像' : ''}粘贴 ${notes.length + events.length} 项`);
  }
  clearSelection(): void { this.selection.clear(); this.refreshSelection(); }
  flipSelection(): void {
    if (!this.chart.notes.some(note => this.selection.has(note.id))) { this.setHint('先选中要前后翻转的音符'); return; }
    this.commit(flipEditorSelection(this.chart, this.selection), '前后翻转音符');
  }
  scaleSelection(): void {
    const text = this.host.querySelector<HTMLInputElement>('[data-option="scale"]')!.value.trim(), factor = parseEditorFraction(text);
    if (!this.selection.size) { this.setHint('先选中要缩放时间间隔的音符或事件'); return; }
    if (factor === undefined || !(factor > 0) || factor > 64) { this.setHint('时间缩放比例须为正数，例如 2、1/2 或 7/8'); return; }
    this.commit(scaleEditorSelection(this.chart, this.selection, factor), `时间轴缩放 ×${text}`);
  }
  /** Open the shape panel for the selected SLIDE / AIR SLIDE segment; the chart changes only on confirm. */
  openShape(shape?: SlideShape): void {
    const note = this.selectedNote();
    if (!note || note.type !== 'SLIDE' && note.type !== 'AIR_SLIDE') { this.setHint('先选中一段 SLIDE / AIR SLIDE，再生成形状'); return; }
    if (this.aligning) this.setAligning(false);
    if (this.inserting) this.setInserting(false);
    this.cancelDrag(); this.continuing = false;
    const field = <T extends HTMLElement>(name: string) => this.shapePanel.querySelector<T>(`[data-shape="${name}"]`)!;
    if (shape) field<HTMLSelectElement>('shape').value = shape;
    const sideways = endLane(note) - note.lane, limit = (this.chart.allowOutOfLane ? 64 : LANES - note.width) - note.lane;
    field<HTMLInputElement>('beats').value = fractionLabel((note.duration ?? 0) * 4 / this.chart.resolution);
    field<HTMLInputElement>('move').value = String(sideways || (limit >= 4 ? 4 : -Math.min(4, note.lane)));
    // Lanes are shown as in the inspector: counted from 1 unless the chart may leave the track.
    const bound = !!boundEditorParent(this.chart, note.id);
    field<HTMLInputElement>('start').value = String(note.lane + this.laneBase); field<HTMLInputElement>('width').value = String(note.width);
    field<HTMLInputElement>('start').disabled = field<HTMLInputElement>('width').disabled = bound;
    this.shapeId = note.id; this.shapePanel.hidden = false;
    this.previewShape(); field<HTMLInputElement>('beats').focus(); field<HTMLInputElement>('beats').select();
  }
  private get laneBase(): number { return this.chart.allowOutOfLane ? 0 : 1; }
  private shapeResult(): SlideShapeResult | undefined {
    const input = (name: string) => this.shapePanel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-shape="${name}"]`)!;
    const field = (name: string) => input(name).value, checked = (name: string) => (input(name) as HTMLInputElement).checked;
    const beats = parseEditorFraction(field('beats')), shape = field('shape') as SlideShape;
    if (!this.shapeId || beats === undefined || !(beats > 0)) return undefined;
    return shapeEditorSlide(this.chart, this.shapeId, { shape, length: beats * this.chart.resolution / 4, move: Number(field('move')) || 0, count: Number(field('count')) || 1,
      ...(field('start').trim() ? { start: Number(field('start')) - this.laneBase } : {}), ...(field('width').trim() ? { width: Number(field('width')) } : {}),
      symmetryV: checked('symmetryV'), symmetryH: checked('symmetryH'), flipV: checked('flipV'), step: this.step, kind: this.nodeKind === 'normal' ? 'normal' : 'control' });
  }
  private previewShape(): void {
    const field = (name: string) => this.shapePanel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-shape="${name}"]`)!;
    const shape = field('shape').value as SlideShape, result = this.shapeResult(), note = this.shapePanel.querySelector<HTMLElement>('[data-shape-note]')!;
    this.shapePanel.querySelector<HTMLElement>('[data-shape-row="count"]')!.hidden = shape === 'curve';
    for (const row of ['start', 'width', 'symmetryV', 'symmetryH', 'flipV']) this.shapePanel.querySelector<HTMLElement>(`[data-shape-row="${row}"]`)!.hidden = shape !== 'curve';
    this.shapePanel.querySelector<HTMLElement>('[data-shape-count-label]')!.textContent = shape === 'wave' ? '往返次数' : '段数';
    this.shapePanel.querySelector<HTMLElement>('[data-shape-move-label]')!.textContent = shape === 'curve' ? '位移（轨道，负数向左）' : '水平移动（轨道，负数向左）';
    this.preview = result?.chart;
    const beats = parseEditorFraction(field('beats').value), wanted = Number(field('move').value) || 0;
    note.textContent = !result ? '长度须为正数，且要给后面相接的一段留出至少一个量化格'
      : [result.move !== Math.round(wanted) ? `${shape === 'curve' ? '位移' : '水平移动'}已收窄为 ${result.move}，再远会超出轨道` : '', beats !== undefined && Math.abs(result.length - beats * this.chart.resolution / 4) > 1e-6 ? '长度已缩短，以保留后面相接的一段' : '',
        shape === 'curve' && field('start').disabled ? '起点绑定在地面音符上，起始位置与宽度不可改' : '',
        `生成 ${result.ids.length} 段；${shape === 'zigzag' ? `折点为${this.nodeKind === 'normal' ? '普通节点' : '控制点'}（跟随“新节点”）` : '中间均为控制点'}`].filter(Boolean).join('；');
    this.draw();
  }
  private closeShape(apply: boolean): void {
    if (this.shapePanel.hidden) return;
    const result = apply ? this.shapeResult() : undefined;
    if (apply && !result) { this.previewShape(); return; }
    this.shapePanel.hidden = true; this.shapeId = undefined; this.preview = undefined;
    if (result) { this.selection = new Set(result.ids); this.commit(result.chart, '生成 SLIDE 形状'); } else this.draw();
    this.viewport.focus({ preventScroll: true });
  }
  /** Margrete's SLIDE join: segments already connect by position here, so joining sets the joint's node kind. */
  joinSelection(kind: EditorNodeKind): void {
    const joints = this.chart.notes.filter(note => this.selection.has(note.id) && hasNodeKind(note) && this.chart.notes.some(next => next.id !== note.id && next.type === note.type && sameTick(next.tick, endTick(note)) && next.lane === endLane(note) && next.width === endWidth(note)));
    if (!joints.length) { this.setHint('选中与下一段首尾相接的 SLIDE / AIR 长条段，再结合'); return; }
    this.commit(joints.reduce((chart, note) => setEditorNodeKind(chart, note.id, kind), this.chart), kind === 'normal' ? '结合为中继点' : '结合为控制点');
  }
  deleteSelection(): void {
    if (!this.selection.size) return;
    // A picked node goes alone and its neighbours join up; the last node takes the segment before it.
    const picked = this.selectedNote(), node = picked?.id === this.pickedJoint ? picked : undefined, joined = node ? removeEditorJoint(this.chart, node.id) : this.chart;
    if (joined !== this.chart) { this.pickedJoint = undefined; this.commit(joined, '删除节点'); return; }
    // SLIDE / AIR chains are deleted by node: the head node takes the whole long note, a body on its own takes nothing.
    const whole = new Set<string>(), notes = new Map(this.chart.notes.map(note => [note.id, note]));
    for (const id of this.selection) {
      const note = notes.get(id);
      if (!note || !hasNodeKind(note) || node) { whole.add(id); continue; }
      if (whole.has(id)) continue;
      const chain = editorChain(this.chart, note);
      if (this.selection.size === 1 ? this.pickedHead === id && chain[0].id === id : this.selection.has(chain[0].id)) for (const item of chain) whole.add(item.id);
    }
    if (!whole.size) { this.setHint('长条按节点删除：右键头节点删除整条，右键其他节点只删该节点；带体不能单独删除'); return; }
    const ids = selectionWithAssignments(this.chart, selectionWithBoundAir(this.chart, whole, false));
    const count = ids.size;
    const chart = { ...this.chart, notes: this.chart.notes.filter(note => !ids.has(note.id)), events: this.chart.events.filter(event => !ids.has(event.id)) };
    this.selection.clear(); this.commit(chart, `删除 ${count} 项`);
  }
  mirrorSelection(): void {
    if (!this.selection.size) return;
    const next = mirrorEditorSelection(this.chart, this.selection);
    const valid = (lane: number, width: number) => this.chart.allowOutOfLane ? lane >= -64 && lane <= 64 && width <= 128 : lane >= 0 && lane + width <= LANES;
    if (next.notes.some((note, index) => note !== this.chart.notes[index] && (!valid(note.lane, note.width) || !valid(endLane(note), endWidth(note)))) || next.events.some((event, index) => event !== this.chart.events[index] && event.type === 'SCROLL_ASSIGNMENT' && !valid(event.lane ?? 0, event.width ?? 1))) {
      this.setHint('镜像结果超出当前坐标范围；请先调整位置或宽度'); return;
    }
    this.commit(next, '镜像音符');
  }

  private get trackViewportWidth(): number { return Math.max(1, this.canvasWidth - this.left - 18); }
  private get trackWidth(): number { return Math.min(this.trackViewportWidth, STANDARD_LANE_WIDTH * (this.viewEnd - this.viewStart)) * this.trackScale; }
  private get trackOffset(): number { return Math.max(0, this.trackWidth - this.trackViewportWidth) * this.trackPan; }
  private get trackRight(): number { return this.left + Math.min(this.trackWidth, this.trackViewportWidth); }
  private get laneWidth(): number { return this.trackWidth / (this.viewEnd - this.viewStart); }
  private x(lane: number): number { return this.left + (lane - this.viewStart) * this.laneWidth - this.trackOffset; }
  private inTrack(x: number): boolean { return x >= this.left && x <= this.trackRight; }
  private y(tick: number): number { return this.canvasHeight - this.bottom - (tick - this.scroll) * this.zoom; }
  private quantize(tick: number): number { if (!this.snap) return Math.max(0, tick); const step = this.step; return Math.max(0, Math.round(tick / step) * step); }
  private get division(): number { return this.snap * (this.snapBase === 'beat' ? 4 : 1); }
  private get step(): number { return this.snap ? this.chart.resolution / this.division : 1; }
  private position(event: MouseEvent): Position {
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const laneAt = this.viewStart + (x - this.left + this.trackOffset) / this.laneWidth;
    return { x, y, tick: this.quantize(this.scroll + (this.canvasHeight - this.bottom - y) / this.zoom), laneAt, lane: clamp(Math.floor(laneAt), this.chart.allowOutOfLane ? -64 : 0, this.chart.allowOutOfLane ? 64 : LANES - 1) };
  }
  /** Left lane of a note of `width` centred on the pointer; an odd width over a lane centre is exact, otherwise the nearest lane boundary. */
  private placeLane(point: Position, width = this.width): number {
    return limitLane(this.chart, Math.round(point.laneAt - width / 2), width);
  }
  private setTrackScale(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.drag) this.cancelDrag();
    const center = (this.trackOffset + (this.trackRight - this.left) / 2) / this.trackWidth;
    this.trackScale = clamp(value, .5, 3);
    const overflow = this.trackWidth - this.trackViewportWidth;
    this.trackPan = overflow > 0 ? clamp((center * this.trackWidth - this.trackViewportWidth / 2) / overflow, 0, 1) : 0;
    this.hover = undefined;
    try { window.localStorage.setItem(TRACK_SCALE_KEY, String(this.trackScale)); } catch { /* Display controls also work when storage is unavailable. */ }
    this.syncTrackControls(); this.draw();
  }
  private syncTrackControls(): void {
    this.host.querySelector<HTMLInputElement>('[data-option="track-width"]')!.value = String(this.trackScale * 100);
    this.host.querySelector<HTMLOutputElement>('[data-track-scale]')!.value = `${Math.round(this.trackScale * 100)}%`;
    const pan = this.host.querySelector<HTMLInputElement>('[data-option="track-pan"]')!;
    pan.value = String(Math.round(this.trackPan * 1000));
    pan.disabled = this.trackWidth <= this.trackViewportWidth + .5;
    this.host.querySelector<HTMLElement>('.editor-track-navigation')!.hidden = pan.disabled;
    Object.assign(this.canvas.dataset, { trackScale: String(this.trackScale), trackWidth: String(this.trackWidth),
      trackRight: String(this.trackRight), trackOffset: String(this.trackOffset), laneWidth: String(this.laneWidth) });
  }
  private emitCursor(tick: number): void { this.cursor = Math.max(0, tick); this.callbacks.onCursor(this.cursor); this.draw(); }
  private setHint(text: string): void { this.host.querySelector('.editor-hint')!.textContent = text; }
  private commit(chart: Chart, label: string): void {
    this.preview = undefined;
    chart = syncEditorAirBindings(this.chart, chart);
    this.callbacks.onChange(chart, label);
    this.setChart(chart);
    this.inspectorKey = '';
    this.renderInspector(); this.updateNavigation(); this.draw();
  }
  private refreshSelection(): void { this.fitLaneRange(false); this.syncAdvancedControls(); this.inspectorKey = ''; this.renderInspector(); this.draw(); }
  private fitLaneRange(all: boolean): void {
    if (!this.chart.allowOutOfLane) return;
    const notes = this.chart.notes.filter(note => all || this.selection.has(note.id));
    const events = this.chart.events.filter(event => event.type === 'SCROLL_ASSIGNMENT' && (all || this.selection.has(event.id)));
    const minimum = Math.min(0, ...notes.flatMap(note => [note.lane, endLane(note)]), ...events.map(event => event.lane ?? 0));
    const maximum = Math.max(LANES, ...notes.flatMap(note => [note.lane + note.width, endLane(note) + endWidth(note)]), ...events.map(event => (event.lane ?? 0) + (event.width ?? 1)));
    if (all) { this.viewStart = Math.max(-64, Math.floor(minimum) - 2); this.viewEnd = Math.min(192, Math.ceil(maximum) + 2); }
    else { if (minimum < this.viewStart) this.viewStart = Math.max(-64, Math.floor(minimum) - 2); if (maximum > this.viewEnd) this.viewEnd = Math.min(192, Math.ceil(maximum) + 2); }
  }
  private syncAdvancedControls(): void {
    const enabled = Boolean(this.chart.allowOutOfLane);
    this.host.querySelector<HTMLInputElement>('[data-option="out-of-lane"]')!.checked = enabled;
    const start = this.host.querySelector<HTMLInputElement>('[data-option="view-start"]')!, end = this.host.querySelector<HTMLInputElement>('[data-option="view-end"]')!;
    start.value = String(this.viewStart); end.value = String(this.viewEnd); start.disabled = !enabled; end.disabled = !enabled;
    const width = this.host.querySelector<HTMLInputElement>('[data-option="width"]')!;
    width.max = enabled ? '128' : '16'; this.width = Math.min(this.width, enabled ? 128 : LANES); width.value = String(this.width);
    this.host.querySelector('.editor-canvas-heading i')!.textContent = enabled ? `演出坐标 ${this.viewStart}…${this.viewEnd}` : '16 LANES';
    this.syncTrackControls();
  }
  private updateNavigation(): void {
    const end = Math.max(this.chart.resolution * 16, getChartEndTick(this.chart) + this.chart.resolution * 4, this.audioDuration ? secondsToTick(this.chart, this.audioDuration + this.audioOffset) : 0, this.cursor + this.chart.resolution * 2, this.scroll);
    this.minimap.max = String(Math.ceil(end)); this.minimap.step = String(this.step); this.minimap.value = String(this.scroll);
  }

  private onClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || !this.host.contains(button)) return;
    if (button.dataset.air) { this.setAir(button.dataset.air as 'IR' | 'DW', this.airLean); return; }
    if (button.dataset.tool) { this.setTool(button.dataset.tool as Tool); return; }
    switch (button.dataset.action) {
      case 'editor-undo': this.callbacks.onUndo(); break;
      case 'editor-redo': this.callbacks.onRedo(); break;
      case 'delete': this.deleteSelection(); break;
      case 'mirror': this.mirrorSelection(); break;
      case 'flip': this.flipSelection(); break;
      case 'scale': this.scaleSelection(); break;
      case 'shape': this.openShape(); break;
      case 'shape-cancel': this.closeShape(false); break;
      case 'copy': this.copySelection(); break;
      case 'paste': this.pasteSelection(); break;
      case 'selectAll': this.selectAll(); break;
      case 'home': this.scroll = Math.max(0, this.cursor - (this.canvasHeight / this.zoom) * .25); this.updateNavigation(); this.draw(); break;
      case 'inspector': this.host.classList.toggle('editor-inspector-hidden'); this.resize(); break;
      case 'fit-track-width': this.setTrackScale(1); break;
      case 'fit-stage': this.viewStart = 0; this.viewEnd = LANES; this.syncAdvancedControls(); this.draw(); break;
      case 'fit-all': this.fitLaneRange(true); this.syncAdvancedControls(); this.draw(); break;
      case 'connect': {
        const note = this.selectedNote();
        if (!note || !long(note)) { this.setHint('先选中一条长条，再点击“接续”'); return; }
        if (this.inserting) this.setInserting(false);
        this.continuing = !this.continuing;
        button.classList.toggle('editor-active', this.continuing);
        this.setHint(this.continuing ? '点击下一节点的时间与轨道；Esc 取消接续' : '已取消接续'); this.draw(); break;
      }
      case 'split': this.setInserting(!this.inserting); break;
      case 'air-side': this.setAir(this.airVertical, Number(button.dataset.side) as -1 | 0 | 1); break;
      case 'align': this.setAligning(!this.aligning); break;
      case 'nudge': this.setOffset(this.audioOffset + Number(button.dataset.ms) / 1000, '微调音乐偏移'); break;
      case 'event': this.addEvent(button.dataset.event as EventType); break;
      case 'applyRaw': this.applyRawAttributes(); break;
      case 'seek': this.emitCursor(Number(button.dataset.tick)); this.setCursor(this.cursor, true); break;
    }
    if (button.dataset.select) { this.selection = new Set([button.dataset.select]); this.refreshSelection(); }
  }

  /** Native AIR token of the current up / down tool and its left / centre / right lean. */
  private get airDirection(): string { return this.airVertical === 'IR' ? ['UL', 'IR', 'UR'][this.airLean + 1] : ['DL', 'DW', 'DR'][this.airLean + 1]; }
  private setAir(vertical: 'IR' | 'DW', lean: -1 | 0 | 1): void { this.airVertical = vertical; this.airLean = lean; this.setTool('AIR'); }
  private setInserting(on: boolean): void {
    if (on) { if (this.aligning) this.setAligning(false); this.cancelDrag(); this.continuing = false; this.host.querySelector('[data-action="connect"]')?.classList.remove('editor-active'); }
    this.inserting = on;
    this.host.querySelector('[data-action="split"]')?.classList.toggle('editor-active', on);
    this.viewport.style.cursor = on ? 'copy' : this.tool === 'select' ? 'default' : this.tool === 'erase' ? 'cell' : 'crosshair';
    this.setHint(on ? '插入节点：把鼠标移到 SLIDE / AIR 长条上，点击即在该处插入 · 可连续插入 · Esc 退出' : '已退出插入节点');
    this.draw();
  }
  /** The chained long note whose body is under the pointer, and the node a click would insert. HOLD has no inner nodes. */
  private insertTarget(point: Position): { note: Note; lane: number; width: number } | undefined {
    const chart = this.chart;
    for (let index = chart.notes.length - 1; index >= 0; index--) {
      const note = chart.notes[index];
      if (!long(note) || note.type === 'HOLD' || !(point.tick > note.tick && point.tick < endTick(note))) continue;
      const startY = this.y(note.tick), finishY = this.y(endTick(note));
      if (point.y > startY + 4 || point.y < finishY - 4) continue;
      const along = clamp((startY - point.y) / (startY - finishY), 0, 1);
      const left = this.x(note.lane) + (this.x(endLane(note)) - this.x(note.lane)) * along, span = (note.width + (endWidth(note) - note.width) * along) * this.laneWidth;
      if (point.x < left - 3 || point.x > left + span + 3) continue;
      const fraction = (point.tick - note.tick) / note.duration!;
      const width = clamp(Math.round(note.width + (endWidth(note) - note.width) * fraction), 1, chart.allowOutOfLane ? 128 : LANES);
      return { note, width, lane: limitLane(chart, Math.round(note.lane + (endLane(note) - note.lane) * fraction), width) };
    }
    return undefined;
  }
  private insertAt(point: Position): void {
    const target = this.insertTarget(point);
    if (!target) { this.setHint('这里没有可插入节点的长条：请点在 SLIDE / AIR SLIDE / AIR HOLD / AIR CRUSH 的带体上（HOLD 没有中间节点）'); return; }
    const result = splitEditorNote(this.chart, target.note.id, point.tick, this.nodeKind === 'inherit' ? undefined : this.nodeKind);
    if (result === this.chart) return;
    this.selection = new Set([target.note.id]);
    this.commit(result, '插入长条节点');
    this.setHint('节点已插入；继续点击可再插入，Esc 完成');
  }
  /** A HOLD, or the first segment of a SLIDE, whose head bar is under the pointer. */
  private groundHeadAt(point: Position): Note | undefined {
    return this.chart.notes.findLast(note => (note.type === 'HOLD' || note.type === 'SLIDE') && Math.abs(point.y - this.y(note.tick)) < 10 && point.x >= this.x(note.lane) - 3 && point.x <= this.x(note.lane + note.width) + 3
      && getNotePlaybackPoints(this.chart, note).some(item => item.position === 'head'));
  }
  private get noteTool(): NoteType | undefined { return this.tool === 'select' || this.tool === 'erase' ? undefined : this.tool; }
  private setNodeKind(kind: EditorNodeKind | 'inherit'): void { this.nodeKind = kind; this.host.querySelector<HTMLSelectElement>('[data-option="node-kind"]')!.value = kind; }
  private setAligning(on: boolean): void {
    if (on && !this.samples) { this.setHint('请先导入音乐，再对齐'); return; }
    if (on && this.inserting) this.setInserting(false);
    this.aligning = on; this.continuing = false; this.cancelDrag();
    this.host.querySelector('[data-action="align"]')!.classList.toggle('editor-active', on);
    this.host.querySelector('[data-action="connect"]')?.classList.remove('editor-active');
    this.host.querySelector<HTMLElement>('.editor-align-controls')!.hidden = !on;
    if (!on && this.zoom > 5) { this.zoom = 5; this.host.querySelector<HTMLInputElement>('[data-option="zoom"]')!.value = '5'; this.updateNavigation(); }
    this.viewport.style.cursor = on ? 'crosshair' : this.tool === 'select' ? 'default' : this.tool === 'erase' ? 'cell' : 'crosshair';
    this.setHint(on ? '对齐音乐：点击小节栏或轨道把光标放到目标线，再点击波形上的起音 · Ctrl+滚轮放大 · Esc 退出' : '已退出对齐音乐');
    this.draw();
  }
  private setOffset(seconds: number, label: string): void {
    // 0.1 ms is finer than one sample period at 48 kHz allows the ear to tell apart, and keeps the stored value readable.
    const offset = Math.round(seconds * 1e4) / 1e4;
    if (!Number.isFinite(offset) || Math.abs(offset) > 600) { this.setHint('音乐偏移超出支持范围'); return; }
    if (offset !== this.audioOffset) this.callbacks.onOffset(offset, label);
  }
  private inAlignWaveform(point: Position): boolean { return point.x >= this.waveformLeft && point.x <= this.waveformLeft + this.alignWidth && point.y <= this.canvasHeight - this.bottom; }
  /** Move the music so that the clicked audio moment lands on the cursor. */
  private alignAt(point: Position): void {
    const tick = this.scroll + (this.canvasHeight - this.bottom - point.y) / this.zoom;
    const audioSeconds = tickToSeconds(this.chart, tick) - this.audioOffset;
    if (audioSeconds < 0 || audioSeconds > this.audioDuration) { this.setHint('这里没有音乐；请点击波形上的起音'); return; }
    this.setOffset(tickToSeconds(this.chart, this.cursor) - audioSeconds, '对齐音乐');
    this.setHint(`已把该起音对齐到光标（${formatTick(this.cursor)} tick）；可用 ±1 / ±10 ms 微调，或重新点击`);
  }
  private setTool(tool: Tool): void {
    if (this.aligning) this.setAligning(false);
    this.tool = tool; this.continuing = false; this.inserting = false;
    if (tool !== 'select' && tool !== 'erase') this.penTool = tool;
    this.host.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.classList.toggle('editor-active', button.dataset.tool === tool && (!button.dataset.air || button.dataset.air === this.airVertical)));
    this.host.querySelector('[data-action="split"]')?.classList.remove('editor-active');
    const side = this.host.querySelector<HTMLElement>('.editor-air-side');
    if (side) { side.hidden = tool !== 'AIR'; side.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.classList.toggle('editor-active', Number(button.dataset.side) === this.airLean)); }
    this.host.querySelector('[data-action="connect"]')?.classList.remove('editor-active');
    this.viewport.style.cursor = tool === 'select' ? 'default' : tool === 'erase' ? 'cell' : 'crosshair';
    this.setHint(tool === 'select' ? '拖动移动 · 左右边缘改宽度 · 点节点编辑节点、拖动改位置 · Shift 框选追加' : tool === 'erase' ? '橡皮擦：点击删除，拖动框选后松开删除 · S 选择' : `${tool === 'AIR' ? `AIR ${({ IR: '上', UL: '左上', UR: '右上', DW: '下', DL: '左下', DR: '右下' } as Record<string, string>)[this.airDirection]}` : LABEL[tool]}：点击放置${LONG.has(tool) ? '，向上拖动设置终点' : ''}${tool === 'EXTAP' ? '；点 HOLD / SLIDE 的头可设为 EX，再点取消' : ''} · 右键删除 · S 选择`);
    this.draw();
  }

  private onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input === this.minimap) { this.scroll = Number(input.value); this.draw(); }
    if (input.dataset.option === 'zoom') { this.zoom = Number(input.value); this.draw(); }
    if (input.dataset.option === 'track-width') this.setTrackScale(Number(input.value) / 100);
    if (input.dataset.option === 'track-pan') { this.trackPan = clamp(Number(input.value) / 1000, 0, 1); this.hover = undefined; this.syncTrackControls(); this.draw(); }
  }

  private onChange(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.dataset.option === 'snap') { this.snap = clamp(Math.round(Number(input.value) || 0), 0, 4096); input.value = String(this.snap); this.updateNavigation(); this.draw(); return; }
    if (input.dataset.option === 'node-kind') { this.nodeKind = input.value as EditorNodeKind | 'inherit'; return; }
    if (input.dataset.option === 'snap-base') { this.snapBase = input.value as 'whole' | 'beat'; this.updateNavigation(); this.draw(); return; }
    if (input.dataset.option === 'out-of-lane') { this.commit({ ...this.chart, allowOutOfLane: (input as HTMLInputElement).checked }, (input as HTMLInputElement).checked ? '启用轨道外演出' : '关闭轨道外演出'); return; }
    if (input.dataset.option === 'view-start') { if (this.chart.allowOutOfLane) this.viewStart = clamp(Number(input.value) || 0, -64, this.viewEnd - 4); this.syncAdvancedControls(); this.draw(); return; }
    if (input.dataset.option === 'view-end') { if (this.chart.allowOutOfLane) this.viewEnd = clamp(Number(input.value) || 16, this.viewStart + 4, 192); this.syncAdvancedControls(); this.draw(); return; }
    if (input.dataset.option === 'width') { this.width = clamp(Math.round(Number(input.value) || 1), 1, this.chart.allowOutOfLane ? 128 : LANES); input.value = String(this.width); this.draw(); return; }
    if (input.dataset.property) this.updateProperty(input.dataset.property, input.type === 'checkbox' ? (input as HTMLInputElement).checked : input.value);
  }

  private selectedNote(): Note | undefined { return this.selection.size === 1 ? this.chart.notes.find(note => this.selection.has(note.id)) : undefined; }
  /** The segment whose end node is selected: a SLIDE / AIR HOLD / AIR SLIDE node that was picked itself, not through the body before it. */
  private selectedNode(): Note | undefined { const note = this.selectedNote(); return note && note.id === this.pickedJoint && hasNodeKind(note) ? note : undefined; }

  private updateProperty(property: string, value: string | boolean): void {
    if (property === 'positionFraction' || property === 'durationFraction') {
      const parsed = parseEditorFraction(String(value));
      if (parsed === undefined || parsed < 0) { this.setHint('音乐时值请输入数字或分数，例如 1/7、3/16、1.5'); this.inspectorKey = ''; this.renderInspector(); return; }
      this.updateProperty(property === 'positionFraction' ? 'tick' : 'duration', String(parsed * this.chart.resolution)); return;
    }
    const note = this.selectedNote();
    // A node is placed by its own time; the segment before it takes whatever length that leaves.
    if (note && (property === 'nodeTick' || property === 'nodePositionFraction')) {
      const tick = property === 'nodeTick' ? Number(value) : (parseEditorFraction(String(value)) ?? NaN) * this.chart.resolution;
      if (!Number.isFinite(tick) || tick < 0) { this.setHint('节点位置请输入数字或分数，例如 1/7、3/16、1.5'); this.inspectorKey = ''; this.renderInspector(); return; }
      this.updateProperty('duration', String(tick - note.tick)); return;
    }
    const number = Number(value);
    if (note) {
      if (property === 'attr.ex') { this.commit(setEditorEx(this.chart, note.id, Boolean(value)), value ? '设为 EX' : '取消 EX'); return; }
      if (property === 'nodeKind') { this.commit(setEditorNodeKind(this.chart, note.id, value as EditorNodeKind), '修改节点类型'); return; }
      if (property === 'height' || property === 'endHeight') { this.commit(setEditorAirHeight(this.chart, note.id, property, Math.max(0, number)), '修改 AIR 高度'); return; }
      if (['tick', 'lane', 'width'].includes(property) && boundEditorParent(this.chart, note.id)) { this.setHint('AIR 绑定在地面音符的尾端，位置与宽度跟随父音符；请修改父音符'); this.inspectorKey = ''; this.renderInspector(); return; }
      let next: Note = { ...copyNote(note) };
      if (property.startsWith('attr.')) { (next.attributes as Record<string, Scalar>)[property.slice(5)] = property === 'attr.interval' ? Math.max(0, number) : value; }
      else if (property === 'type') {
        next.type = value as NoteType;
        if (LONG.has(next.type)) { next.duration ??= this.chart.resolution / 4; next.endLane ??= next.lane; next.endWidth ??= next.width; }
        else { delete next.duration; delete next.endLane; delete next.endWidth; }
        if (next.type === 'AIR_SLIDE' || next.type === 'AIR_CRUSH') { next.height ??= 1; next.endHeight ??= 1; }
      } else {
        if (!Number.isFinite(number)) return;
        switch (property) {
          case 'tick': next.tick = Math.max(0, number); break;
          case 'lane': next.lane = limitLane(this.chart, Math.round(number) - (this.chart.allowOutOfLane ? 0 : 1), next.width); break;
          case 'width': next.width = limitWidth(this.chart, Math.round(number), next.lane); break;
          case 'duration': next.duration = Math.max(next.type === 'AIR_HOLD' || next.type === 'AIR_SLIDE' && next.attributes.visible === false ? 0 : Number.EPSILON, number); break;
          case 'endLane': next.endLane = limitLane(this.chart, Math.round(number) - (this.chart.allowOutOfLane ? 0 : 1), endWidth(next)); break;
          case 'endWidth': next.endWidth = limitWidth(this.chart, Math.round(number), endLane(next)); break;
        }
      }
      if (next.type === 'HOLD' || next.type === 'AIR_HOLD') { next.endLane = next.lane; next.endWidth = next.width; }
      if (['duration', 'endLane', 'endWidth'].includes(property)) { this.commit(this.reshape(this.chart, note, next, true, 1), this.selectedNode() ? '修改节点' : '修改音符属性'); return; }
      this.commit({ ...this.chart, notes: this.chart.notes.map(item => item.id === next.id ? next : item), events: alignAssignments(this.chart, note, next) }, '修改音符属性');
      return;
    }
    const chartEvent = this.chart.events.find(item => this.selection.has(item.id));
    if (!chartEvent || this.selection.size !== 1 || !Number.isFinite(number)) return;
    const next = { ...chartEvent };
    if (property === 'tick') next.tick = Math.max(0, number);
    else if (property === 'value') {
      if (next.type === 'NOTE_SPEED' && number === 0) { this.setHint('音符速度不能为 0；停谱请使用谱面滚速事件'); this.inspectorKey = ''; this.renderInspector(); return; }
      next.value = next.type === 'BPM' ? Math.max(1, number) : number;
    }
    else if (property === 'duration') next.duration = Math.max(0, number);
    else if (property === 'numerator') next.numerator = Math.max(0, Math.round(number));
    else if (property === 'denominator') next.denominator = Math.max(0, Math.round(number));
    else if (property === 'group') { next.group = Math.max(0, Math.round(number)); if (next.type === 'SCROLL_ASSIGNMENT') next.value = next.group; }
    else if (property === 'lane') next.lane = limitLane(this.chart, Math.round(number) - (this.chart.allowOutOfLane ? 0 : 1), next.width ?? 1);
    else if (property === 'width') next.width = limitWidth(this.chart, Math.round(number), next.lane ?? 0);
    if (next.type === 'METER') next.value = next.numerator === 0 || next.denominator === 0 ? 0 : (next.numerator ?? 4) / (next.denominator ?? 4);
    this.commit({ ...this.chart, events: this.chart.events.map(item => item.id === next.id ? next : item) }, `修改 ${EVENT_LABEL[next.type]}`);
  }

  private addEvent(type: EventType): void {
    const target = type === 'SCROLL_ASSIGNMENT' ? this.selectedNote() : undefined;
    let chainEnd = target ? endTick(target) : 0;
    if (target) {
      let last = target;
      const visited = new Set([target.id]);
      for (;;) {
        const next = this.chart.notes.find(note => !visited.has(note.id) && note.type === last.type && sameTick(note.tick, endTick(last)) && note.lane === endLane(last) && note.width === endWidth(last));
        if (!next) break;
        visited.add(next.id); chainEnd = endTick(next); last = next;
      }
    }
    const event: ChartEvent = { id: makeId('event'), tick: this.quantize(this.cursor), type, value: type === 'BPM' ? this.chart.defaultBpm : 1,
      ...(type === 'METER' ? { numerator: 4, denominator: 4 } : {}),
      ...(['SCROLL', 'NOTE_SPEED', 'GROUP_SCROLL', 'SCROLL_ASSIGNMENT'].includes(type) ? { duration: this.chart.resolution } : {}),
      ...(type === 'GROUP_SCROLL' || type === 'SCROLL_ASSIGNMENT' ? { group: 1 } : {}),
      ...(type === 'SCROLL_ASSIGNMENT' ? { tick: target?.tick ?? this.quantize(this.cursor), lane: target?.lane ?? 0, width: target?.width ?? this.width, duration: target ? chainEnd - target.tick : this.chart.resolution } : {}) };
    this.selection = new Set([event.id]);
    this.commit({ ...this.chart, events: [...this.chart.events, event] }, `添加 ${EVENT_LABEL[type]}`);
  }

  private applyRawAttributes(): void {
    const note = this.selectedNote();
    const input = this.inspector.querySelector<HTMLTextAreaElement>('[data-raw-attributes]');
    if (!note || !input) return;
    try {
      const value: unknown = JSON.parse(input.value);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => !['string', 'number', 'boolean'].includes(typeof item))) throw new Error('属性必须是由字符串、数字或布尔值组成的 JSON 对象');
      this.commit({ ...this.chart, notes: this.chart.notes.map(item => item.id === note.id ? { ...item, attributes: value as NoteAttributes } : item) }, '修改原生属性');
      this.setHint('原生属性已应用');
    } catch (error) { this.setHint(`属性格式有误：${error instanceof Error ? error.message : String(error)}`); }
  }

  private hit(position: Position): { id: string; kind: DragKind } | undefined {
    const chart = this.preview ?? this.chart;
    if (position.x > this.trackRight) return undefined;
    if (position.x < this.left) {
      if (position.x <= this.airLeft + this.airWidth + 5) {
        const maximum = this.airHeightMaximum(chart);
        const notes = [...chart.notes].sort((a, b) => Number(this.selection.has(a.id)) - Number(this.selection.has(b.id)));
        for (const note of notes.reverse()) {
          if (!['AIR_SLIDE', 'AIR_CRUSH'].includes(note.type)) continue;
          for (const endpoint of ['endHeight', 'height'] as const) {
            const height = endpoint === 'height' ? note.height ?? 1 : note.endHeight ?? note.height ?? 1;
            const tick = endpoint === 'height' ? note.tick : endTick(note);
            if (Math.abs(position.x - this.airHeightX(height, maximum)) < 7 && Math.abs(position.y - this.y(tick)) < 8) return { id: note.id, kind: endpoint };
          }
        }
      }
      const events = [...chart.events].sort((a, b) => a.tick - b.tick);
      const event = events.find(item => Math.abs(this.y(item.tick) - position.y) < 9 && position.x >= this.eventLeft && position.x < this.eventLeft + 30);
      return event ? { id: event.id, kind: 'move' } : undefined;
    }
    const notes = [...chart.notes].sort((a, b) => Number(this.selection.has(a.id)) - Number(this.selection.has(b.id)));
    // A joint is the end of the segment before it; the segment after it is picked by its body only.
    const joints = new Set(chart.notes.map(note => nextEditorSegment(chart, note)?.id));
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i];
      const startY = this.y(note.tick), finishY = this.y(endTick(note));
      const startX = this.x(note.lane), finishX = this.x(endLane(note));
      if (long(note) && Math.abs(position.y - finishY) < 9 && position.x >= finishX - 4 && position.x <= finishX + endWidth(note) * this.laneWidth + 4) {
        return { id: note.id, kind: Math.abs(position.x - (finishX + endWidth(note) * this.laneWidth)) < 7 ? 'endWidth' : 'end' };
      }
      const span = note.width * this.laneWidth;
      // An AIR is picked by its lifted arrow, which leaves the ground note under it free to click.
      if (note.type === 'AIR' ? Math.abs(position.y - (startY - airArrowLift(span - 2))) <= airArrowHeight(span - 2) / 2 + 2 && position.x >= startX - 3 && position.x <= startX + span + 3
        : !joints.has(note.id) && Math.abs(position.y - startY) < 10 && position.x >= startX - 3 && position.x <= startX + span + 3) {
        return { id: note.id, kind: Math.abs(position.x - (startX + span)) < 7 ? 'width' : span > 24 && Math.abs(position.x - startX) < 5 ? 'widthLeft' : 'move' };
      }
      if (long(note) && position.y < startY && position.y > finishY) {
        const t = (startY - position.y) / (startY - finishY);
        const left = startX + (finishX - startX) * t;
        const width = (note.width + (endWidth(note) - note.width) * t) * this.laneWidth;
        if (position.x >= left && position.x <= left + width) return { id: note.id, kind: 'move' };
      }
    }
    return undefined;
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    this.closeShape(false);
    this.viewport.focus({ preventScroll: true });
    const point = this.position(event);
    if (this.aligning && event.button !== 1) {
      event.preventDefault();
      if (event.button === 0) { if (this.inAlignWaveform(point)) this.alignAt(point); else this.emitCursor(point.tick); }
      return;
    }
    // Space to the right of a narrowed track is not an extra editable lane.
    if (point.x > this.trackRight && event.button !== 1) return;
    if (event.button !== 1) this.pickedJoint = this.pickedHead = undefined;
    let hit = this.hit(point);
    if (event.button === 2) {
      event.preventDefault();
      if (hit) this.erase(hit, point);
      return;
    }
    const hitNote = hit ? this.chart.notes.find(note => note.id === hit!.id) : undefined;
    // AIR layers share a tick and a sensor span with their ground parent.
    const tool = this.noteTool;
    if (event.altKey || tool && AIR.has(tool) && hitNote && !AIR.has(hitNote.type)) hit = undefined;
    if (this.tool === 'erase' && event.button === 0 && hit) { this.erase(hit, point); return; }
    // A bound AIR covers its parent's tail; its width handles edit the parent, which the AIR follows.
    const covered = hit && (hit.kind === 'width' || hit.kind === 'widthLeft') ? boundEditorParent(this.chart, hit.id) : undefined;
    if (hit && covered) hit = !long(covered) ? { id: covered.id, kind: hit.kind } : covered.type === 'SLIDE' && hit.kind === 'width' ? { id: covered.id, kind: 'endWidth' } : { id: hit.id, kind: 'move' };
    if (this.inserting && event.button === 0 && this.inTrack(point.x)) { this.insertAt(point); return; }
    if (this.continuing && event.button === 0 && this.inTrack(point.x)) { this.appendSegment(point); return; }
    // An ExTAP dropped on the head of a HOLD / SLIDE makes that long note EX instead of stacking a second note.
    const exHead = tool === 'EXTAP' && event.button === 0 && !event.altKey && this.inTrack(point.x) ? this.groundHeadAt(point) : undefined;
    if (exHead) {
      const next = setEditorEx(this.chart, exHead.id);
      this.selection = new Set([exHead.id]); this.commit(next, exHead.attributes.ex ? '取消 EX' : '设为 EX');
      this.setHint(exHead.attributes.ex ? `已取消 ${LABEL[exHead.type]} 的 EX` : `${LABEL[exHead.type]} 已设为 EX（导出为 ${exHead.type === 'HOLD' ? 'HXD' : 'SXD / SXC'}）`);
      return;
    }
    const before = new Set(this.selection);
    let kind: DragKind = 'box', id: string | undefined;
    if (event.button === 1) { kind = 'pan'; event.preventDefault(); }
    else if (!hit && (point.x < this.eventLeft || point.y > this.canvasHeight - this.bottom)) { kind = 'seek'; this.emitCursor(point.tick); }
    else if (hit) {
      id = hit.id; kind = hit.kind;
      this.pickedJoint = kind === 'end' || kind === 'endWidth' ? id : undefined;
      this.pickedHead = this.headAt(id, kind, point) ? id : undefined;
      // Only a move carries the rest of the selection along; a handle or joint is edited on its own.
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (this.selection.has(id)) { this.selection.delete(id); this.refreshSelection(); return; }
        this.selection.add(id);
      } else if (!this.selection.has(id) || kind !== 'move') this.selection = new Set([id]);
      this.refreshSelection();
    } else if (tool && this.inTrack(point.x)) {
      const note = createNote(tool, point.tick, this.placeLane(point), this.width);
      if (long(note)) note.duration = this.chart.resolution / 4;
      if (hasNodeKind(note)) note.attributes.visible = this.nodeKind === 'inherit' ? this.selectedNote()?.attributes.visible !== false : this.nodeKind === 'normal';
      if (note.type === 'AIR') note.attributes = { direction: this.airDirection, color: 'DEF' };
      if (tool === 'AIR_CRUSH' || !AIR.has(tool)) this.preview = { ...this.chart, notes: [...this.chart.notes, note] };
      else {
        // The game reads AIR as an attachment of a ground note's tail, never as a free note.
        const parent = hitNote && !AIR.has(hitNote.type) ? hitNote : this.groundTailAt(point);
        this.preview = parent && attachEditorAir(this.chart, note, parent.id);
        if (!this.preview) { this.setHint(parent ? '这个地面音符已带有 AIR；每个地面音符（整条 SLIDE）只能绑定一个' : `${LABEL[tool]} 必须绑定在地面音符上：请点击 TAP / ExTAP / FLICK，或 HOLD / SLIDE 的终点`); return; }
      }
      this.selection = new Set([note.id]); id = note.id; kind = 'draw';
      this.emitCursor(point.tick);
    } else {
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this.selection.clear();
      this.emitCursor(point.tick); this.refreshSelection();
    }
    this.drag = { kind, start: point, current: point, chart: this.chart, id, before: event.shiftKey || event.ctrlKey || event.metaKey ? before : new Set(), moved: false, scroll: this.scroll, pointerId: event.pointerId };
    this.canvas.setPointerCapture(event.pointerId); this.draw();
  }

  /** A SLIDE / AIR chain's first segment when the pointer is on its head node rather than its body. */
  private headAt(id: string, kind: DragKind, point: Position): boolean {
    const note = this.chart.notes.find(item => item.id === id);
    return Boolean(note && hasNodeKind(note) && kind !== 'end' && kind !== 'endWidth' && Math.abs(point.y - this.y(note.tick)) < 10 && editorChain(this.chart, note)[0].id === id);
  }
  /** Delete what was picked: a head node takes its whole long note, any other node goes alone, a chain body takes nothing. */
  private erase(hit: { id: string; kind: DragKind }, point: Position): void {
    this.selection = new Set([hit.id]); this.pickedJoint = hit.kind === 'end' || hit.kind === 'endWidth' ? hit.id : undefined;
    this.pickedHead = this.headAt(hit.id, hit.kind, point) ? hit.id : undefined;
    this.deleteSelection(); this.refreshSelection();
  }

  /** The ground note whose tail is nearest the pointer, within one snap step or the head hit distance. */
  private groundTailAt(point: Position): Note | undefined {
    const reach = Math.max(this.step, 10 / this.zoom);
    return this.chart.notes.filter(note => !AIR.has(note.type) && Math.abs(endTick(note) - point.tick) <= reach && point.lane >= endLane(note) && point.lane < endLane(note) + endWidth(note))
      .sort((a, b) => Math.abs(endTick(a) - point.tick) - Math.abs(endTick(b) - point.tick))[0];
  }

  private appendSegment(point: Position): void {
    const previous = this.selectedNote();
    if (!previous || !long(previous)) return;
    if (point.tick <= endTick(previous)) { this.setHint('接续节点必须晚于当前长条终点'); return; }
    const next = appendEditorNote(this.chart, previous.id, point.tick, this.placeLane(point), this.width, this.nodeKind === 'inherit' ? undefined : this.nodeKind);
    this.selection = new Set([next.notes.at(-1)!.id]);
    this.commit(next, '接续长条节点');
    this.setHint('节点已接续；继续点击可延长，Esc 完成');
  }

  private pointerMove(event: PointerEvent): void {
    const point = this.position(event); this.hover = point;
    const drag = this.drag;
    if (this.aligning && !drag) { this.canvas.style.cursor = ''; this.draw(); return; }
    if (!drag && this.inserting) { this.canvas.style.cursor = ''; this.draw(); return; }
    if (!drag) {
      const hit = this.hit(point);
      this.canvas.style.cursor = hit?.kind === 'width' || hit?.kind === 'widthLeft' || hit?.kind === 'endWidth' || hit?.kind === 'height' || hit?.kind === 'endHeight' ? 'ew-resize' : hit?.kind === 'end' ? 'ns-resize' : hit ? 'grab' : this.tool === 'select' ? 'default' : this.tool === 'erase' ? 'cell' : 'crosshair';
      this.draw(); return;
    }
    drag.current = point;
    if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 3) drag.moved = true;
    if (drag.kind === 'seek') this.emitCursor(point.tick);
    else if (drag.kind === 'pan') { this.scroll = Math.max(0, drag.scroll + (point.y - drag.start.y) / this.zoom); this.updateNavigation(); }
    else if (drag.kind === 'box') {
      const loTick = Math.min(point.tick, drag.start.tick), hiTick = Math.max(point.tick, drag.start.tick);
      const loLane = Math.min(point.lane, drag.start.lane), hiLane = Math.max(point.lane, drag.start.lane) + 1;
      this.selection = new Set(drag.before);
      for (const note of this.chart.notes) {
        if (endTick(note) >= loTick && note.tick <= hiTick && Math.min(note.lane, endLane(note)) < hiLane && Math.max(note.lane + note.width, endLane(note) + endWidth(note)) > loLane) this.selection.add(note.id);
      }
      if (Math.min(point.x, drag.start.x) < this.left) for (const item of this.chart.events) if (item.tick >= loTick && item.tick <= hiTick) this.selection.add(item.id);
    } else if ((drag.kind === 'height' || drag.kind === 'endHeight') && drag.moved && drag.id) {
      const maximum = this.airHeightMaximum(drag.chart);
      const height = Math.round(clamp((point.x - this.airLeft) / this.airWidth, 0, 1) * maximum * 10) / 10;
      this.preview = setEditorAirHeight(drag.chart, drag.id, drag.kind, height);
    } else if (drag.kind === 'move' && drag.moved) {
      this.preview = moveEditorSelection(drag.chart, this.selection, point.tick - drag.start.tick, point.lane - drag.start.lane);
    } else if (drag.kind === 'draw') {
      const note = this.preview?.notes.find(item => item.id === drag.id);
      if (note && long(note) && drag.moved) {
        const next = { ...note, duration: Math.max(this.step, point.tick - note.tick), endLane: note.type === 'HOLD' || note.type === 'AIR_HOLD' ? note.lane : this.placeLane(point, endWidth(note)) };
        this.preview = { ...this.preview!, notes: this.preview!.notes.map(item => item.id === note.id ? next : item) };
      }
    } else if (drag.moved && drag.id) {
      const note = drag.chart.notes.find(item => item.id === drag.id);
      if (!note) return;
      const next = { ...copyNote(note) };
      if (drag.kind === 'width') { next.width = limitWidth(this.chart, Math.round((point.x - this.x(note.lane)) / this.laneWidth), note.lane); }
      if (drag.kind === 'widthLeft') {
        // The right edge stays; the left edge follows the pointer to the nearest lane boundary.
        const right = note.lane + note.width;
        next.lane = clamp(Math.round((point.x - this.x(0)) / this.laneWidth), this.chart.allowOutOfLane ? Math.max(-64, right - 128) : 0, right - 1); next.width = right - next.lane;
      }
      if (drag.kind === 'endWidth') { next.endWidth = limitWidth(this.chart, Math.round((point.x - this.x(endLane(note))) / this.laneWidth), endLane(note)); }
      if (drag.kind === 'end') {
        next.duration = Math.max(this.step, point.tick - note.tick);
        next.endLane = limitLane(this.chart, endLane(note) + point.lane - drag.start.lane, endWidth(note));
      }
      if (next.type === 'HOLD' || next.type === 'AIR_HOLD') { next.endLane = next.lane; next.endWidth = next.width; }
      this.preview = this.reshape(drag.chart, note, next, drag.kind === 'end' || drag.kind === 'endWidth');
    }
    this.draw();
  }

  /** Put a reshaped note back: segments sharing the edited node follow it, the end node when `end`, the start otherwise.
   * `gap` is the shortest length left to the segment after a moved end node.
   */
  private reshape(base: Chart, note: Note, next: Note, end: boolean, gap = this.step): Chart {
    const outgoing = end ? base.notes.filter(item => item.id !== note.id && item.type === note.type && sameTick(item.tick, endTick(note)) && item.lane === endLane(note) && item.width === endWidth(note)) : [];
    const outgoingIds = new Set(outgoing.map(item => item.id));
    // A resized chain start keeps the joint of the segment that ends on it.
    const incomingIds = new Set(!end ? base.notes.filter(item => item.id !== note.id && CHAIN.has(note.type) && item.type === note.type && sameTick(endTick(item), note.tick) && endLane(item) === note.lane && endWidth(item) === note.width).map(item => item.id) : []);
    const latestEnd = outgoing.length ? Math.min(...outgoing.map(endTick)) - gap : Infinity;
    if (endTick(next) > latestEnd) next = { ...next, duration: Math.max(gap, latestEnd - next.tick) };
    return syncEditorAirBindings(base, { ...base, events: alignAssignments(base, note, next), notes: base.notes.map(item => item.id === next.id ? next : outgoingIds.has(item.id) ? { ...item, tick: endTick(next), duration: Math.max(gap, endTick(item) - endTick(next)), lane: endLane(next), width: endWidth(next) } : incomingIds.has(item.id) ? { ...item, endLane: next.lane, endWidth: next.width } : item) });
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const result = this.preview;
    this.drag = undefined; this.preview = undefined;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (this.tool === 'erase' && drag.kind === 'box' && drag.moved && this.selection.size) { this.deleteSelection(); return; }
    if (result && (drag.moved || drag.kind === 'draw')) this.commit(result, drag.kind === 'draw' ? '放置音符' : drag.kind === 'move' ? '移动选中项' : '调整长条节点');
    else this.refreshSelection();
  }
  private cancelDrag(): void { this.drag = undefined; this.preview = undefined; this.refreshSelection(); }
  private doubleClick(event: MouseEvent): void {
    const point = this.position(event), hit = this.hit(point);
    if (!hit) return;
    const result = splitEditorNote(this.chart, hit.id, point.tick, this.nodeKind === 'inherit' ? undefined : this.nodeKind);
    if (result !== this.chart) this.commit(result, '插入长条节点');
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      // Chromium reports a Shift+wheel turn on the horizontal axis.
      const divisions = [4, 8, 12, 16, 24, 32, 48, 64, 96, 192], wider = (event.deltaY || event.deltaX) < 0;
      const next = wider ? divisions.findLast(value => value < this.snap) : divisions.find(value => value > this.snap);
      if (next) { this.snap = next; this.host.querySelector<HTMLInputElement>('[data-option="snap"]')!.value = String(next); this.setHint(`量化 1/${next}`); }
    } else if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) > Math.abs(event.deltaY) && this.trackWidth > this.trackViewportWidth) {
      this.trackPan = clamp(this.trackPan + event.deltaX / (this.trackWidth - this.trackViewportWidth), 0, 1);
      this.hover = undefined;
      this.syncTrackControls();
    } else if (event.ctrlKey || event.metaKey) {
      const point = this.position(event);
      const old = this.zoom;
      this.zoom = clamp(this.zoom * Math.exp(-event.deltaY * .002), .2, this.aligning ? 20 : 5);
      this.scroll = Math.max(0, point.tick - (point.tick - this.scroll) * old / this.zoom);
      this.host.querySelector<HTMLInputElement>('[data-option="zoom"]')!.value = String(this.zoom);
    } else this.scroll = Math.max(0, this.scroll - event.deltaY / this.zoom);
    this.updateNavigation(); this.draw();
  }

  private keyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || document.querySelector('dialog[open]') || target?.closest('input, textarea, select, [contenteditable="true"]') || !this.host.isConnected || this.host.getClientRects().length === 0) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? this.callbacks.onRedo() : this.callbacks.onUndo(); return; }
    if (mod && key === 'y') { event.preventDefault(); this.callbacks.onRedo(); return; }
    if (mod && ['a', 'c', 'v', 'x'].includes(key)) {
      event.preventDefault();
      if (key === 'a') event.shiftKey ? this.clearSelection() : this.selectAll();
      if (key === 'c') this.copySelection(); if (key === 'v') this.pasteSelection(event.shiftKey); if (key === 'x') { this.copySelection(); this.deleteSelection(); } return;
    }
    if (key === 'escape' && this.aligning) { this.setAligning(false); return; }
    if (key === 'escape' && !this.shapePanel.hidden) { this.closeShape(false); return; }
    if (key === 'escape' && this.inserting) { this.setInserting(false); return; }
    if (key === 'escape') { this.cancelDrag(); this.continuing = false; this.selection.clear(); this.setTool('select'); this.refreshSelection(); return; }
    if (key === 'delete' || key === 'backspace') { event.preventDefault(); this.deleteSelection(); return; }
    // Margrete's default single-key commands.
    if (!mod && !event.altKey) switch (key) {
      case 's': this.setTool('select'); break;
      case 'w': this.setTool(this.penTool); break;
      case 'e': this.setTool('erase'); break;
      case 'a': this.setTool('select'); if (this.host.classList.contains('editor-inspector-hidden')) { this.host.classList.remove('editor-inspector-hidden'); this.resize(); } this.setHint('属性编辑：点击音符，在右侧属性面板修改'); break;
      case 'h': this.mirrorSelection(); break;
      case 'v': this.flipSelection(); break;
      case 'l': this.scaleSelection(); break;
      case 'k': this.setInserting(!this.inserting); break;
      case 'j': this.joinSelection(event.shiftKey ? 'control' : 'normal'); break;
      case 'r': event.preventDefault(); this.openShape('curve'); break;
      case 'z': event.preventDefault(); this.openShape('zigzag'); break;
      case 'b': this.addEvent('BPM'); break;
      case 'n': this.addEvent('SCROLL'); break;
      case 'd': this.addEvent('NOTE_SPEED'); break;
      case 'm': this.addEvent('METER'); break;
      case '1': this.setTool('TAP'); break;
      case '2': this.setTool('EXTAP'); break;
      case '3': this.setTool('FLICK'); break;
      case '4': this.setTool('SLIDE'); this.setNodeKind('control'); break;
      case '5': this.setTool('SLIDE'); this.setNodeKind('normal'); break;
      case '6': this.setTool('HOLD'); break;
      case '7': case '8': {
        // Pressing the key of the AIR tool already in use steps its lean: centre, left, right.
        const vertical = key === '7' ? 'IR' : 'DW', again = this.tool === 'AIR' && this.airVertical === vertical;
        this.setAir(vertical, again ? ([-1, 1, 0] as const)[[0, -1, 1].indexOf(this.airLean)] : this.airLean); break;
      }
      case '9': this.setTool('AIR_HOLD'); break;
      case 't': this.setTool('AIR_SLIDE'); this.setNodeKind('normal'); break;
      case 'y': this.setTool('AIR_SLIDE'); this.setNodeKind('control'); break;
      case 'u': case 'i': this.setTool('AIR_CRUSH'); break;
      case '0': this.setTool('DAMAGE'); break;
    }
    if (key === '[' || key === ']') { this.width = clamp(this.width + (key === '[' ? -1 : 1), 1, this.chart.allowOutOfLane ? 128 : LANES); this.host.querySelector<HTMLInputElement>('[data-option="width"]')!.value = String(this.width); this.draw(); }
    if (key === 'home') { event.preventDefault(); this.scroll = 0; this.emitCursor(0); this.updateNavigation(); }
    if (key === 'end') { event.preventDefault(); this.emitCursor(getChartEndTick(this.chart)); this.setCursor(this.cursor, true); }
    if (key === 'pageup' || key === 'pagedown') { event.preventDefault(); this.scroll = Math.max(0, this.scroll + (key === 'pageup' ? 1 : -1) * this.canvasHeight / this.zoom * .8); this.updateNavigation(); this.draw(); }
    if (this.selection.size && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      event.preventDefault(); const amount = event.shiftKey ? this.chart.resolution / 4 : this.step;
      this.commit(moveEditorSelection(this.chart, this.selection, key === 'arrowup' ? amount : key === 'arrowdown' ? -amount : 0, key === 'arrowleft' ? -1 : key === 'arrowright' ? 1 : 0), '微调选中项');
    }
  }

  private input(label: string, property: string, value: unknown, options = ''): string {
    return `<label class="editor-field"><span>${label}</span><input data-property="${property}" type="number" value="${esc(value)}" ${options}></label>`;
  }
  private textInput(label: string, property: string, value: unknown, list = ''): string {
    return `<label class="editor-field"><span>${label}</span><input data-property="${property}" type="text" value="${esc(value)}" ${list ? `list="editor-${list}"` : ''}></label>`;
  }
  private checkbox(label: string, property: string, value: boolean): string { return `<label class="editor-checkbox"><input type="checkbox" data-property="${property}" ${value ? 'checked' : ''}><span>${label}</span></label>`; }

  private renderInspector(): void {
    const advanced = Boolean(this.chart.allowOutOfLane), laneOffset = advanced ? 0 : 1;
    const laneOptions = advanced ? 'min="-64" max="64"' : 'min="1" max="16"';
    const widthOptions = `min="1" max="${advanced ? 128 : 16}"`;
    const selected = [...this.chart.notes, ...this.chart.events].filter(item => this.selection.has(item.id));
    const node = this.selectedNode();
    const key = selected.map(item => JSON.stringify(item)).join('|') + this.chart.events.length + (node ? 'node' : '');
    if (key === this.inspectorKey) return;
    this.inspectorKey = key;
    let content = `<div class="editor-inspector-title"><span>属性</span><small>${selected.length ? `已选 ${selected.length} 项` : 'INSPECTOR'}</small></div>`;
    if (node) {
      const normal = node.type === 'SLIDE' ? `${node.attributes.ex ? 'SXD' : 'SLD'} · 普通连接点` : node.type === 'AIR_HOLD' ? 'AHD · AIR 动作节点' : 'ASD · AIR 动作节点';
      const control = node.type === 'SLIDE' ? `${node.attributes.ex ? 'SXC' : 'SLC'} · 轨迹控制点` : node.type === 'AIR_HOLD' ? 'AHX · 无动作节点' : 'ASC · 轨迹控制点';
      const following = nextEditorSegment(this.chart, node);
      content += `<div class="editor-selection-heading" style="--note-color:${noteColor(node)}"><i></i><strong>${LABEL[node.type]} 节点</strong><code>${getNativeNoteTag(node)}</code></div><label class="editor-field editor-node-property"><span>节点类型</span><select data-property="nodeKind"><option value="normal" ${node.attributes.visible !== false ? 'selected' : ''}>${normal}</option><option value="control" ${node.attributes.visible === false ? 'selected' : ''}>${control}</option></select></label><p class="editor-help">${node.type === 'SLIDE' ? 'SLD 显示蓝色分隔条；SLC 只改变轨迹，演示中不显示分隔。两者都须持续按住，无须重新拍键。' : '动作节点在此处产生 AIR ACTION；控制 / 无动作节点不新增这次动作，持续段仍保留。'} 实心横条为普通 / 动作节点，空心菱形为控制点。</p>`;
      content += this.textInput('位置（全音符，可填 1/7）', 'nodePositionFraction', fractionLabel(endTick(node) / this.chart.resolution)) + this.input('节点 tick', 'nodeTick', endTick(node), 'min="0" step="any"');
      if (node.type !== 'AIR_HOLD') content += `<div class="editor-field-pair">${this.input(advanced ? '坐标（0 基）' : '轨道', 'endLane', endLane(node) + laneOffset, laneOptions)}${this.input('宽度', 'endWidth', endWidth(node), widthOptions)}</div>`;
      if (node.type === 'AIR_SLIDE') content += this.input('高度', 'endHeight', node.endHeight ?? node.height ?? 1, 'min="0" step="0.1"');
      content += `<p class="editor-help">${following ? '节点前后两段共用这里的位置与宽度，修改时一起跟随。点击带体可选中整段。' : '这是长条的终点。点击带体可选中整段。'}</p><div class="editor-inspector-actions">${following ? '<button class="editor-danger" data-action="delete">删除节点</button>' : '<button data-action="connect">⌁ 接续节点</button>'}</div>`;
    } else if (selected.length === 1 && 'attributes' in selected[0]) {
      const note = selected[0];
      content += `<div class="editor-selection-heading" style="--note-color:${noteColor(note)}"><i></i><strong>${LABEL[note.type]}</strong><code>${getNativeNoteTag(note)}</code></div><label class="editor-field"><span>音符类型</span><select data-property="type">${NOTE_TYPES.map(type => `<option value="${type}" ${type === note.type ? 'selected' : ''}>${LABEL[type]}</option>`).join('')}</select></label>`;
      content += this.textInput('位置（全音符，可填 1/7）', 'positionFraction', fractionLabel(note.tick / this.chart.resolution)) + this.input('起始 tick', 'tick', note.tick, 'min="0" step="any"') + `<div class="editor-field-pair">${this.input(advanced ? '起点坐标（0 基）' : '起始轨道', 'lane', note.lane + laneOffset, laneOptions)}${this.input('宽度', 'width', note.width, widthOptions)}</div>`;
      if (long(note)) content += `<div class="editor-section-label">长条终点</div>${this.textInput('时长（全音符，可填 1/7）', 'durationFraction', fractionLabel((note.duration ?? 0) / this.chart.resolution))}${this.input('长度 tick', 'duration', note.duration, `min="${note.type === 'AIR_HOLD' || note.type === 'AIR_SLIDE' && note.attributes.visible === false ? 0 : .000001}" step="any"`)}<div class="editor-field-pair">${this.input(advanced ? '终点坐标（0 基）' : '终点轨道', 'endLane', endLane(note) + laneOffset, laneOptions)}${this.input('终点宽度', 'endWidth', endWidth(note), widthOptions)}</div><div class="editor-inspector-actions"><button data-action="connect">⌁ 接续节点</button><button data-action="split">◇ 插入节点</button></div>`;
      if (note.type === 'AIR_SLIDE' || note.type === 'AIR_CRUSH') content += `<div class="editor-field-pair">${this.input('起始高度', 'height', note.height ?? 1, 'min="0" step="0.1"')}${this.input('终点高度', 'endHeight', note.endHeight ?? note.height ?? 1, 'min="0" step="0.1"')}</div>`;
      content += `<div class="editor-section-label">原生 / WORLD’S END 属性</div>`;
      if (note.type === 'AIR') content += `<label class="editor-field"><span>AIR 方向</span><select data-property="attr.direction">${[['IR', '↑ 上'], ['UL', '↖ 左上'], ['UR', '↗ 右上'], ['DW', '↓ 下'], ['DL', '↙ 左下'], ['DR', '↘ 右下']].map(([value, label]) => `<option value="${value}" ${value === (note.attributes.direction ?? 'IR') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
      if (note.type === 'FLICK') content += this.textInput('方向', 'attr.direction', note.attributes.direction ?? '', 'direction');
      if (AIR.has(note.type) || note.type === 'SLIDE') content += this.textInput('关联音符', 'attr.parent', note.attributes.parent ?? (note.type === 'SLIDE' ? 'SLD' : 'TAP'), 'parent');
      if (note.type !== 'AIR_CRUSH' && AIR.has(note.type) && !['AHD', 'AHX', 'ASD', 'ASC'].includes(String(note.attributes.parent))) content += `<p class="editor-help">${boundEditorParent(this.chart, note.id) ? '已绑定在地面音符的尾端：位置与宽度跟随父音符，移动或删除父音符时一并处理。' : '未绑定地面音符：原游戏读谱时找不到父音符会失败。请删除后在地面音符上重新放置。'}</p>`;
      if (AIR.has(note.type)) content += this.textInput('颜色', 'attr.color', note.attributes.color ?? 'DEF', 'color');
      if (note.type === 'EXTAP' || note.type === 'HOLD' || note.type === 'SLIDE' || note.type === 'AIR_CRUSH') content += this.textInput('特效', 'attr.effect', note.attributes.effect ?? (note.type === 'AIR_CRUSH' ? 'DEF' : 'UP'), 'effect');
      if (note.type === 'HOLD' || note.type === 'SLIDE') content += this.checkbox('EX 音符', 'attr.ex', Boolean(note.attributes.ex));
      if (note.type === 'AIR_CRUSH') content += this.input('CRUSH 间隔 tick', 'attr.interval', note.attributes.interval ?? 24, 'min="0"') + `<p class="editor-help">间隔 0 表示无判定装饰段。</p>`;
      content += `<details class="editor-raw"><summary>高级原生属性</summary><textarea data-raw-attributes spellcheck="false" aria-label="原生属性 JSON">${esc(JSON.stringify(note.attributes, null, 2))}</textarea><button data-action="applyRaw">应用属性</button><p>只编辑已知原生值；未识别的源行与额外列随谱面保留。</p></details><div class="editor-inspector-actions"><button data-action="copy">复制</button><button data-action="mirror">镜像</button><button class="editor-danger" data-action="delete">删除</button></div>`;
    } else if (selected.length === 1) {
      const item = selected[0] as ChartEvent;
      content += `<div class="editor-selection-heading editor-event-heading"><i></i><strong>${EVENT_LABEL[item.type]}</strong><code>EVENT</code></div>${this.textInput('位置（全音符，可填 1/7）', 'positionFraction', fractionLabel(item.tick / this.chart.resolution))}${this.input('起始 tick', 'tick', item.tick, 'min="0" step="any"')}`;
      if (item.type === 'METER') content += `<div class="editor-field-pair">${this.input('分子', 'numerator', item.numerator ?? 4, 'min="0"')}${this.input('分母', 'denominator', item.denominator ?? 4, 'min="0"')}</div><p class="editor-help">拍号改变小节线；原生 tick 的时间基准保持不变。分子或分母为 0 时隐藏小节线，用于特殊谱演出。</p>`;
      else if (item.type !== 'SCROLL_ASSIGNMENT' && item.type !== 'STOP') content += this.input(item.type === 'BPM' ? 'BPM' : '速度倍率', 'value', item.value, `step="${item.type === 'BPM' ? '.1' : '.05'}" ${item.type === 'BPM' ? 'min="1"' : ''}`);
      if (item.type === 'GROUP_SCROLL' || item.type === 'SCROLL_ASSIGNMENT') content += this.input('分组编号', 'group', item.group ?? (item.type === 'SCROLL_ASSIGNMENT' ? item.value : 0), 'min="0" step="1"');
      if (item.type === 'SCROLL_ASSIGNMENT') content += `<div class="editor-field-pair">${this.input(advanced ? '起点坐标（0 基）' : '起始轨道', 'lane', (item.lane ?? 0) + laneOffset, laneOptions)}${this.input('宽度', 'width', item.width ?? this.width, widthOptions)}</div>`;
      if (['SCROLL', 'NOTE_SPEED', 'GROUP_SCROLL', 'SCROLL_ASSIGNMENT'].includes(item.type)) content += this.textInput('时长（全音符，可填 1/7）', 'durationFraction', fractionLabel((item.duration ?? this.chart.resolution) / this.chart.resolution)) + this.input('持续 tick', 'duration', item.duration ?? this.chart.resolution, 'min="0" step="any"') + `<p class="editor-help">${item.type === 'SCROLL_ASSIGNMENT' ? '精确匹配事件起点的时间、轨道、宽度；持续时间覆盖该长条链。编辑对应音符时，分组关联自动同步。' : item.type === 'GROUP_SCROLL' ? '控制指定分组的滚速。0 组为全局；其他分组配合滚速分组事件使用。' : item.type === 'SCROLL' ? '支持零速、负速与正速。' : '支持正负倍率，不能为零。'}持续区间以原生 tick 为单位。</p>`;
      if (item.type === 'STOP') content += this.input('持续 tick', 'duration', item.duration ?? this.chart.resolution, 'min="0"') + `<p class="editor-help">保留导入谱面的旧版 STP。预览按区间停止显示，实际游戏行为待对照；新建停止可使用倍率 0 的谱面滚速事件。</p>`;
      content += `<div class="editor-inspector-actions"><button data-action="seek" data-tick="${item.tick}">定位光标</button><button class="editor-danger" data-action="delete">删除事件</button></div>`;
    } else if (selected.length > 1) {
      content += `<div class="editor-multi-count">${selected.length}<span>个项目已选中</span></div><p class="editor-help">拖动整组选区。方向键微调轨道与时间；Shift + 方向键按一拍移动。工具栏的“翻转”与“时间 ×”作用于整组选区。</p><div class="editor-inspector-actions"><button data-action="copy">复制</button><button data-action="mirror">镜像</button><button data-action="flip">翻转</button><button class="editor-danger" data-action="delete">删除</button></div>`;
    } else {
      content += `<div class="editor-empty-selection"><div>◇</div><strong>音符属性</strong><p>点击音符编辑属性；点击 SLIDE / AIR 长条的节点编辑该节点。拖动空白区域框选，Shift 保留原有选择。</p></div><div class="editor-shortcuts"><p><kbd>S / W / E</kbd><span>选择 / 笔 / 橡皮</span></p><p><kbd>1 — 0 · T Y U</kbd><span>切换音符</span></p><p><kbd>H / V / L</kbd><span>镜像 / 翻转 / 时间缩放</span></p><p><kbd>B N D M</kbd><span>BPM / 滚速 / 音符速度 / 拍号</span></p><p><kbd>K · J · R</kbd><span>插入节点 · 结合 · 曲线</span></p><p><kbd>[ ]</kbd><span>调整放置宽度</span></p><p><kbd>Shift + 滚轮</kbd><span>量化间隔</span></p><p><kbd>Ctrl + 滚轮</kbd><span>时间轴缩放</span></p><p><kbd>中键拖动</kbd><span>平移时间轴</span></p><p><kbd>双击长条</kbd><span>插入节点</span></p></div>`;
    }
    content += `<div class="editor-section-label editor-events-title">时间事件 <small>添加到光标位置</small></div><div class="editor-event-buttons">${(Object.keys(EVENT_LABEL) as EventType[]).filter(type => type !== 'STOP').map(type => `<button data-action="event" data-event="${type}">＋ ${EVENT_LABEL[type]}</button>`).join('')}</div>`;
    const events = [...this.chart.events].sort((a, b) => a.tick - b.tick);
    if (events.length) content += `<div class="editor-event-list">${events.slice(0, 120).map(item => `<button data-select="${esc(item.id)}" class="${this.selection.has(item.id) ? 'editor-selected-event' : ''}"><span>${EVENT_LABEL[item.type]}</span><strong>${item.type === 'METER' ? `${item.numerator}/${item.denominator}` : item.value}</strong><small title="${item.tick} tick">${Number(item.tick.toFixed(3))}t</small></button>`).join('')}${events.length > 120 ? `<p class="editor-help">显示前 120 个事件；画布中可选择全部事件。</p>` : ''}</div>`;
    content += `<datalist id="editor-parent">${['TAP', 'CHR', 'FLK', 'HLD', 'SLD', 'AIR', 'AHD', 'ASD', 'MNE'].map(value => `<option value="${value}">`).join('')}</datalist><datalist id="editor-color">${['DEF', 'RED', 'ORN', 'YEL', 'GRN', 'CYN', 'BLU', 'PPL', 'PNK', 'VLT', 'GRY', 'BLK', 'NON'].map(value => `<option value="${value}">`).join('')}</datalist><datalist id="editor-effect"><option value="UP"><option value="DOWN"><option value="DEF"></datalist><datalist id="editor-direction"><option value="L"><option value="R"></datalist>`;
    this.inspector.innerHTML = content;
  }

  private draw(): void {
    if (this.pendingDraw) return;
    this.pendingDraw = requestAnimationFrame(() => { this.pendingDraw = 0; this.paint(); });
  }

  private paint(): void {
    const ctx = this.context, w = this.canvasWidth, h = this.canvasHeight;
    const chart = this.preview ?? this.chart;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, w, h);
    const right = this.trackRight, lo = this.scroll, hi = this.scroll + (h - this.bottom) / this.zoom;
    ctx.fillStyle = '#080808'; ctx.fillRect(this.rulerLeft, 0, this.rulerWidth, h - this.bottom);
    // Lightly alternate the four sensor banks while retaining all sixteen lane boundaries.
    ctx.save(); ctx.beginPath(); ctx.rect(this.left, 0, right - this.left, h - this.bottom); ctx.clip();
    for (let lane = Math.floor(this.viewStart); lane < Math.ceil(this.viewEnd); lane++) {
      const outside = lane < 0 || lane >= LANES;
      ctx.fillStyle = outside ? '#151015' : Math.floor(lane / 4) % 2 ? '#050505' : '#000000'; ctx.fillRect(this.x(lane), 0, this.laneWidth, h - this.bottom);
      if (outside && this.laneWidth < 8 && lane % 4 !== 0) continue;
      ctx.strokeStyle = lane === 0 || lane === LANES ? '#777777' : outside ? '#383038' : lane % 4 === 0 ? '#464646' : '#242424'; ctx.lineWidth = lane === 0 || lane === LANES ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(this.x(lane) + .5, 0); ctx.lineTo(this.x(lane) + .5, h - this.bottom); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#464646'; ctx.beginPath(); ctx.moveTo(right + .5, 0); ctx.lineTo(right + .5, h - this.bottom); ctx.stroke();
    const division = this.division || 16;
    const grid = getGrid(chart, Math.max(0, lo), hi + chart.resolution, division);
    for (const line of grid) {
      const y = this.y(line.tick);
      if (y < -1 || y > h - this.bottom + 1) continue;
      if (!line.major && this.zoom * chart.resolution / division < 5) continue;
      ctx.strokeStyle = line.major ? '#606060' : line.beat === Math.floor(line.beat) ? '#353535' : '#1a1a1a';
      ctx.lineWidth = line.major ? 1.25 : .65;
      ctx.beginPath(); ctx.moveTo(line.major ? this.airLeft : this.left, Math.round(y) + .5); ctx.lineTo(right, Math.round(y) + .5); ctx.stroke();
    }
    this.paintWaveform(ctx, lo, hi);
    this.paintAirHeights(ctx, chart, lo, hi);
    // A separate ruler gives measure names their own space, including at simultaneous BPM/MET events.
    let lastLabelY = Infinity;
    for (const line of grid) {
      if (!line.major) continue;
      const y = this.y(line.tick);
      if (y < 0 || y > h - this.bottom || lastLabelY - y < 23) continue;
      const top = clamp(y - 21, 0, Math.max(0, h - this.bottom - 21));
      ctx.fillStyle = '#151515'; ctx.beginPath(); ctx.rect(this.rulerLeft + 4, top, this.rulerWidth - 8, 20); ctx.fill();
      ctx.fillStyle = '#dddddd'; ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(`第${String(line.measure + 1).padStart(3, '0')}小节`, this.rulerLeft + 7, top + 14, this.rulerWidth - 14);
      if (lastLabelY - y >= 44 && y + 14 < h - this.bottom) {
        ctx.fillStyle = '#888888'; ctx.font = '9px "Segoe UI", sans-serif'; ctx.fillText(`${formatTick(line.tick)} tick`, this.rulerLeft + 8, y + 12, this.rulerWidth - 12);
      }
      lastLabelY = y;
    }
    ctx.save(); ctx.beginPath(); ctx.rect(this.left, 0, right - this.left, h - this.bottom); ctx.clip();
    for (const event of chart.events) {
      if (event.type !== 'SCROLL_ASSIGNMENT' || !this.selection.has(event.id)) continue;
      const y = this.y(event.tick), finish = this.y(event.tick + (event.duration ?? 0));
      ctx.fillStyle = '#c4b5fd14'; ctx.strokeStyle = '#c4b5fd99'; ctx.setLineDash([4, 4]);
      ctx.fillRect(this.x(event.lane ?? 0), finish, (event.width ?? 1) * this.laneWidth, y - finish);
      ctx.strokeRect(this.x(event.lane ?? 0), finish, (event.width ?? 1) * this.laneWidth, y - finish); ctx.setLineDash([]);
    }
    const visible = chart.notes.filter(note => endTick(note) >= lo - 20 / this.zoom && note.tick <= hi + 32 / this.zoom);
    for (const note of visible.filter(long)) this.paintNote(ctx, note, true);
    for (const note of visible) this.paintNote(ctx, note, false);
    ctx.restore();
    // Dedicated event gutter keeps timing edits separate from note hit targets.
    const labelRoom = w - right >= 90, labelRows = new Map<number, number>();
    for (const item of [...chart.events].sort((a, b) => a.tick - b.tick)) {
      const y = this.y(item.tick); if (y < -10 || y > h - this.bottom + 10) continue;
      ctx.fillStyle = this.selection.has(item.id) ? '#c4b5fd' : item.type === 'BPM' ? '#65cf69' : '#d4a46b';
      ctx.fillRect(this.eventLeft, y - 7, 30, 14);
      ctx.fillStyle = '#202020'; ctx.font = 'bold 8px "Segoe UI", sans-serif'; ctx.fillText(({ BPM: 'BPM', METER: 'MET', SCROLL: 'SFL', NOTE_SPEED: 'DCM', GROUP_SCROLL: 'SLP', SCROLL_ASSIGNMENT: 'SLA', STOP: 'STP' })[item.type], this.eventLeft + 3, y + 3);
      ctx.strokeStyle = '#a897d852'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(this.left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
      if (labelRoom && item.type !== 'SCROLL_ASSIGNMENT') {
        // Margrete shows each event's value beside the chart; events sharing a tick line up in one row.
        const row = Math.round(y), text = eventText(item); ctx.font = '11px "Segoe UI", sans-serif';
        const x = labelRows.get(row) ?? right + 10, width = ctx.measureText(text).width;
        ctx.fillStyle = ctx.strokeStyle = this.selection.has(item.id) ? '#c4b5fd' : EVENT_COLOR[item.type];
        ctx.fillText(text, x, y - 3); ctx.beginPath(); ctx.moveTo(x - 4, row + .5); ctx.lineTo(x + width + 4, row + .5); ctx.stroke();
        labelRows.set(row, x + width + 14);
      } else if (item.type === 'BPM') { ctx.fillStyle = '#101010ee'; ctx.fillRect(this.left + 5, y - 19, 63, 14); ctx.fillStyle = '#65cf69'; ctx.font = '10px "Segoe UI", sans-serif'; ctx.fillText(`♩ ${formatTick(item.value)}`, this.left + 9, y - 8); }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(this.left, 0, right - this.left, h - this.bottom); ctx.clip();
    const ghostTool = this.noteTool;
    const insert = this.inserting && this.hover && !this.drag && this.inTrack(this.hover.x) ? this.insertTarget(this.hover) : undefined;
    if (insert) {
      // The node a click would insert: a bar for an ordinary node, a hollow diamond for a control point.
      const y = this.y(this.hover!.tick), x = this.x(insert.lane) + 1, width = insert.width * this.laneWidth - 2, color = noteColor(insert.note);
      const control = hasNodeKind(insert.note) && (this.nodeKind === 'inherit' ? insert.note.attributes.visible === false : this.nodeKind === 'control');
      ctx.strokeStyle = '#ffffff'; ctx.fillStyle = `${color}cc`; ctx.lineWidth = 1.5;
      if (control) { const center = x + width / 2; ctx.beginPath(); ctx.moveTo(center, y - 6); ctx.lineTo(center + 6, y); ctx.lineTo(center, y + 6); ctx.lineTo(center - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      else { ctx.fillRect(x, y - NOTE_BAR_HEIGHT / 2, width, NOTE_BAR_HEIGHT); ctx.strokeRect(x, y - NOTE_BAR_HEIGHT / 2, width, NOTE_BAR_HEIGHT); }
    }
    if (this.hover && !this.drag && ghostTool && !this.continuing && !this.inserting && !this.aligning && this.inTrack(this.hover.x)) {
      const note = createNote(ghostTool, this.hover.tick, this.placeLane(this.hover), this.width);
      if (long(note)) note.duration = this.chart.resolution / 4;
      if (note.type === 'AIR') note.attributes.direction = this.airDirection;
      ctx.globalAlpha = .45; this.paintNote(ctx, note, true, true); this.paintNote(ctx, note, false, true); ctx.globalAlpha = 1;
    }
    if (this.continuing && this.hover && this.inTrack(this.hover.x)) {
      const note = this.selectedNote();
      if (note && this.hover.tick > endTick(note)) {
        const ghost: Note = { ...note, tick: endTick(note), lane: endLane(note), width: endWidth(note), duration: this.hover.tick - endTick(note), endLane: this.placeLane(this.hover), endWidth: this.width };
        ctx.globalAlpha = .45; this.paintNote(ctx, ghost, true); this.paintNote(ctx, ghost, false); ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
    if (this.aligning) this.paintAlignWaveform(ctx, lo);
    const cursorY = this.y(this.cursor);
    if (cursorY >= 0 && cursorY <= h - this.bottom) {
      ctx.strokeStyle = '#d23838'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, cursorY); ctx.lineTo(right + 8, cursorY); ctx.stroke();
      ctx.fillStyle = '#d23838'; ctx.beginPath(); ctx.moveTo(0, cursorY - 5); ctx.lineTo(7, cursorY); ctx.lineTo(0, cursorY + 5); ctx.fill();
    }
    if (this.drag?.kind === 'box' && this.drag.moved) {
      const { start, current } = this.drag;
      ctx.fillStyle = '#86e7ff16'; ctx.strokeStyle = '#86e7ff'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.fillRect(start.x, start.y, current.x - start.x, current.y - start.y); ctx.strokeRect(start.x, start.y, current.x - start.x, current.y - start.y); ctx.setLineDash([]);
    }
    ctx.fillStyle = '#202020'; ctx.fillRect(this.left - 1, h - this.bottom, right - this.left + 2, this.bottom);
    ctx.save(); ctx.beginPath(); ctx.rect(this.left, h - this.bottom, right - this.left, this.bottom); ctx.clip();
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    const laneStride = this.laneWidth > 19 ? 1 : this.laneWidth > 7 ? 4 : 8;
    for (let lane = Math.ceil(this.viewStart / laneStride) * laneStride; lane < Math.ceil(this.viewEnd); lane += laneStride) { ctx.fillStyle = lane < 0 || lane >= LANES ? '#a191b4' : lane % 4 === 0 ? '#cccccc' : '#888888'; ctx.fillText(this.chart.allowOutOfLane ? String(lane) : String(lane + 1).padStart(2, '0'), this.x(lane + .5), h - 11); }
    ctx.restore();
    ctx.textAlign = 'left';
    this.status.innerHTML = `<span><i></i>${this.continuing ? '接续节点' : this.tool === 'select' ? '选择模式' : this.tool === 'erase' ? '橡皮擦' : LABEL[this.tool]}</span><span>光标 <b>${formatTick(this.cursor)}</b> tick · ${tickToSeconds(chart, this.cursor).toFixed(3)} s</span><span>${this.selection.size ? `已选 ${this.selection.size} · ` : ''}${chart.notes.length} 音符 · ${chart.events.length} 事件</span><span>${Math.round(this.zoom / .75 * 100)}% · ${this.snap ? `1/${this.snap} ${this.snapBase === 'whole' ? '全音符' : '拍'}` : '自由'}</span>`;
  }

  private airHeightMaximum(chart: Chart): number {
    return Math.max(5, Math.ceil(chart.notes.reduce((maximum, note) => Math.max(maximum, note.height ?? 0, note.endHeight ?? 0), 0)));
  }
  private airHeightX(height: number, maximum: number): number { return this.airLeft + height / maximum * this.airWidth; }
  private paintAirHeights(ctx: CanvasRenderingContext2D, chart: Chart, lo: number, hi: number): void {
    const maximum = this.airHeightMaximum(chart), bottom = this.canvasHeight - this.bottom;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.rulerLeft - 2, bottom); ctx.clip();
    for (let index = 0; index <= 5; index++) {
      const x = this.airLeft + index * this.airWidth / 5;
      ctx.strokeStyle = index === 0 || index === 5 ? '#414141' : '#202020'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, bottom); ctx.stroke();
    }
    const notes = chart.notes.filter(note => ['AIR_SLIDE', 'AIR_CRUSH'].includes(note.type) && endTick(note) >= lo && note.tick <= hi);
    for (const note of notes) {
      ctx.strokeStyle = this.selection.has(note.id) ? '#eeeeee' : '#40d6c4'; ctx.lineWidth = this.selection.has(note.id) ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(this.airHeightX(note.height ?? 1, maximum), this.y(note.tick));
      ctx.lineTo(this.airHeightX(note.endHeight ?? note.height ?? 1, maximum), this.y(endTick(note))); ctx.stroke();
    }
    // End joints are drawn after starts, so a following segment cannot cover a normal joint with a hollow square.
    for (const endpoint of ['height', 'endHeight'] as const) for (const note of notes) {
      const atEnd = endpoint === 'endHeight';
      const x = this.airHeightX(atEnd ? note.endHeight ?? note.height ?? 1 : note.height ?? 1, maximum);
      const y = this.y(atEnd ? endTick(note) : note.tick), normal = atEnd && note.attributes.visible !== false;
      ctx.lineWidth = 1; ctx.fillStyle = normal ? noteColor(note) : '#111111'; ctx.strokeStyle = this.selection.has(note.id) ? '#ffffff' : '#acacac';
      ctx.fillRect(x - 3, y - 3, 6, 6); ctx.strokeRect(x - 3, y - 3, 6, 6);
    }
    ctx.restore(); ctx.fillStyle = '#202020'; ctx.fillRect(0, bottom, this.rulerLeft - 2, this.bottom);
    ctx.fillStyle = '#bdbdbd'; ctx.font = '9px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    for (const index of [0, 2, 5]) ctx.fillText(formatTick(maximum * index / 5), this.airLeft + index * this.airWidth / 5, bottom + 18);
    ctx.textAlign = 'left';
  }

  private paintWaveform(ctx: CanvasRenderingContext2D, lo: number, hi: number): void {
    const mid = this.waveformLeft + 12, half = 12;
    ctx.fillStyle = '#000000'; ctx.fillRect(this.waveformLeft, 0, 25, this.canvasHeight - this.bottom);
    ctx.strokeStyle = '#303030'; ctx.beginPath(); ctx.moveTo(mid, 0); ctx.lineTo(mid, this.canvasHeight - this.bottom); ctx.stroke();
    if (!this.peaks.length || !this.audioDuration) return;
    ctx.strokeStyle = '#619ef2c0'; ctx.lineWidth = 1;
    ctx.beginPath();
    // Waveform bins are mapped through the actual tempo map, including BPM changes.
    for (let y = 0; y < this.canvasHeight - this.bottom; y += 2) {
      const tick = lo + (this.canvasHeight - this.bottom - y) / this.zoom;
      if (tick > hi + 1) continue;
      const seconds = tickToSeconds(this.chart, tick) - this.audioOffset;
      if (seconds < 0 || seconds > this.audioDuration) continue;
      const index = Math.floor(seconds / this.audioDuration * this.peaks.length);
      const amplitude = Math.min(1, Math.abs(this.peaks[index] ?? 0));
      ctx.moveTo(mid - amplitude * half, y); ctx.lineTo(mid + amplitude * half, y);
    }
    ctx.stroke();
  }

  /** Alignment mode widens the waveform over the track and reads min/max straight from the samples under each pixel row. */
  private paintAlignWaveform(ctx: CanvasRenderingContext2D, lo: number): void {
    const samples = this.samples; if (!samples) return;
    const left = this.waveformLeft, width = this.alignWidth, height = this.canvasHeight - this.bottom, mid = left + width / 2, half = width / 2 - 5;
    ctx.fillStyle = '#000000f0'; ctx.fillRect(left, 0, width, height);
    ctx.strokeStyle = '#303030'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mid + .5, 0); ctx.lineTo(mid + .5, height); ctx.stroke();
    const { data, sampleRate } = samples;
    const sampleAt = (y: number) => (tickToSeconds(this.chart, lo + (height - y) / this.zoom) - this.audioOffset) * sampleRate;
    ctx.strokeStyle = '#8fc0ff'; ctx.beginPath();
    let previous = sampleAt(height);
    for (let y = height - 1; y >= 0; y--) {
      const next = sampleAt(y), first = Math.max(0, Math.floor(previous)), last = Math.min(data.length, Math.max(Math.ceil(next), Math.floor(previous) + 1));
      previous = next;
      if (last <= first) continue;
      let low = 1, high = -1;
      for (let index = first, stride = Math.max(1, Math.floor((last - first) / 256)); index < last; index += stride) { const value = data[index]; if (value < low) low = value; if (value > high) high = value; }
      ctx.moveTo(mid + clamp(low, -1, 1) * half, y + .5); ctx.lineTo(mid + clamp(high, -1, 1) * half + 1, y + .5);
    }
    ctx.stroke();
    ctx.strokeStyle = '#619ef2'; ctx.strokeRect(left + .5, .5, width - 1, height - 1);
    if (this.hover && !this.drag && this.inAlignWaveform(this.hover)) {
      ctx.strokeStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(left, this.hover.y + .5); ctx.lineTo(left + width, this.hover.y + .5); ctx.stroke();
    }
  }

  /** `ghost` paints a placement preview: it is not in the chart, so its chain head cannot be looked up and is always drawn. */
  private paintNote(ctx: CanvasRenderingContext2D, note: Note, body: boolean, ghost = false): void {
    const x = this.x(note.lane) + 1, y = this.y(note.tick), width = note.width * this.laneWidth - 2;
    const finishX = this.x(endLane(note)) + 1, finishY = this.y(endTick(note)), finishWidth = endWidth(note) * this.laneWidth - 2;
    // A picked node is highlighted alone; the segment that ends on it is not.
    const color = noteColor(note), picked = this.selection.has(note.id), selected = picked && !(this.selection.size === 1 && this.pickedJoint === note.id), airborne = AIR.has(note.type);
    if (body) {
      if (!long(note)) return;
      ctx.fillStyle = `${color}35`; ctx.strokeStyle = `${color}88`; ctx.lineWidth = selected ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(finishX, finishY); ctx.lineTo(finishX + finishWidth, finishY); ctx.lineTo(x + width, y); ctx.closePath();
      // AIR bodies stay translucent so the ground notes under them remain visible.
      if (airborne) ctx.fill(); else this.paintGroundBody(ctx, note, x, y, width, finishX, finishY, finishWidth);
      // Only the sides belong to the body; control joints must not draw horizontal separators.
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(finishX,finishY); ctx.moveTo(x+width,y); ctx.lineTo(finishX+finishWidth,finishY); ctx.stroke();
      if (note.type === 'AIR_CRUSH' && Number(note.attributes.interval ?? 24) > 0) {
        const interval = Math.max(1, Number(note.attributes.interval) || 24);
        const minimum = Math.max(1, Math.ceil(8 / (interval * this.zoom)));
        const count = Math.min(5000, Math.floor((note.duration ?? 0) / interval));
        ctx.strokeStyle = `${color}9a`; ctx.lineWidth = 1;
        const first = Math.max(minimum, Math.floor((this.scroll - note.tick) / interval / minimum) * minimum);
        for (let index = first; index < count; index += minimum) {
          const fraction = index * interval / (note.duration ?? 1), cy = this.y(note.tick + index * interval);
          if (cy < 0) break;
          const cx = x + (finishX - x) * fraction, cw = width + (finishWidth - width) * fraction;
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + cw, cy); ctx.stroke();
        }
      }
      if (airborne) {
        // AIR HOLD / AIR SLIDE read as one solid centre line, like Margrete; a CRUSH keeps a dashed guide in its own colour.
        const line = note.type !== 'AIR_CRUSH';
        if (!line) ctx.setLineDash([5, 5]);
        ctx.strokeStyle = line ? color : `${color}b0`; ctx.lineWidth = line ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(x + width / 2, y); ctx.lineTo(finishX + finishWidth / 2, finishY); ctx.stroke(); ctx.setLineDash([]);
      }
      return;
    }
    if (long(note)) {
      const control = hasNodeKind(note) && note.attributes.visible === false;
      ctx.fillStyle = color; ctx.strokeStyle = picked ? '#fff' : color; ctx.lineWidth = picked ? 2 : 1.5;
      if (control) {
        const center = finishX + finishWidth / 2;
        if (picked) { ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(finishX, finishY); ctx.lineTo(finishX + finishWidth, finishY); ctx.stroke(); ctx.setLineDash([]); }
        ctx.beginPath(); ctx.moveTo(center, finishY - 6); ctx.lineTo(center + 6, finishY); ctx.lineTo(center, finishY + 6); ctx.lineTo(center - 6, finishY); ctx.closePath(); ctx.stroke();
      } else if (!this.noteSprites.draw(ctx,note,true,finishX,finishY,finishWidth)) { ctx.fillRect(finishX, finishY - 3, finishWidth, 6); ctx.strokeStyle = picked ? '#fff' : '#cccccc'; ctx.strokeRect(finishX, finishY - 3, finishWidth, 6); }
      if (picked) this.handle(ctx, finishX + finishWidth, finishY, color);
    }
    if (!ghost && hasNodeKind(note) && !getNotePlaybackPoints(this.preview ?? this.chart, note).some(point => point.position === 'head')) {
      if (selected) this.handle(ctx, x + width, y, color);
      return;
    }
    ctx.fillStyle = color; ctx.strokeStyle = selected ? '#ffffff' : '#eeeeee'; ctx.lineWidth = selected ? 2 : 1;
    // An AIR, and the implied AIR that starts an AIR HOLD / AIR SLIDE chain, float above the ground note they belong to.
    const arrow = note.type === 'AIR' || note.type === 'AIR_HOLD' || note.type === 'AIR_SLIDE';
    if (arrow) {
      const direction = note.type === 'AIR' ? String(note.attributes.direction ?? 'IR') : 'IR', arrowY = y - airArrowLift(width), half = airArrowHeight(width) / 2;
      if (!this.noteSprites.drawArrow(ctx, direction, x, arrowY, width)) {
        const down = airDown(direction), tip = x + width / 2 + airSide(direction) * airLean(width) / 2, base = down ? arrowY - half : arrowY + half, point = down ? arrowY + half : arrowY - half;
        ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(tip, point); ctx.lineTo(x + width, base); ctx.lineTo(tip, (base + point) / 2); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      if (selected) { ctx.strokeStyle = '#fff'; ctx.strokeRect(x - 1, arrowY - half - 1, width + 2, half * 2 + 2); }
    } else if (this.noteSprites.draw(ctx,note,false,x,y,width)) {
      if (selected) { ctx.strokeStyle='#fff'; ctx.strokeRect(x-1,y-5,width+2,10); }
    } else {
      ctx.beginPath(); ctx.roundRect(x, y - NOTE_BAR_HEIGHT / 2, Math.max(1, width), NOTE_BAR_HEIGHT, 1); ctx.fill(); ctx.stroke();
      if (note.type === 'EXTAP' || note.attributes.ex) { ctx.fillStyle = '#fff9dc'; ctx.fillRect(x + 2, y - 1.5, Math.max(1, width - 4), 3); }
      if (note.type === 'FLICK') {
        ctx.strokeStyle = '#143353'; ctx.lineWidth = 1.5;
        for (let cx = x + 5; cx < x + width - 3; cx += 10) { ctx.beginPath(); ctx.moveTo(cx - 2, y - 3); ctx.lineTo(cx + 2, y); ctx.lineTo(cx - 2, y + 3); ctx.stroke(); }
      }
      if (note.type === 'DAMAGE') { ctx.strokeStyle = '#532741'; ctx.lineWidth = 2; for (let cx = x + 4; cx < x + width - 4; cx += 10) { ctx.beginPath(); ctx.moveTo(cx - 2, y - 3); ctx.lineTo(cx + 2, y + 3); ctx.moveTo(cx + 2, y - 3); ctx.lineTo(cx - 2, y + 3); ctx.stroke(); } }
    }
    if (selected) this.handle(ctx, x + width, arrow ? y - airArrowLift(width) : y, color);
  }
  /**
   * HOLD / SLIDE body inside the current path. The joint texture runs from the start (bottom row) to the end (top row)
   * of each ordinary-node span, so control joints do not restart it; its rows stay horizontal like the time axis.
   */
  private paintGroundBody(ctx: CanvasRenderingContext2D, note: Note, x: number, y: number, width: number, finishX: number, finishY: number, finishWidth: number): void {
    const span = note.type === 'SLIDE' ? getSlideUvSpans(this.chart).get(note.id) : undefined, height = y - finishY;
    const from = span ? slideUvProgress(this.chart, span, note.tick) : 0, to = span ? slideUvProgress(this.chart, span, endTick(note)) : 1;
    if (height < .5 || to <= from) return;
    const image = this.bodyTextures[note.type];
    ctx.save(); ctx.clip();
    if (!image) {
      // Same colours as the texture centre, placed on the line where progress 0 and 1 would fall.
      const at = (progress: number) => y - height * (progress - from) / (to - from), gradient = ctx.createLinearGradient(0, at(0), 0, at(1));
      for (const [progress, color] of BODY_STOPS[note.type] ?? []) gradient.addColorStop(progress, color);
      ctx.fillStyle = gradient; ctx.fill();
    } else if (Math.abs(finishWidth - width) < .5) {
      // Constant width: one affine map takes the texture rows onto the sheared body exactly.
      ctx.transform(width, 0, x - finishX, height, finishX, finishY);
      ctx.drawImage(image, 0, image.naturalHeight * (1 - to), image.naturalWidth, image.naturalHeight * (to - from), 0, 0, 1, 1);
    } else {
      // Changing width: rows one device pixel high, each stretched to the body's width there, so the texture's soft
      // sides follow the slanted edges. Rows sit on the pixel grid and neither overlap nor leave seams.
      const ratio = this.canvas.width / this.canvasWidth, rows = height * ratio, top = Math.round(finishY * ratio);
      const row = (t: number) => image.naturalHeight * (1 - to + (to - from) * t);
      for (let index = Math.max(0, -top); index < rows && (top + index) / ratio < this.canvasHeight; index++) {
        const t0 = index / rows, t1 = Math.min(1, (index + 1) / rows), middle = (t0 + t1) / 2;
        ctx.drawImage(image, 0, row(t0), image.naturalWidth, row(t1) - row(t0), finishX + (x - finishX) * middle, (top + index) / ratio, finishWidth + (width - finishWidth) * middle, 1 / ratio);
      }
    }
    ctx.restore();
  }
  private handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void { ctx.fillStyle = '#202020'; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.fillRect(x - 3, y - 3, 6, 6); ctx.strokeRect(x - 3, y - 3, 6, 6); }
}
