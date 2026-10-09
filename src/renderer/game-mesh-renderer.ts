/** One transparent GPU layer for original note geometry. Shared triangle edges are
 * rasterized once, avoiding Canvas clip antialias seams in HOLD/SLIDE surfaces. */
export interface MeshPoint { x: number; y: number; scale?: number }
export interface MeshVertex extends MeshPoint { uv: readonly number[]; uv2?: readonly number[]; color?: readonly number[] }
export interface MeshSprite { image: TexImageSource; x: number; y: number; width: number; height: number }
export interface MeshPaint {
  image?: TexImageSource; image2?: TexImageSource; additive?: boolean; alphaCutoff?: number; color?: readonly number[];
  wrap?: readonly number[]; wrap2?: readonly number[];
  layer?: { sourceFactor: number; destinationFactor: number; operation: number };
  blendSource?: number; blendDestination?: number; blendOperation?: number;
  cullMode?: number;
  blendEnabled?: boolean;
}
interface Draw { paint: MeshPaint; state: string; start: number; count: number }
const STRIDE = 11;
const white = [1, 1, 1, 1];
function dimensions(image: TexImageSource): [number, number] {
  if ('naturalWidth' in image) return [image.naturalWidth, image.naturalHeight];
  if ('videoWidth' in image) return [image.videoWidth, image.videoHeight];
  if ('displayWidth' in image) return [image.displayWidth, image.displayHeight];
  return [Number(image.width), Number(image.height)];
}
export function meshColor(color: string): number[] {
  let hex = color.replace('#', '');
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map(c => c + c).join('');
  if (hex.length === 6) hex += 'ff';
  if (!/^[0-9a-f]{8}$/i.test(hex)) throw new Error(`Unsupported mesh color ${color}`);
  return [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}
export class GameMeshRenderer {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private textures = new Map<TexImageSource, WebGLTexture>();
  private samplers = new Map<string, WebGLSampler>();
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private empty: WebGLTexture;
  private values: number[] = [];
  private draws: Draw[] = [];
  private capacity = new Float32Array(16384);
  private clipTop = 0;
  private contextLost = false;
  private destroyed = false;
  active = false;
  /** A lost context stays unavailable; the owner switches to its software path. */
  get available(): boolean { return !this.contextLost && !this.destroyed && !this.gl.isContextLost(); }
  constructor(readonly width = 1920, readonly height = 1080) {
    this.canvas.width = width; this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { alpha: true, antialias: true, depth: false, stencil: false, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL 2 不可用');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); this.contextLost = true; this.active = false;
      this.values.length = 0; this.draws.length = 0;
    }, { once: true });
    const shader = (kind: number, source: string) => {
      const s = gl.createShader(kind)!; gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'Shader compile failed');
      return s;
    };
    const vertex = shader(gl.VERTEX_SHADER, `#version 300 es
      in vec3 position; in vec2 uv; in vec2 uv2; in vec4 color;
      uniform vec2 size; out vec2 tex; out vec2 tex2; out vec4 tint;
      void main() { gl_Position=vec4((position.x/size.x*2.0-1.0)*position.z,
        (1.0-position.y/size.y*2.0)*position.z,0.0,position.z); tex=uv; tex2=uv2; tint=color; }`);
    const fragment = shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float; uniform sampler2D image; uniform sampler2D image2;
      uniform float firstTexture; uniform float secondTexture; uniform float alphaCutoff; uniform ivec3 layer;
      uniform vec4 border;
      in vec2 tex; in vec2 tex2; in vec4 tint; out vec4 result;
      float factor(int f, float s, float d) { if(f==0) return 0.0; if(f==2) return s; if(f==3) return 1.0-s;
        if(f==4) return d; if(f==5) return 1.0-d; return 1.0; }
      bool outside(vec2 uv,vec2 axes) { return (axes.x>0.0&&(uv.x<0.0||uv.x>1.0))||(axes.y>0.0&&(uv.y<0.0||uv.y>1.0)); }
      void main() {
        vec4 base=outside(tex,border.xy)?vec4(0.0):texture(image,tex);
        if(secondTexture>0.5) {
          vec4 src=outside(tex2,border.zw)?vec4(0.0):texture(image2,tex2);
          vec3 a=src.rgb*factor(layer.x,src.a,base.a), b=base.rgb*factor(layer.y,src.a,base.a);
          base.rgb=layer.z==2?a*b:(layer.z==1?a-b:a+b);
        }
        result=base*tint;
        if((firstTexture>0.5?base.a:result.a)<alphaCutoff) discard;
      }`);
    this.program = gl.createProgram()!; gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) ?? 'Shader link failed');
    gl.useProgram(this.program); this.buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const name of ['size', 'image', 'image2', 'firstTexture', 'secondTexture', 'alphaCutoff', 'layer', 'border']) this.uniforms[name] = gl.getUniformLocation(this.program, name);
    let offset = 0;
    for (const [name, length] of [['position', 3], ['uv', 2], ['uv2', 2], ['color', 4]] as const) {
      const location = gl.getAttribLocation(this.program, name); gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, length, gl.FLOAT, false, STRIDE * 4, offset * 4); offset += length;
    }
    this.empty = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, this.empty);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform2f(this.uniforms.size, width, height);
    gl.uniform1i(this.uniforms.image, 0); gl.uniform1i(this.uniforms.image2, 1);
    gl.enable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
  }
  begin(clipTop = 0): void { this.values.length = 0; this.draws.length = 0; this.clipTop = clipTop; this.active = this.available; }
  mesh(vertices: readonly MeshVertex[], indices: readonly number[], paint: MeshPaint = {}): void {
    if (!this.active) return;
    const start = this.values.length / STRIDE, tint = paint.color ?? white;
    for (const index of indices) {
      const v = vertices[index], color = v.color ?? white;
      const second = v.uv2 ?? v.uv;
      this.values.push(v.x, v.y, 1 / Math.max(.00001, v.scale ?? 1), v.uv[0], v.uv[1], second[0], second[1],
        color[0] * tint[0], color[1] * tint[1], color[2] * tint[2], color[3] * tint[3]);
    }
    const count = this.values.length / STRIDE - start, previous = this.draws.at(-1);
    const state = [paint.additive, paint.alphaCutoff, paint.wrap?.join(','), paint.wrap2?.join(','), paint.blendSource,
      paint.blendDestination, paint.blendOperation, paint.blendEnabled, paint.cullMode, paint.layer?.sourceFactor, paint.layer?.destinationFactor, paint.layer?.operation].join(':');
    if (previous && previous.paint.image === paint.image && previous.paint.image2 === paint.image2
      && previous.state === state) previous.count += count;
    else this.draws.push({ paint, state, start, count });
  }
  quad(sprite: MeshSprite, points: readonly MeshPoint[], paint: Omit<MeshPaint, 'image'> = {}): void {
    const [width, height] = dimensions(sprite.image), u0 = sprite.x / width, u1 = (sprite.x + sprite.width) / width;
    const v0 = sprite.y / height, v1 = (sprite.y + sprite.height) / height;
    this.mesh(points.map((p, i) => ({ ...p, uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]][i] })), [0, 1, 3, 1, 2, 3], { ...paint, image: sprite.image });
  }
  polygon(points: readonly MeshPoint[], color: string): void {
    const indices: number[] = [];
    for (let i = 2; i < points.length; i++) indices.push(0, i - 1, i);
    this.mesh(points.map(p => ({ ...p, uv: [0, 0] })), indices, { color: meshColor(color) });
  }
  line(a: MeshPoint, b: MeshPoint, color: string, width = 1): void {
    const length = Math.hypot(b.x - a.x, b.y - a.y); if (!length) return;
    const x = (b.y - a.y) / length * width / 2, y = (a.x - b.x) / length * width / 2;
    this.polygon([{ x: a.x + x, y: a.y + y }, { x: b.x + x, y: b.y + y }, { x: b.x - x, y: b.y - y }, { x: a.x - x, y: a.y - y }], color);
  }
  private texture(image: TexImageSource | undefined, unit: number, wrap: readonly number[] = [2, 2]): void {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit);
    let texture = image ? this.textures.get(image) : this.empty;
    if (image && !texture) {
      texture = gl.createTexture()!; this.textures.set(image, texture); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else gl.bindTexture(gl.TEXTURE_2D, texture!);
    const key = wrap.join(','); let sampler = this.samplers.get(key);
    if (!sampler) {
      sampler = gl.createSampler()!; this.samplers.set(key, sampler);
      const modes = [gl.REPEAT, gl.MIRRORED_REPEAT, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE];
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, modes[wrap[0]] ?? gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, modes[wrap[1]] ?? gl.CLAMP_TO_EDGE);
    }
    gl.bindSampler(unit, sampler);
  }
  /** The original animated stage is composited in this framebuffer too, so
   * additive note effects blend with the scene, including outside the track. */
  refreshTexture(image: TexImageSource): void {
    if (!this.available) return;
    const existing = this.textures.has(image); this.texture(image, 0);
    if (existing) this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
  }
  finish(): HTMLCanvasElement {
    const gl = this.gl; this.active = false;
    if (!this.available) return this.canvas;
    gl.viewport(0, 0, this.width, this.height); gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, this.width, Math.max(0, this.height - this.clipTop));
    if (this.values.length > this.capacity.length) this.capacity = new Float32Array(2 ** Math.ceil(Math.log2(this.values.length)));
    this.capacity.set(this.values); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity.subarray(0, this.values.length), gl.DYNAMIC_DRAW);
    gl.useProgram(this.program);
    const blend = [gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.SRC_ALPHA_SATURATE];
    const operation = [gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX];
    for (const draw of this.draws) {
      const p = draw.paint, layer = p.layer ?? { sourceFactor: 1, destinationFactor: 1, operation: 2 };
      if (p.blendEnabled === false) gl.disable(gl.BLEND); else gl.enable(gl.BLEND);
      this.texture(p.image, 0, p.wrap); this.texture(p.image2, 1, p.wrap2);
      gl.uniform1f(this.uniforms.firstTexture, p.image ? 1 : 0);
      gl.uniform1f(this.uniforms.secondTexture, p.image2 ? 1 : 0);
      gl.uniform1f(this.uniforms.alphaCutoff, p.alphaCutoff ?? 0);
      gl.uniform3i(this.uniforms.layer, layer.sourceFactor, layer.destinationFactor, layer.operation);
      gl.uniform4f(this.uniforms.border, Number(p.wrap?.[0] === 3), Number(p.wrap?.[1] === 3), Number(p.wrap2?.[0] === 3), Number(p.wrap2?.[1] === 3));
      gl.blendEquationSeparate(operation[p.blendOperation ?? 0] ?? gl.FUNC_ADD, gl.FUNC_ADD);
      gl.blendFuncSeparate(blend[p.blendSource ?? 4] ?? gl.SRC_ALPHA,
        blend[p.blendDestination ?? (p.additive ? 1 : 5)] ?? gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (p.cullMode === 0 || p.cullMode === 1) {
        gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(p.cullMode === 0 ? gl.CCW : gl.CW);
      } else gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, draw.start, draw.count);
    }
    return this.canvas;
  }
  clearTextures(): void { for (const texture of this.textures.values()) this.gl.deleteTexture(texture); this.textures.clear(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.active = false; this.values.length = 0; this.draws.length = 0;
    this.clearTextures(); for (const sampler of this.samplers.values()) this.gl.deleteSampler(sampler); this.samplers.clear();
    this.gl.deleteTexture(this.empty); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
