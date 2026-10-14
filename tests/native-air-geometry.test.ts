import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getNativeAirCrushGeometry,
  getNativeAirCrushLineV,
  getNativeAirCrushMarker,
  getNativeAirHoldMaterialColors,
  getNativeAirHoldSuffix,
  getNativeAirSlideGeometry,
  getNativeAirSlideTextures,
} from '../src/renderer/native-air-geometry';

test('AIR HOLD and AIR SLIDE have distinct native DEF color choices', () => {
  assert.equal(getNativeAirHoldSuffix('DEF'), '');
  assert.equal(getNativeAirHoldSuffix('GRN'), '');
  assert.equal(getNativeAirHoldSuffix('PNK'), '_P');
  assert.deepEqual(getNativeAirSlideTextures('DEF'), {
    joint: 'AirHoldJoint_S',
    ground: 'Field',
    line: 'AirHoldLine_S',
  });
  assert.equal(getNativeAirSlideTextures('GRN').joint, 'AirHoldJoint');
  assert.equal(getNativeAirSlideTextures('PNK').line, 'AirHoldLine_P');
});

test('AIR HOLD roof applies native runtime alpha separately from the line top', () => {
  assert.deepEqual(getNativeAirHoldMaterialColors(), { roof: [1, 1, 1, 27 / 255], lineTop: [1, 1, 1, 1] });
  assert.deepEqual(getNativeAirHoldMaterialColors(1), { roof: [1, 1, 1, 80 / 255], lineTop: [1, 1, 1, 1] });
  assert.deepEqual(getNativeAirHoldMaterialColors(2), {
    roof: [0.5, 0.5, 0.5, 3 / 255],
    lineTop: [1, 1, 1, 128 / 255],
  });
});

test('AIR SLIDE uses source height, shrunken joint, original UV and separate ground layer', () => {
  const [joint, ground, line] = getNativeAirSlideGeometry(
    { centerLane: 8, width: 4, y: 15.574, z: 0 },
    { centerLane: 10, width: 2, y: 31.148, z: -100 },
  );
  assert.deepEqual(
    joint.vertices.map(v => v.position),
    [
      [-6, 15.574, 0],
      [6, 15.574, 0],
      [5, 31.148, -100],
      [11, 31.148, -100],
    ],
  );
  assert.ok(Math.abs(joint.vertices[0].uv[0] - -2.1) < 1e-6);
  assert.equal(joint.vertices[0].uv[1], 1);
  assert.equal(joint.vertices[2].uv[1], 0);
  assert.equal(joint.vertices[0].color[3], 27 / 255);
  assert.ok(ground.vertices.every(v => v.position[1] === 0 && v.color[3] === 64 / 255));
  assert.ok(Math.abs(ground.vertices[0].position[0] + 5.2) < 1e-6);
  assert.ok(Math.abs(line.vertices[0].position[0] + 1.96) < 1e-6);
});

test('head riser is vertical and clipping subdivisions retain supplied UV phase', () => {
  const layers = getNativeAirSlideGeometry(
    { centerLane: 4, width: 2, y: 15.574, z: -30 },
    { centerLane: 6, width: 4, y: 15.574, z: -60 },
    { headRiser: true, vStart: 0.75, vEnd: 0.25, status: 1, narrowLine: true },
  );
  assert.equal(layers.length, 5);
  assert.deepEqual(
    layers[0].vertices.map(v => v.position[1]),
    [0, 0, 15.574, 15.574],
  );
  assert.ok(layers[0].vertices.every(v => v.position[2] === -30));
  assert.equal(layers[2].vertices[0].uv[1], 0.75);
  assert.equal(layers[2].vertices[2].uv[1], 0.25);
  assert.equal(layers[2].vertices[0].color[3], 80 / 255);
  assert.ok(Math.abs(layers[4].vertices[1].position[0] - layers[4].vertices[0].position[0] - 1.96) < 1e-6);
});

test('reverse scrolling reverses winding, invalid data rejects, CRUSH first marker is Top', () => {
  const a = { centerLane: 8, width: 4, y: 15.574, z: 0 },
    b = { ...a, z: 100 };
  assert.notDeepEqual(getNativeAirSlideGeometry(a, b)[0].indices, getNativeAirSlideGeometry(b, a)[0].indices);
  assert.deepEqual(getNativeAirSlideGeometry(a, { ...b, z: NaN }), []);
  assert.equal(getNativeAirCrushMarker(4, true), 'NotesAirLadderTop_04');
  assert.equal(getNativeAirCrushMarker(4, false), 'NotesAirLadder_04');
  assert.equal(getNativeAirCrushMarker(32, false), undefined);
});

test('CRUSH uses only its original center line and NON disables its connections', () => {
  const a = { centerLane: 8, width: 4, y: 15.574, z: 0 },
    b = { ...a, z: -100 };
  const layers = getNativeAirCrushGeometry(a, b);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].texture, 'AirLadderLine');
  assert.equal(layers[0].part, 'line');
  assert.ok(layers[0].vertices.every(v => v.uv[1] === 0.15619999170303345));
  assert.deepEqual(getNativeAirCrushGeometry(a, b, { color: 'NON' }), []);
  const vertical = getNativeAirCrushGeometry(a, b, { lineOrientation: 1 })[0];
  assert.equal(vertical.vertices[0].position[0], 0);
  assert.ok(vertical.vertices[0].position[1] < a.y && vertical.vertices[1].position[1] > a.y);
  const deep = getNativeAirCrushGeometry(a, b, { lineOrientation: 2 })[0];
  assert.ok(Math.abs(deep.vertices[0].position[2] + 5.88) < 1e-6);
});

test('CRUSH colors select constant native atlas rows, including less common color tokens', () => {
  const a = { centerLane: 8, width: 4, y: 15.574, z: 0 },
    b = { ...a, z: -100 };
  for (const [color, value] of [
    ['RED', 0.9688000082969666],
    ['LIM', 0.7811999917030334],
    ['AQA', 0.6561999917030334],
    ['DGR', 0.5311999917030334],
    ['PNK', 0.28119999170303345],
  ] as const) {
    assert.equal(getNativeAirCrushLineV(color), value);
    const [line] = getNativeAirCrushGeometry(a, b, { color, vStart: 0.75, vEnd: 0.25 });
    assert.ok(line.vertices.every(v => v.uv[1] === value));
  }
  assert.equal(getNativeAirCrushLineV('custom'), getNativeAirCrushLineV('DEF'));
  assert.equal(getNativeAirCrushLineV('NON'), undefined);
});

test('Trace triangles and UVs match the isolated original x86 geometry branch', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-crush-trace.json', import.meta.url), 'utf8')) as {
    cases: {
      name: string;
      start: [number, number, number];
      end: [number, number, number];
      cap: boolean;
      triangles: { position: number[]; uv: number[]; color: number[] }[];
    }[];
  };
  for (const sample of fixture.cases) {
    const point = ([x, y, z]: number[]) => ({ centerLane: x / 4 + 8, width: 4, y, z });
    const [line] = getNativeAirCrushGeometry(point(sample.start), point(sample.end), {
      lineOrientation: 3,
      traceHeadCap: sample.cap,
      narrowLine: true,
    });
    assert.equal(line.vertices.length, 8, sample.name);
    assert.equal(line.indices.length, sample.triangles.length, sample.name);
    line.indices.forEach((index, i) => {
      const actual = line.vertices[index],
        expected = sample.triangles[i];
      for (const field of ['position', 'uv', 'color'] as const)
        actual[field].forEach((value, j) =>
          assert.ok(Math.abs(value - expected[field][j]) < 2e-6, `${sample.name} triangle vertex ${i} ${field}[${j}]`),
        );
    });
  }
});
