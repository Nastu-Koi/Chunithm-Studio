import test from 'node:test';
import assert from 'node:assert/strict';
import { ChartPlayer } from '../src/renderer/player';
import { parseC2S } from '../src/core/c2s';
import { tickToSeconds } from '../src/core/timing';

function render(type: 'AHD' | 'ASD', tick: number) {
  const records = type === 'AHD'
    ? 'AHD 0 0 4 4 TAP 96 DEF\nAHD 0 96 4 4 AHD 96 DEF'
    : 'ASD 0 0 4 4 TAP 5 96 4 4 5 DEF\nASD 0 96 4 4 ASD 5 96 4 4 5 DEF';
  const chart = parseC2S(`VERSION 1.15.00 1.15.00\nRESOLUTION 384\nBPM_DEF 120\nTAP 0 0 4 4\n${records}\n`);
  const models: string[] = [], risers: number[] = [];
  const player: any = Object.create(ChartPlayer.prototype);
  const context = new Proxy({ measureText: () => ({ width: 0 }), createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
  Object.assign(player, { canvas: { dataset: {} }, context, crushRoots: new Set(), nativeDiagnostics: new Set(),
    sceneMaterials: new Map(), modelSprites: new Map(), bodySprites: new Map(), hudSprites: new Map(),
    hostWidth: 1920, hostHeight: 1080, width: 1920, height: 1080, dpr: 1, speed: 6,
    title: '', artist: '', difficulty: 'MASTER', level: '', weTag: '', stars: 0, frameNumber: 0,
    nativeModel: (name: string) => { models.push(name); return true; }, nativeHead: () => true,
    ribbon: (note: any, segment: any, _points: any, _color: any, _extent: any, _tick: number, headRiser: boolean) => {
      if (note.type === 'AIR_SLIDE' && headRiser && segment.startTick === Math.max(tick, note.tick)) risers.push(note.tick);
    },
  });
  player.setChart(chart); player.render(tickToSeconds(chart, tick));
  return { models, risers };
}
for (const type of ['AHD', 'ASD'] as const) {
  test(`${type} shows a lift only at the original head, never while inside AIR or at continuation nodes`, () => {
    const initial = render(type, 0);
    assert.equal(type === 'AHD' ? initial.models.filter(name => name === 'NotesAirHold_Line').length : initial.risers.length, 1);
    for (const tick of [48, 96, 144]) {
      const frame = render(type, tick);
      assert.equal(type === 'AHD' ? frame.models.filter(name => name === 'NotesAirHold_Line').length : frame.risers.length, 0,
        `tick ${tick} must not acquire a new lift at the clipped start`);
    }
  });
}
