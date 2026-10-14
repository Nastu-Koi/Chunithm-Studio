import { GameMeshRenderer, type MeshPaint, type MeshVertex } from '../src/renderer/game-mesh-renderer';

/** Reads real WebGL pixels, including native layer alpha and simulated context loss. */
export async function testMeshGpu(): Promise<{ passed: string[]; renderer: string }> {
  const passed: string[] = [];
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
    passed.push(message);
  };
  const close = (actual: readonly number[], expected: readonly number[]) =>
    actual.every((n, i) => Math.abs(n - expected[i]) <= 2);
  const texture = (rgba: number[]) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), 1, 1), 0, 0);
    return canvas;
  };
  const layer = new GameMeshRenderer(32, 32),
    gl = layer.canvas.getContext('webgl2')!;
  const quad = (uv = [0.5, 0.5]): MeshVertex[] =>
    [
      [0, 0],
      [32, 0],
      [32, 32],
      [0, 32],
    ].map(([x, y]) => ({ x, y, uv }));
  const read = () => {
    const pixel = new Uint8Array(4);
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
  };
  const draw = (paint: MeshPaint, uv?: number[]) => {
    layer.begin();
    layer.mesh(quad(uv), [0, 1, 2, 0, 2, 3], paint);
    layer.finish();
    return read();
  };
  const overlaps = (reverse: boolean) => {
    layer.begin();
    for (const rgba of reverse
      ? [
          [0, 60, 80, 255],
          [80, 40, 0, 255],
        ]
      : [
          [80, 40, 0, 255],
          [0, 60, 80, 255],
        ])
      layer.mesh(quad(), [0, 1, 2, 0, 2, 3], {
        image: texture(rgba),
        blendSource: 4,
        blendDestination: 1,
        blendOperation: 0,
      });
    layer.finish();
    return read();
  };
  assert(close(overlaps(false), [80, 100, 80, 255]), 'opaque native ribbons accumulate RGB at overlap');
  assert(close(overlaps(true), [80, 100, 80, 255]), 'overlapping native ribbons are independent of submission order');
  const replace = { blendSource: 1, blendDestination: 0 };
  assert(layer.available, 'real WebGL 2 renderer starts available');
  const alphaBase = texture([200, 100, 50, 128]),
    transparentOverlay = texture([128, 255, 64, 1]);
  // A canvas cannot retain RGB at alpha=0; alpha=1 still distinguishes multiplication of the two alphas.
  const combined = draw({
    ...replace,
    image: alphaBase,
    image2: transparentOverlay,
    layer: { sourceFactor: 1, destinationFactor: 1, operation: 2 },
    alphaCutoff: 0.1,
  });
  assert(combined[3] >= 126 && combined[3] <= 130, 'MUL_RGB keeps the base alpha instead of multiplying overlay alpha');
  // Use an opaque overlay for an exact RGB check unaffected by Canvas alpha quantization.
  const multiplied = draw({
    ...replace,
    image: texture([200, 100, 50, 255]),
    image2: texture([128, 255, 64, 255]),
    layer: { sourceFactor: 1, destinationFactor: 1, operation: 2 },
  });
  assert(close(multiplied, [100, 100, 13, 255]), 'MUL_RGB multiplies the two sampled RGB values');
  const tintAlpha = draw({ ...replace, image: texture([255, 128, 64, 255]), alphaCutoff: 0.5, color: [1, 1, 1, 0.1] });
  assert(close(tintAlpha, [255, 128, 64, 26]), 'alpha test uses base alpha before vertex/material tint');
  assert(
    draw({ ...replace, image: texture([255, 128, 64, 64]), alphaCutoff: 0.5 })[3] === 0,
    'base alpha below the reference discards the fragment',
  );
  assert(
    draw({ ...replace, color: [1, 0, 0, 0.2], alphaCutoff: 0.5 })[3] === 0,
    'untextured alpha test uses final vertex/material alpha',
  );
  assert(
    close(draw({ ...replace, color: [1, 0, 0, 0.2], alphaCutoff: 0.1 }), [255, 0, 0, 51]),
    'untextured color above the alpha reference survives',
  );
  const ordinary = draw({ image: texture([200, 100, 50, 128]) });
  assert(close(ordinary, [100, 50, 25, 128]), 'SRC_ALPHA / ONE_MINUS_SRC_ALPHA stores the expected composited pixel');
  assert(
    draw({ ...replace, image: texture([255, 0, 0, 255]), wrap: [3, 2] }, [-0.5, 0.5])[3] === 0,
    'border wrapping clears samples outside the selected U axis',
  );
  assert(
    close(draw({ ...replace, image: texture([255, 0, 0, 255]), wrap: [0, 2] }, [-0.5, 0.5]), [255, 0, 0, 255]),
    'repeat wrapping keeps outside-U texture samples',
  );
  const triangle: MeshVertex[] = [
    [2, 2],
    [16, 30],
    [30, 2],
  ].map(([x, y]) => ({ x, y, uv: [0.5, 0.5] }));
  const cull = (cullMode: number, indices: number[]) => {
    layer.begin();
    layer.mesh(triangle, indices, { ...replace, cullMode, color: [1, 0, 0, 1] });
    layer.finish();
    return read()[3];
  };
  assert(
    cull(0, [0, 1, 2]) === 255 && cull(0, [0, 2, 1]) === 0,
    'native Cull0 keeps projected GL CCW and discards CW triangles',
  );
  assert(cull(1, [0, 1, 2]) === 0 && cull(1, [0, 2, 1]) === 255, 'native Cull1 reverses the front-facing winding');
  assert(cull(2, [0, 1, 2]) === 255 && cull(2, [0, 2, 1]) === 255, 'native Cull2 draws both triangle orientations');
  const loss = gl.getExtension('WEBGL_lose_context');
  if (!loss) throw new Error('Context-loss simulation unavailable');
  await new Promise<void>(resolve => {
    layer.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
    loss.loseContext();
  });
  assert(!layer.available && !layer.active, 'context loss immediately makes the layer unavailable and inactive');
  layer.begin();
  layer.mesh(quad(), [0, 1, 2]);
  layer.finish();
  assert(!layer.active && !layer.available, 'later frames cannot reactivate or submit to a lost context');
  layer.destroy();
  layer.destroy();
  assert(!layer.available, 'destroy after context loss is idempotent');
  const disposable = new GameMeshRenderer(8, 8);
  disposable.destroy();
  disposable.begin();
  assert(!disposable.available && !disposable.active, 'destroyed healthy renderers cannot be reactivated');
  return { passed, renderer: 'webgl2' };
}
