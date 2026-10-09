import type { StageAnimation } from './stage-animation';
import type { StageProgram } from './stage-program';
import type { NativeEffectProgram } from './game-effects';
/** Images decoded from game resources, available to the asset import pipeline. */
export interface GameTexture {
  dataUrl: string;
  width: number;
  height: number;
  sourcePath: string;
  sourceName: string;
  sourceOffset: number;
}
export interface GameModelTexture {
  images: GameTexture[];
  /** ModelTableRecord width; native x scale is requested lane width / this value. */
  nominalWidth?: number;
  /** Actual UV rectangle read from the model, when it is a four-vertex sprite. */
  rectangle?: { u0: number; v0: number; u1: number; v1: number };
  /** Original YABX shape/batch geometry and exact material bindings. */
  meshes?: GameModelMesh[];
}
export interface GameModelMesh {
  name: string;
  /** Node world transform has already been applied; all meshes share model coordinates. */
  vertices: { position: [number, number, number]; uv: [number, number]; uv2?: [number, number]; color: [number, number, number, number] }[];
  /** Actual strip is expanded into independent triangles; degenerate connector triangles are omitted. */
  indices: number[];
  topology: 'triangles';
  material: {
    name: string;
    textures: { image: number; uvSet: number; wrapU: number; wrapV: number; type: string }[];
    /** Original Stevia enum values; no inferred material recoloring. */
    blendOperation: number; blendSource: number; blendDestination: number; alphaRef: number; cullMode: number;
    diffuse: [number, number, number, number]; opacity: number; vertexColor: boolean;
    /** Shader layer enums: factor 0..5 = zero/one/srcA/invSrcA/dstA/invDstA; operation 0 add, 1 subtract, 2 multiply. */
    textureLayers?: { sourceFactor: number; destinationFactor: number; operation: number }[];
    /** Original tsUVScrollUVn, applied as uv * scale + offset when enabled. */
    textureTransforms?: { offset: [number, number]; scale: [number, number] }[];
  };
  sourceOffset: number;
  sourceVertexOffset: number;
  sourceIndexOffset: number;
  sourceMatrix: number[];
}
export interface GameEffectTables {
  /** Original AcroartsTableRecord identifiers; filename is provenance, never opened at playback. */
  acroarts: { id: number; name: string; filename: string; values: number[] }[];
  /** Original fourteen numeric references, retained in their original order. */
  notes: { id: number; name: string; values: number[] }[];
}
export interface GameSceneSprite {
  image: GameTexture;
  /** Pixel bounds from the original SRD CROP record, or the complete standalone texture. */
  rect: { x: number; y: number; width: number; height: number };
  /** Static SRD node placement at the 1920×1080 design size; animations are not evaluated. */
  layout?: { x: number; y: number; width: number; height: number };
  sourceLayout: string;
  sourceOffset: number;
}
export interface GameSceneAssets {
  stage: { id: number; name: string; sourcePath: string };
  /** Named original materials, not a flattened/reconstructed background. */
  materials: Record<string, GameTexture>;
  hud: Record<string, GameSceneSprite>;
  geometry: {
    designWidth: number;
    designHeight: number;
    /** Object-space data. These values do not establish the final game camera. */
    meshes: Record<string, {
      sourcePath: string; sourceOffset: number; vertexCount: number;
      bounds: { min: [number, number, number]; max: [number, number, number] };
      /** Object-space vertices. Packed PNTW binding bytes are also decoded in animation.rig.vertexBones. */
      vertices?: { position: [number, number, number]; uv: [number, number]; attachment?: number }[];
      indices?: number[];
      topology?: 'triangle-strip';
      sourceIndexOffset?: number;
    }>;
  };
  /** Decoded original rig and curves; no paths are dereferenced at playback time. */
  animation?: StageAnimation;
  /** Copied AFNC scene control records. Unsupported commands are retained with diagnostics. */
  program?: StageProgram;
  warnings: string[];
}
export interface GameTextures {
  font?: GameBitmapFont;
  gameRoot: string;
  /** Exact ModelTableRecord identifiers, for example NotesTap_04. */
  models: Record<string, GameModelTexture>;
  /** Exact TextureTableRecord identifiers, for example HoldJoint. */
  textures: Record<string, GameTexture>;
  /** Original effect textures; particle timing/layout is not decoded. */
  effects: Record<string, GameTexture[]>;
  effectTables?: GameEffectTables;
  /** Copied original AFNC records, with explicit executable coverage diagnostics. */
  effectPrograms?: Record<string, NativeEffectProgram>;
  scene?: GameSceneAssets;
  warnings: string[];
}
export interface GameBitmapFont {
  name: string; height: number; ascent: number; pages: GameTexture[];
  glyphs: Record<string, { advance: number; page: number; originX: number; originY: number; x: number; y: number; width: number; height: number }>;
}
