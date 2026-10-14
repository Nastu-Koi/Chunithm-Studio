import type { Chart, NoteType } from '../core/model';
import { lowerBound } from '../core/search';
import { tickToSeconds, secondsToTick, getBeatLines } from '../core/timing';
import { getPlayerPlaybackPoints } from './playback-points';
import {
  curveShape,
  type GameHitSoundCombo,
  type GameHitSoundCurve,
  type GameHitSoundId,
  type GameHitSoundLayer,
  type GameHitSoundLimit,
  type GameHitSounds,
} from '../core/game-sounds';
import { buildJudgementTimeline } from '../core/judgement';
type SoundLayers = (Omit<GameHitSoundLayer, 'path'> & { buffer: AudioBuffer })[];
type Voice = { stop(at: number): void };
/** The shortest release the game's runtime gives a stopped voice, whatever its envelope says (0x13978c7). */
const MIN_RELEASE = 0.005;
/** A HOLD or SLIDE no longer than this sounds a plain TAP at its start and no sustained loop (6 frames in the game). */
const SUSTAIN_MINIMUM = 0.1;
/** A curved stage is scheduled as this many straight pieces. */
const CURVE_STEPS = 16;
/** Moves `param` from one value to another over `duration` from `start`: one ramp if linear, a run of short ones along a curve. */
function shapedRamp(
  param: AudioParam,
  from: number,
  to: number,
  start: number,
  duration: number,
  curve?: GameHitSoundCurve,
): void {
  param.setValueAtTime(from, start);
  if (!curve?.type) {
    param.linearRampToValueAtTime(to, start + duration);
    return;
  }
  for (let step = 1; step <= CURVE_STEPS; step++)
    param.linearRampToValueAtTime(
      from + (to - from) * curveShape(curve, step / CURVE_STEPS),
      start + (duration * step) / CURVE_STEPS,
    );
}
/**
 * The band-pass section the game's runtime designs (0x139c178): gain B and a zero at 0 over s² + Bs + low·high with
 * B = high − low, both corners pre-warped, then the bilinear transform. Returns null where the runtime bypasses it.
 */
export function bandpassCoefficients(
  low: number,
  high: number,
  sampleRate: number,
): { feedforward: number[]; feedback: number[] } | null {
  low = Math.max(low, 10);
  high = Math.min(high, sampleRate / 2 - 100);
  if (low > high - 1) return null;
  const a = Math.tan((Math.PI * low) / sampleRate),
    b = Math.tan((Math.PI * high) / sampleRate),
    width = b - a,
    square = a * b;
  return { feedforward: [width, 0, -width], feedback: [1 + width + square, 2 * square - 2, 1 - width + square] };
}
/**
 * `sustainHead`: the start of an AIR HOLD / AIR SLIDE chain, drawn as an AIR arrow but sounded by the sustain note itself.
 * `until`: on the start of a HOLD, SLIDE or AIR sustain chain, the time its end is reached and its loop stops.
 */
export interface Hit {
  time: number;
  type: NoteType;
  lane: number;
  width: number;
  key: string;
  direction?: string;
  sustainHead?: boolean;
  until?: number;
}
/**
 * The cues the game's note classes start, read from chusanApp.exe (docs/native-hit-sounds.md). An ExTAP sounds the TAP
 * judgement and the ExTAP effect together. A HOLD or SLIDE starts with a TAP sample and a loop that lasts until its end;
 * the HOLD judgement itself sounds at the end, the SLIDE judgement at each later node. An AIR HOLD / AIR SLIDE starts
 * with its own cue and loop and marks each action with another.
 */
export function soundsForHit(
  hit: Pick<Hit, 'type' | 'direction' | 'sustainHead' | 'until'> & { time?: number },
): GameHitSoundId[] {
  const start = hit.until !== undefined,
    sustained = start && hit.until! - (hit.time ?? 0) > SUSTAIN_MINIMUM;
  switch (hit.type) {
    case 'TAP':
      return ['tap'];
    case 'EXTAP':
      return ['tap', 'ex'];
    case 'FLICK':
      return ['flick'];
    case 'HOLD':
      return start ? [sustained ? 'holdStart' : 'tap'] : ['hold'];
    case 'SLIDE':
      return start ? [sustained ? 'slideStart' : 'tap'] : ['slide'];
    case 'AIR':
      return hit.sustainHead
        ? ['airHoldIn', 'airHoldLoop']
        : [['DOWN', 'DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR'].includes(hit.direction ?? '') ? 'airDown' : 'airUp'];
    case 'AIR_HOLD':
    case 'AIR_SLIDE':
      return ['airHold'];
    case 'AIR_CRUSH':
      return ['airCrush'];
    // A DAMAGE note that is avoided counts as a top judgement of the TAP kind and sounds like one; one that hits is silent.
    case 'DAMAGE':
      return ['tap'];
  }
}
/** Envelope level (0 to 1) of a sounding voice `elapsed` seconds after its start, before any release. */
export function envelopeLevel(envelope: GameHitSoundLayer['envelope'], elapsed: number): number {
  if (!envelope) return 1;
  const { attack, hold, decay, sustain } = envelope;
  if (elapsed < attack) return curveShape(envelope.attackCurve, Math.max(0, elapsed) / attack);
  const decaying = elapsed - attack - hold;
  if (decaying <= 0 || sustain >= 1) return 1;
  return decaying < decay ? 1 + (sustain - 1) * curveShape(envelope.decayCurve, decaying / decay) : sustain;
}
export function getChartHits(chart: Chart): Hit[] {
  const hits: Hit[] = [];
  const crushNotes = new Map(chart.notes.filter(note => note.type === 'AIR_CRUSH').map(note => [note.id, note]));
  if (crushNotes.size)
    for (const point of buildJudgementTimeline(chart).points) {
      if (point.kind !== 'crush') continue;
      const note = crushNotes.get(point.noteId);
      if (!note) continue;
      const progress = note.duration ? (point.tick - note.tick) / note.duration : 0;
      hits.push({
        time: tickToSeconds(chart, point.tick),
        type: note.type,
        lane: note.lane + ((note.endLane ?? note.lane) - note.lane) * progress,
        width: note.width + ((note.endWidth ?? note.width) - note.width) * progress,
        key: `${note.id}:crush:${point.tick}`,
      });
    }
  // A chain of SLIDE or AIR sustain segments keeps one loop from its head to the end of its last segment.
  const node = (type: string, tick: number, lane: number, width: number) =>
    `${type}:${tick.toFixed(7)}:${lane}:${width}`;
  const starts = new Map<string, typeof chart.notes>();
  for (const n of chart.notes)
    if (n.type === 'SLIDE' || n.type === 'AIR_HOLD' || n.type === 'AIR_SLIDE') {
      const key = node(n.type, n.tick, n.lane, n.width);
      starts.set(key, [...(starts.get(key) ?? []), n]);
    }
  const chainEnd = (head: (typeof chart.notes)[number]): number => {
    const seen = new Set([head.id]);
    for (let current = head; ;) {
      const end = current.tick + (current.duration ?? 0);
      const next =
        current.type === 'HOLD'
          ? undefined
          : starts
              .get(node(current.type, end, current.endLane ?? current.lane, current.endWidth ?? current.width))
              ?.find(other => !seen.has(other.id));
      if (!next) return end;
      seen.add(next.id);
      current = next;
    }
  };
  const sustain = new Set(['HOLD', 'SLIDE', 'AIR_HOLD', 'AIR_SLIDE']);
  for (const n of chart.notes) {
    if (n.type === 'AIR_CRUSH') continue;
    // The HOLD judgement sounds where the HOLD ends.
    for (const point of getPlayerPlaybackPoints(chart, n))
      if (point.sound || n.type === 'DAMAGE' || (n.type === 'HOLD' && point.position === 'end')) {
        const head = point.position === 'head' && sustain.has(n.type);
        hits.push({
          time: tickToSeconds(chart, point.tick),
          type: point.type,
          lane: point.lane,
          width: point.width,
          key: `${n.id}:${point.position}`,
          direction: point.direction,
          ...(head && n.type !== 'HOLD' && n.type !== 'SLIDE' ? { sustainHead: true } : {}),
          ...(head ? { until: tickToSeconds(chart, chainEnd(n)) } : {}),
        });
      }
  }
  hits.sort((a, b) => a.time - b.time);
  return hits;
}
/** The audio clock is the only playback clock; rendering samples it, never advances it. */
export class Transport {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private metronomeGain: GainNode | null = null;
  private chart: Chart | null = null;
  private metronomeTick = 0;
  private metronomeEnabled = false;
  private metronomeLevel = 0.5;
  private activeEffects = new Set<AudioScheduledSourceNode>();
  private anchorSeconds = 0;
  private anchorClock = 0;
  private scheduledIndex = 0;
  /** Set whenever sounding effects were cut: the next scheduling pass restarts the loops of notes still being held. */
  private resumeSustains = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hits: Hit[] = [];
  private loadGeneration = 0;
  private playGeneration = 0;
  private playRequested = false;
  private effectsGeneration = 0;
  private samples = new Map<GameHitSoundId, SoundLayers>();
  private limits = new Map<GameHitSoundId, GameHitSoundLimit[]>();
  private combos = new Map<GameHitSoundId, GameHitSoundCombo[]>();
  /** Step and start time of the latest start of each combo cue. */
  private comboSteps = new Map<string, { step: number; time: number }>();
  /** Sounding voices per limit key, oldest first. */
  private voices = new Map<string, Voice[]>();
  private output: AudioNode | null = null;
  private effectsLevel = 0.6;
  playing = false;
  rate = 1;
  offset = 0;
  volume = 0.8;
  private effectsEnabled = true;
  get effects(): boolean {
    return this.effectsEnabled;
  }
  set effects(enabled: boolean) {
    this.effectsEnabled = enabled;
    if (this.effectsGain) this.effectsGain.gain.value = enabled ? this.effectsLevel : 0;
    if (!enabled) this.stopEffects();
  }
  /** Editing aid only: clicks on the chart's beats, never part of an export. */
  get metronome(): boolean {
    return this.metronomeEnabled;
  }
  set metronome(enabled: boolean) {
    this.metronomeEnabled = enabled;
    this.resetScheduler();
  }
  /** Master level of every hit sound, 0 to 1; the relative mix between sounds comes from the game's own data. */
  get effectsVolume(): number {
    return this.effectsLevel;
  }
  set effectsVolume(value: number) {
    this.effectsLevel = Math.max(0, Math.min(1, value));
    if (this.effectsGain && this.effectsEnabled) this.effectsGain.gain.value = this.effectsLevel;
  }
  get metronomeVolume(): number {
    return this.metronomeLevel;
  }
  set metronomeVolume(value: number) {
    this.metronomeLevel = value;
    if (this.metronomeGain) this.metronomeGain.gain.value = value;
  }
  /** First channel of the loaded music, for drawing a waveform finer than the overview peaks. */
  get musicSamples(): { data: Float32Array; sampleRate: number } | null {
    return this.buffer ? { data: this.buffer.getChannelData(0), sampleRate: this.buffer.sampleRate } : null;
  }
  loop: { start: number; end: number } | null = null;
  onLoop?: () => void;
  get duration(): number {
    return this.buffer?.duration ?? 0;
  }
  get hasAudio(): boolean {
    return this.buffer !== null;
  }
  get seconds(): number {
    return this.playing && this.context
      ? this.anchorSeconds + (this.context.currentTime - this.anchorClock) * this.rate
      : this.anchorSeconds;
  }
  private audioContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      // Safety limiter on the whole mix: it acts only within 1 dB of full scale, where the sum would otherwise clip.
      // Music and hit sounds share it, so its look-ahead delays both equally.
      const limiter = this.context.createDynamicsCompressor?.();
      if (limiter) {
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.05;
        limiter.connect(this.context.destination);
      }
      this.output = limiter ?? this.context.destination;
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = this.volume;
      this.musicGain.connect(this.output);
      this.effectsGain = this.context.createGain();
      this.effectsGain.gain.value = this.effectsEnabled ? this.effectsLevel : 0;
      this.effectsGain.connect(this.output);
    }
    return this.context;
  }
  async load(bytes: ArrayBuffer): Promise<{ peaks: Float32Array; duration: number }> {
    this.pause();
    const context = this.audioContext(),
      generation = ++this.loadGeneration;
    const decoded = await context.decodeAudioData(bytes.slice(0));
    if (generation !== this.loadGeneration) return { peaks: new Float32Array(), duration: 0 };
    this.buffer = decoded;
    const channel = this.buffer.getChannelData(0),
      length = Math.min(18000, Math.ceil(this.buffer.duration * 80));
    const peaks = new Float32Array(length);
    const block = Math.max(1, Math.floor(channel.length / length));
    for (let i = 0; i < length; i++) {
      let peak = 0;
      for (let j = i * block; j < Math.min(channel.length, (i + 1) * block); j++)
        peak = Math.max(peak, Math.abs(channel[j]));
      peaks[i] = peak;
    }
    return { peaks, duration: this.buffer.duration };
  }
  clearAudio(): void {
    this.pause();
    this.loadGeneration++;
    this.buffer = null;
  }
  clearGameSounds(): void {
    this.effectsGeneration++;
    this.samples.clear();
    this.limits.clear();
    this.combos.clear();
  }
  async setGameSounds(
    sounds: GameHitSounds,
    read: (path: string) => Promise<Uint8Array>,
  ): Promise<{ loaded: number; failed: string[] }> {
    const generation = ++this.effectsGeneration,
      context = this.audioContext();
    const decoded = new Map<string, Promise<AudioBuffer>>(),
      next: typeof this.samples = new Map(),
      failed: string[] = [];
    const sharedLayers = new Map<string, SoundLayers>(),
      limits: typeof this.limits = new Map(),
      combos: typeof this.combos = new Map();
    await Promise.all(
      Object.entries(sounds.sounds).map(async ([id, sound]) => {
        try {
          const layers = await Promise.all(
            sound.layers.map(async layer => {
              if (
                !Number.isFinite(layer.gain) ||
                layer.gain < 0 ||
                !Number.isFinite(layer.playbackRate) ||
                layer.playbackRate <= 0
              )
                throw new Error('音效参数无效');
              if (
                [
                  ...Object.values(layer.envelope ?? {}).filter(value => typeof value === 'number'),
                  layer.stopAfter ?? 0,
                  layer.delay ?? 0,
                  ...(layer.swell ?? []).flatMap(point => [point.time, point.level]),
                ].some(value => !Number.isFinite(value) || value < 0)
              )
                throw new Error('音效参数无效');
              if (
                [
                  layer.bandpass?.low ?? 1,
                  layer.bandpass?.high ?? 1,
                  layer.peaking?.frequency ?? 1,
                  layer.peaking?.q ?? 1,
                  layer.peaking?.gain ?? 1,
                ].some(value => !Number.isFinite(value) || value <= 0)
              )
                throw new Error('音效参数无效');
              if (!decoded.has(layer.path))
                decoded.set(
                  layer.path,
                  read(layer.path).then(bytes => context.decodeAudioData(new Uint8Array(bytes).buffer)),
                );
              const { path: _path, ...rest } = layer;
              return { ...rest, buffer: await decoded.get(layer.path)! };
            }),
          );
          if (layers.length) {
            // Some cues (including bundled HOLD/SLIDE) are the same complete sound.
            // Keep every layer within a cue, but share identity for equal cue mixes.
            const key = JSON.stringify(
              sound.layers
                .map(layer =>
                  JSON.stringify([
                    layer.path,
                    layer.gain,
                    layer.playbackRate,
                    layer.envelope,
                    layer.stopAfter,
                    layer.loop,
                    layer.group,
                    layer.delay,
                    layer.bandpass,
                    layer.peaking,
                    layer.swell,
                  ]),
                )
                .sort(),
            );
            if (!sharedLayers.has(key)) sharedLayers.set(key, layers);
            next.set(id as GameHitSoundId, sharedLayers.get(key)!);
            limits.set(
              id as GameHitSoundId,
              (sound.limits ?? []).filter(limit => limit.max >= 1),
            );
            combos.set(
              id as GameHitSoundId,
              (sound.combos ?? []).filter(
                combo => combo.steps.length > 0 && combo.steps.every(step => step.delay >= 0 && step.spread >= 0),
              ),
            );
          }
        } catch (error) {
          failed.push(`${sound.cueName}: ${error instanceof Error ? error.message : error}`);
        }
      }),
    );
    if (generation !== this.effectsGeneration) return { loaded: 0, failed: [] };
    this.samples = next;
    this.limits = limits;
    this.combos = combos;
    return { loaded: next.size, failed };
  }
  setChart(chart: Chart): void {
    this.chart = chart;
    this.hits = getChartHits(chart);
    this.resetScheduler();
  }
  private resetScheduler(): void {
    const time = this.seconds - 0.0001;
    this.scheduledIndex = lowerBound(this.hits, time, hit => hit.time);
    if (this.chart) this.metronomeTick = secondsToTick(this.chart, Math.max(0, time));
  }
  async play(): Promise<void> {
    if (this.playing) return;
    const context = this.audioContext(),
      generation = ++this.playGeneration;
    this.playRequested = true;
    try {
      await context.resume();
    } catch (error) {
      if (generation === this.playGeneration) this.playRequested = false;
      throw error;
    }
    if (generation !== this.playGeneration || this.playing) return;
    this.anchorClock = context.currentTime;
    this.playing = true;
    this.startMusic();
    this.resetScheduler();
    this.schedule();
    if (generation !== this.playGeneration || !this.playing) return;
    this.timer = setInterval(() => this.schedule(), 25);
  }
  pause(): void {
    this.playGeneration++;
    this.playRequested = false;
    this.anchorSeconds = this.seconds;
    this.playing = false;
    this.stopSources();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  seek(seconds: number): void {
    const resume = this.playing || this.playRequested;
    this.pause();
    this.anchorSeconds = Math.max(0, seconds);
    this.resetScheduler();
    if (resume) void this.play();
  }
  setRate(value: number): void {
    const resume = this.playing || this.playRequested;
    this.pause();
    this.rate = Math.max(0.1, Math.min(2, value));
    if (resume) void this.play();
  }
  setOffset(value: number): void {
    const resume = this.playing || this.playRequested;
    this.pause();
    this.offset = value;
    if (resume) void this.play();
  }
  setVolume(value: number): void {
    this.volume = value;
    if (this.musicGain) this.musicGain.gain.value = value;
  }
  private startMusic(): void {
    if (!this.buffer || !this.context || !this.musicGain) return;
    const audioOffset = this.anchorSeconds - this.offset;
    if (audioOffset >= this.buffer.duration) return;
    this.source = this.context.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = this.rate;
    this.source.connect(this.musicGain);
    this.source.start(this.anchorClock + Math.max(0, -audioOffset) / this.rate, Math.max(0, audioOffset));
  }
  private stopSources(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* Already ended. */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.stopEffects();
  }
  private stopEffects(): void {
    for (const effect of this.activeEffects) {
      try {
        effect.stop();
      } catch {
        /* Already ended. */
      }
      effect.disconnect();
    }
    this.activeEffects.clear();
    this.voices.clear();
    this.comboSteps.clear();
    this.resumeSustains = true;
  }
  private schedule(): void {
    if (!this.playing || !this.context) return;
    const now = this.seconds;
    if (this.loop && this.loop.end > this.loop.start && now >= this.loop.end) {
      this.seek(this.loop.start);
      this.onLoop?.();
      return;
    }
    const horizon = now + 0.1 * this.rate;
    this.scheduleMetronome(Math.min(horizon, this.loop && this.loop.end > this.loop.start ? this.loop.end : Infinity));
    // Playback that starts inside a HOLD or SLIDE picks up its loop without replaying the start.
    if (this.resumeSustains) {
      this.resumeSustains = false;
      const end = this.loop && this.loop.end > this.loop.start ? this.loop.end : Infinity;
      if (this.effects)
        for (const hit of this.hits.slice(0, this.scheduledIndex))
          if (hit.until !== undefined && hit.until > now && hit.time < now - 0.03)
            for (const soundId of soundsForHit(hit))
              this.playSound(
                soundId,
                this.context.currentTime,
                this.anchorClock + (Math.min(hit.until, end) - this.anchorSeconds) / this.rate,
                true,
              );
    }
    const played = new Set<GameHitSoundId | SoundLayers>();
    let groupTime: number | undefined;
    while (this.scheduledIndex < this.hits.length && this.hits[this.scheduledIndex].time < horizon) {
      const hit = this.hits[this.scheduledIndex++];
      // A scheduling pass consumes each entire timestamp group. Use chart time,
      // not the clamped audio start time, so nearby/late hits remain distinct.
      if (hit.time !== groupTime) {
        groupTime = hit.time;
        played.clear();
      }
      // Equal sounds at one instant merge into one. Of a merged sustained start only the loop still plays: each note ends its own.
      const sounds = soundsForHit(hit),
        fresh = sounds.filter(soundId => {
          const sound = this.samples.get(soundId) ?? soundId;
          return !played.has(sound) && !!played.add(sound);
        });
      if (!this.effects || hit.time < now - 0.03 || (this.loop && hit.time >= this.loop.end)) continue;
      const clock = (seconds: number) => this.anchorClock + (seconds - this.anchorSeconds) / this.rate;
      const until = hit.until === undefined ? undefined : clock(Math.min(hit.until, this.loop?.end ?? Infinity));
      if (fresh.length) this.scheduleEffect(hit, fresh, clock(hit.time), until);
      if (until !== undefined)
        for (const soundId of sounds)
          if (!fresh.includes(soundId))
            this.playSound(soundId, Math.max(clock(hit.time), this.context.currentTime), until, true);
    }
  }
  private scheduleMetronome(horizon: number): void {
    if (!this.chart || !this.context) return;
    const until = secondsToTick(this.chart, horizon);
    if (!(until > this.metronomeTick)) return;
    if (this.metronomeEnabled && !this.metronomeGain) {
      this.metronomeGain = this.context.createGain();
      this.metronomeGain.gain.value = this.metronomeLevel;
      this.metronomeGain.connect(this.output ?? this.context.destination);
    }
    if (this.metronomeEnabled && this.metronomeGain)
      for (const beat of getBeatLines(this.chart, this.metronomeTick, until)) {
        const when = Math.max(
          this.context.currentTime,
          this.anchorClock + (tickToSeconds(this.chart, beat.tick) - this.anchorSeconds) / this.rate,
        );
        const oscillator = this.context.createOscillator(),
          gain = this.context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.value = beat.downbeat ? 1760 : 1175;
        gain.gain.setValueAtTime(beat.downbeat ? 0.5 : 0.32, when);
        gain.gain.exponentialRampToValueAtTime(0.001, when + 0.03);
        oscillator.connect(gain);
        gain.connect(this.metronomeGain);
        oscillator.start(when);
        oscillator.stop(when + 0.04);
        this.activeEffects.add(oscillator);
        oscillator.onended = () => {
          this.activeEffects.delete(oscillator);
          oscillator.disconnect();
          gain.disconnect();
        };
      }
    this.metronomeTick = until;
  }
  /** `until`: when the note that starts a looping layer ends. `sustainOnly` leaves out everything but those loops. */
  private playSound(soundId: GameHitSoundId, when: number, until?: number, sustainOnly = false): boolean {
    const context = this.context!,
      destination = this.effectsGain!,
      known = this.samples.get(soundId);
    if (!known?.length) return false;
    // A loop needs something to end it: the cue that started it, or the end of its note.
    const layers = known.filter(layer =>
      layer.loop ? layer.stopAfter !== undefined || until !== undefined : !sustainOnly,
    );
    // Loops of one cue started together (two HOLDs at once) would sound as a single louder loop; the game sets each
    // start that follows the previous one within the combo time a little later than the one before.
    const shifts = new Map<number | undefined, number>();
    for (const combo of this.combos.get(soundId) ?? []) {
      if (!layers.some(layer => layer.group === combo.group)) continue;
      const last = this.comboSteps.get(combo.key);
      let step = last && when >= last.time && when - last.time <= combo.window ? last.step + 1 : 0;
      if (step >= combo.steps.length) step = Math.min(combo.loopback, combo.steps.length - 1);
      this.comboSteps.set(combo.key, { step, time: when });
      shifts.set(
        combo.group,
        Math.max(0, combo.steps[step].delay + (Math.random() * 2 - 1) * combo.steps[step].spread),
      );
    }
    const nodes = layers.map(layer => {
      const source = context.createBufferSource(),
        gain = context.createGain(),
        envelope = layer.envelope,
        chain: AudioNode[] = [source];
      const start = when + (layer.delay ?? 0) + (shifts.get(layer.group) ?? 0);
      source.buffer = layer.buffer;
      source.playbackRate.value = layer.playbackRate;
      if (layer.loop) {
        source.loop = true;
        source.loopStart = layer.loop.start;
        source.loopEnd = layer.loop.end;
      }
      // The cue's filters, with the coefficients the game's runtime computes for them.
      const band = layer.bandpass && bandpassCoefficients(layer.bandpass.low, layer.bandpass.high, context.sampleRate);
      if (band) chain.push(context.createIIRFilter(band.feedforward, band.feedback));
      if (layer.peaking) {
        const filter = context.createBiquadFilter();
        filter.type = 'peaking';
        filter.Q.value = layer.peaking.q;
        filter.gain.value = 20 * Math.log10(layer.peaking.gain);
        filter.frequency.value = Math.max(10, Math.min(layer.peaking.frequency, context.sampleRate / 2 - 100));
        chain.push(filter);
      }
      // Volume over the time since the start, apart from the envelope: the sustained loops swell in over 0.1 s.
      if (layer.swell?.length) {
        const swell = context.createGain(),
          points = layer.swell;
        swell.gain.value = points[0].level;
        swell.gain.setValueAtTime(points[0].level, start);
        for (let index = 1; index < points.length; index++) {
          if (points[index].curve?.type)
            shapedRamp(
              swell.gain,
              points[index - 1].level,
              points[index].level,
              start + points[index - 1].time,
              points[index].time - points[index - 1].time,
              points[index].curve,
            );
          else swell.gain.linearRampToValueAtTime(points[index].level, start + points[index].time);
        }
        chain.push(swell);
      }
      // Envelope times run in real time, whatever the pitch of the layer.
      if (envelope && envelope.attack > 0) {
        gain.gain.value = 0;
        shapedRamp(gain.gain, 0, layer.gain, start, envelope.attack, envelope.attackCurve);
      } else gain.gain.value = layer.gain;
      if (envelope && envelope.sustain < 1)
        shapedRamp(
          gain.gain,
          layer.gain,
          layer.gain * envelope.sustain,
          start + envelope.attack + envelope.hold,
          envelope.decay,
          envelope.decayCurve,
        );
      chain.push(gain);
      for (let index = 1; index < chain.length; index++) chain[index - 1].connect(chain[index]);
      gain.connect(destination);
      this.activeEffects.add(source);
      source.start(start);
      return {
        source,
        gain,
        chain,
        start,
        level: layer.gain,
        envelope,
        group: layer.group,
        stopAt: undefined as number | undefined,
        ended: false,
      };
    });
    // A stop enters the release from wherever the envelope is; an earlier stop replaces a later one.
    const stop = (node: (typeof nodes)[number], at: number): void => {
      if (node.stopAt !== undefined && node.stopAt <= at) return;
      node.stopAt = at;
      const release = Math.max(node.envelope?.release ?? 0, MIN_RELEASE),
        param = node.gain.gain;
      param.cancelScheduledValues?.(at);
      shapedRamp(
        param,
        node.level * envelopeLevel(node.envelope, at - node.start),
        0,
        at,
        release,
        node.envelope?.releaseCurve,
      );
      try {
        node.source.stop(at + release);
      } catch {
        /* Already ended. */
      }
    };
    for (const [index, layer] of layers.entries()) {
      // The cue that started a layer may stop it again shortly after: a TAP judgement sounds 50 ms and then releases.
      if (layer.stopAfter !== undefined) stop(nodes[index], Math.max(nodes[index].start, when + layer.stopAfter));
      if (layer.loop && until !== undefined) stop(nodes[index], Math.max(nodes[index].start, until));
    }
    // The game limits how many playbacks of one cue, or of one category such as HOLD / SLIDE, sound together:
    // a new hit takes the place of the oldest instead of piling another full-length tail on top.
    const held: { key: string; voice: Voice; members: typeof nodes }[] = [],
      voices = new Map<number | undefined, Voice>();
    for (const limit of this.limits.get(soundId) ?? []) {
      const members = limit.group === undefined ? nodes : nodes.filter(node => node.group === limit.group);
      if (!members.length) continue;
      const voice = voices.get(limit.group) ?? {
        stop: (at: number) => {
          for (const node of members) stop(node, at);
        },
      };
      voices.set(limit.group, voice);
      const list = this.voices.get(limit.key) ?? [];
      while (list.length >= limit.max) list.shift()!.stop(when);
      list.push(voice);
      this.voices.set(limit.key, list);
      held.push({ key: limit.key, voice, members });
    }
    for (const node of nodes)
      node.source.onended = () => {
        node.ended = true;
        this.activeEffects.delete(node.source);
        for (const part of node.chain) part.disconnect();
        for (const { key, voice, members } of held)
          if (members.every(member => member.ended)) {
            const list = this.voices.get(key),
              index = list?.indexOf(voice) ?? -1;
            if (index >= 0) list!.splice(index, 1);
          }
      };
    return nodes.length > 0;
  }
  private scheduleEffect(hit: Hit, sounds: GameHitSoundId[], when: number, until?: number): void {
    const context = this.context!,
      destination = this.effectsGain!;
    when = Math.max(when, context.currentTime);
    let sampled = false;
    for (const soundId of sounds) sampled = this.playSound(soundId, when, until) || sampled;
    if (sampled) return;
    const air = hit.type.startsWith('AIR'),
      ex = hit.type === 'EXTAP';
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    const duration = air ? 0.13 : ex ? 0.09 : 0.045;
    oscillator.type = hit.type === 'FLICK' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(air ? 1500 : ex ? 1850 : 1000, when);
    oscillator.frequency.exponentialRampToValueAtTime(air ? 500 : 320, when + duration);
    gain.gain.setValueAtTime(0.001, when);
    gain.gain.linearRampToValueAtTime(air ? 0.28 : 0.65, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.01);
    this.activeEffects.add(oscillator);
    oscillator.onended = () => {
      this.activeEffects.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
  }
  destroy(): void {
    this.pause();
    this.clearGameSounds();
    this.loadGeneration++;
    void this.context?.close();
  }
}
