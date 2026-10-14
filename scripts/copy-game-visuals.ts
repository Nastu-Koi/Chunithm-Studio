import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameTextures } from '../src/backend/game-textures';
import { loadGameEffects } from '../src/backend/game-effects';
import type { GameTexture } from '../src/core/game-assets';
import type { GameResourceManifest, StoredGameTexture } from '../src/backend/bundled-assets';

/** Incremental original visual import: existing sound and scene copies remain intact. */
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? (process.platform === 'win32' ? 'D:\\chunithm' : '/mnt/d/chunithm'));
const destination = path.join(project, 'assets/game');
const manifestPath = path.join(destination, 'manifest.json');
const original = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(original) as GameResourceManifest;
if (manifest.version !== 1) throw new Error('资源副本版本不受支持');
const textures = await loadGameTextures(source);
if (!textures.models.NotesAirU_04?.meshes?.length || !textures.models.NotesAirLadder_04?.meshes?.length)
  throw new Error('原生 AIR / CRUSH 模型未完整提取，未更新清单');
const backup = path.join(project, 'out', `game-manifest-before-visuals-${Date.now()}.json`);
await mkdir(path.dirname(backup), { recursive: true });
await writeFile(backup, original, { flag: 'wx' });
const digests = JSON.parse(await readFile(path.join(destination, 'sha256.json'), 'utf8')) as Record<string, string>;
let copied = 0;
async function copyImage(image: GameTexture): Promise<StoredGameTexture> {
  const prefix = 'data:image/png;base64,';
  if (!image.dataUrl.startsWith(prefix)) throw new Error('不支持的图像数据');
  const bytes = Buffer.from(image.dataUrl.slice(prefix.length), 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex'),
    file = `images/${hash.slice(0, 24)}.png`;
  if (!(file in digests)) {
    await writeFile(path.join(destination, file), bytes, { flag: 'wx' }).catch(async error => {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        !bytes.equals(await readFile(path.join(destination, file)))
      )
        throw error;
    });
    copied++;
    digests[file] = hash;
  }
  return {
    file,
    width: image.width,
    height: image.height,
    sourceName: image.sourceName,
    sourcePath: path.relative(source, image.sourcePath).replaceAll('\\', '/'),
    sourceOffset: image.sourceOffset,
  };
}
manifest.textures.models = {};
manifest.textures.textures = {};
manifest.textures.effects = {};
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
manifest.textures.effectTables = textures.effectTables;
manifest.textures.effectPrograms = await loadGameEffects(source);
manifest.textures.warnings = textures.warnings;
// Commit manifest last; an interrupted copy keeps the previous playable resource set.
await writeFile(`${manifestPath}.next`, JSON.stringify(manifest));
await writeFile(path.join(destination, 'sha256.json.next'), JSON.stringify(digests, null, 2));
await rename(path.join(destination, 'sha256.json.next'), path.join(destination, 'sha256.json'));
await rename(`${manifestPath}.next`, manifestPath);
console.log(
  JSON.stringify({
    backup,
    models: Object.keys(textures.models).length,
    meshes: Object.values(textures.models).reduce((n, m) => n + (m.meshes?.length ?? 0), 0),
    effects: Object.keys(textures.effects).length,
    copied,
    warnings: textures.warnings,
  }),
);
