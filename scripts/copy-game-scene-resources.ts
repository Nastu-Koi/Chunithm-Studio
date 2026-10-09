import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGameSceneAssets } from '../src/backend/game-scene';
import type { GameTexture } from '../src/core/game-assets';
import type { GameResourceManifest, StoredGameScene, StoredGameTexture } from '../src/backend/bundled-assets';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? (process.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm'));
const destination = path.join(root, 'assets/game');
const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')) as GameResourceManifest;
if (manifest.version !== 1) throw new Error('资源清单版本不受支持');
const digests = JSON.parse(await readFile(path.join(destination, 'sha256.json'), 'utf8')) as Record<string, string>;
const scene = await loadGameSceneAssets(source);
await mkdir(path.join(destination, 'images'), { recursive: true });
const relative = (file: string): string => path.relative(source, file).replaceAll('\\', '/');
const stored: StoredGameScene = { ...scene, stage: { ...scene.stage, sourcePath: relative(scene.stage.sourcePath) }, materials: {}, hud: {}, geometry: { ...scene.geometry, meshes: {} } };
const copied = new Set<string>();
async function copyImage(image: GameTexture): Promise<StoredGameTexture> {
  if (!image.dataUrl.startsWith('data:image/png;base64,')) throw new Error('不支持的图片格式');
  const bytes = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex'), file = `images/${hash.slice(0, 24)}.png`;
  if (!copied.has(file)) {
    if (digests[file] && digests[file] !== hash) throw new Error('资源文件 hash 冲突');
    if (digests[file]) {
      const actual = createHash('sha256').update(await readFile(path.join(destination, file))).digest('hex');
      if (actual !== hash) throw new Error('已有资源副本内容改变');
    } else await writeFile(path.join(destination, file), bytes, { flag: 'wx' });
    copied.add(file); digests[file] = hash;
  }
  return { file, width: image.width, height: image.height, sourceName: image.sourceName, sourcePath: relative(image.sourcePath), sourceOffset: image.sourceOffset };
}
for (const [id, material] of Object.entries(scene.materials)) stored.materials[id] = await copyImage(material);
for (const [id, sprite] of Object.entries(scene.hud)) stored.hud[id] = { ...sprite, sourceLayout: relative(sprite.sourceLayout), image: await copyImage(sprite.image) };
for (const [id, mesh] of Object.entries(scene.geometry.meshes)) stored.geometry.meshes[id] = { ...mesh, sourcePath: relative(mesh.sourcePath) };
manifest.textures.scene = stored;
await writeFile(path.join(destination, 'sha256.json'), JSON.stringify(digests, null, 2));
const temporary = path.join(destination, `manifest.scene-${process.pid}.json`);
await writeFile(temporary, JSON.stringify(manifest, null, 2));
await rename(temporary, path.join(destination, 'manifest.json'));
console.log(JSON.stringify({ destination, materials: Object.keys(stored.materials), hud: Object.keys(stored.hud).length, images: copied.size, meshes: Object.fromEntries(Object.entries(stored.geometry.meshes).map(([key, value]) => [key, { vertices: value.vertexCount, indices: value.indices?.length, bounds: value.bounds }])) }, null, 2));
