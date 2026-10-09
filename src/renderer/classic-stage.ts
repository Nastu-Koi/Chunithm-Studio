import type { GameSceneAssets } from '../core/game-assets';
import type { HudSprite } from './player-hud';
import { createStageView, clipStageDepth, type StageCamera } from './stage-projection';

export type StagePosition = readonly [number, number, number];
interface Face { vertices: [number, number, number]; color: string; rgba: [number, number, number, number] }
interface StageGpu {
  gl: WebGLRenderingContext; program: WebGLProgram; position: WebGLBuffer; color: WebGLBuffer;
  transform: WebGLUniformLocation; projection: WebGLUniformLocation; vertices: Float32Array;
  transformMatrix: Float32Array; projectionMatrix: Float32Array;
}
function createStageGpu(canvas: HTMLCanvasElement, faces: Face[]): StageGpu | undefined {
  // The decoded ring palette is opaque. Retain the painter fallback for a future
  // translucent material rather than silently changing its compositing order.
  if (faces.some(face => face.rgba[3] !== 1)) return;
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl || typeof gl.createShader !== 'function') return;
  const shader = (type: number, source: string): WebGLShader => {
    const value = gl.createShader(type)!; gl.shaderSource(value, source); gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(value); gl.deleteShader(value); throw new Error(message ?? 'Stage shader compilation failed'); }
    return value;
  };
  const vertex = shader(gl.VERTEX_SHADER, `attribute vec3 position; attribute vec4 color; uniform mat4 transform; uniform mat4 projection; varying lowp vec4 faceColor;
    void main() { gl_Position = projection * transform * vec4(position, 1.0); faceColor = color; }`);
  const fragment = shader(gl.FRAGMENT_SHADER, `precision mediump float; varying lowp vec4 faceColor; void main() { gl_FragColor = faceColor; }`);
  const program = gl.createProgram()!; gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Stage shader link failed');
  gl.useProgram(program);
  const vertices = new Float32Array(faces.length * 9), colors = new Float32Array(faces.length * 12);
  for (let face = 0; face < faces.length; face++) for (let corner = 0; corner < 3; corner++) colors.set(faces[face].rgba, face * 12 + corner * 4);
  const position = gl.createBuffer()!, color = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, position); gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
  const positionLocation = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(positionLocation); gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, color); gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  const colorLocation = gl.getAttribLocation(program, 'color'); gl.enableVertexAttribArray(colorLocation); gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0); gl.viewport(0, 0, canvas.width, canvas.height);
  return { gl, program, position, color, vertices, transform: gl.getUniformLocation(program, 'transform')!, projection: gl.getUniformLocation(program, 'projection')!, transformMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16) };
}


/** Palette and topology are invariant; only original mesh positions change when sampling a pose. */
export class ClassicRingRenderer {
  private output = document.createElement('canvas');
  get canvas(): HTMLCanvasElement { return this.output; }
  private context?: CanvasRenderingContext2D;
  private gpu?: StageGpu;
  private disposed = false;
  private faces: Face[] = [];
  private positions: StagePosition[];
  private scale: number;
  constructor(mesh: NonNullable<GameSceneAssets['geometry']['meshes'][string]>, material: HudSprite) {
    this.canvas.width = 1920; this.canvas.height = 1080;
    this.positions = mesh.vertices!.map(vertex => vertex.position);
    this.scale = 1180 / Math.max(mesh.bounds.max[0] - mesh.bounds.min[0], mesh.bounds.max[1] - mesh.bounds.min[1]);
    const texture = document.createElement('canvas'); texture.width = material.width; texture.height = material.height;
    const tc = texture.getContext('2d', { willReadFrequently: true })!;
    tc.drawImage(material.image, material.x, material.y, material.width, material.height, 0, 0, material.width, material.height);
    const pixels = tc.getImageData(0, 0, material.width, material.height).data;
    const indices = mesh.indices!, vertices = mesh.vertices!;
    for (let i = 2; i < indices.length; i++) {
      const ids: [number, number, number] = [indices[i - 2], indices[i - 1], indices[i]];
      if (new Set(ids).size !== 3) continue;
      const [a, b, d] = ids.map(index => vertices[index]);
      if (!a || !b || !d) continue;
      // Each original ring triangle refers to a single flat swatch in RingColor, not a light map.
      const u = Math.min(material.width - 1, Math.max(0, Math.floor((a.uv[0] + b.uv[0] + d.uv[0]) / 3 * material.width)));
      const v = Math.min(material.height - 1, Math.max(0, Math.floor((a.uv[1] + b.uv[1] + d.uv[1]) / 3 * material.height)));
      const at = (v * material.width + u) * 4;
      this.faces.push({ vertices: ids, color: `rgba(${pixels[at]},${pixels[at + 1]},${pixels[at + 2]},${pixels[at + 3] / 255})`, rgba: [pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255, pixels[at + 3] / 255] });
    }
    try { this.gpu = createStageGpu(this.canvas, this.faces); } catch {
      this.canvas.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext(); this.gpu = undefined;
    }
    if (!this.gpu) this.useCanvasFallback();
    else {
      this.canvas.dataset.stageRenderer = 'webgl';
      this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); if (!this.disposed) this.useCanvasFallback(); }, { once: true });
    }
  }
  /** Release the GPU context when the asset bundle is replaced or unloaded. */
  dispose(): void {
    this.disposed = true;
    const state = this.gpu; this.gpu = undefined;
    if (!state) return;
    state.gl.deleteBuffer(state.position); state.gl.deleteBuffer(state.color); state.gl.deleteProgram(state.program);
    state.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  private useCanvasFallback(): void {
    this.gpu = undefined; this.output = document.createElement('canvas'); this.output.width = 1920; this.output.height = 1080;
    this.output.dataset.stageRenderer = 'canvas2d'; this.context = this.output.getContext('2d')!;
  }
  private drawGpu(positions: readonly StagePosition[]): HTMLCanvasElement {
    const state = this.gpu!, { gl, vertices } = state; let offset = 0;
    for (const face of this.faces) for (const index of face.vertices) {
      const p = positions[index]; vertices[offset++] = p[0]; vertices[offset++] = p[1]; vertices[offset++] = p[2];
    }
    gl.useProgram(state.program); gl.bindBuffer(gl.ARRAY_BUFFER, state.position); gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    gl.uniformMatrix4fv(state.transform, false, state.transformMatrix); gl.uniformMatrix4fv(state.projection, false, state.projectionMatrix);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, this.faces.length * 3);
    return this.canvas;
  }
  /** The screen fit is separate from the source bone pose; it is not an engine camera transform. */
  render(positions: readonly StagePosition[] = this.positions): HTMLCanvasElement {
    const scale = this.scale;
    if (this.gpu) {
      const { transformMatrix: m, projectionMatrix: p } = this.gpu;
      m.fill(0); m[0] = m[5] = m[10] = m[15] = 1;
      let depth = 1; for (const point of positions) depth = Math.max(depth, Math.abs(point[2]) + 1);
      p.fill(0); p[0] = scale / 960; p[5] = scale / 540; p[10] = -1 / depth; p[13] = 1 - 618 / 540; p[15] = 1;
      return this.drawGpu(positions);
    }
    const c = this.context!;
    c.clearRect(0, 0, 1920, 1080);
    // All ring faces are flat-colored. Sorting by model Z gives deterministic overlap after rotation.
    const ordered = this.faces.map(face => ({ face, depth: face.vertices.reduce((sum, index) => sum + positions[index][2], 0) }));
    ordered.sort((a, b) => a.depth - b.depth);
    for (const { face } of ordered) {
      c.fillStyle = face.color; c.beginPath();
      face.vertices.forEach((index, corner) => {
        const point = positions[index], x = 960 + point[0] * scale, y = 618 - point[1] * scale;
        if (corner) c.lineTo(x, y); else c.moveTo(x, y);
      });
      c.closePath(); c.fill();
    }
    return this.canvas;
  }
  /** Draw original posed geometry through an independently decoded world matrix and camera. */
  renderWorld(positions: readonly StagePosition[], world: readonly number[], camera: StageCamera): HTMLCanvasElement {
    const view = createStageView(camera);
    if (this.gpu) {
      const { transformMatrix: m, projectionMatrix: p } = this.gpu;
      const origin = view.toView([0, 0, 0], world);
      for (let column = 0; column < 3; column++) {
        const basis: [number, number, number] = [0, 0, 0]; basis[column] = 1;
        const axis = view.toView(basis, world);
        for (let row = 0; row < 3; row++) m[column * 4 + row] = axis[row] - origin[row];
        m[column * 4 + 3] = 0;
      }
      m[12] = origin[0]; m[13] = origin[1]; m[14] = origin[2]; m[15] = 1;
      const cotangent = 1 / Math.tan(camera.verticalFov * Math.PI / 360), range = camera.far - camera.near;
      p.fill(0); p[0] = cotangent * 1080 / 1920; p[5] = cotangent;
      p[10] = (camera.far + camera.near) / range; p[11] = 1; p[14] = -2 * camera.near * camera.far / range;
      return this.drawGpu(positions);
    }
    const c = this.context!;
    c.clearRect(0, 0, 1920, 1080);
    const vertices = positions.map(position => view.toView(position, world));
    const polygons = this.faces.flatMap(face => {
      const polygon = clipStageDepth(face.vertices.map(index => vertices[index]), camera.near, camera.far);
      return polygon.length < 3 ? [] : [{ polygon, color: face.color, depth: polygon.reduce((sum, p) => sum + p[2], 0) / polygon.length }];
    });
    polygons.sort((a, b) => b.depth - a.depth);
    for (const { polygon, color } of polygons) {
      c.fillStyle = color; c.beginPath();
      polygon.forEach((p, i) => { const { x, y } = view.project(p); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
      c.closePath(); c.fill();
    }
    return this.canvas;
  }
}

export function createClassicRingRenderer(scene: GameSceneAssets | undefined, material: HudSprite | undefined): ClassicRingRenderer | undefined {
  const mesh = scene?.geometry.meshes.ring;
  return mesh?.vertices?.length && mesh.indices?.length && material ? new ClassicRingRenderer(mesh, material) : undefined;
}
/** Static fallback when the copied bundle does not carry a supported animation. */
export function createClassicRingLayer(scene: GameSceneAssets | undefined, material: HudSprite | undefined): HTMLCanvasElement | undefined {
  return createClassicRingRenderer(scene, material)?.render();
}
