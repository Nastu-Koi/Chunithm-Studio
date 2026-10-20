import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, type Note } from '../src/core/model';
import { getNativeBodyDrawOrder, getNativeDrawOrder } from '../src/renderer/native-notes';
import { ChartPlayer, sortPlayerPrimitives } from '../src/renderer/player';
import { editorBodies, editorMarks } from '../src/renderer/editor-paint';
import { hitsAt } from '../src/renderer/editor-hit';
import { EditorView } from '../src/renderer/editor-view';
import { chartImageBodies, chartImageMarks } from '../src/renderer/chart-image';

const ex = (note: Note): Note => ({ ...note, attributes: { ...note.attributes, ex: true } });
/** A TAP and an EX SLIDE (C2S `SXD`) whose head lies exactly on it, as in many original charts. */
const tap = () => createNote('TAP', 96, 4, 4);
const sxd = () => ex(createNote('SLIDE', 96, 4, 4));
/** A wider SLIDE ending under both, so it is not continued by the EX SLIDE. */
const endingUnder = () => createNote('SLIDE', 0, 3, 6);

test('note models overlap in the game layer order: EX heads over TAP over HOLD / SLIDE heads over their ends', () => {
  const order = (note: Note, endpoint = false) => getNativeDrawOrder(note, note.width, endpoint);
  // An EX HOLD / EX SLIDE head is the ExTAP model, so it shares the ExTAP layer.
  assert.equal(order(sxd()), order(createNote('EXTAP', 96, 4, 4)));
  assert.equal(order(ex(createNote('HOLD', 96, 4, 4))), order(createNote('EXTAP', 96, 4, 4)));
  const rising = [
    order(createNote('HOLD', 0, 4, 4), true),
    order(createNote('SLIDE', 0, 4, 4), true),
    order(createNote('HOLD', 0, 4, 4)),
    order(createNote('SLIDE', 0, 4, 4)),
    order(tap()),
    order(createNote('FLICK', 0, 4, 4)),
    order(sxd()),
    order(createNote('DAMAGE', 0, 4, 4)),
    order(createNote('AIR', 0, 4, 4)),
    order(createNote('AIR_HOLD', 0, 4, 4), true),
  ];
  assert.deepEqual(
    rising,
    [...rising].sort((a, b) => a - b),
  );
  assert.equal(new Set(rising).size, rising.length);
  // Inside one layer the narrower note comes later; a layer always wins over width.
  assert.ok(order(createNote('TAP', 0, 0, 2)) > order(createNote('TAP', 0, 0, 8)));
  assert.ok(order(createNote('EXTAP', 0, 0, 16)) > order(createNote('TAP', 0, 0, 1)));
});

test('player: a TAP and the EX SLIDE head on it overlap as in the game, whatever the record order', () => {
  const drawn: string[] = [];
  const player = {
    nativeHead: (note: Note) => {
      drawn.push(`${note.type}${note.attributes.ex ? ' EX' : ''}`);
      return true;
    },
  };
  const head = (ChartPlayer.prototype as any).headPrimitive,
    tail = (ChartPlayer.prototype as any).tailPrimitive;
  const point = (note: Note, position: 'head' | 'end') => ({
    noteId: note.id,
    position,
    tick: note.tick,
    lane: note.lane,
    width: note.width,
    type: note.type,
    sound: true,
  });
  // The SLIDE ending under the TAP is drawn below it as well: its end node is a lower layer.
  const ending = endingUnder();
  for (const reversed of [false, true]) {
    const notes = [tap(), sxd()];
    if (reversed) notes.reverse();
    const primitives: any[] = [];
    head.call(player, ending, point(ending, 'head'), 3, 0, '#fff', primitives);
    tail.call(player, ending, point(ending, 'end'), 2, 0, '#fff', primitives);
    for (const note of notes) head.call(player, note, point(note, 'head'), 2, 0, '#fff', primitives);
    drawn.length = 0;
    for (const primitive of sortPlayerPrimitives(primitives)) primitive.draw();
    assert.deepEqual(drawn, ['SLIDE', 'SLIDE', 'TAP', 'SLIDE EX'], reversed ? 'EX SLIDE first' : 'TAP first');
  }
});

test('editor: nodes and heads are drawn and picked in the game layer order, whatever the record order', () => {
  const chart = createChart();
  const ending = endingUnder();
  const view = new EditorView(1);
  view.canvasWidth = 800;
  view.canvasHeight = 600;
  for (const reversed of [false, true]) {
    const notes = [tap(), sxd()];
    if (reversed) notes.reverse();
    chart.notes = [ending, ...notes];
    const marks = editorMarks(chart.notes).map(
      ({ note, part }) => `${note.type}${note.attributes.ex ? ' EX' : ''} ${part}`,
    );
    assert.deepEqual(
      marks.filter(mark => !mark.endsWith('SLIDE head')),
      ['SLIDE node', 'SLIDE EX node', 'TAP head', 'SLIDE EX head'],
    );
    // A click on the shared spot takes what is drawn on top first.
    const at = { x: view.x(6), y: view.y(96), tick: 96, lane: 6, laneAt: 6 };
    const stack = hitsAt(view, chart, new Set(), at, false).map(hit => chart.notes.find(note => note.id === hit.id)!);
    assert.deepEqual(
      stack.map(note => `${note.type}${note.attributes.ex ? ' EX' : ''}`),
      ['SLIDE EX', 'TAP', 'SLIDE'],
    );
    // Bodies are drawn under every node and head, so a TAP lying on the EX SLIDE's body is picked before it.
    const inside = createNote('TAP', 144, 4, 4);
    chart.notes = reversed ? [inside, sxd()] : [sxd(), inside];
    const middle = { x: view.x(6), y: view.y(144), tick: 144, lane: 6, laneAt: 6 };
    assert.deepEqual(
      hitsAt(view, chart, new Set(), middle, false).map(hit => [
        chart.notes.find(note => note.id === hit.id)!.type,
        hit.kind,
      ]),
      [
        ['TAP', 'move'],
        ['SLIDE', 'move'],
      ],
    );
  }
});

test('chart image: heads, nodes, AIR and CRUSH rungs are drawn in the game layer order, whatever the record order', () => {
  const chart = createChart();
  const air = createNote('AIR', 96, 4, 4),
    crush = { ...createNote('AIR_CRUSH', 96, 4, 4), attributes: { interval: 48 } };
  for (const reversed of [false, true]) {
    const notes = [tap(), sxd()];
    if (reversed) notes.reverse();
    chart.notes = [crush, air, endingUnder(), ...notes];
    assert.deepEqual(
      chartImageMarks(chart).map(mark => `${mark.note.type}${mark.note.attributes.ex ? ' EX' : ''} ${mark.kind}`),
      [
        // End nodes, then the plain SLIDE head, the TAP and the EX SLIDE head over it.
        'SLIDE end',
        'SLIDE EX end',
        'SLIDE head',
        'TAP head',
        'SLIDE EX head',
        // The AIR family last: the arrow, then the CRUSH rungs (the first one the top model).
        'AIR air',
        'AIR_CRUSH rung',
        'AIR_CRUSH rung',
        'AIR_CRUSH rung',
      ],
    );
  }
  const rungs = chartImageMarks(chart).filter(mark => mark.kind === 'rung');
  assert.deepEqual(
    rungs.map(mark => [mark.tick, mark.endpoint]),
    [
      [96, true],
      [144, false],
      [192, false],
    ],
  );
});

test('long-note bodies keep the game layers: HOLD under SLIDE under every head, AIR strips over ground notes', () => {
  const body = (type: Note['type'], width = 4) => getNativeBodyDrawOrder(createNote(type, 0, 4, width));
  const head = (type: Note['type'], endpoint = false) => getNativeDrawOrder(createNote(type, 0, 4, 4), 4, endpoint);
  const rising = [
    body('HOLD'),
    body('SLIDE'),
    head('HOLD', true),
    head('TAP'),
    head('DAMAGE'),
    body('AIR_SLIDE'),
    body('AIR_CRUSH', 2),
    head('AIR'),
    body('AIR_HOLD'),
  ];
  assert.deepEqual(
    rising,
    [...rising].sort((a, b) => a - b),
  );
  assert.ok(body('SLIDE', 2) > body('SLIDE', 8), 'a narrower band is drawn later');
  assert.ok(body('SLIDE', 16) > body('HOLD', 1), 'a layer always wins over width');
});

test('player: on the same spot an AIR strip covers a ground head, and the shadows of AIR parts lie under an AIR', () => {
  const drawn: string[] = [];
  const player = {
    // An AIR SLIDE strip is drawn in two steps: its ground layer (28), then its joint and centre line (30).
    ribbon: (note: Note, ...rest: unknown[]) =>
      drawn.push(`${note.type} ${rest[6] ? [...(rest[6] as Set<string>)].join('+') : 'body'}`),
    nativeHead: (note: Note) => (drawn.push(note.type), true),
    airNodeModel: (_note: Note, family: string) => (drawn.push(family), true),
    point: () => ({ x: 0, y: 0, scale: 1 }),
  };
  const proto = ChartPlayer.prototype as any;
  const strip = { ...createNote('AIR_SLIDE', 96, 4, 4), duration: 0 },
    hold = createNote('AIR_HOLD', 0, 4, 4),
    air = createNote('AIR', 96, 4, 4),
    ground = tap();
  const primitives: any[] = [];
  proto.ribbonPrimitives.call(
    player,
    strip,
    [{ startTick: 96, endTick: 96, startDistance: 2, endDistance: 2 }],
    1,
    '#fff',
    0,
    false,
    primitives,
  );
  proto.headPrimitive.call(player, ground, { position: 'head', type: 'TAP' }, 2, 0, '#fff', primitives);
  proto.tailPrimitive.call(
    player,
    hold,
    { position: 'end', type: 'AIR_HOLD', lane: 4, width: 4 },
    2,
    1,
    '#fff',
    primitives,
  );
  proto.headPrimitive.call(player, air, { position: 'head', type: 'AIR' }, 2, 1, '#fff', primitives);
  for (const primitive of sortPlayerPrimitives(primitives)) primitive.draw();
  assert.deepEqual(drawn, ['TAP', 'AIR_SLIDE ground', 'Shadow', 'AIR_SLIDE joint+line', 'AIR', 'Ring']);
});

test('player: layers come first at any distance (an unconfirmed reading of the game), far before near inside a layer', () => {
  const drawn: string[] = [];
  const player: any = Object.create(ChartPlayer.prototype);
  const context = new Proxy(
    { measureText: () => ({ width: 0 }), createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
  );
  Object.assign(player, {
    canvas: { dataset: {} },
    context,
    crushRoots: new Set(),
    nativeDiagnostics: new Set(),
    sceneMaterials: new Map(),
    modelSprites: new Map(),
    bodySprites: new Map(),
    hudSprites: new Map(),
    hostWidth: 1920,
    hostHeight: 1080,
    width: 1920,
    height: 1080,
    dpr: 1,
    speed: 6,
    title: '',
    artist: '',
    difficulty: 'MASTER',
    level: '',
    weTag: '',
    stars: 0,
    frameNumber: 0,
    nativeModel: (name: string) => (drawn.push(name), true),
    nativeHead: (note: Note) => (drawn.push(`${note.type}@${note.tick}`), true),
    airNodeModel: () => true,
    ribbon: () => {},
  });
  const chart = createChart();
  // Near to far (all within the track at speed 6): a TAP, a TAP with an AIR, an ExTAP, a TAP with an AIR.
  chart.notes = [
    createNote('TAP', 48, 0, 4),
    createNote('TAP', 96, 8, 4),
    { ...createNote('AIR', 96, 8, 4), attributes: { direction: 'IR' } },
    createNote('EXTAP', 120, 0, 4),
    createNote('TAP', 144, 4, 4),
    { ...createNote('AIR', 144, 4, 4), attributes: { direction: 'IR' } },
  ];
  player.setChart(chart);
  player.render(0);
  assert.deepEqual(drawn, [
    // The judgement line (GoalLine, 13) is under every note.
    'GoalLine',
    // NormalNotes (23), far to near; then ExTapNotes (25) although it is further than two TAPs; then AirNotes (30).
    'TAP@144',
    'TAP@96',
    'TAP@48',
    'EXTAP@120',
    'AIR@144',
    'AIR@96',
  ]);
});

test('editor and chart image draw long-note bodies in the game layer order, whatever the record order', () => {
  const chart = createChart();
  const hold = createNote('HOLD', 0, 4, 4),
    slide = createNote('SLIDE', 0, 4, 4),
    airHold = createNote('AIR_HOLD', 0, 4, 4),
    airSlide = createNote('AIR_SLIDE', 0, 4, 4),
    crush = createNote('AIR_CRUSH', 0, 4, 4);
  chart.notes = [airHold, crush, slide, airSlide, hold, tap()];
  const expected = ['HOLD', 'SLIDE', 'AIR_CRUSH', 'AIR_SLIDE', 'AIR_HOLD'];
  assert.deepEqual(
    editorBodies(chart.notes).map(note => note.type),
    expected,
  );
  assert.deepEqual(
    chartImageBodies(chart).map(note => note.type),
    expected,
  );
});
