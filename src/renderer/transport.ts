import type { Chart, NoteType } from '../core/model';
import { tickToSeconds, secondsToTick, getBeatLines } from '../core/timing';
import { getPlayerPlaybackPoints } from './playback-points';
import type { GameHitSoundEnvelope, GameHitSoundId, GameHitSoundLimit, GameHitSounds } from '../core/game-sounds';
import { buildJudgementTimeline } from '../core/judgement';
type SoundLayers = { buffer: AudioBuffer; gain: number; playbackRate: number; envelope?: GameHitSoundEnvelope; stopAfter?: number }[];
type Voice = { stop(at: number): void };
/** A stopped voice without a release time of its own fades this long instead of clicking off. */
const LIMIT_FADE = 0.02;
/** `sustainHead`: the start of an AIR HOLD / AIR SLIDE chain, drawn as an AIR arrow but sounded by the sustain note itself. */
export interface Hit { time: number; type: NoteType; lane: number; width: number; key: string; direction?: string; sustainHead?: boolean }
/**
 * The cues the game's note classes start, read from chusanApp.exe (docs/native-hit-sounds.md): an ExTAP sounds the TAP
 * judgement and the ExTAP effect together; an AIR HOLD / AIR SLIDE starts with its own cue and marks each action with another.
 */
export function soundsForHit(hit: Pick<Hit, 'type' | 'direction' | 'sustainHead'>): GameHitSoundId[] {
  switch (hit.type) {
    case 'TAP': return ['tap'];
    case 'EXTAP': return ['tap', 'ex'];
    case 'FLICK': return ['flick'];
    case 'HOLD': return ['hold'];
    case 'SLIDE': return ['slide'];
    case 'AIR': return [hit.sustainHead ? 'airHoldIn' : ['DOWN', 'DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR'].includes(hit.direction ?? '') ? 'airDown' : 'airUp'];
    case 'AIR_HOLD': case 'AIR_SLIDE': return ['airHold'];
    case 'AIR_CRUSH': return ['airCrush'];
    case 'DAMAGE': return [];
  }
}
/** Envelope level (0 to 1) of a sounding voice `elapsed` seconds after its start, before any release. */
export function envelopeLevel(envelope: GameHitSoundEnvelope | undefined, elapsed: number): number {
  if (!envelope) return 1;
  const { attack, hold, decay, sustain } = envelope;
  if (elapsed < attack) return Math.max(0, elapsed) / attack;
  const decaying = elapsed - attack - hold;
  if (decaying <= 0 || sustain >= 1) return 1;
  return decaying < decay ? 1 + (sustain - 1) * decaying / decay : sustain;
}
export function getChartHits(chart: Chart): Hit[] {
  const hits: Hit[] = [];
  const crushNotes = new Map(chart.notes.filter(note => note.type === 'AIR_CRUSH').map(note => [note.id, note]));
  if (crushNotes.size) for (const point of buildJudgementTimeline(chart).points) {
    if (point.kind !== 'crush') continue;
    const note = crushNotes.get(point.noteId); if (!note) continue;
    const progress = note.duration ? (point.tick - note.tick) / note.duration : 0;
    hits.push({ time: tickToSeconds(chart, point.tick), type: note.type,
      lane: note.lane + ((note.endLane ?? note.lane) - note.lane) * progress,
      width: note.width + ((note.endWidth ?? note.width) - note.width) * progress,
      key: `${note.id}:crush:${point.tick}` });
  }
  for (const n of chart.notes) {
    if (n.type === 'DAMAGE' || n.type === 'AIR_CRUSH') continue;
    for (const point of getPlayerPlaybackPoints(chart, n)) if (point.sound) hits.push({ time: tickToSeconds(chart, point.tick), type: point.type, lane: point.lane, width: point.width, key: `${n.id}:${point.position}`, direction: point.direction,
      ...(point.position === 'head' && (n.type === 'AIR_HOLD' || n.type === 'AIR_SLIDE') ? { sustainHead: true } : {}) });
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private hits: Hit[] = [];
  private loadGeneration = 0;
  private playGeneration = 0;
  private playRequested = false;
  private effectsGeneration = 0;
  private samples = new Map<GameHitSoundId, SoundLayers>();
  private limits = new Map<GameHitSoundId, GameHitSoundLimit[]>();
  /** Sounding voices per limit key, oldest first. */
  private voices = new Map<string, Voice[]>();
  private output: AudioNode | null = null;
  private effectsLevel = 0.6;
  playing = false;
  rate = 1;
  offset = 0;
  volume = 0.8;
  private effectsEnabled = true;
  get effects(): boolean { return this.effectsEnabled; }
  set effects(enabled: boolean) {
    this.effectsEnabled = enabled;
    if (this.effectsGain) this.effectsGain.gain.value = enabled ? this.effectsLevel : 0;
    if (!enabled) this.stopEffects();
  }
  /** Editing aid only: clicks on the chart's beats, never part of an export. */
  get metronome(): boolean { return this.metronomeEnabled; }
  set metronome(enabled: boolean) { this.metronomeEnabled = enabled; this.resetScheduler(); }
  /** Master level of every hit sound, 0 to 1; the relative mix between sounds comes from the game's own data. */
  get effectsVolume(): number { return this.effectsLevel; }
  set effectsVolume(value: number) { this.effectsLevel = Math.max(0, Math.min(1, value)); if (this.effectsGain && this.effectsEnabled) this.effectsGain.gain.value = this.effectsLevel; }
  get metronomeVolume(): number { return this.metronomeLevel; }
  set metronomeVolume(value: number) { this.metronomeLevel = value; if (this.metronomeGain) this.metronomeGain.gain.value = value; }
  /** First channel of the loaded music, for drawing a waveform finer than the overview peaks. */
  get musicSamples(): { data: Float32Array; sampleRate: number } | null { return this.buffer ? { data: this.buffer.getChannelData(0), sampleRate: this.buffer.sampleRate } : null; }
  loop: { start: number; end: number } | null = null;
  onLoop?: () => void;
  get duration(): number { return this.buffer?.duration ?? 0; }
  get hasAudio(): boolean { return this.buffer !== null; }
  get seconds(): number { return this.playing && this.context ? this.anchorSeconds + (this.context.currentTime - this.anchorClock) * this.rate : this.anchorSeconds; }
  private audioContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      // Safety limiter on the whole mix: it acts only within 1 dB of full scale, where the sum would otherwise clip.
      // Music and hit sounds share it, so its look-ahead delays both equally.
      const limiter = this.context.createDynamicsCompressor?.();
      if (limiter) { limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.05; limiter.connect(this.context.destination); }
      this.output = limiter ?? this.context.destination;
      this.musicGain = this.context.createGain(); this.musicGain.gain.value = this.volume; this.musicGain.connect(this.output);
      this.effectsGain = this.context.createGain(); this.effectsGain.gain.value = this.effectsEnabled ? this.effectsLevel : 0; this.effectsGain.connect(this.output);
    }
    return this.context;
  }
  async load(bytes: ArrayBuffer): Promise<{ peaks: Float32Array; duration: number }> {
    this.pause(); const context = this.audioContext(), generation = ++this.loadGeneration;
    const decoded = await context.decodeAudioData(bytes.slice(0));
    if (generation !== this.loadGeneration) return { peaks: new Float32Array(), duration: 0 };
    this.buffer = decoded;
    const channel = this.buffer.getChannelData(0), length = Math.min(18000, Math.ceil(this.buffer.duration * 80));
    const peaks = new Float32Array(length);
    const block = Math.max(1, Math.floor(channel.length / length));
    for (let i = 0; i < length; i++) { let peak = 0; for (let j = i * block; j < Math.min(channel.length, (i + 1) * block); j++) peak = Math.max(peak, Math.abs(channel[j])); peaks[i] = peak; }
    return { peaks, duration: this.buffer.duration };
  }
  clearAudio(): void { this.pause(); this.loadGeneration++; this.buffer = null; }
  clearGameSounds(): void { this.effectsGeneration++; this.samples.clear(); this.limits.clear(); }
  async setGameSounds(sounds: GameHitSounds, read: (path: string) => Promise<Uint8Array>): Promise<{ loaded: number; failed: string[] }> {
    const generation = ++this.effectsGeneration, context = this.audioContext();
    const decoded = new Map<string, Promise<AudioBuffer>>(), next: typeof this.samples = new Map(), failed: string[] = [];
    const sharedLayers = new Map<string, SoundLayers>(), limits: typeof this.limits = new Map();
    await Promise.all(Object.entries(sounds.sounds).map(async ([id, sound]) => {
      try {
        const layers = await Promise.all(sound.layers.map(async layer => {
          if (!Number.isFinite(layer.gain) || layer.gain < 0 || !Number.isFinite(layer.playbackRate) || layer.playbackRate <= 0) throw new Error('音效参数无效');
          if ([...Object.values(layer.envelope ?? {}), layer.stopAfter ?? 0].some(value => !Number.isFinite(value) || value < 0)) throw new Error('音效参数无效');
          if (!decoded.has(layer.path)) decoded.set(layer.path, read(layer.path).then(bytes => context.decodeAudioData(new Uint8Array(bytes).buffer)));
          return { buffer: await decoded.get(layer.path)!, gain: layer.gain, playbackRate: layer.playbackRate, envelope: layer.envelope, stopAfter: layer.stopAfter };
        }));
        if (layers.length) {
          // Some cues (including bundled HOLD/SLIDE) are the same complete sound.
          // Keep every layer within a cue, but share identity for equal cue mixes.
          const key = JSON.stringify(sound.layers.map(layer => JSON.stringify([layer.path, layer.gain, layer.playbackRate, layer.envelope, layer.stopAfter])).sort());
          if (!sharedLayers.has(key)) sharedLayers.set(key, layers);
          next.set(id as GameHitSoundId, sharedLayers.get(key)!);
          limits.set(id as GameHitSoundId, (sound.limits ?? []).filter(limit => limit.max >= 1));
        }
      } catch (error) { failed.push(`${sound.cueName}: ${error instanceof Error ? error.message : error}`); }
    }));
    if (generation !== this.effectsGeneration) return { loaded: 0, failed: [] };
    this.samples = next; this.limits = limits; return { loaded: next.size, failed };
  }
  setChart(chart: Chart): void { this.chart = chart; this.hits = getChartHits(chart); this.resetScheduler(); }
  private resetScheduler(): void {
    const time = this.seconds - 0.0001;
    let lo = 0, hi = this.hits.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.hits[mid].time < time) lo = mid + 1; else hi = mid; }
    this.scheduledIndex = lo;
    if (this.chart) this.metronomeTick = secondsToTick(this.chart, Math.max(0, time));
  }
  async play(): Promise<void> {
    if (this.playing) return;
    const context = this.audioContext(), generation = ++this.playGeneration; this.playRequested = true;
    try { await context.resume(); }
    catch (error) { if (generation === this.playGeneration) this.playRequested = false; throw error; }
    if (generation !== this.playGeneration || this.playing) return;
    this.anchorClock = context.currentTime; this.playing = true;
    this.startMusic(); this.resetScheduler(); this.schedule();
    if (generation !== this.playGeneration || !this.playing) return;
    this.timer = setInterval(() => this.schedule(), 25);
  }
  pause(): void {
    this.playGeneration++; this.playRequested = false; this.anchorSeconds = this.seconds; this.playing = false;
    this.stopSources(); if (this.timer) clearInterval(this.timer); this.timer = null;
  }
  seek(seconds: number): void {
    const resume = this.playing || this.playRequested; this.pause(); this.anchorSeconds = Math.max(0, seconds); this.resetScheduler(); if (resume) void this.play();
  }
  setRate(value: number): void { const resume = this.playing || this.playRequested; this.pause(); this.rate = Math.max(0.1, Math.min(2, value)); if (resume) void this.play(); }
  setOffset(value: number): void { const resume = this.playing || this.playRequested; this.pause(); this.offset = value; if (resume) void this.play(); }
  setVolume(value: number): void { this.volume = value; if (this.musicGain) this.musicGain.gain.value = value; }
  private startMusic(): void {
    if (!this.buffer || !this.context || !this.musicGain) return;
    const audioOffset = this.anchorSeconds - this.offset;
    if (audioOffset >= this.buffer.duration) return;
    this.source = this.context.createBufferSource(); this.source.buffer = this.buffer; this.source.playbackRate.value = this.rate;
    this.source.connect(this.musicGain); this.source.start(this.anchorClock + Math.max(0, -audioOffset) / this.rate, Math.max(0, audioOffset));
  }
  private stopSources(): void {
    if (this.source) { try { this.source.stop(); } catch { /* Already ended. */ } this.source.disconnect(); this.source = null; }
    this.stopEffects();
  }
  private stopEffects(): void {
    for (const effect of this.activeEffects) { try { effect.stop(); } catch { /* Already ended. */ } effect.disconnect(); }
    this.activeEffects.clear(); this.voices.clear();
  }
  private schedule(): void {
    if (!this.playing || !this.context) return;
    const now = this.seconds;
    if (this.loop && this.loop.end > this.loop.start && now >= this.loop.end) { this.seek(this.loop.start); this.onLoop?.(); return; }
    const horizon = now + 0.10 * this.rate;
    this.scheduleMetronome(Math.min(horizon, this.loop && this.loop.end > this.loop.start ? this.loop.end : Infinity));
    const played = new Set<GameHitSoundId | SoundLayers>();
    let groupTime: number | undefined;
    while (this.scheduledIndex < this.hits.length && this.hits[this.scheduledIndex].time < horizon) {
      const hit = this.hits[this.scheduledIndex++];
      // A scheduling pass consumes each entire timestamp group. Use chart time,
      // not the clamped audio start time, so nearby/late hits remain distinct.
      if (hit.time !== groupTime) { groupTime = hit.time; played.clear(); }
      const fresh = soundsForHit(hit).filter(soundId => { const sound = this.samples.get(soundId) ?? soundId; return !played.has(sound) && !!played.add(sound); });
      if (!fresh.length) continue;
      if (this.effects && hit.time >= now - 0.03 && (!this.loop || hit.time < this.loop.end)) this.scheduleEffect(hit, fresh, this.anchorClock + (hit.time - this.anchorSeconds) / this.rate);
    }
  }
  private scheduleMetronome(horizon: number): void {
    if (!this.chart || !this.context) return;
    const until = secondsToTick(this.chart, horizon);
    if (!(until > this.metronomeTick)) return;
    if (this.metronomeEnabled && !this.metronomeGain) { this.metronomeGain = this.context.createGain(); this.metronomeGain.gain.value = this.metronomeLevel; this.metronomeGain.connect(this.output ?? this.context.destination); }
    if (this.metronomeEnabled && this.metronomeGain) for (const beat of getBeatLines(this.chart, this.metronomeTick, until)) {
      const when = Math.max(this.context.currentTime, this.anchorClock + (tickToSeconds(this.chart, beat.tick) - this.anchorSeconds) / this.rate);
      const oscillator = this.context.createOscillator(), gain = this.context.createGain();
      oscillator.type = 'square'; oscillator.frequency.value = beat.downbeat ? 1760 : 1175;
      gain.gain.setValueAtTime(beat.downbeat ? 0.5 : 0.32, when); gain.gain.exponentialRampToValueAtTime(0.001, when + 0.03);
      oscillator.connect(gain); gain.connect(this.metronomeGain); oscillator.start(when); oscillator.stop(when + 0.04);
      this.activeEffects.add(oscillator); oscillator.onended = () => { this.activeEffects.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    }
    this.metronomeTick = until;
  }
  private playSound(soundId: GameHitSoundId, when: number): boolean {
    const context = this.context!, destination = this.effectsGain!, layers = this.samples.get(soundId);
    if (!layers?.length) return false;
    const nodes = layers.map(layer => {
      const source = context.createBufferSource(), gain = context.createGain(), envelope = layer.envelope;
      source.buffer = layer.buffer; source.playbackRate.value = layer.playbackRate;
      // Envelope times run in real time, whatever the pitch of the layer.
      if (envelope && envelope.attack > 0) { gain.gain.value = 0; gain.gain.setValueAtTime(0, when); gain.gain.linearRampToValueAtTime(layer.gain, when + envelope.attack); }
      else gain.gain.value = layer.gain;
      if (envelope && envelope.sustain < 1) { const start = when + envelope.attack + envelope.hold; gain.gain.setValueAtTime(layer.gain, start); gain.gain.linearRampToValueAtTime(layer.gain * envelope.sustain, start + envelope.decay); }
      source.connect(gain); gain.connect(destination); this.activeEffects.add(source);
      source.start(when);
      return { source, gain, level: layer.gain, envelope, stopAt: undefined as number | undefined };
    });
    // A stop enters the release from wherever the envelope is; an earlier stop replaces a later one.
    const stop = (node: typeof nodes[number], at: number): void => {
      if (node.stopAt !== undefined && node.stopAt <= at) return;
      node.stopAt = at;
      const release = node.envelope?.release || LIMIT_FADE, param = node.gain.gain;
      param.cancelScheduledValues?.(at); param.setValueAtTime(node.level * envelopeLevel(node.envelope, at - when), at); param.linearRampToValueAtTime(0, at + release);
      try { node.source.stop(at + release); } catch { /* Already ended. */ }
    };
    // The cue that started a layer may stop it again shortly after: a TAP judgement sounds 50 ms and then releases.
    for (const [index, layer] of layers.entries()) if (layer.stopAfter !== undefined) stop(nodes[index], when + layer.stopAfter);
    const voice: Voice = { stop: at => { for (const node of nodes) stop(node, at); } };
    // The game limits how many playbacks of one cue, or of one category such as HOLD / SLIDE, sound together:
    // a new hit takes the place of the oldest instead of piling another full-length tail on top.
    const keys = (this.limits.get(soundId) ?? []).map(limit => {
      const list = this.voices.get(limit.key) ?? [];
      while (list.length >= limit.max) list.shift()!.stop(when);
      list.push(voice); this.voices.set(limit.key, list);
      return limit.key;
    });
    let remaining = nodes.length;
    for (const { source, gain } of nodes) source.onended = () => {
      this.activeEffects.delete(source); source.disconnect(); gain.disconnect();
      if (--remaining) return;
      for (const key of keys) { const list = this.voices.get(key), index = list?.indexOf(voice) ?? -1; if (index >= 0) list!.splice(index, 1); }
    };
    return true;
  }
  private scheduleEffect(hit: Hit, sounds: GameHitSoundId[], when: number): void {
    const context = this.context!, destination = this.effectsGain!;
    when = Math.max(when, context.currentTime);
    let sampled = false;
    for (const soundId of sounds) sampled = this.playSound(soundId, when) || sampled;
    if (sampled) return;
    const air = hit.type.startsWith('AIR'), ex = hit.type === 'EXTAP';
    const oscillator = context.createOscillator(), gain = context.createGain();
    const duration = air ? 0.13 : ex ? 0.09 : 0.045;
    oscillator.type = hit.type === 'FLICK' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(air ? 1500 : ex ? 1850 : 1000, when);
    oscillator.frequency.exponentialRampToValueAtTime(air ? 500 : 320, when + duration);
    gain.gain.setValueAtTime(0.001, when); gain.gain.linearRampToValueAtTime(air ? 0.28 : 0.65, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
    oscillator.connect(gain); gain.connect(destination); oscillator.start(when); oscillator.stop(when + duration + 0.01);
    this.activeEffects.add(oscillator); oscillator.onended = () => { this.activeEffects.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
  }
  destroy(): void { this.pause(); this.clearGameSounds(); this.loadGeneration++; void this.context?.close(); }
}
