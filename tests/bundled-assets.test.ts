import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadBundledGameResources, type GameResourceManifest } from '../src/backend/bundled-assets';

test('bundled resources load from a moved copy without original source files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'chuni-copy-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'images')); await mkdir(path.join(root, 'sounds'));
  await writeFile(path.join(root, 'images/head.png'), Buffer.from([1, 2, 3]));
  await writeFile(path.join(root, 'sounds/tap.wav'), 'copied sample');
  const manifest: GameResourceManifest = { version: 1, textures: { models: { NotesTap_04: { images: [{ file: 'images/head.png', width: 1, height: 1, sourcePath: 'nonexistent-original.svo', sourceName: 'head.dds', sourceOffset: 128 }] } }, textures: {}, effects: {}, warnings: [] }, sounds: { source: 'nonexistent-original.acb', sounds: { tap: { cueName: 'tap', layers: [{ path: 'sounds/tap.wav', gain: 0.5, playbackRate: 1 }] } }, warnings: [] } };
  const manifestPath = path.join(root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const resources = await loadBundledGameResources(root);
  assert.equal(resources.textures.models.NotesTap_04.images[0].dataUrl, 'data:image/png;base64,AQID');
  assert.equal(resources.sounds.sounds.tap!.layers[0].path, path.join(root, 'sounds/tap.wav'));
  manifest.textures.models.NotesTap_04.images[0].file = '../outside.png'; await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadBundledGameResources(root), /超出资源目录/);
});

test('copied project assets match their import hashes and contain eight ready-to-play cues', async () => {
  const root = path.resolve('assets/game'), hashes = JSON.parse(await readFile(path.join(root, 'sha256.json'), 'utf8')) as Record<string, string>;
  for (const [file, expected] of Object.entries(hashes)) {
    const bytes = await readFile(path.join(root, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
    if (file.endsWith('.wav')) { assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE'); }
  }
  const assets = await loadBundledGameResources(root);
  assert.equal(Object.keys(assets.sounds.sounds).length, 8);
  for (const kind of ['Tap', 'Chara', 'Flick', 'Mine']) for (let width = 1; width <= 16; width++) assert.ok(assets.textures.models[`Notes${kind}_${String(width).padStart(2, '0')}`]);
  for (const sound of Object.values(assets.sounds.sounds)) for (const layer of sound.layers) assert.ok(layer.path.startsWith(root + path.sep));
});
