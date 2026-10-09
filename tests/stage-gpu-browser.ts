import { ClassicRingRenderer } from '../src/renderer/classic-stage';
import type { GameSceneAssets } from '../src/core/game-assets';
import type { HudSprite } from '../src/renderer/player-hud';

/** Real browser/GPU tests: no canvas mocks can prove clipping, depth or context loss. */
export async function testStageGpu(): Promise<{ passed: string[]; backend: string }> {
  const passed: string[] = [];
  const assert = (condition: unknown, name: string): void => { if (!condition) throw new Error(name); passed.push(name); };
  const texture = document.createElement('canvas'); texture.width = 2; texture.height = 1;
  const tc = texture.getContext('2d')!; tc.fillStyle = '#f00'; tc.fillRect(0, 0, 1, 1); tc.fillStyle = '#00f'; tc.fillRect(1, 0, 1, 1);
  const image = new Image(); image.src = texture.toDataURL(); await image.decode();
  const material: HudSprite = { image, x: 0, y: 0, width: 2, height: 1 };
  const mesh: GameSceneAssets['geometry']['meshes'][string] = {
    sourcePath: 'synthetic', sourceOffset: 0, vertexCount: 6,
    bounds: { min: [-2, -2, 2], max: [2, 2, 4] },
    vertices: [
      { position: [-1, -1, 2], uv: [.25, .5] }, { position: [1, -1, 2], uv: [.25, .5] }, { position: [0, 1, 2], uv: [.25, .5] },
      { position: [-2, -2, 4], uv: [.75, .5] }, { position: [2, -2, 4], uv: [.75, .5] }, { position: [0, 2, 4], uv: [.75, .5] },
    ], indices: [0, 1, 2, 2, 3, 3, 4, 5],
  };
  const renderer = new ClassicRingRenderer(mesh, material), backend = renderer.canvas.dataset.stageRenderer!;
  assert(backend === 'webgl', 'stage uses the real WebGL batch path');
  const positions = mesh.vertices!.map(v => v.position), world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const camera = { eye: [0, 0, 0] as const, target: [0, 0, 1] as const, verticalFov: 90, near: 1, far: 10 };
  const sample = (canvas: HTMLCanvasElement, x = 960, y = 540) => {
    const output = document.createElement('canvas'); output.width = 1; output.height = 1;
    const c = output.getContext('2d', { willReadFrequently: true })!; c.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data];
  };
  const red = sample(renderer.renderWorld(positions, world, camera));
  assert(red[0] > 250 && red[2] < 5 && red[3] === 255, 'near red face occludes a later submitted far blue face');
  const far = positions.map(p => [p[0], p[1], 20] as const);
  assert(sample(renderer.renderWorld(far, world, camera))[3] === 0, 'far-plane clipping also clears the preceding frame');
  const behind = positions.map(p => [p[0], p[1], -2] as const);
  assert(sample(renderer.renderWorld(behind, world, camera))[3] === 0, 'geometry behind the camera does not appear');
  const crossing = [...positions]; crossing[0] = [-1, -1, .5];
  assert(sample(renderer.renderWorld(crossing, world, camera))[0] > 250, 'triangles crossing the near plane are clipped instead of discarded');
  const shifted = [...world]; shifted[3] = 100;
  assert(sample(renderer.renderWorld(positions, shifted, camera))[3] === 0, 'original world translation participates in projection');
  assert(sample(renderer.render(positions), 960, 618)[3] > 250, 'orthographic clip-preview fallback keeps its screen anchor');
  const canvas = renderer.canvas, gl = canvas.getContext('webgl')!, loss = gl.getExtension('WEBGL_lose_context');
  if (!loss) throw new Error('Test GPU does not expose context-loss simulation');
  await new Promise<void>(resolve => { canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }); loss.loseContext(); });
  assert(renderer.canvas.dataset.stageRenderer === 'canvas2d', 'context loss switches to the existing CPU renderer');
  const fallback = sample(renderer.renderWorld(positions, world, camera));
  assert(fallback[0] > 250 && fallback[2] < 5 && fallback[3] === 255, 'context-loss fallback continues rendering the original geometry');
  const replacement = new ClassicRingRenderer(mesh, material), originalCanvas = replacement.canvas;
  await new Promise<void>(resolve => { originalCanvas.addEventListener('webglcontextlost', () => resolve(), { once: true }); replacement.dispose(); });
  assert(replacement.canvas === originalCanvas, 'disposing a replaced renderer does not allocate a fallback canvas');
  return { passed, backend };
}
