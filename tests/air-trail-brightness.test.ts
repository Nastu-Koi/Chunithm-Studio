import test from 'node:test';
import assert from 'node:assert/strict';
import { ChartPlayer } from '../src/renderer/player';
import { parseC2S } from '../src/core/c2s';
import { tickToSeconds } from '../src/core/timing';

const ORDINARY = 27 / 255;

/** Renders one frame and returns the alpha of every AIR SLIDE joint vertex and every AIR HOLD roof tint. */
function render(type: 'AHD' | 'ASD', tick: number): number[] {
  const records =
    type === 'AHD'
      ? 'AHD 0 0 4 4 TAP 96 DEF\nAHD 0 96 4 4 AHD 96 DEF'
      : 'ASD 0 0 4 4 TAP 5 96 4 4 5 DEF\nASD 0 96 4 4 ASD 5 96 4 4 5 DEF';
  const chart = parseC2S(`VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 120\nTAP 0 0 4 4\n${records}\n`);
  const alphas: number[] = [],
    image = {};
  const player: any = Object.create(ChartPlayer.prototype);
  const context = new Proxy(
    { measureText: () => ({ width: 0 }), createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
  );
  const textureLayer = new Proxy(
    {
      active: true,
      available: true,
      mesh: (vertices: { color?: number[] }[], _indices: number[], paint?: { image?: unknown }) => {
        if (paint?.image === image) alphas.push(...vertices.map(vertex => vertex.color![3]));
      },
    },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
  );
  Object.assign(player, {
    canvas: { dataset: {} },
    context,
    textureLayer,
    crushRoots: new Set(),
    nativeDiagnostics: new Set(),
    sceneMaterials: new Map(),
    modelSprites: new Map(),
    bodySprites: new Map([['AirHoldJoint_S', { image }]]),
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
    nativeHead: () => true,
    airNodeModel: () => true,
    nativeModel: (name: string, ..._rest: unknown[]) => {
      const tint = _rest[_rest.length - 1];
      if (name.startsWith('NotesAirHold_JointRoof') && Array.isArray(tint)) alphas.push(tint[3]);
      return true;
    },
  });
  player.setChart(chart);
  player.render(tickToSeconds(chart, tick));
  return alphas;
}

for (const type of ['AHD', 'ASD'] as const) {
  test(`${type} trail keeps the ordinary brightness before and after the judgement line`, () => {
    for (const tick of [0, 48, 96, 144]) {
      const alphas = render(type, tick);
      assert.ok(alphas.length > 0, `tick ${tick} must draw the trail`);
      assert.deepEqual([...new Set(alphas)], [ORDINARY], `tick ${tick}`);
    }
  });
}
