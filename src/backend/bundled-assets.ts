import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUNDLED_ASSET_HOST,
  BUNDLED_ASSET_SCHEME,
  type GameTexture,
  type GameTextures,
  type GameSceneAssets,
  type GameSceneSprite,
} from '../core/game-assets';
import type { GameHitSounds } from '../core/game-sounds';

export interface BundledGameResources {
  textures: GameTextures;
  sounds: GameHitSounds;
}
export interface StoredGameTexture extends Omit<GameTexture, 'dataUrl'> {
  file: string;
}
export interface StoredGameScene extends Omit<GameSceneAssets, 'materials' | 'hud'> {
  materials: Record<string, StoredGameTexture>;
  hud: Record<string, Omit<GameSceneSprite, 'image'> & { image: StoredGameTexture }>;
}
export interface GameResourceManifest {
  version: 1;
  textures: {
    font?: Omit<NonNullable<GameTextures['font']>, 'pages'> & { pages: StoredGameTexture[] };
    models: Record<string, Omit<GameTextures['models'][string], 'images'> & { images: StoredGameTexture[] }>;
    textures: Record<string, StoredGameTexture>;
    effects: Record<string, StoredGameTexture[]>;
    effectTables?: GameTextures['effectTables'];
    effectPrograms?: GameTextures['effectPrograms'];
    scene?: StoredGameScene;
    warnings: string[];
  };
  sounds: GameHitSounds;
}
/** URL the renderer uses for a manifest-relative image when the desktop app serves the copies itself. */
export function bundledAssetUrl(relativeFile: string): string {
  return `${BUNDLED_ASSET_SCHEME}://${BUNDLED_ASSET_HOST}/${relativeFile.split('/').map(encodeURIComponent).join('/')}`;
}
const assetTypes: Record<string, string> = { '.png': 'image/png', '.wav': 'audio/wav', '.json': 'application/json' };
/** Resolve a bundled-asset URL to a file inside `root`, or null for any other host, type or escaping path. */
export function resolveBundledAsset(root: string, url: string): { file: string; type: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${BUNDLED_ASSET_SCHEME}:` || parsed.host !== BUNDLED_ASSET_HOST) return null;
  const base = path.resolve(root),
    file = path.resolve(base, decodeURIComponent(parsed.pathname).replace(/^\/+/, ''));
  const relative = path.relative(base, file),
    type = assetTypes[path.extname(file).toLowerCase()];
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !type)
    return null;
  return { file, type };
}
function resourceFile(root: string, file: string): string {
  if (!file || path.isAbsolute(file) || file.includes('\\')) throw new Error('资源清单路径无效');
  const target = path.resolve(root, file),
    relative = path.relative(path.resolve(root), target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('资源清单路径超出资源目录');
  return target;
}
export interface BundledResourceOptions {
  /** Map a manifest-relative image file to a URL the renderer can load directly. Without it images are inlined as base64 data URLs. */
  imageUrl?: (relativeFile: string) => string;
}
/** Load only copies stored beside the app; no access to the original game installation. */
export async function loadBundledGameResources(
  root: string,
  options: BundledResourceOptions = {},
): Promise<BundledGameResources> {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as GameResourceManifest;
  if (manifest.version !== 1) throw new Error('游戏资源副本版本不受支持');
  const imageCache = new Map<string, Promise<string>>();
  const readTexture = async (entry: StoredGameTexture): Promise<GameTexture> => {
    const file = resourceFile(root, entry.file);
    if (!imageCache.has(file))
      imageCache.set(
        file,
        options.imageUrl
          ? Promise.resolve(options.imageUrl(entry.file))
          : readFile(file).then(bytes => `data:image/png;base64,${bytes.toString('base64')}`),
      );
    return {
      dataUrl: await imageCache.get(file)!,
      width: entry.width,
      height: entry.height,
      sourcePath: file,
      sourceName: entry.sourceName,
      sourceOffset: entry.sourceOffset,
    };
  };
  const textures: GameTextures = {
    gameRoot: root,
    models: {},
    textures: {},
    effects: {},
    effectTables: manifest.textures.effectTables,
    effectPrograms: manifest.textures.effectPrograms,
    warnings: [...manifest.textures.warnings],
  };
  await Promise.all([
    ...Object.entries(manifest.textures.models).map(async ([id, model]) => {
      textures.models[id] = { ...model, images: await Promise.all(model.images.map(readTexture)) };
    }),
    ...Object.entries(manifest.textures.textures).map(async ([id, image]) => {
      textures.textures[id] = await readTexture(image);
    }),
    ...Object.entries(manifest.textures.effects).map(async ([id, images]) => {
      textures.effects[id] = await Promise.all(images.map(readTexture));
    }),
  ]);
  if (manifest.textures.font)
    textures.font = {
      ...manifest.textures.font,
      pages: await Promise.all(manifest.textures.font.pages.map(readTexture)),
    };
  if (manifest.textures.scene) {
    const stored = manifest.textures.scene;
    textures.scene = { ...stored, materials: {}, hud: {} };
    for (const [id, entry] of Object.entries(stored.materials)) textures.scene.materials[id] = await readTexture(entry);
    for (const [id, entry] of Object.entries(stored.hud))
      textures.scene.hud[id] = { ...entry, image: await readTexture(entry.image) };
  }
  const sounds: GameHitSounds = { source: root, sounds: {}, warnings: [...manifest.sounds.warnings] };
  for (const [id, sound] of Object.entries(manifest.sounds.sounds)) {
    sounds.sounds[id as keyof GameHitSounds['sounds']] = {
      ...sound,
      layers: sound.layers.map(layer => ({ ...layer, path: resourceFile(root, layer.path) })),
    };
  }
  return { textures, sounds };
}
