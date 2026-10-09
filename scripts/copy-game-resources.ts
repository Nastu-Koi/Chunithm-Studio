import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGameTextures } from '../src/backend/game-textures';
import { loadGameHitSounds } from '../src/backend/game-audio';
import { loadGameSceneAssets } from '../src/backend/game-scene';
import { loadGameEffects } from '../src/backend/game-effects';
import type { GameTexture } from '../src/core/game-assets';
import type { GameResourceManifest, StoredGameTexture } from '../src/backend/bundled-assets';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? (process.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm'));
const destination = path.join(projectRoot, 'assets', 'game');
const staging = `${destination}.staging-${process.pid}`;
const audioCache = path.join(os.tmpdir(), `chuni-resources-${process.pid}`);
try { await stat(destination); throw new Error('资源目录已存在；请保留现有副本后再重新导入。'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await mkdir(path.join(staging, 'images'), { recursive: true });
await mkdir(path.join(staging, 'sounds'), { recursive: true });
try {
  const [textures, sounds] = await Promise.all([loadGameTextures(source), loadGameHitSounds(source, audioCache)]);
  if (!textures.models.NotesTap_04 || !sounds.sounds.tap) throw new Error('没有找到完整的基础 TAP 贴图和打击音，未生成资源副本。');
  const manifest: GameResourceManifest = { version: 1, textures: { models: {}, textures: {}, effects: {}, effectTables: textures.effectTables, warnings: textures.warnings }, sounds: { source: 'Copied game sound samples', sounds: {}, warnings: sounds.warnings } };
  manifest.textures.effectPrograms = await loadGameEffects(source);
  const saved = new Set<string>(), digests: Record<string, string> = {};
  async function store(bytes: Buffer, folder: string, extension: string): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex'), file = `${folder}/${hash.slice(0, 24)}.${extension}`;
    if (!saved.has(file)) { await writeFile(path.join(staging, file), bytes, { flag: 'wx' }); saved.add(file); digests[file] = hash; }
    return file;
  }
  async function copyImage(image: GameTexture): Promise<StoredGameTexture> {
    if (!image.dataUrl.startsWith('data:image/png;base64,')) throw new Error('不支持的图像数据');
    const file = await store(Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64'), 'images', 'png');
    return { file, width: image.width, height: image.height, sourceName: image.sourceName, sourcePath: path.relative(source, image.sourcePath).replaceAll('\\', '/'), sourceOffset: image.sourceOffset };
  }
  // Serial storage deduplicates repeated embedded textures without concurrent file races.
  for (const [id, model] of Object.entries(textures.models)) {
    const images: StoredGameTexture[] = [];
    for (const image of model.images) images.push(await copyImage(image));
    manifest.textures.models[id] = { ...model, images };
  }
  for (const [id, image] of Object.entries(textures.textures)) manifest.textures.textures[id] = await copyImage(image);
  for (const [id, original] of Object.entries(textures.effects)) {
    const images: StoredGameTexture[] = [];
    for (const image of original) images.push(await copyImage(image));
    manifest.textures.effects[id] = images;
  }
  const scene = await loadGameSceneAssets(source);
  const relative = (filename: string): string => path.relative(source, filename).replaceAll('\\', '/');
  const storedScene: NonNullable<GameResourceManifest['textures']['scene']> = {
    ...scene, stage: { ...scene.stage, sourcePath: relative(scene.stage.sourcePath) }, materials: {}, hud: {},
    geometry: { ...scene.geometry, meshes: Object.fromEntries(Object.entries(scene.geometry.meshes).map(([id, mesh]) => [id, { ...mesh, sourcePath: relative(mesh.sourcePath) }])) },
  };
  for (const [id, material] of Object.entries(scene.materials)) storedScene.materials[id] = await copyImage(material);
  for (const [id, sprite] of Object.entries(scene.hud)) storedScene.hud[id] = { ...sprite, sourceLayout: relative(sprite.sourceLayout), image: await copyImage(sprite.image) };
  manifest.textures.scene = storedScene;
  for (const [id, sound] of Object.entries(sounds.sounds)) {
    const layers = [];
    for (const layer of sound.layers) layers.push({ ...layer, path: await store(await readFile(layer.path), 'sounds', 'wav') });
    manifest.sounds.sounds[id as keyof typeof sounds.sounds] = { cueName: sound.cueName, layers };
  }
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(staging, 'sha256.json'), JSON.stringify(digests, null, 2));
  await rename(staging, destination);
  console.log(JSON.stringify({ destination, models: Object.keys(manifest.textures.models).length, images: saved.size - Object.keys(digests).filter(file => file.endsWith('.wav')).length, sounds: Object.keys(manifest.sounds.sounds), files: saved.size, warnings: [...textures.warnings, ...sounds.warnings] }, null, 2));
} finally { await rm(staging, { recursive: true, force: true }); await rm(audioCache, { recursive: true, force: true }); }
