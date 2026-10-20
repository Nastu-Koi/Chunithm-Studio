import {
  AIR_NOTE_TYPES,
  LONG_NOTE_TYPES,
  createChart,
  createNote,
  LANES,
  makeId,
  type Chart,
  type ChartEvent,
  type EventType,
  type Note,
  type NoteAttributes,
  type NoteType,
} from '../core/model';
import { getChartEndTick, secondsToTick, tickToSeconds } from '../core/timing';
import { isBundledImageSource, type GameTexture } from '../core/game-assets';
import { EVENT_LABEL, editorTemplate, LABEL } from './editor-template';
import { EditorView, LANE_DIVISIONS, airHeightMaximum, type LaneDivision, type Position } from './editor-view';
import {
  groundHeadAt,
  groundTailAt,
  hitsAt,
  insertTargetAt,
  isChainHeadPick,
  type DragKind,
  type Hit,
} from './editor-hit';
import { BODY_TEXTURE, EditorPainter, type AudioSamples } from './editor-paint';
import { fractionLabel, inspectorHtml, inspectorKey } from './editor-inspector';
import { readChoice, readNumber, writeSetting } from './ui-settings';
import {
  clamp,
  endLane,
  endWidth,
  endTick,
  sameTick,
  formatTick,
  long,
  copyNote,
  hasNodeKind,
  limitLane,
  limitWidth,
  selectionWithAssignments,
  appendEditorNote,
  attachEditorAir,
  editorChain,
  removeEditorJoint,
  mergeEditorExTaps,
  boundEditorParent,
  copyEditorSelection,
  flipEditorSelection,
  mirrorEditorSelection,
  moveEditorSelection,
  parseEditorFraction,
  selectionWithBoundAir,
  setEditorAirHeight,
  setEditorEx,
  setEditorNodeKind,
  shapeEditorSlide,
  splitEditorNote,
  syncEditorAirBindings,
  type Clipboard,
  type EditorNodeKind,
  type SlideShape,
  type SlideShapeResult,
  editEditorEventProperty,
  editEditorNoteProperty,
  editorLaneBase,
  pasteEditorClipboard,
  reshapeEditorNote,
  type PropertyRejection,
} from '../core/editing';

type Callbacks = {
  onChange(chart: Chart, label: string): void;
  onCursor(tick: number): void;
  onUndo(): void;
  onRedo(): void;
  onOffset(seconds: number, label: string): void;
};
type Tool = NoteType | 'select' | 'erase';
/** What a click on the track does besides applying the current tool. Exactly one mode is active. */
type EditorMode =
  | { kind: 'normal' }
  /** Clicks split the long note under the pointer instead of placing or selecting. */
  | { kind: 'insert' }
  /** Clicks append a node to the selected long note. */
  | { kind: 'continue' }
  /** Clicks set the cursor or the music offset and never edit notes. */
  | { kind: 'align' }
  /** The shape panel is open for segment `id`; `preview` then holds the candidate path. */
  | { kind: 'shape'; id: string };
type Drag = {
  kind: DragKind;
  start: Position;
  current: Position;
  chart: Chart;
  id?: string;
  before: Set<string>;
  moved: boolean;
  scroll: number;
  pointerId: number;
};
const PROPERTY_REJECTION: Record<PropertyRejection, string> = {
  fraction: '音乐时值请输入数字或分数，例如 1/7、3/16、1.5',
  'node-position': '节点位置请输入数字或分数，例如 1/7、3/16、1.5',
  'bound-air': 'AIR 绑定在地面音符的尾端，位置与宽度跟随父音符；请修改父音符',
  'zero-note-speed': '音符速度不能为 0；停谱请使用谱面滚速事件',
};
export class ChartEditor {
  private readonly view = new EditorView(readNumber('editor-zoom', 0.75, 0.2, 5));
  private readonly painter: EditorPainter;
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
  private mode: EditorMode = { kind: 'normal' };
  /** Segment whose end node was picked rather than its body; the highlight and the inspector then show that node alone. */
  private pickedJoint?: string;
  /** First segment of a SLIDE / AIR chain whose head node was picked; deleting it takes the whole long note. */
  private pickedHead?: string;
  /** Set on press when the click lands on the only selected item with others stacked under it; a release without a drag then picks the next one. */
  private cycling = false;
  /** The pick a cycling click replaced, so that a double click still acts on the item it began on. */
  private cycled?: { selection: Set<string>; joint?: string; head?: string; time: number };
  private readonly shapePanel: HTMLFormElement;
  private snap = Math.round(readNumber('editor-snap', 16, 0, 4096));
  private width = Math.round(readNumber('editor-width', 2, 1, LANES));
  private laneDivision: LaneDivision = readChoice('editor-lane-division', LANE_DIVISIONS, 1);
  private nodeKind: EditorNodeKind | 'inherit' = readChoice(
    'editor-node-kind',
    ['inherit', 'normal', 'control'] as const,
    'inherit',
  );
  /** The toolbar options as last written to this machine's settings. */
  private savedOptions = '';
  private cursor = 0;
  private drag?: Drag;
  private preview?: Chart;
  private clipboard?: Clipboard;
  private hover?: Position;
  private peaks: Float32Array = new Float32Array();
  private audioDuration = 0;
  private audioOffset = 0;
  private samples?: AudioSamples;
  private pendingDraw = 0;
  private inspectorKey = '';
  private bodyTextureGeneration = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: Callbacks,
  ) {
    host.classList.add('editor-root');
    host.innerHTML = editorTemplate({ zoom: this.view.zoom });
    this.canvas = host.querySelector('canvas')!;
    this.canvas.dataset.trackLeft = String(this.view.left);
    this.canvas.dataset.airHeightLeft = String(this.view.airLeft);
    this.canvas.dataset.airHeightWidth = String(this.view.airWidth);
    host.style.setProperty('--editor-track-left', `${this.view.left}px`);
    this.context = this.canvas.getContext('2d')!;
    this.painter = new EditorPainter(this.canvas, this.context, this.view);
    this.viewport = host.querySelector('.editor-viewport')!;
    this.inspector = host.querySelector('.editor-inspector')!;
    this.shapePanel = host.querySelector('.editor-shape-panel')!;
    this.status = host.querySelector('.editor-status')!;
    this.minimap = host.querySelector('.editor-navigation input')!;
    // The toolbar starts from the options this machine last used.
    for (const [name, value] of [
      ['snap', this.snap],
      ['width', this.width],
      ['lane-division', this.laneDivision],
      ['node-kind', this.nodeKind],
    ] as const)
      host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-option="${name}"]`)!.value = String(value);
    const signal = this.abort.signal;
    host.addEventListener('click', event => this.onClick(event), { signal });
    this.shapePanel.addEventListener(
      'submit',
      event => {
        event.preventDefault();
        this.closeShape(true);
      },
      { signal },
    );
    this.shapePanel.addEventListener('input', () => this.previewShape(), { signal });
    this.shapePanel.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          this.closeShape(false);
        }
      },
      { signal },
    );
    host.addEventListener('change', event => this.onChange(event), { signal });
    host.addEventListener('input', event => this.onInput(event), { signal });
    this.canvas.addEventListener('pointerdown', event => this.pointerDown(event), { signal });
    this.canvas.addEventListener('pointermove', event => this.pointerMove(event), { signal });
    this.canvas.addEventListener('pointerup', event => this.pointerUp(event), { signal });
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag(), { signal });
    this.canvas.addEventListener(
      'lostpointercapture',
      () => {
        if (this.drag) this.cancelDrag();
      },
      { signal },
    );
    this.canvas.addEventListener(
      'pointerleave',
      () => {
        if (!this.drag) {
          this.hover = undefined;
          this.draw();
        }
      },
      { signal },
    );
    this.canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    this.canvas.addEventListener('dblclick', event => this.doubleClick(event), { signal });
    this.viewport.addEventListener('wheel', event => this.wheel(event), { passive: false, signal });
    window.addEventListener('keydown', event => this.keyDown(event), { signal });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.viewport);
    this.renderInspector();
    this.resize();
    this.painter.noteSprites.load(() => {
      this.canvas.dataset.noteSprites = 'margrete-1.8.0';
      this.draw();
    });
  }

  setChart(chart: Chart): void {
    const changedMode = Boolean(this.chart.allowOutOfLane) !== Boolean(chart.allowOutOfLane);
    // A candidate shape belongs to the chart it was computed from.
    if (chart !== this.chart && this.mode.kind === 'shape') this.setMode({ kind: 'normal' });
    this.chart = chart;
    const ids = new Set([...chart.notes, ...chart.events].map(item => item.id));
    this.selection = new Set([...this.selection].filter(id => ids.has(id)));
    if (!chart.allowOutOfLane) {
      this.view.viewStart = 0;
      this.view.viewEnd = LANES;
    } else if (changedMode) this.fitLaneRange(true);
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
    const visible = (this.view.canvasHeight - this.view.bottom) / this.view.zoom;
    if (follow && (tick < this.view.scroll || tick > this.view.scroll + visible * 0.8))
      this.view.scroll = Math.max(0, tick - visible * 0.2);
    this.updateNavigation();
    this.draw();
  }

  /** Use the copied game joint textures for HOLD / SLIDE bodies; without them the bodies keep the matching gradient. */
  setBodyTextures(textures: Readonly<Record<string, GameTexture>> | undefined): void {
    const generation = ++this.bodyTextureGeneration;
    this.painter.bodyTextures = {};
    this.canvas.dataset.bodyTextures = 'gradient';
    for (const [type, key] of Object.entries(BODY_TEXTURE) as [NoteType, string][]) {
      const source = textures?.[key]?.dataUrl;
      if (!source || !isBundledImageSource(source)) continue;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (generation !== this.bodyTextureGeneration) return;
        this.painter.bodyTextures[type] = image;
        this.canvas.dataset.bodyTextures = 'game';
        this.draw();
      };
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
    if (this.mode.kind === 'align' && !this.samples) this.setAligning(false);
    this.host.querySelector('[data-align-offset]')!.textContent = `${(offset * 1000).toFixed(1)} ms`;
    this.updateNavigation();
    this.draw();
  }

  resize(): void {
    const bounds = this.viewport.getBoundingClientRect();
    this.view.canvasWidth = Math.max(1, bounds.width);
    this.view.canvasHeight = Math.max(1, bounds.height);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.view.canvasWidth * dpr);
    this.canvas.height = Math.round(this.view.canvasHeight * dpr);
    this.canvas.style.width = `${this.view.canvasWidth}px`;
    this.canvas.style.height = `${this.view.canvasHeight}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.syncTrackLayout();
    this.draw();
  }

  destroy(): void {
    this.abort.abort();
    this.observer.disconnect();
    cancelAnimationFrame(this.pendingDraw);
    this.host.innerHTML = '';
  }
  selectAll(): void {
    this.selection = new Set([...this.chart.notes, ...this.chart.events].map(item => item.id));
    this.refreshSelection();
  }
  copySelection(): void {
    const copied = copyEditorSelection(this.chart, this.selection);
    if (!copied) return;
    this.clipboard = copied;
    this.setHint(`已复制 ${copied.notes.length + copied.events.length} 项；移动光标后 Ctrl+V 粘贴`);
  }
  pasteSelection(mirrored = false): void {
    if (!this.clipboard) {
      this.setHint('请先选中并复制音符或事件');
      return;
    }
    const pasted = pasteEditorClipboard(this.chart, this.clipboard, this.quantize(this.cursor), mirrored);
    this.selection = pasted.ids;
    this.commit(pasted.chart, `${mirrored ? '左右镜像' : ''}粘贴 ${pasted.ids.size} 项`);
  }
  clearSelection(): void {
    this.selection.clear();
    this.refreshSelection();
  }
  flipSelection(): void {
    if (!this.chart.notes.some(note => this.selection.has(note.id))) {
      this.setHint('先选中要前后翻转的音符');
      return;
    }
    this.commit(flipEditorSelection(this.chart, this.selection), '前后翻转音符');
  }
  /** Open the shape panel for the selected SLIDE / AIR SLIDE segment; the chart changes only on confirm. */
  openShape(shape?: SlideShape): void {
    const note = this.selectedNote();
    if (!note || (note.type !== 'SLIDE' && note.type !== 'AIR_SLIDE')) {
      this.setHint('先选中一段 SLIDE / AIR SLIDE，再生成形状');
      return;
    }
    this.cancelDrag();
    const field = <T extends HTMLElement>(name: string) => this.shapePanel.querySelector<T>(`[data-shape="${name}"]`)!;
    if (shape) field<HTMLSelectElement>('shape').value = shape;
    const sideways = endLane(note) - note.lane,
      limit = (this.chart.allowOutOfLane ? 64 : LANES - note.width) - note.lane;
    field<HTMLInputElement>('beats').value = fractionLabel(((note.duration ?? 0) * 4) / this.chart.resolution);
    field<HTMLInputElement>('move').value = String(sideways || (limit >= 4 ? 4 : -Math.min(4, note.lane)));
    // Lanes are shown as in the inspector: counted from 1 unless the chart may leave the track.
    const bound = !!boundEditorParent(this.chart, note.id);
    field<HTMLInputElement>('start').value = String(note.lane + this.laneBase);
    field<HTMLInputElement>('width').value = String(note.width);
    field<HTMLInputElement>('start').disabled = field<HTMLInputElement>('width').disabled = bound;
    this.setMode({ kind: 'shape', id: note.id });
    this.shapePanel.hidden = false;
    this.previewShape();
    field<HTMLInputElement>('beats').focus();
    field<HTMLInputElement>('beats').select();
  }
  private get laneBase(): number {
    return editorLaneBase(this.chart);
  }
  private shapeResult(): SlideShapeResult | undefined {
    const input = (name: string) =>
      this.shapePanel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-shape="${name}"]`)!;
    const field = (name: string) => input(name).value,
      checked = (name: string) => (input(name) as HTMLInputElement).checked;
    const beats = parseEditorFraction(field('beats')),
      shape = field('shape') as SlideShape;
    if (this.mode.kind !== 'shape' || beats === undefined || !(beats > 0)) return undefined;
    return shapeEditorSlide(this.chart, this.mode.id, {
      shape,
      length: (beats * this.chart.resolution) / 4,
      move: Number(field('move')) || 0,
      count: Number(field('count')) || 1,
      ...(field('start').trim() ? { start: Number(field('start')) - this.laneBase } : {}),
      ...(field('width').trim() ? { width: Number(field('width')) } : {}),
      symmetryV: checked('symmetryV'),
      symmetryH: checked('symmetryH'),
      flipV: checked('flipV'),
      step: this.step,
      kind: this.nodeKind === 'normal' ? 'normal' : 'control',
    });
  }
  private previewShape(): void {
    const field = (name: string) =>
      this.shapePanel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-shape="${name}"]`)!;
    const shape = field('shape').value as SlideShape,
      result = this.shapeResult(),
      note = this.shapePanel.querySelector<HTMLElement>('[data-shape-note]')!;
    this.shapePanel.querySelector<HTMLElement>('[data-shape-row="count"]')!.hidden = shape === 'curve';
    for (const row of ['start', 'width', 'symmetryV', 'symmetryH', 'flipV'])
      this.shapePanel.querySelector<HTMLElement>(`[data-shape-row="${row}"]`)!.hidden = shape !== 'curve';
    this.shapePanel.querySelector<HTMLElement>('[data-shape-count-label]')!.textContent =
      shape === 'wave' ? '往返次数（左右各摆一次）' : '段数（每段出去再回来）';
    this.shapePanel.querySelector<HTMLElement>('[data-shape-move-label]')!.textContent =
      shape === 'curve'
        ? '位移（轨道，负数向左）'
        : shape === 'wave'
          ? '摆幅（轨道，负数先向左）'
          : '水平移动（轨道，负数向左）';
    this.preview = result?.chart;
    const beats = parseEditorFraction(field('beats').value),
      wanted = Number(field('move').value) || 0;
    note.textContent = !result
      ? '长度须为正数，且要给后面相接的一段留出至少一格音符间隔'
      : [
          result.move !== Math.round(wanted)
            ? `${shape === 'curve' ? '位移' : shape === 'wave' ? '摆幅' : '水平移动'}已收窄为 ${result.move}，再远会超出轨道`
            : '',
          beats !== undefined && Math.abs(result.length - (beats * this.chart.resolution) / 4) > 1e-6
            ? '长度已缩短，以保留后面相接的一段'
            : '',
          shape === 'curve' && field('start').disabled ? '起点绑定在地面音符上，起始位置与宽度不可改' : '',
          `生成 ${result.ids.length} 段；${shape !== 'curve' ? `折点为${this.nodeKind === 'normal' ? '普通节点' : '控制点'}（跟随“SLIDE 控制”）` : '中间均为控制点'}`,
        ]
          .filter(Boolean)
          .join('；');
    this.draw();
  }
  private closeShape(apply: boolean): void {
    if (this.mode.kind !== 'shape') return;
    const result = apply ? this.shapeResult() : undefined;
    if (apply && !result) {
      this.previewShape();
      return;
    }
    this.setMode({ kind: 'normal' });
    if (result) {
      this.selection = new Set(result.ids);
      this.commit(result.chart, '生成 SLIDE 形状');
    } else this.draw();
    this.viewport.focus({ preventScroll: true });
  }
  /** Margrete's SLIDE join: segments already connect by position here, so joining sets the joint's node kind. */
  joinSelection(kind: EditorNodeKind): void {
    const joints = this.chart.notes.filter(
      note =>
        this.selection.has(note.id) &&
        hasNodeKind(note) &&
        this.chart.notes.some(
          next =>
            next.id !== note.id &&
            next.type === note.type &&
            sameTick(next.tick, endTick(note)) &&
            next.lane === endLane(note) &&
            next.width === endWidth(note),
        ),
    );
    if (!joints.length) {
      this.setHint('选中与下一段首尾相接的 SLIDE / AIR 长条段，再结合');
      return;
    }
    this.commit(
      joints.reduce((chart, note) => setEditorNodeKind(chart, note.id, kind), this.chart),
      kind === 'normal' ? '结合为中继点' : '结合为控制点',
    );
  }
  deleteSelection(): void {
    if (!this.selection.size) return;
    // A picked node goes alone and its neighbours join up; the last node takes the segment before it.
    const picked = this.selectedNote(),
      node = picked?.id === this.pickedJoint ? picked : undefined,
      joined = node ? removeEditorJoint(this.chart, node.id) : this.chart;
    if (joined !== this.chart) {
      this.pickedJoint = undefined;
      this.commit(joined, '删除节点');
      return;
    }
    // SLIDE / AIR chains are deleted by node: the head node takes the whole long note, a body on its own takes nothing.
    const whole = new Set<string>(),
      notes = new Map(this.chart.notes.map(note => [note.id, note]));
    for (const id of this.selection) {
      const note = notes.get(id);
      if (!note || !hasNodeKind(note) || node) {
        whole.add(id);
        continue;
      }
      if (whole.has(id)) continue;
      const chain = editorChain(this.chart, note);
      if (this.selection.size === 1 ? this.pickedHead === id && chain[0].id === id : this.selection.has(chain[0].id))
        for (const item of chain) whole.add(item.id);
    }
    if (!whole.size) {
      this.setHint('长条按节点删除：右键头节点删除整条，右键其他节点只删该节点；带体不能单独删除');
      return;
    }
    const ids = selectionWithAssignments(this.chart, selectionWithBoundAir(this.chart, whole, false));
    const count = ids.size;
    const chart = {
      ...this.chart,
      notes: this.chart.notes.filter(note => !ids.has(note.id)),
      events: this.chart.events.filter(event => !ids.has(event.id)),
    };
    this.selection.clear();
    this.commit(chart, `删除 ${count} 项`);
  }
  mirrorSelection(): void {
    if (!this.selection.size) return;
    const next = mirrorEditorSelection(this.chart, this.selection);
    const valid = (lane: number, width: number) =>
      this.chart.allowOutOfLane ? lane >= -64 && lane <= 64 && width <= 128 : lane >= 0 && lane + width <= LANES;
    if (
      next.notes.some(
        (note, index) =>
          note !== this.chart.notes[index] && (!valid(note.lane, note.width) || !valid(endLane(note), endWidth(note))),
      ) ||
      next.events.some(
        (event, index) =>
          event !== this.chart.events[index] &&
          event.type === 'SCROLL_ASSIGNMENT' &&
          !valid(event.lane ?? 0, event.width ?? 1),
      )
    ) {
      this.setHint('镜像结果超出当前坐标范围；请先调整位置或宽度');
      return;
    }
    this.commit(next, '镜像音符');
  }

  private quantize(tick: number): number {
    if (!this.snap) return Math.max(0, tick);
    const step = this.step;
    return Math.max(0, Math.round(tick / step) * step);
  }
  private get step(): number {
    return this.snap ? this.chart.resolution / this.snap : 1;
  }
  private position(event: MouseEvent): Position {
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left,
      y = event.clientY - bounds.top;
    const laneAt = this.view.laneAt(x);
    return {
      x,
      y,
      tick: this.quantize(this.view.tickAt(y)),
      laneAt,
      lane: clamp(Math.floor(laneAt), this.chart.allowOutOfLane ? -64 : 0, this.chart.allowOutOfLane ? 64 : LANES - 1),
    };
  }
  /** Left lane of a note of `width` centred on the pointer; an odd width over a lane centre is exact, otherwise the nearest lane boundary. */
  private placeLane(point: Position, width = this.width): number {
    return limitLane(this.chart, Math.round(point.laneAt - width / 2), width);
  }
  private syncTrackLayout(): void {
    Object.assign(this.canvas.dataset, {
      trackWidth: String(this.view.trackWidth),
      trackRight: String(this.view.trackRight),
      laneWidth: String(this.view.laneWidth),
    });
  }
  private emitCursor(tick: number): void {
    this.cursor = Math.max(0, tick);
    this.callbacks.onCursor(this.cursor);
    this.draw();
  }
  private setHint(text: string): void {
    this.host.querySelector('.editor-hint')!.textContent = text;
  }
  private commit(chart: Chart, label: string): void {
    this.preview = undefined;
    chart = syncEditorAirBindings(this.chart, chart);
    this.callbacks.onChange(chart, label);
    this.setChart(chart);
    this.inspectorKey = '';
    this.renderInspector();
    this.updateNavigation();
    this.draw();
  }
  private refreshSelection(): void {
    this.fitLaneRange(false);
    this.syncAdvancedControls();
    this.inspectorKey = '';
    this.renderInspector();
    this.draw();
  }
  private fitLaneRange(all: boolean): void {
    if (!this.chart.allowOutOfLane) return;
    const notes = this.chart.notes.filter(note => all || this.selection.has(note.id));
    const events = this.chart.events.filter(
      event => event.type === 'SCROLL_ASSIGNMENT' && (all || this.selection.has(event.id)),
    );
    const minimum = Math.min(
      0,
      ...notes.flatMap(note => [note.lane, endLane(note)]),
      ...events.map(event => event.lane ?? 0),
    );
    const maximum = Math.max(
      LANES,
      ...notes.flatMap(note => [note.lane + note.width, endLane(note) + endWidth(note)]),
      ...events.map(event => (event.lane ?? 0) + (event.width ?? 1)),
    );
    if (all) {
      this.view.viewStart = Math.max(-64, Math.floor(minimum) - 2);
      this.view.viewEnd = Math.min(192, Math.ceil(maximum) + 2);
    } else {
      if (minimum < this.view.viewStart) this.view.viewStart = Math.max(-64, Math.floor(minimum) - 2);
      if (maximum > this.view.viewEnd) this.view.viewEnd = Math.min(192, Math.ceil(maximum) + 2);
    }
  }
  private syncAdvancedControls(): void {
    const enabled = Boolean(this.chart.allowOutOfLane);
    this.host.querySelector<HTMLInputElement>('[data-option="out-of-lane"]')!.checked = enabled;
    const start = this.host.querySelector<HTMLInputElement>('[data-option="view-start"]')!,
      end = this.host.querySelector<HTMLInputElement>('[data-option="view-end"]')!;
    start.value = String(this.view.viewStart);
    end.value = String(this.view.viewEnd);
    start.disabled = !enabled;
    end.disabled = !enabled;
    const width = this.host.querySelector<HTMLInputElement>('[data-option="width"]')!;
    width.max = enabled ? '128' : '16';
    this.width = Math.min(this.width, enabled ? 128 : LANES);
    width.value = String(this.width);
    this.host.querySelector('.editor-canvas-heading i')!.textContent = enabled
      ? `演出坐标 ${this.view.viewStart}…${this.view.viewEnd}`
      : '16 LANES';
    this.syncTrackLayout();
  }
  private updateNavigation(): void {
    const end = Math.max(
      this.chart.resolution * 16,
      getChartEndTick(this.chart) + this.chart.resolution * 4,
      this.audioDuration ? secondsToTick(this.chart, this.audioDuration + this.audioOffset) : 0,
      this.cursor + this.chart.resolution * 2,
      this.view.scroll,
    );
    this.minimap.max = String(Math.ceil(end));
    this.minimap.step = String(this.step);
    this.minimap.value = String(this.view.scroll);
  }

  private onClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || !this.host.contains(button)) return;
    if (button.dataset.air) {
      this.setAir(button.dataset.air as 'IR' | 'DW', this.airLean);
      return;
    }
    if (button.dataset.tool) {
      this.setTool(button.dataset.tool as Tool);
      return;
    }
    switch (button.dataset.action) {
      case 'delete':
        this.deleteSelection();
        break;
      case 'mirror':
        this.mirrorSelection();
        break;
      case 'flip':
        this.flipSelection();
        break;
      case 'shape':
        this.openShape();
        break;
      case 'shape-cancel':
        this.closeShape(false);
        break;
      case 'copy':
        this.copySelection();
        break;
      case 'paste':
        this.pasteSelection();
        break;
      case 'selectAll':
        this.selectAll();
        break;
      case 'home':
        this.view.scroll = Math.max(0, this.cursor - (this.view.canvasHeight / this.view.zoom) * 0.25);
        this.updateNavigation();
        this.draw();
        break;
      case 'inspector':
        this.host.classList.toggle('editor-inspector-hidden');
        this.resize();
        break;
      case 'fit-stage':
        this.view.viewStart = 0;
        this.view.viewEnd = LANES;
        this.syncAdvancedControls();
        this.draw();
        break;
      case 'fit-all':
        this.fitLaneRange(true);
        this.syncAdvancedControls();
        this.draw();
        break;
      case 'connect': {
        const note = this.selectedNote();
        if (!note || !long(note)) {
          this.setHint('先选中一条长条，再点击“接续”');
          return;
        }
        const on = this.mode.kind !== 'continue';
        this.setMode(on ? { kind: 'continue' } : { kind: 'normal' });
        this.setHint(on ? '点击下一节点的时间与轨道；Esc 取消接续' : '已取消接续');
        break;
      }
      case 'split':
        this.setInserting(this.mode.kind !== 'insert');
        break;
      case 'air-side':
        this.setAir(this.airVertical, Number(button.dataset.side) as -1 | 0 | 1);
        break;
      case 'align':
        this.setAligning(this.mode.kind !== 'align');
        break;
      case 'nudge':
        this.setOffset(this.audioOffset + Number(button.dataset.ms) / 1000, '微调音乐偏移');
        break;
      case 'event':
        this.addEvent(button.dataset.event as EventType);
        break;
      case 'applyRaw':
        this.applyRawAttributes();
        break;
      case 'seek':
        this.emitCursor(Number(button.dataset.tick));
        this.setCursor(this.cursor, true);
        break;
    }
    if (button.dataset.select) {
      this.selection = new Set([button.dataset.select]);
      this.refreshSelection();
    }
  }

  /** Native AIR token of the current up / down tool and its left / centre / right lean. */
  private get airDirection(): string {
    return this.airVertical === 'IR' ? ['UL', 'IR', 'UR'][this.airLean + 1] : ['DL', 'DW', 'DR'][this.airLean + 1];
  }
  private setAir(vertical: 'IR' | 'DW', lean: -1 | 0 | 1): void {
    this.airVertical = vertical;
    this.airLean = lean;
    this.setTool('AIR');
  }
  /** Switch the interaction mode: leave the current one, then sync the mode buttons and the pointer cursor. */
  private setMode(next: EditorMode): void {
    const previous = this.mode;
    this.mode = next;
    if (previous.kind === 'shape' && next.kind !== 'shape') {
      this.shapePanel.hidden = true;
      this.preview = undefined;
    }
    // Alignment allows a closer zoom than editing; the editing limit returns with it.
    if (previous.kind === 'align' && next.kind !== 'align' && this.view.zoom > 5) {
      this.view.zoom = 5;
      this.host.querySelector<HTMLInputElement>('[data-option="zoom"]')!.value = '5';
      this.updateNavigation();
    }
    this.host.querySelector('[data-action="split"]')?.classList.toggle('editor-active', next.kind === 'insert');
    this.host
      .querySelectorAll('[data-action="connect"]')
      .forEach(button => button.classList.toggle('editor-active', next.kind === 'continue'));
    this.host.querySelector('[data-action="align"]')!.classList.toggle('editor-active', next.kind === 'align');
    this.host.querySelector<HTMLElement>('.editor-align-controls')!.hidden = next.kind !== 'align';
    this.syncViewportCursor();
    this.draw();
  }
  private syncViewportCursor(): void {
    this.viewport.style.cursor =
      this.mode.kind === 'insert'
        ? 'copy'
        : this.mode.kind === 'align' || (this.tool !== 'select' && this.tool !== 'erase')
          ? 'crosshair'
          : this.tool === 'select'
            ? 'default'
            : 'cell';
  }
  private setInserting(on: boolean): void {
    if (!on && this.mode.kind !== 'insert') return;
    if (on) this.cancelDrag();
    this.setMode(on ? { kind: 'insert' } : { kind: 'normal' });
    this.setHint(
      on ? '插入节点：把鼠标移到 SLIDE / AIR 长条上，点击即在该处插入 · 可连续插入 · Esc 退出' : '已退出插入节点',
    );
  }
  private insertAt(point: Position): void {
    const target = insertTargetAt(this.view, this.chart, point);
    if (!target) {
      this.setHint(
        '这里没有可插入节点的长条：请点在 SLIDE / AIR SLIDE / AIR HOLD / AIR CRUSH 的带体上（HOLD 没有中间节点）',
      );
      return;
    }
    const result = splitEditorNote(
      this.chart,
      target.note.id,
      point.tick,
      this.nodeKind === 'inherit' ? undefined : this.nodeKind,
    );
    if (result === this.chart) return;
    this.selection = new Set([target.note.id]);
    this.commit(result, '插入长条节点');
    this.setHint('节点已插入；继续点击可再插入，Esc 完成');
  }
  private get noteTool(): NoteType | undefined {
    return this.tool === 'select' || this.tool === 'erase' ? undefined : this.tool;
  }
  private setNodeKind(kind: EditorNodeKind | 'inherit'): void {
    this.nodeKind = kind;
    this.host.querySelector<HTMLSelectElement>('[data-option="node-kind"]')!.value = kind;
    this.saveOptions();
  }
  /** Keep the toolbar options for the next session. The wider zoom of alignment mode is temporary and is not kept. */
  private saveOptions(): void {
    const options = {
      'editor-snap': this.snap,
      'editor-width': Math.min(this.width, LANES),
      'editor-lane-division': this.laneDivision,
      'editor-node-kind': this.nodeKind,
      ...(this.mode.kind === 'align' ? {} : { 'editor-zoom': this.view.zoom }),
    };
    const key = JSON.stringify(options);
    if (key === this.savedOptions) return;
    this.savedOptions = key;
    for (const [name, value] of Object.entries(options)) writeSetting(name, value);
  }
  private setAligning(on: boolean): void {
    if (on && !this.samples) {
      this.setHint('请先导入音乐，再对齐');
      return;
    }
    if (!on && this.mode.kind !== 'align') return;
    this.setMode(on ? { kind: 'align' } : { kind: 'normal' });
    this.cancelDrag();
    this.setHint(
      on
        ? '对齐音乐：点击小节栏或轨道把光标放到目标线，再点击波形上的起音 · Ctrl+滚轮放大 · Esc 退出'
        : '已退出对齐音乐',
    );
  }
  private setOffset(seconds: number, label: string): void {
    // 0.1 ms is finer than one sample period at 48 kHz allows the ear to tell apart, and keeps the stored value readable.
    const offset = Math.round(seconds * 1e4) / 1e4;
    if (!Number.isFinite(offset) || Math.abs(offset) > 600) {
      this.setHint('音乐偏移超出支持范围');
      return;
    }
    if (offset !== this.audioOffset) this.callbacks.onOffset(offset, label);
  }
  /** Move the music so that the clicked audio moment lands on the cursor. */
  private alignAt(point: Position): void {
    const tick = this.view.scroll + (this.view.canvasHeight - this.view.bottom - point.y) / this.view.zoom;
    const audioSeconds = tickToSeconds(this.chart, tick) - this.audioOffset;
    if (audioSeconds < 0 || audioSeconds > this.audioDuration) {
      this.setHint('这里没有音乐；请点击波形上的起音');
      return;
    }
    this.setOffset(tickToSeconds(this.chart, this.cursor) - audioSeconds, '对齐音乐');
    this.setHint(`已把该起音对齐到光标（${formatTick(this.cursor)} tick）；可用 ±1 / ±10 ms 微调，或重新点击`);
  }
  private setTool(tool: Tool): void {
    if (this.mode.kind === 'align') this.cancelDrag();
    this.tool = tool;
    if (tool !== 'select' && tool !== 'erase') this.penTool = tool;
    // A tool change ends the click modes; an open shape panel stays.
    if (this.mode.kind !== 'shape') this.setMode({ kind: 'normal' });
    else this.syncViewportCursor();
    this.host
      .querySelectorAll<HTMLButtonElement>('[data-tool]')
      .forEach(button =>
        button.classList.toggle(
          'editor-active',
          button.dataset.tool === tool && (!button.dataset.air || button.dataset.air === this.airVertical),
        ),
      );
    const side = this.host.querySelector<HTMLElement>('.editor-air-side');
    if (side) {
      side.hidden = tool !== 'AIR';
      side
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach(button => button.classList.toggle('editor-active', Number(button.dataset.side) === this.airLean));
    }
    this.setHint(
      tool === 'select'
        ? '拖动移动 · 左右边缘改宽度 · 点节点编辑节点、拖动改位置 · 叠放处再次单击切换 · Shift 框选追加'
        : tool === 'erase'
          ? '橡皮擦：点击删除，拖动框选后松开删除 · S 选择'
          : `${tool === 'AIR' ? `AIR ${({ IR: '上', UL: '左上', UR: '右上', DW: '下', DL: '左下', DR: '右下' } as Record<string, string>)[this.airDirection]}` : LABEL[tool]}：点击放置${LONG_NOTE_TYPES.has(tool) ? '，向上拖动设置终点' : ''}${tool === 'EXTAP' ? '；点 HOLD / SLIDE 的头可设为 EX，再点取消' : ''} · 右键删除 · S 选择`,
    );
    this.draw();
  }

  private onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input === this.minimap) {
      this.view.scroll = Number(input.value);
      this.draw();
    }
    if (input.dataset.option === 'zoom') {
      this.view.zoom = Number(input.value);
      this.draw();
    }
  }

  private onChange(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.dataset.option === 'snap') {
      this.snap = clamp(Math.round(Number(input.value) || 0), 0, 4096);
      input.value = String(this.snap);
      this.updateNavigation();
      this.draw();
      return;
    }
    if (input.dataset.option === 'lane-division') {
      this.laneDivision = LANE_DIVISIONS.find(value => String(value) === input.value) ?? 1;
      this.draw();
      return;
    }
    if (input.dataset.option === 'node-kind') {
      this.nodeKind = input.value as EditorNodeKind | 'inherit';
      this.saveOptions();
      return;
    }
    if (input.dataset.option === 'out-of-lane') {
      this.commit(
        { ...this.chart, allowOutOfLane: (input as HTMLInputElement).checked },
        (input as HTMLInputElement).checked ? '启用轨道外演出' : '关闭轨道外演出',
      );
      return;
    }
    if (input.dataset.option === 'view-start') {
      if (this.chart.allowOutOfLane) this.view.viewStart = clamp(Number(input.value) || 0, -64, this.view.viewEnd - 4);
      this.syncAdvancedControls();
      this.draw();
      return;
    }
    if (input.dataset.option === 'view-end') {
      if (this.chart.allowOutOfLane) this.view.viewEnd = clamp(Number(input.value) || 16, this.view.viewStart + 4, 192);
      this.syncAdvancedControls();
      this.draw();
      return;
    }
    if (input.dataset.option === 'width') {
      this.width = clamp(Math.round(Number(input.value) || 1), 1, this.chart.allowOutOfLane ? 128 : LANES);
      input.value = String(this.width);
      this.draw();
      return;
    }
    if (input.dataset.property)
      this.updateProperty(
        input.dataset.property,
        input.type === 'checkbox' ? (input as HTMLInputElement).checked : input.value,
      );
  }

  private selectedNote(): Note | undefined {
    return this.selection.size === 1 ? this.chart.notes.find(note => this.selection.has(note.id)) : undefined;
  }
  /** The segment whose end node is selected: a SLIDE / AIR HOLD / AIR SLIDE node that was picked itself, not through the body before it. */
  private selectedNode(): Note | undefined {
    const note = this.selectedNote();
    return note && note.id === this.pickedJoint && hasNodeKind(note) ? note : undefined;
  }

  private updateProperty(property: string, value: string | boolean): void {
    const note = this.selectedNote();
    const chartEvent = note ? undefined : this.chart.events.find(item => this.selection.has(item.id));
    if (!note && (!chartEvent || this.selection.size !== 1)) return;
    const edit = note
      ? editEditorNoteProperty(this.chart, note.id, property, value)
      : editEditorEventProperty(this.chart, chartEvent!.id, property, value);
    if (!edit) return;
    if ('rejected' in edit) {
      this.setHint(PROPERTY_REJECTION[edit.rejected]);
      this.inspectorKey = '';
      this.renderInspector();
      return;
    }
    if (chartEvent) {
      this.commit(edit.chart, `修改 ${EVENT_LABEL[chartEvent.type]}`);
      return;
    }
    const label =
      property === 'attr.ex'
        ? value
          ? '设为 EX'
          : '取消 EX'
        : property === 'nodeKind'
          ? '修改节点类型'
          : property === 'height' || property === 'endHeight'
            ? '修改 AIR 高度'
            : edit.reshaped && this.selectedNode()
              ? '修改节点'
              : '修改音符属性';
    this.commit(edit.chart, label);
  }

  private addEvent(type: EventType): void {
    const target = type === 'SCROLL_ASSIGNMENT' ? this.selectedNote() : undefined;
    let chainEnd = target ? endTick(target) : 0;
    if (target) {
      let last = target;
      const visited = new Set([target.id]);
      for (;;) {
        const next = this.chart.notes.find(
          note =>
            !visited.has(note.id) &&
            note.type === last.type &&
            sameTick(note.tick, endTick(last)) &&
            note.lane === endLane(last) &&
            note.width === endWidth(last),
        );
        if (!next) break;
        visited.add(next.id);
        chainEnd = endTick(next);
        last = next;
      }
    }
    const event: ChartEvent = {
      id: makeId('event'),
      tick: this.quantize(this.cursor),
      type,
      value: type === 'BPM' ? this.chart.defaultBpm : 1,
      ...(type === 'METER' ? { numerator: 4, denominator: 4 } : {}),
      ...(['SCROLL', 'NOTE_SPEED', 'GROUP_SCROLL', 'SCROLL_ASSIGNMENT'].includes(type)
        ? { duration: this.chart.resolution }
        : {}),
      ...(type === 'GROUP_SCROLL' || type === 'SCROLL_ASSIGNMENT' ? { group: 1 } : {}),
      ...(type === 'SCROLL_ASSIGNMENT'
        ? {
            tick: target?.tick ?? this.quantize(this.cursor),
            lane: target?.lane ?? 0,
            width: target?.width ?? this.width,
            duration: target ? chainEnd - target.tick : this.chart.resolution,
          }
        : {}),
    };
    this.selection = new Set([event.id]);
    this.commit({ ...this.chart, events: [...this.chart.events, event] }, `添加 ${EVENT_LABEL[type]}`);
  }

  private applyRawAttributes(): void {
    const note = this.selectedNote();
    const input = this.inspector.querySelector<HTMLTextAreaElement>('[data-raw-attributes]');
    if (!note || !input) return;
    try {
      const value: unknown = JSON.parse(input.value);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some(item => !['string', 'number', 'boolean'].includes(typeof item))
      )
        throw new Error('属性必须是由字符串、数字或布尔值组成的 JSON 对象');
      this.commit(
        {
          ...this.chart,
          notes: this.chart.notes.map(item =>
            item.id === note.id ? { ...item, attributes: value as NoteAttributes } : item,
          ),
        },
        '修改原生属性',
      );
      this.setHint('原生属性已应用');
    } catch (error) {
      this.setHint(`属性格式有误：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private hit(position: Position): Hit | undefined {
    return hitsAt(this.view, this.preview ?? this.chart, this.selection, position)[0];
  }
  /** Take the pick that lies under the current one, wrapping round to the top. */
  private cycleSelection(point: Position): boolean {
    const stack = hitsAt(this.view, this.preview ?? this.chart, this.selection, point, false),
      current = stack.findIndex(item => this.selection.has(item.id));
    if (stack.length < 2 || current < 0) return false;
    const next = stack[(current + 1) % stack.length],
      note = this.chart.notes.find(item => item.id === next.id);
    this.cycled = {
      selection: new Set(this.selection),
      joint: this.pickedJoint,
      head: this.pickedHead,
      time: performance.now(),
    };
    this.selection = new Set([next.id]);
    this.pickedJoint = next.kind === 'end' || next.kind === 'endWidth' ? next.id : undefined;
    this.pickedHead = this.headAt(next.id, next.kind, point) ? next.id : undefined;
    this.refreshSelection();
    const node =
      next.kind === 'end' || next.kind === 'endWidth' || next.kind === 'endHeight'
        ? ' 末节点'
        : next.kind === 'height'
          ? ' 头节点'
          : '';
    this.setHint(
      `叠放 ${((current + 1) % stack.length) + 1}/${stack.length}：${note ? LABEL[note.type] + node : '事件'} · 再次单击切换到下一个`,
    );
    return true;
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    this.closeShape(false);
    this.viewport.focus({ preventScroll: true });
    const point = this.position(event);
    if (this.mode.kind === 'align' && event.button !== 1) {
      event.preventDefault();
      if (event.button === 0) {
        if (this.view.inAlignWaveform(point)) this.alignAt(point);
        else this.emitCursor(point.tick);
      }
      return;
    }
    // Space to the right of a narrowed track is not an extra editable lane.
    if (point.x > this.view.trackRight && event.button !== 1) return;
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
    if (event.altKey || (tool && AIR_NOTE_TYPES.has(tool) && hitNote && !AIR_NOTE_TYPES.has(hitNote.type)))
      hit = undefined;
    if (this.tool === 'erase' && event.button === 0 && hit) {
      this.erase(hit, point);
      return;
    }
    // A bound AIR covers its parent's tail; its width handles edit the parent, which the AIR follows.
    const covered =
      hit && (hit.kind === 'width' || hit.kind === 'widthLeft') ? boundEditorParent(this.chart, hit.id) : undefined;
    if (hit && covered)
      hit = !long(covered)
        ? { id: covered.id, kind: hit.kind }
        : covered.type === 'SLIDE' && hit.kind === 'width'
          ? { id: covered.id, kind: 'endWidth' }
          : { id: hit.id, kind: 'move' };
    if (this.mode.kind === 'insert' && event.button === 0 && this.view.inTrack(point.x)) {
      this.insertAt(point);
      return;
    }
    if (this.mode.kind === 'continue' && event.button === 0 && this.view.inTrack(point.x)) {
      this.appendSegment(point);
      return;
    }
    // An ExTAP dropped on the head of a HOLD / SLIDE makes that long note EX instead of stacking a second note.
    const exHead =
      tool === 'EXTAP' && event.button === 0 && !event.altKey && this.view.inTrack(point.x)
        ? groundHeadAt(this.view, this.chart, point)
        : undefined;
    if (exHead) {
      const next = setEditorEx(this.chart, exHead.id);
      this.selection = new Set([exHead.id]);
      this.commit(next, exHead.attributes.ex ? '取消 EX' : '设为 EX');
      this.setHint(
        exHead.attributes.ex
          ? `已取消 ${LABEL[exHead.type]} 的 EX`
          : `${LABEL[exHead.type]} 已设为 EX（导出为 ${exHead.type === 'HOLD' ? 'HXD' : 'SXD / SXC'}）`,
      );
      return;
    }
    const before = new Set(this.selection);
    this.cycling = Boolean(
      hit &&
      event.button === 0 &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      before.size === 1 &&
      before.has(hit.id),
    );
    let kind: DragKind = 'box',
      id: string | undefined;
    if (event.button === 1) {
      kind = 'pan';
      event.preventDefault();
    } else if (!hit && (point.x < this.view.eventLeft || point.y > this.view.canvasHeight - this.view.bottom)) {
      kind = 'seek';
      this.emitCursor(point.tick);
    } else if (hit) {
      id = hit.id;
      kind = hit.kind;
      this.pickedJoint = kind === 'end' || kind === 'endWidth' ? id : undefined;
      this.pickedHead = this.headAt(id, kind, point) ? id : undefined;
      // Only a move carries the rest of the selection along; a handle or joint is edited on its own.
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (this.selection.has(id)) {
          this.selection.delete(id);
          this.refreshSelection();
          return;
        }
        this.selection.add(id);
      } else if (!this.selection.has(id) || kind !== 'move') this.selection = new Set([id]);
      this.refreshSelection();
    } else if (tool && this.view.inTrack(point.x)) {
      const note = createNote(tool, point.tick, this.placeLane(point), this.width);
      if (long(note)) note.duration = this.chart.resolution / 4;
      if (hasNodeKind(note))
        note.attributes.visible =
          this.nodeKind === 'inherit' ? this.selectedNote()?.attributes.visible !== false : this.nodeKind === 'normal';
      if (note.type === 'AIR') note.attributes = { direction: this.airDirection, color: 'DEF' };
      if (tool === 'AIR_CRUSH' || !AIR_NOTE_TYPES.has(tool))
        this.preview = { ...this.chart, notes: [...this.chart.notes, note] };
      else {
        // The game reads AIR as an attachment of a ground note's tail, never as a free note.
        const parent =
          hitNote && !AIR_NOTE_TYPES.has(hitNote.type)
            ? hitNote
            : groundTailAt(this.chart, point, Math.max(this.step, 10 / this.view.zoom));
        this.preview = parent && attachEditorAir(this.chart, note, parent.id);
        if (!this.preview) {
          this.setHint(
            parent
              ? '这个地面音符已带有 AIR；每个地面音符（整条 SLIDE）只能绑定一个'
              : `${LABEL[tool]} 必须绑定在地面音符上：请点击 TAP / ExTAP / FLICK，或 HOLD / SLIDE 的终点`,
          );
          return;
        }
      }
      this.selection = new Set([note.id]);
      id = note.id;
      kind = 'draw';
      this.emitCursor(point.tick);
    } else {
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this.selection.clear();
      this.emitCursor(point.tick);
      this.refreshSelection();
    }
    this.drag = {
      kind,
      start: point,
      current: point,
      chart: this.chart,
      id,
      before: event.shiftKey || event.ctrlKey || event.metaKey ? before : new Set(),
      moved: false,
      scroll: this.view.scroll,
      pointerId: event.pointerId,
    };
    this.canvas.setPointerCapture(event.pointerId);
    this.draw();
  }

  private headAt(id: string, kind: DragKind, point: Position): boolean {
    return isChainHeadPick(this.view, this.chart, id, kind, point);
  }
  /**
   * Delete what was picked: a head node takes its whole long note, any other node goes alone, a chain body takes nothing.
   * The head of an EX HOLD / SLIDE first sheds its EX, as if the ExTAP lying on it were erased; the next erase takes the note.
   */
  private erase(hit: { id: string; kind: DragKind }, point: Position): void {
    const note = this.chart.notes.find(item => item.id === hit.id);
    if (
      note &&
      (note.type === 'HOLD' || note.type === 'SLIDE') &&
      note.attributes.ex &&
      hit.kind !== 'end' &&
      hit.kind !== 'endWidth' &&
      Math.abs(point.y - this.view.y(note.tick)) < 10 &&
      (note.type === 'HOLD' || editorChain(this.chart, note)[0].id === note.id)
    ) {
      this.selection = new Set([note.id]);
      this.commit(setEditorEx(this.chart, note.id, false), '取消 EX');
      this.setHint(`已取消 ${LABEL[note.type]} 的 EX；再次删除可移除整条`);
      this.refreshSelection();
      return;
    }
    this.selection = new Set([hit.id]);
    this.pickedJoint = hit.kind === 'end' || hit.kind === 'endWidth' ? hit.id : undefined;
    this.pickedHead = this.headAt(hit.id, hit.kind, point) ? hit.id : undefined;
    this.deleteSelection();
    this.refreshSelection();
  }

  private appendSegment(point: Position): void {
    const previous = this.selectedNote();
    if (!previous || !long(previous)) return;
    if (point.tick <= endTick(previous)) {
      this.setHint('接续节点必须晚于当前长条终点');
      return;
    }
    const next = appendEditorNote(
      this.chart,
      previous.id,
      point.tick,
      this.placeLane(point),
      this.width,
      this.nodeKind === 'inherit' ? undefined : this.nodeKind,
    );
    this.selection = new Set([next.notes.at(-1)!.id]);
    this.commit(next, '接续长条节点');
    this.setHint('节点已接续；继续点击可延长，Esc 完成');
  }

  private pointerMove(event: PointerEvent): void {
    const point = this.position(event);
    this.hover = point;
    const drag = this.drag;
    if (this.mode.kind === 'align' && !drag) {
      this.canvas.style.cursor = '';
      this.draw();
      return;
    }
    if (!drag && this.mode.kind === 'insert') {
      this.canvas.style.cursor = '';
      this.draw();
      return;
    }
    if (!drag) {
      const hit = this.hit(point);
      this.canvas.style.cursor =
        hit?.kind === 'width' ||
        hit?.kind === 'widthLeft' ||
        hit?.kind === 'endWidth' ||
        hit?.kind === 'height' ||
        hit?.kind === 'endHeight'
          ? 'ew-resize'
          : hit?.kind === 'end'
            ? 'ns-resize'
            : hit
              ? 'grab'
              : this.tool === 'select'
                ? 'default'
                : this.tool === 'erase'
                  ? 'cell'
                  : 'crosshair';
      this.draw();
      return;
    }
    drag.current = point;
    if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 3) drag.moved = true;
    if (drag.kind === 'seek') this.emitCursor(point.tick);
    else if (drag.kind === 'pan') {
      this.view.scroll = Math.max(0, drag.scroll + (point.y - drag.start.y) / this.view.zoom);
      this.updateNavigation();
    } else if (drag.kind === 'box') {
      const loTick = Math.min(point.tick, drag.start.tick),
        hiTick = Math.max(point.tick, drag.start.tick);
      const loLane = Math.min(point.lane, drag.start.lane),
        hiLane = Math.max(point.lane, drag.start.lane) + 1;
      this.selection = new Set(drag.before);
      for (const note of this.chart.notes) {
        if (
          endTick(note) >= loTick &&
          note.tick <= hiTick &&
          Math.min(note.lane, endLane(note)) < hiLane &&
          Math.max(note.lane + note.width, endLane(note) + endWidth(note)) > loLane
        )
          this.selection.add(note.id);
      }
      if (Math.min(point.x, drag.start.x) < this.view.left)
        for (const item of this.chart.events)
          if (item.tick >= loTick && item.tick <= hiTick) this.selection.add(item.id);
    } else if ((drag.kind === 'height' || drag.kind === 'endHeight') && drag.moved && drag.id) {
      const maximum = airHeightMaximum(drag.chart);
      const height = Math.round(clamp((point.x - this.view.airLeft) / this.view.airWidth, 0, 1) * maximum * 10) / 10;
      this.preview = setEditorAirHeight(drag.chart, drag.id, drag.kind, height);
    } else if (drag.kind === 'move' && drag.moved) {
      this.preview = moveEditorSelection(
        drag.chart,
        this.selection,
        point.tick - drag.start.tick,
        point.lane - drag.start.lane,
      );
    } else if (drag.kind === 'draw') {
      const note = this.preview?.notes.find(item => item.id === drag.id);
      if (note && long(note) && drag.moved) {
        const next = {
          ...note,
          duration: Math.max(this.step, point.tick - note.tick),
          endLane: note.type === 'HOLD' || note.type === 'AIR_HOLD' ? note.lane : this.placeLane(point, endWidth(note)),
        };
        this.preview = {
          ...this.preview!,
          notes: this.preview!.notes.map(item => (item.id === note.id ? next : item)),
        };
      }
    } else if (drag.moved && drag.id) {
      const note = drag.chart.notes.find(item => item.id === drag.id);
      if (!note) return;
      const next = { ...copyNote(note) };
      if (drag.kind === 'width') {
        next.width = limitWidth(
          this.chart,
          Math.round((point.x - this.view.x(note.lane)) / this.view.laneWidth),
          note.lane,
        );
      }
      if (drag.kind === 'widthLeft') {
        // The right edge stays; the left edge follows the pointer to the nearest lane boundary.
        const right = note.lane + note.width;
        next.lane = clamp(
          Math.round((point.x - this.view.x(0)) / this.view.laneWidth),
          this.chart.allowOutOfLane ? Math.max(-64, right - 128) : 0,
          right - 1,
        );
        next.width = right - next.lane;
      }
      if (drag.kind === 'endWidth') {
        next.endWidth = limitWidth(
          this.chart,
          Math.round((point.x - this.view.x(endLane(note))) / this.view.laneWidth),
          endLane(note),
        );
      }
      if (drag.kind === 'end') {
        next.duration = Math.max(this.step, point.tick - note.tick);
        next.endLane = limitLane(this.chart, endLane(note) + point.lane - drag.start.lane, endWidth(note));
      }
      if (next.type === 'HOLD' || next.type === 'AIR_HOLD') {
        next.endLane = next.lane;
        next.endWidth = next.width;
      }
      this.preview = reshapeEditorNote(
        drag.chart,
        note,
        next,
        drag.kind === 'end' || drag.kind === 'endWidth',
        this.step,
      );
    }
    this.draw();
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const result = this.preview;
    this.drag = undefined;
    this.preview = undefined;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (this.tool === 'erase' && drag.kind === 'box' && drag.moved && this.selection.size) {
      this.deleteSelection();
      return;
    }
    const cycling = this.cycling && !drag.moved;
    this.cycling = false;
    if (cycling && this.cycleSelection(drag.start)) {
      this.draw();
      return;
    }
    if (result && drag.kind === 'move' && drag.moved) this.commitMove(result, '移动选中项');
    else if (result && (drag.moved || drag.kind === 'draw'))
      this.commit(result, drag.kind === 'draw' ? '放置音符' : '调整长条节点');
    else this.refreshSelection();
  }
  /** Commit a move; an ExTAP that lands exactly on a HOLD / SLIDE head makes that long note EX, as placing it there does. */
  private commitMove(moved: Chart, label: string): void {
    const { chart, merged } = mergeEditorExTaps(moved, this.selection);
    if (!merged.length) {
      this.commit(moved, label);
      return;
    }
    for (const note of this.chart.notes)
      if (this.selection.has(note.id) && !chart.notes.some(item => item.id === note.id)) this.selection.delete(note.id);
    for (const id of merged) this.selection.add(id);
    this.commit(chart, 'ExTAP 并入长条头');
    this.setHint(`ExTAP 与长条头重合，已并入：${merged.length} 条长条设为 EX`);
  }
  private cancelDrag(): void {
    this.drag = undefined;
    this.preview = undefined;
    this.refreshSelection();
  }
  private doubleClick(event: MouseEvent): void {
    const point = this.position(event);
    // The second click of the pair has just moved on to the next stacked item; go back to the one the double click began on.
    if (this.cycled && performance.now() - this.cycled.time < 600) {
      this.selection = this.cycled.selection;
      this.pickedJoint = this.cycled.joint;
      this.pickedHead = this.cycled.head;
      this.refreshSelection();
    }
    this.cycled = undefined;
    const hit = this.hit(point);
    if (!hit) return;
    const result = splitEditorNote(
      this.chart,
      hit.id,
      point.tick,
      this.nodeKind === 'inherit' ? undefined : this.nodeKind,
    );
    if (result !== this.chart) this.commit(result, '插入长条节点');
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      // Chromium reports a Shift+wheel turn on the horizontal axis.
      const divisions = [4, 8, 12, 16, 24, 32, 48, 64, 96, 192],
        wider = (event.deltaY || event.deltaX) < 0;
      const next = wider ? divisions.findLast(value => value < this.snap) : divisions.find(value => value > this.snap);
      if (next) {
        this.snap = next;
        this.host.querySelector<HTMLInputElement>('[data-option="snap"]')!.value = String(next);
        this.setHint(`音符间隔 1/${next}`);
      }
    } else if (event.ctrlKey || event.metaKey) {
      const point = this.position(event);
      const old = this.view.zoom;
      this.view.zoom = clamp(
        this.view.zoom * Math.exp(-event.deltaY * 0.002),
        0.2,
        this.mode.kind === 'align' ? 20 : 5,
      );
      this.view.scroll = Math.max(0, point.tick - ((point.tick - this.view.scroll) * old) / this.view.zoom);
      this.host.querySelector<HTMLInputElement>('[data-option="zoom"]')!.value = String(this.view.zoom);
    } else this.view.scroll = Math.max(0, this.view.scroll - event.deltaY / this.view.zoom);
    this.updateNavigation();
    this.draw();
  }

  private keyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (
      event.defaultPrevented ||
      document.querySelector('dialog[open]') ||
      target?.closest('input, textarea, select, [contenteditable="true"]') ||
      !this.host.isConnected ||
      this.host.getClientRects().length === 0
    )
      return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      event.shiftKey ? this.callbacks.onRedo() : this.callbacks.onUndo();
      return;
    }
    if (mod && key === 'y') {
      event.preventDefault();
      this.callbacks.onRedo();
      return;
    }
    if (mod && ['a', 'c', 'v', 'x'].includes(key)) {
      event.preventDefault();
      if (key === 'a') event.shiftKey ? this.clearSelection() : this.selectAll();
      if (key === 'c') this.copySelection();
      if (key === 'v') this.pasteSelection(event.shiftKey);
      if (key === 'x') {
        this.copySelection();
        this.deleteSelection();
      }
      return;
    }
    if (key === 'escape' && this.mode.kind === 'align') {
      this.setAligning(false);
      return;
    }
    if (key === 'escape' && this.mode.kind === 'shape') {
      this.closeShape(false);
      return;
    }
    if (key === 'escape' && this.mode.kind === 'insert') {
      this.setInserting(false);
      return;
    }
    if (key === 'escape') {
      this.cancelDrag();
      this.selection.clear();
      this.setTool('select');
      this.refreshSelection();
      return;
    }
    if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    // Margrete's default single-key commands.
    if (!mod && !event.altKey)
      switch (key) {
        case 's':
          this.setTool('select');
          break;
        case 'w':
          this.setTool(this.penTool);
          break;
        case 'e':
          this.setTool('erase');
          break;
        case 'a':
          this.setTool('select');
          if (this.host.classList.contains('editor-inspector-hidden')) {
            this.host.classList.remove('editor-inspector-hidden');
            this.resize();
          }
          this.setHint('属性编辑：点击音符，在右侧属性面板修改');
          break;
        case 'h':
          this.mirrorSelection();
          break;
        case 'v':
          this.flipSelection();
          break;
        case 'k':
          this.setInserting(this.mode.kind !== 'insert');
          break;
        case 'j':
          this.joinSelection(event.shiftKey ? 'control' : 'normal');
          break;
        case 'r':
          event.preventDefault();
          this.openShape('curve');
          break;
        case 'z':
          event.preventDefault();
          this.openShape('zigzag');
          break;
        case 'b':
          this.addEvent('BPM');
          break;
        case 'n':
          this.addEvent('SCROLL');
          break;
        case 'd':
          this.addEvent('NOTE_SPEED');
          break;
        case 'm':
          this.addEvent('METER');
          break;
        case '1':
          this.setTool('TAP');
          break;
        case '2':
          this.setTool('EXTAP');
          break;
        case '3':
          this.setTool('FLICK');
          break;
        case '4':
          this.setTool('SLIDE');
          this.setNodeKind('control');
          break;
        case '5':
          this.setTool('SLIDE');
          this.setNodeKind('normal');
          break;
        case '6':
          this.setTool('HOLD');
          break;
        case '7':
        case '8': {
          // Pressing the key of the AIR tool already in use steps its lean: centre, left, right.
          const vertical = key === '7' ? 'IR' : 'DW',
            again = this.tool === 'AIR' && this.airVertical === vertical;
          this.setAir(vertical, again ? ([-1, 1, 0] as const)[[0, -1, 1].indexOf(this.airLean)] : this.airLean);
          break;
        }
        case '9':
          this.setTool('AIR_HOLD');
          break;
        case 't':
          this.setTool('AIR_SLIDE');
          this.setNodeKind('normal');
          break;
        case 'y':
          this.setTool('AIR_SLIDE');
          this.setNodeKind('control');
          break;
        case 'u':
        case 'i':
          this.setTool('AIR_CRUSH');
          break;
        case '0':
          this.setTool('DAMAGE');
          break;
      }
    if (key === '[' || key === ']') {
      this.width = clamp(this.width + (key === '[' ? -1 : 1), 1, this.chart.allowOutOfLane ? 128 : LANES);
      this.host.querySelector<HTMLInputElement>('[data-option="width"]')!.value = String(this.width);
      this.draw();
    }
    if (key === 'home') {
      event.preventDefault();
      this.view.scroll = 0;
      this.emitCursor(0);
      this.updateNavigation();
    }
    if (key === 'end') {
      event.preventDefault();
      this.emitCursor(getChartEndTick(this.chart));
      this.setCursor(this.cursor, true);
    }
    if (key === 'pageup' || key === 'pagedown') {
      event.preventDefault();
      this.view.scroll = Math.max(
        0,
        this.view.scroll + (((key === 'pageup' ? 1 : -1) * this.view.canvasHeight) / this.view.zoom) * 0.8,
      );
      this.updateNavigation();
      this.draw();
    }
    if (this.selection.size && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      event.preventDefault();
      const amount = event.shiftKey ? this.chart.resolution / 4 : this.step;
      this.commitMove(
        moveEditorSelection(
          this.chart,
          this.selection,
          key === 'arrowup' ? amount : key === 'arrowdown' ? -amount : 0,
          key === 'arrowleft' ? -1 : key === 'arrowright' ? 1 : 0,
        ),
        '微调选中项',
      );
    }
  }

  private renderInspector(): void {
    const node = this.selectedNode(),
      key = inspectorKey(this.chart, this.selection, node);
    if (key === this.inspectorKey) return;
    this.inspectorKey = key;
    this.inspector.innerHTML = inspectorHtml(this.chart, this.selection, node, this.width);
  }

  private draw(): void {
    this.saveOptions();
    if (this.pendingDraw) return;
    this.pendingDraw = requestAnimationFrame(() => {
      this.pendingDraw = 0;
      this.paint();
    });
  }

  private paint(): void {
    const view = this.view,
      hover = this.hover,
      inTrack = Boolean(hover && view.inTrack(hover.x));
    const insertTarget =
      this.mode.kind === 'insert' && hover && !this.drag && inTrack
        ? insertTargetAt(view, this.chart, hover)
        : undefined;
    const ghostTool = this.noteTool;
    let placement: Note | undefined;
    if (hover && !this.drag && ghostTool && (this.mode.kind === 'normal' || this.mode.kind === 'shape') && inTrack) {
      placement = createNote(ghostTool, hover.tick, this.placeLane(hover), this.width);
      if (long(placement)) placement.duration = this.chart.resolution / 4;
      if (placement.type === 'AIR') placement.attributes.direction = this.airDirection;
    }
    const last = this.mode.kind === 'continue' && hover && inTrack ? this.selectedNote() : undefined;
    const continuation: Note | undefined =
      last && hover && hover.tick > endTick(last)
        ? {
            ...last,
            tick: endTick(last),
            lane: endLane(last),
            width: endWidth(last),
            duration: hover.tick - endTick(last),
            endLane: this.placeLane(hover),
            endWidth: this.width,
          }
        : undefined;
    const shown = this.preview ?? this.chart;
    this.painter.paint({
      chart: this.chart,
      shown,
      selection: this.selection,
      pickedJoint: this.pickedJoint,
      cursor: this.cursor,
      snap: this.snap,
      laneDivision: this.laneDivision,
      hover,
      dragging: Boolean(this.drag),
      box: this.drag?.kind === 'box' && this.drag.moved ? this.drag : undefined,
      aligning: this.mode.kind === 'align',
      insert: insertTarget && {
        target: insertTarget,
        tick: hover!.tick,
        control:
          hasNodeKind(insertTarget.note) &&
          (this.nodeKind === 'inherit' ? insertTarget.note.attributes.visible === false : this.nodeKind === 'control'),
      },
      placement,
      continuation,
      waveform: { peaks: this.peaks, duration: this.audioDuration, offset: this.audioOffset, samples: this.samples },
    });
    this.status.innerHTML = `<span><i></i>${this.mode.kind === 'continue' ? '接续节点' : this.tool === 'select' ? '选择模式' : this.tool === 'erase' ? '橡皮擦' : LABEL[this.tool]}</span><span>光标 <b>${formatTick(this.cursor)}</b> tick · ${tickToSeconds(shown, this.cursor).toFixed(3)} s</span><span>${this.selection.size ? `已选 ${this.selection.size} · ` : ''}${shown.notes.length} 音符 · ${shown.events.length} 事件</span><span>${Math.round((view.zoom / 0.75) * 100)}% · ${this.snap ? `1/${this.snap} 全音符` : '自由'}</span>`;
  }
}
