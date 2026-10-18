import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport, soundsForHit, envelopeLevel, getChartHits, bandpassCoefficients } from '../src/renderer/transport';
import { curveShape } from '../src/core/game-sounds';
import { createProject, createNote } from '../src/core/model';
import { tickToSeconds } from '../src/core/timing';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function fakeAudio() {
  const decoding: ReturnType<typeof deferred<{ duration: number; getChannelData(): Float32Array }>>[] = [];
  const resumes: ReturnType<typeof deferred<void>>[] = [];
  const sources: {
    buffer: unknown;
    playbackRate: { value: number };
    when?: number;
    offset?: number;
    stopped: boolean;
    disconnected: boolean;
  }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  const gains: { gain: { value: number }; ramps: number[]; events: [string, number, number][] }[] = [];
  const oscillators: unknown[] = [];
  const filters: {
    type: string;
    frequency: { value: number };
    Q: { value: number };
    gain: { value: number };
    feedforward?: number[];
    feedback?: number[];
  }[] = [];
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => {
      const ramps: number[] = [],
        events: [string, number, number][] = [];
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      const node = {
        gain: {
          value: 1,
          setValueAtTime(value: number, time: number) {
            events.push(['set', round(value), round(time)]);
          },
          linearRampToValueAtTime(value: number, time: number) {
            ramps.push(value);
            events.push(['ramp', round(value), round(time)]);
          },
          exponentialRampToValueAtTime() {},
          cancelScheduledValues(time: number) {
            for (let i = events.length - 1; i >= 0; i--) if (events[i][2] >= round(time)) events.splice(i, 1);
          },
        },
        ramps,
        events,
        connect() {},
        disconnect() {},
      };
      gains.push(node);
      return node;
    },
    createOscillator: () => {
      const node = {
        type: 'sine',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
      oscillators.push(node);
      return node;
    },
    decodeAudioData: () => {
      const call = deferred<{ duration: number; getChannelData(): Float32Array }>();
      decoding.push(call);
      return call.promise;
    },
    resume: () => {
      const call = deferred<void>();
      resumes.push(call);
      return call.promise;
    },
    close: async () => {},
    sampleRate: 48000,
    createBiquadFilter: () => {
      const node = {
        type: '',
        frequency: { value: 0 },
        Q: { value: 1 },
        gain: { value: 0 },
        connect() {},
        disconnect() {},
      };
      filters.push(node);
      return node;
    },
    createIIRFilter: (feedforward: number[], feedback: number[]) => {
      const node = {
        type: 'iir',
        feedforward,
        feedback,
        frequency: { value: 0 },
        Q: { value: 1 },
        gain: { value: 0 },
        connect() {},
        disconnect() {},
      };
      filters.push(node);
      return node;
    },
    createBufferSource: () => {
      const source = {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        when: undefined as number | undefined,
        offset: undefined as number | undefined,
        stopped: false,
        disconnected: false,
        connect() {},
        disconnect() {
          this.disconnected = true;
        },
        start(when: number, offset?: number) {
          this.when = when;
          this.offset = offset;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  const previous = new Map(
    ['AudioContext', 'setInterval', 'clearInterval'].map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: function () {
      return context;
    },
  });
  Object.defineProperty(globalThis, 'setInterval', {
    configurable: true,
    value: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
  });
  Object.defineProperty(globalThis, 'clearInterval', {
    configurable: true,
    value: (id: number) => {
      timers.delete(id);
    },
  });
  return {
    context,
    decoding,
    resumes,
    sources,
    timers,
    gains,
    oscillators,
    filters,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
const buffer = (duration: number) => ({ duration, getChannelData: () => new Float32Array(100).fill(0.5) });
function near(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `expected ${expected}, received ${actual}`);
}

test('audio file replacement ignores an older decoder finishing last', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const oldLoad = transport.load(new ArrayBuffer(1));
    const newLoad = transport.load(new ArrayBuffer(1));
    fake.decoding[1].resolve(buffer(7));
    await newLoad;
    fake.decoding[0].resolve(buffer(3));
    await oldLoad;
    assert.equal(transport.duration, 7);
    const pending = transport.load(new ArrayBuffer(1));
    transport.clearAudio();
    fake.decoding[2].resolve(buffer(9));
    await pending;
    assert.equal(transport.hasAudio, false);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('pause cancels an in-flight AudioContext resume and rapid plays create one clock', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const canceled = transport.play();
    transport.pause();
    fake.resumes[0].resolve();
    await canceled;
    assert.equal(transport.playing, false);
    const first = transport.play(),
      second = transport.play();
    fake.resumes[2].resolve();
    await second;
    fake.context.currentTime = 1;
    fake.resumes[1].resolve();
    await first;
    assert.equal(transport.playing, true);
    assert.equal(transport.seconds, 1);
    transport.pause();
    assert.equal(transport.seconds, 1);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('original hit samples use the audio clock, preserve cue rate and stop on pause', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const sample = buffer(0.3);
    const loading = transport.setGameSounds(
      {
        source: 'copied',
        sounds: { tap: { cueName: 'tap', layers: [{ path: 'tap.wav', gain: 0.4, playbackRate: 1.1 }] } },
        warnings: [],
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    fake.decoding[0].resolve(sample);
    assert.equal((await loading).loaded, 1);
    const chart = createProject().chart;
    chart.notes = [createNote('TAP', 0, 4, 4)];
    transport.setChart(chart);
    transport.setRate(0.5);
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    assert.equal(fake.sources.length, 1);
    assert.equal(fake.sources[0].buffer, sample);
    assert.equal(fake.sources[0].when, 0);
    assert.equal(fake.sources[0].playbackRate.value, 1.1);
    near(fake.gains[2].gain.value, 0.4);
    near(fake.gains[1].gain.value, 0.6);
    transport.effectsVolume = 0.3;
    near(fake.gains[1].gain.value, 0.3);
    transport.effectsVolume = 7;
    near(fake.gains[1].gain.value, 1);
    transport.effects = false;
    assert.equal(fake.sources[0].stopped, true);
    assert.equal(transport.playing, true);
    transport.pause();
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('cue and category limits replace the oldest voice instead of stacking full-length tails', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const layer = (path: string) => [{ path, gain: 1, playbackRate: 1 }];
    const loading = transport.setGameSounds(
      {
        source: 'copied',
        warnings: [],
        sounds: {
          flick: { cueName: 'flick', layers: layer('flick.wav'), limits: [{ key: 'cue:flick', max: 1 }] },
          holdStart: {
            cueName: 'hold',
            layers: layer('hold.wav'),
            limits: [{ key: 'category:Limit_HoldSlideCritical', max: 1 }],
          },
          slideStart: {
            cueName: 'slide',
            layers: layer('slide.wav'),
            limits: [{ key: 'category:Limit_HoldSlideCritical', max: 1 }],
          },
          tap: { cueName: 'tap', layers: layer('tap.wav') },
        },
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    for (const call of fake.decoding) call.resolve(buffer(3));
    await loading;
    const chart = createProject().chart,
      at = (type: Parameters<typeof createNote>[0], tick: number, lane: number) => ({
        ...createNote(type, tick, lane, 2),
        ...(type === 'HOLD' || type === 'SLIDE' ? { duration: 3840 } : {}),
      });
    // Three FLICKs a few milliseconds apart, a HOLD then a SLIDE head, and two unlimited TAPs.
    chart.notes = [
      at('FLICK', 0, 0),
      at('FLICK', 8, 0),
      at('FLICK', 16, 0),
      at('HOLD', 4, 4),
      at('SLIDE', 12, 8),
      at('TAP', 2, 12),
      at('TAP', 10, 12),
    ];
    transport.setChart(chart);
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    assert.equal(fake.sources.length, 7);
    const order = ['FLICK', 'TAP', 'HOLD', 'FLICK', 'TAP', 'SLIDE', 'FLICK'];
    assert.deepEqual(
      fake.sources.map((source, index) => [order[index], source.stopped]),
      [
        ['FLICK', true],
        ['TAP', false],
        ['HOLD', true],
        ['FLICK', true],
        ['TAP', false],
        ['SLIDE', false],
        ['FLICK', false],
      ],
    );
    // A replaced voice fades to silence rather than cutting off.
    assert.equal(fake.gains.filter(node => node.ramps.includes(0)).length, 3);
    transport.pause();
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('clearing sound resources invalidates an unfinished decoder', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.setGameSounds(
      {
        source: 'copied',
        sounds: { tap: { cueName: 'tap', layers: [{ path: 'tap.wav', gain: 1, playbackRate: 1 }] } },
        warnings: [],
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    transport.clearGameSounds();
    fake.decoding[0].resolve(buffer(0.3));
    assert.equal((await loading).loaded, 0);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('AIR down directions choose the down cue and an avoided DAMAGE sounds like a TAP', () => {
  for (const direction of ['DW', 'DL', 'DR', 'ADW', 'ADL', 'ADR', 'DOWN'])
    assert.deepEqual(soundsForHit({ type: 'AIR', direction }), ['airDown']);
  assert.deepEqual(soundsForHit({ type: 'AIR', direction: 'IR' }), ['airUp']);
  assert.deepEqual(soundsForHit({ type: 'DAMAGE' }), ['tap']);
  const mined = createProject().chart;
  mined.notes = [createNote('DAMAGE', 96, 0, 2)];
  assert.deepEqual(
    getChartHits(mined).map(hit => [hit.type, hit.time === tickToSeconds(mined, 96)]),
    [['DAMAGE', true]],
  );
});

test('note types start the cues the game starts for them', () => {
  // ExTAP: the TAP judgement and the ExTAP effect together.
  assert.deepEqual(soundsForHit({ type: 'EXTAP' }), ['tap', 'ex']);
  assert.deepEqual(soundsForHit({ type: 'AIR', direction: 'IR', sustainHead: true }), ['airHoldIn', 'airHoldLoop']);
  // HOLD and SLIDE: a TAP sample with a loop at the start (a plain TAP when shorter than 0.1 s), the judgement afterwards.
  for (const [type, start, later] of [
    ['HOLD', 'holdStart', 'hold'],
    ['SLIDE', 'slideStart', 'slide'],
  ] as const) {
    assert.deepEqual(soundsForHit({ type, time: 2, until: 2.5 }), [start]);
    assert.deepEqual(soundsForHit({ type, time: 2, until: 2.0625 }), ['tap']);
    assert.deepEqual(soundsForHit({ type }), [later]);
  }
  assert.deepEqual(soundsForHit({ type: 'AIR_SLIDE' }), ['airHold']);
  assert.deepEqual(soundsForHit({ type: 'AIR_CRUSH' }), ['airCrush']);
  const chart = createProject().chart;
  chart.notes = [
    createNote('TAP', 0, 0, 4),
    { ...createNote('AIR_HOLD', 0, 0, 4), duration: 480, attributes: { parent: 'TAP' } },
    { ...createNote('AIR', 960, 8, 4), attributes: { direction: 'IR', parent: 'TAP' } },
  ];
  const air = getChartHits(chart).filter(hit => hit.type === 'AIR');
  assert.deepEqual(
    air.map(hit => [hit.time > 0, soundsForHit(hit)]),
    [
      [false, ['airHoldIn', 'airHoldLoop']],
      [true, ['airUp']],
    ],
  );
  // The HOLD judgement sounds at its end; a SLIDE chain keeps one loop from its head to the end of its last segment.
  const sustained = createProject().chart;
  sustained.notes = [
    { ...createNote('HOLD', 0, 0, 4), duration: 960 },
    { ...createNote('SLIDE', 0, 8, 4), duration: 480, endLane: 9, endWidth: 4 },
    { ...createNote('SLIDE', 480, 9, 4), duration: 480, endLane: 8, endWidth: 4 },
  ];
  const end = tickToSeconds(sustained, 960);
  assert.deepEqual(
    getChartHits(sustained).map(hit => [
      hit.type,
      hit.time === 0 ? 0 : hit.time === end ? 'end' : 'middle',
      hit.until === undefined ? undefined : hit.until === end,
      soundsForHit(hit),
    ]),
    [
      ['HOLD', 0, true, ['holdStart']],
      ['SLIDE', 0, true, ['slideStart']],
      ['SLIDE', 'middle', undefined, ['slide']],
      ['HOLD', 'end', undefined, ['hold']],
      ['SLIDE', 'end', undefined, ['slide']],
    ],
  );
});

test('an envelope holds, decays to its sustain level, and a stop releases from wherever it is', async () => {
  const envelope = { attack: 0, hold: 0.02, decay: 0.1, sustain: 0.4, release: 0.5 };
  assert.deepEqual(
    [0, 0.02, 0.07, 0.12, 1].map(time => Math.round(envelopeLevel(envelope, time) * 100) / 100),
    [1, 1, 0.7, 0.4, 0.4],
  );
  assert.equal(envelopeLevel({ ...envelope, attack: 0.1 }, 0.05), 0.5);
  assert.equal(envelopeLevel(undefined, 3), 1);
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.setGameSounds(
      {
        source: 'copied',
        warnings: [],
        sounds: {
          // A TAP judgement: started, stopped again 50 ms later, then a 500 ms release.
          tap: {
            cueName: 'tap',
            layers: [
              {
                path: 'tap.wav',
                gain: 0.5,
                playbackRate: 1,
                envelope: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.5 },
                stopAfter: 0.05,
              },
            ],
          },
          holdStart: {
            cueName: 'hold',
            layers: [{ path: 'hold.wav', gain: 1, playbackRate: 1, envelope }],
            limits: [{ key: 'category:Limit_HoldSlideCritical', max: 1 }],
          },
        },
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    for (const call of fake.decoding) call.resolve(buffer(3));
    await loading;
    const chart = createProject().chart;
    chart.notes = [
      createNote('TAP', 0, 0, 2),
      { ...createNote('HOLD', 0, 4, 2), duration: 3840 },
      { ...createNote('HOLD', 8, 8, 2), duration: 3840 },
    ];
    transport.setChart(chart);
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    const [tap, first, second] = fake.gains.slice(-3),
      later = tickToSeconds(chart, 8);
    assert.deepEqual(tap.events, [
      ['set', 0.5, 0.05],
      ['ramp', 0, 0.55],
    ]);
    // The second HOLD replaces the first part-way through its decay: the release starts from that level.
    const level = Math.round(envelopeLevel(envelope, later) * 1e6) / 1e6,
      at = Math.round(later * 1e6) / 1e6;
    assert.ok(level > 0.4 && level < 1);
    assert.deepEqual(first.events, [
      ['set', 1, 0.02],
      ['set', level, at],
      ['ramp', 0, Math.round((later + 0.5) * 1e6) / 1e6],
    ]);
    assert.deepEqual(second.events, [
      ['set', 1, Math.round((later + 0.02) * 1e6) / 1e6],
      ['ramp', 0.4, Math.round((later + 0.12) * 1e6) / 1e6],
    ]);
    transport.pause();
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test("a displaced voice without a release time fades over the runtime's 5 ms minimum", async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.setGameSounds(
      {
        source: 'copied',
        warnings: [],
        sounds: {
          flick: {
            cueName: 'flick',
            layers: [{ path: 'flick.wav', gain: 1, playbackRate: 1 }],
            limits: [{ key: 'cue:flick', max: 1 }],
          },
        },
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    for (const call of fake.decoding) call.resolve(buffer(3));
    await loading;
    const chart = createProject().chart;
    chart.notes = [createNote('FLICK', 0, 0, 2), createNote('FLICK', 8, 8, 2)];
    transport.setChart(chart);
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    const [first, second] = fake.gains.slice(-2),
      later = tickToSeconds(chart, 8),
      micro = (value: number) => Math.round(value * 1e6) / 1e6;
    assert.deepEqual(first.events, [
      ['set', 1, micro(later)],
      ['ramp', 0, micro(later + 0.005)],
    ]);
    assert.deepEqual(second.events, []);
    transport.pause();
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('AIR-CRUSH sounds preserve the shared phase across non-interval shape splits and use the owning shape', () => {
  const chart = createProject().chart;
  const a = createNote('AIR_CRUSH', 0, 0, 2),
    b = createNote('AIR_CRUSH', 2, 2, 4),
    c = createNote('AIR_CRUSH', 5, 4, 6);
  a.duration = 2;
  a.endLane = 2;
  a.endWidth = 4;
  b.duration = 3;
  b.endLane = 4;
  b.endWidth = 6;
  c.duration = 7;
  c.endLane = 11;
  c.endWidth = 13;
  for (const note of [a, b, c]) note.attributes.interval = 6;
  const tap = createNote('TAP', 3, 12, 2);
  chart.notes = [a, b, c, tap];
  chart.events = [{ id: 'tempo', type: 'BPM', tick: 4, value: 180 }];
  const hits = getChartHits(chart),
    crush = hits.filter(hit => hit.type === 'AIR_CRUSH');
  assert.deepEqual(
    crush.map(hit => hit.time),
    [0, 6, 12].map(tick => tickToSeconds(chart, tick)),
  );
  assert.deepEqual(
    crush.map(hit => [hit.lane, hit.width]),
    [
      [0, 2],
      [5, 7],
      [11, 13],
    ],
  );
  assert.deepEqual(
    crush.map(hit => hit.key),
    [`${a.id}:crush:0`, `${c.id}:crush:6`, `${c.id}:crush:12`],
  );
  assert.deepEqual(
    hits.filter(hit => hit.type === 'TAP'),
    [{ time: tickToSeconds(chart, 3), type: 'TAP', lane: 12, width: 2, key: `${tap.id}:head`, direction: '' }],
  );
});

test('AIR-CRUSH boundary sounds occur once, belong to the next shape and interval zero stays silent', () => {
  const chart = createProject().chart;
  const a = createNote('AIR_CRUSH', 0),
    b = createNote('AIR_CRUSH', 6),
    decoration = createNote('AIR_CRUSH', 12);
  a.duration = b.duration = decoration.duration = 6;
  a.attributes.interval = b.attributes.interval = 6;
  decoration.attributes.interval = 0;
  chart.notes = [a, b, decoration];
  const hits = getChartHits(chart);
  assert.deepEqual(
    hits.map(hit => hit.key),
    [`${a.id}:crush:0`, `${b.id}:crush:6`, `${b.id}:crush:12`],
  );
  assert.equal(new Set(hits.map(hit => hit.time)).size, 3);
});

for (const rate of [0.1, 0.25, 0.5, 0.75, 1, 2]) {
  test(`${rate}x advances chart time by the audio clock and sets the same music playback rate`, async () => {
    const fake = fakeAudio(),
      transport = new Transport();
    try {
      const loading = transport.load(new ArrayBuffer(1));
      fake.decoding[0].resolve(buffer(90));
      await loading;
      fake.context.currentTime = 100;
      transport.setRate(rate);
      transport.seek(12);
      const playing = transport.play();
      fake.resumes[0].resolve();
      await playing;
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
      transport.pause();
      fake.context.currentTime = 105;
      near(transport.seconds, 12 + 4 * rate);
      assert.equal(fake.sources[0].stopped, true);
      assert.equal(fake.timers.size, 0);
    } finally {
      transport.destroy();
      fake.restore();
    }
  });
}

test('changing rate during playback preserves position and replaces one source and scheduler', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1));
    fake.decoding[0].resolve(buffer(90));
    await loading;
    transport.seek(2);
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    fake.context.currentTime = 3;
    for (const rate of [0.1, 0.25, 0.5, 0.75, 1, 2]) {
      const position = transport.seconds,
        previous = fake.sources.at(-1)!;
      transport.setRate(rate);
      near(transport.seconds, position);
      assert.equal(previous.stopped, true);
      assert.equal(previous.disconnected, true);
      assert.equal(fake.timers.size, 0);
      fake.resumes.at(-1)!.resolve();
      await Promise.resolve();
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
    assert.equal(
      fake.sources.every(source => source.stopped),
      true,
    );
    assert.equal(fake.timers.size, 0);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

for (const { offset, seek } of [
  { offset: 1.5, seek: 6.25 },
  { offset: 1.5, seek: 0.25 },
  { offset: -0.75, seek: 3 },
]) {
  test(`seeking to ${seek}s with ${offset}s audio offset starts the matching sample position`, async () => {
    const fake = fakeAudio(),
      transport = new Transport();
    try {
      const loading = transport.load(new ArrayBuffer(1));
      fake.decoding[0].resolve(buffer(90));
      await loading;
      transport.setRate(0.5);
      transport.setOffset(offset);
      fake.context.currentTime = 100;
      const playing = transport.play();
      fake.resumes[0].resolve();
      await playing;
      fake.context.currentTime = 100.25;
      transport.seek(seek);
      assert.equal(fake.sources[0].stopped, true);
      fake.resumes.at(-1)!.resolve();
      await Promise.resolve();
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
    } finally {
      transport.destroy();
      fake.restore();
    }
  });
}

test('rapid rate changes while audio resume is pending keep the last rate playing once', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1));
    fake.decoding[0].resolve(buffer(90));
    await loading;
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    fake.context.currentTime = 2;
    transport.setRate(0.5);
    transport.setRate(2);
    near(transport.seconds, 2);
    // Resolve all pending starts in reverse order to expose a stale resume winning.
    for (const pending of fake.resumes.slice(1).reverse()) {
      pending.resolve();
      await Promise.resolve();
    }
    assert.equal(transport.playing, true);
    assert.equal(transport.rate, 2);
    near(fake.sources.at(-1)!.offset, 2);
    assert.equal(fake.sources.at(-1)!.playbackRate.value, 2);
    assert.equal(fake.sources.filter(source => !source.stopped).length, 1);
    assert.equal(fake.timers.size, 1);
    fake.context.currentTime = 2.5;
    near(transport.seconds, 3);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('an explicit pause cancels pending rate changes and further rate selection stays paused', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1));
    fake.decoding[0].resolve(buffer(90));
    await loading;
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    fake.context.currentTime = 2;
    transport.setRate(0.25);
    transport.setRate(2);
    transport.pause();
    for (const pending of fake.resumes.slice(1).reverse()) {
      pending.resolve();
      await Promise.resolve();
    }
    const resumeCount = fake.resumes.length;
    transport.setRate(0.75);
    fake.context.currentTime = 4;
    assert.equal(transport.playing, false);
    near(transport.seconds, 2);
    assert.equal(fake.resumes.length, resumeCount);
    assert.equal(
      fake.sources.every(source => source.stopped),
      true,
    );
    assert.equal(fake.timers.size, 0);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('starting past a loop end redirects once without leaving an orphan scheduler', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.load(new ArrayBuffer(1));
    fake.decoding[0].resolve(buffer(90));
    await loading;
    transport.loop = { start: 5, end: 6 };
    transport.seek(8);
    const playing = transport.play();
    fake.resumes[0].resolve();
    await playing;
    assert.equal(fake.timers.size, 0);
    fake.resumes[1].resolve();
    await Promise.resolve();
    near(transport.seconds, 5);
    assert.equal(fake.timers.size, 1);
    assert.equal(fake.sources.filter(source => !source.stopped).length, 1);
    transport.pause();
    assert.equal(fake.timers.size, 0);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

// HOLD and SLIDE starts long enough to be sustained; their own judgement sounds come later.
const long = (type: Parameters<typeof createNote>[0], tick: number, lane: number, width = 1) => ({
  ...createNote(type, tick, lane, width),
  ...(type === 'HOLD' || type === 'SLIDE' ? { duration: 3840 } : {}),
});
for (const [type, soundId] of [
  ['HOLD', 'holdStart'],
  ['SLIDE', 'slideStart'],
  ['AIR_CRUSH', 'airCrush'],
] as const) {
  test(`${type} simultaneous hits play one complete imported cue at its original gain`, async () => {
    const fake = fakeAudio(),
      transport = new Transport();
    try {
      const loading = transport.setGameSounds(
        {
          source: 'fixture',
          warnings: [],
          sounds: {
            [soundId]: {
              cueName: soundId,
              layers: [
                { path: 'hit.wav', gain: 1, playbackRate: 1 },
                { path: 'hit.wav', gain: 0.8, playbackRate: 1.1 },
              ],
            },
          },
        },
        async () => new Uint8Array(1),
      );
      await Promise.resolve();
      fake.decoding[0].resolve(buffer(0.3));
      await loading;
      const chart = createProject().chart;
      chart.notes = Array.from({ length: 16 }, (_, lane) => long(type, 0, lane));
      transport.setChart(chart);
      assert.equal(
        getChartHits(chart).filter(hit => hit.time === 0).length,
        16,
        'audio coalescing must preserve the chart hits',
      );
      const playing = transport.play();
      fake.resumes[0].resolve();
      await playing;
      assert.equal(fake.sources.length, 2);
      const [first, second] = fake.gains.slice(2).map(node => node.gain.value);
      near(first, 1);
      near(second / first, 0.8);
      assert.equal(fake.sources[1].playbackRate.value, 1.1);
    } finally {
      transport.destroy();
      fake.restore();
    }
  });
  test(`${type} simultaneous fallback hits play once at the original gain`, async () => {
    const fake = fakeAudio(),
      transport = new Transport();
    try {
      const chart = createProject().chart;
      chart.notes = Array.from({ length: 16 }, (_, lane) => long(type, 0, lane));
      transport.setChart(chart);
      assert.equal(
        getChartHits(chart).filter(hit => hit.time === 0).length,
        16,
        'audio coalescing must preserve the chart hits',
      );
      const playing = transport.play();
      fake.resumes[0].resolve();
      await playing;
      assert.equal(fake.oscillators.length, 1);
      const peak = fake.gains[2].ramps[0],
        original = type === 'AIR_CRUSH' ? 0.28 : 0.65;
      near(peak, original);
    } finally {
      transport.destroy();
      fake.restore();
    }
  });
}

async function playNow(transport: Transport, fake: ReturnType<typeof fakeAudio>): Promise<void> {
  const playing = transport.play();
  fake.resumes.at(-1)!.resolve();
  await playing;
}

test('same-time sound identities merge across AIR directions but distinct cues and nearby ticks remain audible', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const chart = createProject().chart;
    const air = (direction: string) => {
      const note = createNote('AIR', 0);
      note.attributes.direction = direction;
      return note;
    };
    chart.notes = [
      createNote('TAP', 0),
      air('IR'),
      createNote('TAP', 0),
      air('UL'),
      air('DW'),
      air('DR'),
      createNote('FLICK', 0),
      createNote('TAP', 1),
      createNote('TAP', 1),
    ];
    transport.setChart(chart);
    await playNow(transport, fake);
    assert.equal(
      fake.oscillators.length,
      5,
      'tap, air-up, air-down, flick at tick zero, then a separate tap at tick one',
    );
    for (const timer of fake.timers.values()) timer.callback();
    assert.equal(fake.oscillators.length, 5, 'the next scheduling pass cannot repeat a group');
    transport.pause();
    transport.seek(0);
    await playNow(transport, fake);
    assert.equal(fake.oscillators.length, 10, 'seeking back restores all sound groups');
  } finally {
    transport.destroy();
    fake.restore();
  }
});

for (const variant of ['same', 'gain', 'rate', 'path'] as const)
  test(`simultaneous HOLD/SLIDE samples merge only with identical layers: ${variant}`, async () => {
    const fake = fakeAudio(),
      transport = new Transport();
    try {
      const layers = [
        { path: 'a.wav', gain: 1, playbackRate: 1 },
        { path: 'b.wav', gain: 0.8, playbackRate: 1 },
      ];
      const other = layers.map(layer => ({ ...layer })).reverse();
      if (variant === 'gain') other[0].gain = 0.4;
      if (variant === 'rate') other[0].playbackRate = 1.2;
      if (variant === 'path') other[0].path = 'c.wav';
      const loading = transport.setGameSounds(
        {
          source: 'fixture',
          warnings: [],
          sounds: {
            holdStart: { cueName: 'hold', layers },
            slideStart: { cueName: 'slide', layers: other },
          },
        },
        async () => new Uint8Array(1),
      );
      await Promise.resolve();
      for (const decoding of fake.decoding) decoding.resolve(buffer(0.3));
      await loading;
      const chart = createProject().chart;
      chart.notes = [long('HOLD', 0, 0), long('SLIDE', 0, 2), long('HOLD', 0, 4), long('SLIDE', 1, 6)];
      transport.setChart(chart);
      await playNow(transport, fake);
      assert.equal(fake.sources.length, variant === 'same' ? 4 : 6);
      assert.equal(fake.sources.filter(source => source.when === 0).length, variant === 'same' ? 2 : 4);
      assert.equal(fake.sources.filter(source => source.when === tickToSeconds(chart, 1)).length, 2);
    } finally {
      transport.destroy();
      fake.restore();
    }
  });

test('sound groups play again across a loop and rate change', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const chart = createProject().chart;
    chart.notes = [createNote('TAP', 0), createNote('TAP', 0)];
    transport.setChart(chart);
    transport.loop = { start: 0, end: 0.25 };
    await playNow(transport, fake);
    assert.equal(fake.oscillators.length, 1);
    fake.context.currentTime = 0.25;
    for (const timer of fake.timers.values()) timer.callback();
    fake.resumes.at(-1)!.resolve();
    await Promise.resolve();
    assert.equal(fake.oscillators.length, 2);
    transport.setRate(0.5);
    fake.resumes.at(-1)!.resolve();
    await Promise.resolve();
    assert.equal(fake.oscillators.length, 3);
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('metronome clicks once per beat from the play position and stays silent when disabled', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    transport.setChart(createProject().chart);
    const silent = transport.play();
    fake.resumes[0].resolve();
    await silent;
    assert.equal(fake.oscillators.length, 0);
    transport.pause();
    transport.metronome = true;
    transport.seek(0);
    const playing = transport.play();
    fake.resumes[1].resolve();
    await playing;
    // 120 BPM: beats at 0 s and 0.5 s. Only the first is within the 100 ms scheduling horizon.
    assert.equal(fake.oscillators.length, 1);
    const tick = [...fake.timers.values()][0].callback;
    fake.context.currentTime = 0.2;
    tick();
    assert.equal(fake.oscillators.length, 1);
    fake.context.currentTime = 0.45;
    tick();
    tick();
    assert.equal(fake.oscillators.length, 2);
    transport.seek(0.75);
    await Promise.resolve();
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('a sustained start loops until its note ends, and playback started inside the note picks the loop up', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const release = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.5 };
    const loading = transport.setGameSounds(
      {
        source: 'fixture',
        warnings: [],
        sounds: {
          holdStart: {
            cueName: 'start',
            layers: [
              {
                path: 'loop.wav',
                gain: 0.3,
                playbackRate: 1,
                envelope: release,
                loop: { start: 2, end: 2.9 },
                group: 1,
              },
              { path: 'tap.wav', gain: 0.5, playbackRate: 1, group: 2 },
            ],
            limits: [
              { key: 'cue:loop', max: 4, group: 1 },
              { key: 'cue:tap', max: 1, group: 2 },
            ],
          },
        },
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    for (const call of fake.decoding) call.resolve(buffer(3));
    await loading;
    const chart = createProject().chart;
    chart.notes = [
      { ...createNote('HOLD', 0, 0, 2), duration: 960 },
      { ...createNote('HOLD', 0, 4, 2), duration: 1920 },
    ];
    transport.setChart(chart);
    await playNow(transport, fake);
    const [first, second] = [960, 1920].map(tick => Math.round(tickToSeconds(chart, tick) * 1e6) / 1e6);
    // Two starts at one instant share the TAP sample; each keeps a loop that releases at its own end.
    const sources = fake.sources as unknown as { loop?: boolean; loopStart?: number; loopEnd?: number }[];
    assert.deepEqual(
      sources.map(source => [source.loop === true, source.loopStart, source.loopEnd]),
      [
        [true, 2, 2.9],
        [false, undefined, undefined],
        [true, 2, 2.9],
      ],
    );
    const [loop, , other] = fake.gains.slice(-3);
    assert.deepEqual(loop.events, [
      ['set', 0.3, first],
      ['ramp', 0, first + 0.5],
    ]);
    assert.deepEqual(other.events, [
      ['set', 0.3, second],
      ['ramp', 0, second + 0.5],
    ]);
    // The TAP sample's limit of one voice stops neither loop.
    assert.deepEqual(
      fake.sources.map(source => source.stopped),
      [true, false, true],
    );
    transport.pause();
    transport.seek((first + second) / 2);
    const before = fake.sources.length;
    await playNow(transport, fake);
    assert.deepEqual(
      sources.slice(before).map(source => source.loop === true),
      [true],
      'only the loop of the note still held resumes',
    );
    assert.deepEqual(
      fake.gains.at(-1)!.events.at(-1),
      ['ramp', 0, (second - first) / 2 + 0.5],
      'the resumed loop still ends with its note',
    );
    transport.pause();
  } finally {
    transport.destroy();
    fake.restore();
  }
});

test('loops started together are set apart, filtered and swelled in the way their cue says', async () => {
  const fake = fakeAudio(),
    transport = new Transport(),
    random = Math.random;
  try {
    Math.random = () => 0.5;
    const loading = transport.setGameSounds(
      {
        source: 'fixture',
        warnings: [],
        sounds: {
          holdStart: {
            cueName: 'start',
            layers: [
              {
                path: 'loop.wav',
                gain: 0.3,
                playbackRate: 1,
                loop: { start: 2, end: 2.9 },
                group: 1,
                bandpass: { low: 24, high: 8000 },
                swell: [
                  { time: 0, level: 0.1 },
                  { time: 0.1, level: 1 },
                ],
              },
            ],
            combos: [
              {
                key: 'cue:loop',
                window: 0.03,
                loopback: 0,
                steps: [
                  { delay: 0, spread: 0 },
                  { delay: 0.01, spread: 0.001 },
                  { delay: 0.02, spread: 0.001 },
                ],
                group: 1,
              },
            ],
          },
        },
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    for (const call of fake.decoding) call.resolve(buffer(3));
    await loading;
    const chart = createProject().chart;
    // Four HOLDs at one instant and a fifth well after the combo time.
    chart.notes = [
      ...[0, 2, 4, 6].map(lane => ({ ...createNote('HOLD', 0, lane, 2), duration: 1920 })),
      { ...createNote('HOLD', 480, 8, 2), duration: 1920 },
    ];
    transport.setChart(chart);
    await playNow(transport, fake);
    fake.context.currentTime = tickToSeconds(chart, 480) - 0.05;
    for (const timer of fake.timers.values()) timer.callback();
    const later = tickToSeconds(chart, 480);
    // Steps 0, 1, 2, then back to the loop-back step; the late start begins again at the first.
    assert.deepEqual(
      fake.sources.map(source => Math.round(source.when! * 1e6) / 1e6),
      [0, 0.01, 0.02, 0, Math.round(later * 1e6) / 1e6],
    );
    assert.deepEqual(
      fake.filters.map(filter => [filter.type, filter.feedforward]),
      Array(5).fill(['iir', bandpassCoefficients(24, 8000, 48000)!.feedforward]),
    );
    // Each loop has a gain of its own for the swell, which starts with the delayed layer.
    const swells = fake.gains.filter(node => node.events[0]?.[1] === 0.1);
    assert.deepEqual(
      swells.slice(0, 2).map(node => node.events),
      [
        [
          ['set', 0.1, 0],
          ['ramp', 1, 0.1],
        ],
        [
          ['set', 0.1, 0.01],
          ['ramp', 1, 0.11],
        ],
      ],
    );
    transport.pause();
  } finally {
    Math.random = random;
    transport.destroy();
    fake.restore();
  }
});

test('curve shapes follow the runtime and the band-pass section has its corners 3 dB down', () => {
  const at = (type: number, strength: number, x: number) => Math.round(curveShape({ type, strength }, x) * 1e6) / 1e6;
  // Strength 0 is linear whatever the type; every shape runs from 0 to 1.
  for (const type of [1, 2, 3, 4]) {
    assert.equal(at(type, 0, 0.3), 0.3);
    assert.deepEqual([at(type, 1, 0), at(type, 1, 1), at(type, 2, 0), at(type, 2, 1)], [0, 1, 0, 1]);
  }
  assert.deepEqual([at(1, 1, 0.5), at(1, 2, 0.5), at(1, 0.5, 0.5)], [0.25, 0.0625, 0.375]);
  assert.deepEqual([at(2, 1, 0.5), at(2, 2, 0.5)], [0.75, 0.9375]);
  assert.deepEqual([at(3, 1, 0.25), at(3, 1, 0.5), at(3, 2, 0.25), at(3, 2, 0.75)], [0.15625, 0.5, 0.0625, 0.9375]);
  assert.deepEqual(
    [at(4, 1, 0.25), at(4, 1, 0.5), at(4, 1, 0.75), at(4, 2, 0.25), at(4, 2, 0.5)],
    [0.375, 0.5, 0.625, 0.46875, 0.5],
  );
  assert.equal(curveShape(undefined, 0.3), 0.3);
  // Magnitude of the section at a frequency.
  const gain = (low: number, high: number, frequency: number) => {
    const { feedforward: b, feedback: a } = bandpassCoefficients(low, high, 48000)!,
      w = (2 * Math.PI * frequency) / 48000;
    const size = (c: number[]) =>
      Math.hypot(c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w), c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
    return size(b) / size(a);
  };
  assert.ok(Math.abs(gain(24, 7947, 7947) - Math.SQRT1_2) < 0.005);
  assert.ok(Math.abs(gain(24, 7947, 24) - Math.SQRT1_2) < 0.005);
  assert.ok(gain(24, 7947, 1000) > 0.99);
  // One pole either side: an octave above the corner it is down by about 7 dB, not 12.
  assert.ok(gain(24, 7947, 15894) > 0.3 && gain(24, 7947, 15894) < 0.5);
  assert.equal(bandpassCoefficients(5000, 5000, 48000), null);
});

test('a curved release and a curved swell are scheduled along their shapes', async () => {
  const fake = fakeAudio(),
    transport = new Transport();
  try {
    const loading = transport.setGameSounds(
      {
        source: 'fixture',
        warnings: [],
        sounds: {
          tap: {
            cueName: 'tap',
            layers: [
              {
                path: 'a.wav',
                gain: 0.4,
                playbackRate: 1,
                stopAfter: 0.05,
                envelope: {
                  attack: 0,
                  hold: 0,
                  decay: 0,
                  sustain: 1,
                  release: 0.5,
                  releaseCurve: { type: 2, strength: 1 },
                },
                swell: [
                  { time: 0, level: 0.05 },
                  { time: 0.1, level: 1, curve: { type: 1, strength: 1 } },
                ],
                peaking: { frequency: 309, q: 0.79, gain: 0.23 },
              },
            ],
          },
        },
      },
      async () => new Uint8Array(1),
    );
    await Promise.resolve();
    for (const call of fake.decoding) call.resolve(buffer(3));
    await loading;
    const chart = createProject().chart;
    chart.notes = [createNote('TAP', 0, 0, 2)];
    transport.setChart(chart);
    await playNow(transport, fake);
    const [swell, level] = fake.gains
      .slice(-2)
      .sort((a, b) => b.events.length - a.events.length && (a.events[0][1] === 0.05 ? -1 : 1));
    // Type 2 falls fast first: a quarter of the way through the release three sixteenths short of half remain.
    assert.deepEqual(level.events.slice(0, 2), [
      ['set', 0.4, 0.05],
      ['ramp', Math.round(0.4 * (1 - curveShape({ type: 2, strength: 1 }, 1 / 16)) * 1e6) / 1e6, 0.05 + 0.5 / 16],
    ]);
    assert.deepEqual(level.events.at(-1), ['ramp', 0, 0.55]);
    assert.equal(level.events.length, 17);
    // Type 1 rises slowly first.
    assert.deepEqual(swell.events[0], ['set', 0.05, 0]);
    assert.deepEqual(swell.events.at(-1), ['ramp', 1, 0.1]);
    assert.ok(swell.events.some(event => event[2] === 0.05 && Math.abs(event[1] - (0.05 + 0.95 * 0.25)) < 1e-6));
    assert.deepEqual(
      fake.filters.map(filter => [
        filter.type,
        filter.frequency.value,
        filter.Q.value,
        Math.round(filter.gain.value * 100) / 100,
      ]),
      [['peaking', 309, 0.79, -12.77]],
    );
    transport.pause();
  } finally {
    transport.destroy();
    fake.restore();
  }
});
