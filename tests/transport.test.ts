import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport, soundForHit, getChartHits } from '../src/renderer/transport';
import { createProject, createNote } from '../src/core/model';
import { tickToSeconds } from '../src/core/timing';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fakeAudio() {
  const decoding: ReturnType<typeof deferred<{ duration: number; getChannelData(): Float32Array }>>[] = [];
  const resumes: ReturnType<typeof deferred<void>>[] = [];
  const sources: { buffer: unknown; playbackRate: { value: number }; when?: number; offset?: number; stopped: boolean; disconnected: boolean }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  const gains: { gain: { value: number }; ramps: number[] }[] = [];
  const oscillators: unknown[] = [];
  const context = {
    currentTime: 0, destination: {},
    createGain: () => {
      const ramps: number[] = [];
      const node = { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime(value: number) { ramps.push(value); }, exponentialRampToValueAtTime() {} }, ramps, connect() {}, disconnect() {} };
      gains.push(node); return node;
    },
    createOscillator: () => {
      const node = { type: 'sine', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} };
      oscillators.push(node); return node;
    },
    decodeAudioData: () => { const call = deferred<{ duration: number; getChannelData(): Float32Array }>(); decoding.push(call); return call.promise; },
    resume: () => { const call = deferred<void>(); resumes.push(call); return call.promise; },
    close: async () => {},
    createBufferSource: () => {
      const source = { buffer: null as unknown, playbackRate: { value: 1 }, when: undefined as number | undefined, offset: undefined as number | undefined, stopped: false, disconnected: false, connect() {}, disconnect() { this.disconnected = true; }, start(when: number, offset?: number) { this.when = when; this.offset = offset; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
  };
  const previous = new Map(['AudioContext', 'setInterval', 'clearInterval'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: function () { return context; } });
  Object.defineProperty(globalThis, 'setInterval', { configurable: true, value: (callback: () => void, delay: number) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; } });
  Object.defineProperty(globalThis, 'clearInterval', { configurable: true, value: (id: number) => { timers.delete(id); } });
  return { context, decoding, resumes, sources, timers, gains, oscillators, restore() { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}
const buffer = (duration: number) => ({ duration, getChannelData: () => new Float32Array(100).fill(0.5) });
function near(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `expected ${expected}, received ${actual}`);
}

test('audio file replacement ignores an older decoder finishing last', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const oldLoad = transport.load(new ArrayBuffer(1));
    const newLoad = transport.load(new ArrayBuffer(1));
    fake.decoding[1].resolve(buffer(7)); await newLoad;
    fake.decoding[0].resolve(buffer(3)); await oldLoad;
    assert.equal(transport.duration, 7);
    const pending = transport.load(new ArrayBuffer(1)); transport.clearAudio();
    fake.decoding[2].resolve(buffer(9)); await pending;
    assert.equal(transport.hasAudio, false);
  } finally { transport.destroy(); fake.restore(); }
});

test('pause cancels an in-flight AudioContext resume and rapid plays create one clock', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const canceled = transport.play(); transport.pause(); fake.resumes[0].resolve(); await canceled;
    assert.equal(transport.playing, false);
    const first = transport.play(), second = transport.play();
    fake.resumes[2].resolve(); await second;
    fake.context.currentTime = 1; fake.resumes[1].resolve(); await first;
    assert.equal(transport.playing, true); assert.equal(transport.seconds, 1);
    transport.pause(); assert.equal(transport.seconds, 1);
  } finally { transport.destroy(); fake.restore(); }
});

test('original hit samples use the audio clock, preserve cue rate and stop on pause', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const sample = buffer(0.3);
    const loading = transport.setGameSounds({ source: 'copied', sounds: { tap: { cueName: 'tap', layers: [{ path: 'tap.wav', gain: 0.4, playbackRate: 1.1 }] } }, warnings: [] }, async () => new Uint8Array(1));
    await Promise.resolve(); fake.decoding[0].resolve(sample); assert.equal((await loading).loaded, 1);
    const chart = createProject().chart; chart.notes = [createNote('TAP', 0, 4, 4)]; transport.setChart(chart);
    transport.setRate(0.5);
    const playing = transport.play(); fake.resumes[0].resolve(); await playing;
    assert.equal(fake.sources.length, 1); assert.equal(fake.sources[0].buffer, sample);
    assert.equal(fake.sources[0].when, 0); assert.equal(fake.sources[0].playbackRate.value, 1.1);
    near(fake.gains[2].gain.value, .4); near(fake.gains[1].gain.value, .23);
    transport.effects = false; assert.equal(fake.sources[0].stopped, true); assert.equal(transport.playing, true);
    transport.pause();
  } finally { transport.destroy(); fake.restore(); }
});

test('clearing sound resources invalidates an unfinished decoder', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const loading = transport.setGameSounds({ source: 'copied', sounds: { tap: { cueName: 'tap', layers: [{ path: 'tap.wav', gain: 1, playbackRate: 1 }] } }, warnings: [] }, async () => new Uint8Array(1));
    await Promise.resolve(); transport.clearGameSounds(); fake.decoding[0].resolve(buffer(0.3));
    assert.equal((await loading).loaded, 0);
  } finally { transport.destroy(); fake.restore(); }
});

test('AIR down directions choose the down cue and DAMAGE emits no hit sound', () => {
  for (const direction of ['DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR', 'DOWN']) assert.equal(soundForHit({ type: 'AIR', direction }), 'airDown');
  assert.equal(soundForHit({ type: 'AIR', direction: 'IR' }), 'airUp');
  assert.equal(soundForHit({ type: 'DAMAGE' }), undefined);
});

test('AIR-CRUSH sounds preserve the shared phase across non-interval shape splits and use the owning shape', () => {
  const chart = createProject().chart;
  const a = createNote('AIR_CRUSH', 0, 0, 2), b = createNote('AIR_CRUSH', 2, 2, 4), c = createNote('AIR_CRUSH', 5, 4, 6);
  a.duration = 2; a.endLane = 2; a.endWidth = 4;
  b.duration = 3; b.endLane = 4; b.endWidth = 6;
  c.duration = 7; c.endLane = 11; c.endWidth = 13;
  for (const note of [a, b, c]) note.attributes.interval = 6;
  const tap = createNote('TAP', 3, 12, 2); chart.notes = [a, b, c, tap];
  chart.events = [{ id: 'tempo', type: 'BPM', tick: 4, value: 180 }];
  const hits = getChartHits(chart), crush = hits.filter(hit => hit.type === 'AIR_CRUSH');
  assert.deepEqual(crush.map(hit => hit.time), [0, 6, 12].map(tick => tickToSeconds(chart, tick)));
  assert.deepEqual(crush.map(hit => [hit.lane, hit.width]), [[0, 2], [5, 7], [11, 13]]);
  assert.deepEqual(crush.map(hit => hit.key), [`${a.id}:crush:0`, `${c.id}:crush:6`, `${c.id}:crush:12`]);
  assert.deepEqual(hits.filter(hit => hit.type === 'TAP'), [{ time: tickToSeconds(chart, 3), type: 'TAP', lane: 12, width: 2, key: `${tap.id}:head`, direction: '' }]);
});

test('AIR-CRUSH boundary sounds occur once, belong to the next shape and interval zero stays silent', () => {
  const chart = createProject().chart;
  const a = createNote('AIR_CRUSH', 0), b = createNote('AIR_CRUSH', 6), decoration = createNote('AIR_CRUSH', 12);
  a.duration = b.duration = decoration.duration = 6;
  a.attributes.interval = b.attributes.interval = 6; decoration.attributes.interval = 0;
  chart.notes = [a, b, decoration];
  const hits = getChartHits(chart);
  assert.deepEqual(hits.map(hit => hit.key), [`${a.id}:crush:0`, `${b.id}:crush:6`, `${b.id}:crush:12`]);
  assert.equal(new Set(hits.map(hit => hit.time)).size, 3);
});

for (const rate of [0.25, 0.5, 0.75, 1, 2]) {
  test(`${rate}x advances chart time by the audio clock and sets the same music playback rate`, async () => {
    const fake = fakeAudio(), transport = new Transport();
    try {
      const loading = transport.load(new ArrayBuffer(1)); fake.decoding[0].resolve(buffer(90)); await loading;
      fake.context.currentTime = 100;
      transport.setRate(rate); transport.seek(12);
      const playing = transport.play(); fake.resumes[0].resolve(); await playing;
      assert.equal(fake.sources.length, 1);
      assert.equal(fake.sources[0].playbackRate.value, rate);
      assert.equal(fake.sources[0].when, 100);
      assert.equal(fake.sources[0].offset, 12);
      assert.equal(fake.timers.size, 1);
      fake.context.currentTime = 101.6;
      near(transport.seconds, 12 + 1.6 * rate);
      near(transport.seconds, 12 + 1.6 * rate); // Rendering reads must not advance playback.
      fake.context.currentTime = 104;
      near(transport.seconds, 12 + 4 * rate);
      transport.pause(); fake.context.currentTime = 105;
      near(transport.seconds, 12 + 4 * rate);
      assert.equal(fake.sources[0].stopped, true);
      assert.equal(fake.timers.size, 0);
    } finally { transport.destroy(); fake.restore(); }
  });
}

test('changing rate during playback preserves position and replaces one source and scheduler', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1)); fake.decoding[0].resolve(buffer(90)); await loading;
    transport.seek(2);
    const playing = transport.play(); fake.resumes[0].resolve(); await playing;
    fake.context.currentTime = 3;
    for (const rate of [0.25, 0.5, 0.75, 1, 2]) {
      const position = transport.seconds, previous = fake.sources.at(-1)!;
      transport.setRate(rate);
      near(transport.seconds, position);
      assert.equal(previous.stopped, true);
      assert.equal(previous.disconnected, true);
      assert.equal(fake.timers.size, 0);
      fake.resumes.at(-1)!.resolve(); await Promise.resolve();
      assert.equal(transport.playing, true);
      near(transport.seconds, position);
      const source = fake.sources.at(-1)!;
      assert.equal(source.playbackRate.value, rate);
      near(source.offset, position);
      near(source.when, fake.context.currentTime);
      assert.equal(fake.sources.filter(candidate => !candidate.stopped).length, 1);
      assert.equal(fake.timers.size, 1);
      fake.context.currentTime += 0.8;
      near(transport.seconds, position + 0.8 * rate);
    }
    transport.pause();
    assert.equal(fake.sources.every(source => source.stopped), true);
    assert.equal(fake.timers.size, 0);
  } finally { transport.destroy(); fake.restore(); }
});

for (const { offset, seek } of [{ offset: 1.5, seek: 6.25 }, { offset: 1.5, seek: 0.25 }, { offset: -0.75, seek: 3 }]) {
  test(`seeking to ${seek}s with ${offset}s audio offset starts the matching sample position`, async () => {
    const fake = fakeAudio(), transport = new Transport();
    try {
      const loading = transport.load(new ArrayBuffer(1)); fake.decoding[0].resolve(buffer(90)); await loading;
      transport.setRate(0.5); transport.setOffset(offset);
      fake.context.currentTime = 100;
      const playing = transport.play(); fake.resumes[0].resolve(); await playing;
      fake.context.currentTime = 100.25;
      transport.seek(seek);
      assert.equal(fake.sources[0].stopped, true);
      fake.resumes.at(-1)!.resolve(); await Promise.resolve();
      assert.equal(transport.playing, true);
      near(transport.seconds, seek);
      const source = fake.sources.at(-1)!;
      near(source.offset, Math.max(0, seek - offset));
      near(source.when, 100.25 + Math.max(0, offset - seek) / 0.5);
      assert.equal(source.playbackRate.value, 0.5);
      assert.equal(fake.sources.filter(candidate => !candidate.stopped).length, 1);
      assert.equal(fake.timers.size, 1);
      fake.context.currentTime += 0.5;
      near(transport.seconds, seek + 0.25);
    } finally { transport.destroy(); fake.restore(); }
  });
}

test('rapid rate changes while audio resume is pending keep the last rate playing once', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1)); fake.decoding[0].resolve(buffer(90)); await loading;
    const playing = transport.play(); fake.resumes[0].resolve(); await playing;
    fake.context.currentTime = 2;
    transport.setRate(0.5); transport.setRate(2);
    near(transport.seconds, 2);
    // Resolve all pending starts in reverse order to expose a stale resume winning.
    for (const pending of fake.resumes.slice(1).reverse()) { pending.resolve(); await Promise.resolve(); }
    assert.equal(transport.playing, true);
    assert.equal(transport.rate, 2);
    near(fake.sources.at(-1)!.offset, 2);
    assert.equal(fake.sources.at(-1)!.playbackRate.value, 2);
    assert.equal(fake.sources.filter(source => !source.stopped).length, 1);
    assert.equal(fake.timers.size, 1);
    fake.context.currentTime = 2.5;
    near(transport.seconds, 3);
  } finally { transport.destroy(); fake.restore(); }
});

test('an explicit pause cancels pending rate changes and further rate selection stays paused', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1)); fake.decoding[0].resolve(buffer(90)); await loading;
    const playing = transport.play(); fake.resumes[0].resolve(); await playing;
    fake.context.currentTime = 2;
    transport.setRate(0.25); transport.setRate(2); transport.pause();
    for (const pending of fake.resumes.slice(1).reverse()) { pending.resolve(); await Promise.resolve(); }
    const resumeCount = fake.resumes.length;
    transport.setRate(0.75);
    fake.context.currentTime = 4;
    assert.equal(transport.playing, false);
    near(transport.seconds, 2);
    assert.equal(fake.resumes.length, resumeCount);
    assert.equal(fake.sources.every(source => source.stopped), true);
    assert.equal(fake.timers.size, 0);
  } finally { transport.destroy(); fake.restore(); }
});

test('starting past a loop end redirects once without leaving an orphan scheduler', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1)); fake.decoding[0].resolve(buffer(90)); await loading;
    transport.loop = { start: 5, end: 6 }; transport.seek(8);
    const playing = transport.play(); fake.resumes[0].resolve(); await playing;
    assert.equal(fake.timers.size, 0);
    fake.resumes[1].resolve(); await Promise.resolve();
    near(transport.seconds, 5); assert.equal(fake.timers.size, 1);
    assert.equal(fake.sources.filter(source => !source.stopped).length, 1);
    transport.pause(); assert.equal(fake.timers.size, 0);
  } finally { transport.destroy(); fake.restore(); }
});

for (const [type, soundId] of [['HOLD', 'hold'], ['SLIDE', 'slide'], ['AIR_CRUSH', 'airCrush']] as const) {
  test(`${type} simultaneous hits play one complete imported cue at its original gain`, async () => {
    const fake = fakeAudio(), transport = new Transport();
    try {
      const loading = transport.setGameSounds({ source: 'fixture', warnings: [], sounds: {
        [soundId]: { cueName: soundId, layers: [{ path: 'hit.wav', gain: 1, playbackRate: 1 }, { path: 'hit.wav', gain: .8, playbackRate: 1.1 }] },
      } }, async () => new Uint8Array(1));
      await Promise.resolve(); fake.decoding[0].resolve(buffer(.3)); await loading;
      const chart = createProject().chart; chart.notes = Array.from({ length: 16 }, (_, lane) => createNote(type, 0, lane, 1)); transport.setChart(chart);
      assert.equal(getChartHits(chart).filter(hit => hit.time === 0).length, 16, 'audio coalescing must preserve the chart hits');
      const playing = transport.play(); fake.resumes[0].resolve(); await playing;
      assert.equal(fake.sources.length, 2);
      const [first, second] = fake.gains.slice(2).map(node => node.gain.value);
      near(first, 1);
      near(second / first, .8);
      assert.equal(fake.sources[1].playbackRate.value, 1.1);
    } finally { transport.destroy(); fake.restore(); }
  });
  test(`${type} simultaneous fallback hits play once at the original gain`, async () => {
    const fake = fakeAudio(), transport = new Transport();
    try {
      const chart = createProject().chart; chart.notes = Array.from({ length: 16 }, (_, lane) => createNote(type, 0, lane, 1)); transport.setChart(chart);
      assert.equal(getChartHits(chart).filter(hit => hit.time === 0).length, 16, 'audio coalescing must preserve the chart hits');
      const playing = transport.play(); fake.resumes[0].resolve(); await playing;
      assert.equal(fake.oscillators.length, 1);
      const peak = fake.gains[2].ramps[0], original = type === 'AIR_CRUSH' ? .28 : .65;
      near(peak, original);
    } finally { transport.destroy(); fake.restore(); }
  });
}

async function playNow(transport: Transport, fake: ReturnType<typeof fakeAudio>): Promise<void> {
  const playing = transport.play(); fake.resumes.at(-1)!.resolve(); await playing;
}

test('same-time sound identities merge across AIR directions but distinct cues and nearby ticks remain audible', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const chart = createProject().chart;
    const air = (direction: string) => { const note = createNote('AIR', 0); note.attributes.direction = direction; return note; };
    chart.notes = [createNote('TAP', 0), air('IR'), createNote('TAP', 0), air('UL'), air('DW'), air('DR'),
      createNote('FLICK', 0), createNote('TAP', 1), createNote('TAP', 1)];
    transport.setChart(chart);
    await playNow(transport, fake);
    assert.equal(fake.oscillators.length, 5, 'tap, air-up, air-down, flick at tick zero, then a separate tap at tick one');
    for (const timer of fake.timers.values()) timer.callback();
    assert.equal(fake.oscillators.length, 5, 'the next scheduling pass cannot repeat a group');
    transport.pause(); transport.seek(0); await playNow(transport, fake);
    assert.equal(fake.oscillators.length, 10, 'seeking back restores all sound groups');
  } finally { transport.destroy(); fake.restore(); }
});

for (const variant of ['same', 'gain', 'rate', 'path'] as const) test(`simultaneous HOLD/SLIDE samples merge only with identical layers: ${variant}`, async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const layers = [{ path: 'a.wav', gain: 1, playbackRate: 1 }, { path: 'b.wav', gain: .8, playbackRate: 1 }];
    const other = layers.map(layer => ({ ...layer })).reverse();
    if (variant === 'gain') other[0].gain = .4;
    if (variant === 'rate') other[0].playbackRate = 1.2;
    if (variant === 'path') other[0].path = 'c.wav';
    const loading = transport.setGameSounds({ source: 'fixture', warnings: [], sounds: {
      hold: { cueName: 'hold', layers }, slide: { cueName: 'slide', layers: other },
    } }, async () => new Uint8Array(1));
    await Promise.resolve(); for (const decoding of fake.decoding) decoding.resolve(buffer(.3)); await loading;
    const chart = createProject().chart;
    chart.notes = [createNote('HOLD', 0, 0, 1), createNote('SLIDE', 0, 2, 1), createNote('HOLD', 0, 4, 1), createNote('SLIDE', 1, 6, 1)];
    transport.setChart(chart); await playNow(transport, fake);
    assert.equal(fake.sources.length, variant === 'same' ? 4 : 6);
    assert.equal(fake.sources.filter(source => source.when === 0).length, variant === 'same' ? 2 : 4);
    assert.equal(fake.sources.filter(source => source.when === tickToSeconds(chart, 1)).length, 2);
  } finally { transport.destroy(); fake.restore(); }
});

test('sound groups play again across a loop and rate change', async () => {
  const fake = fakeAudio(), transport = new Transport();
  try {
    const chart = createProject().chart; chart.notes = [createNote('TAP', 0), createNote('TAP', 0)];
    transport.setChart(chart); transport.loop = { start: 0, end: .25 };
    await playNow(transport, fake); assert.equal(fake.oscillators.length, 1);
    fake.context.currentTime = .25;
    for (const timer of fake.timers.values()) timer.callback();
    fake.resumes.at(-1)!.resolve(); await Promise.resolve();
    assert.equal(fake.oscillators.length, 2);
    transport.setRate(.5); fake.resumes.at(-1)!.resolve(); await Promise.resolve();
    assert.equal(fake.oscillators.length, 3);
  } finally { transport.destroy(); fake.restore(); }
});
