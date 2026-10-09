import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractCueLayers, loadGameHitSounds } from '../src/backend/game-audio';
import { decodeAdx } from '../src/backend/audio';
import { writeAfs2, writeUtf, type UtfValue } from '../src/backend/cri';

function table(name: string, rows: Record<string, UtfValue>[]): Buffer {
  return writeUtf({ name, version: 1, rows, columns: Object.keys(rows[0] ?? {}).map(key => ({ name: key, storage: 0x50, type: Buffer.isBuffer(rows[0][key]) ? 11 : typeof rows[0][key] === 'string' ? 10 : 4 })) });
}
function fixture(cycle = false): Buffer {
  const ref = (type: number, index: number) => { const b = Buffer.alloc(4); b.writeUInt16BE(type); b.writeUInt16BE(index, 2); return b; };
  const note = (index: number) => Buffer.concat([Buffer.from([7, 208, 4]), ref(2, index), Buffer.alloc(3)]);
  const selector = (label: number) => Buffer.concat([Buffer.from([0, 100, 4]), ref(0, label)]);
  const adx = Buffer.alloc(32); adx.writeUInt16BE(0x8000);
  return table('Header', [{
    CueNameTable: table('CueNameTable', [{ CueName: 'hit', CueIndex: 0 }]),
    CueTable: table('CueTable', [{ ReferenceType: 3, ReferenceIndex: 0 }]),
    SequenceTable: table('SequenceTable', [{ Type: 0, NumTracks: 2, TrackIndex: ref(0, 1), CommandIndex: 65535, NumActionTracks: 0 }]),
    TrackTable: table('TrackTable', [{ EventIndex: 0, CommandIndex: 0 }, { EventIndex: 1, CommandIndex: 1 }]),
    TrackEventTable: table('TrackEventTable', [{ Command: note(0) }, { Command: note(1) }]),
    TrackCommandTable: table('TrackCommandTable', [{ Command: selector(1) }, { Command: selector(2) }]),
    StringValueTable: table('StringValueTable', [{ StringValue: 'Options_Tap_Inst' }, { StringValue: 'Default' }, { StringValue: 'Woodblock' }]),
    SynthTable: table('SynthTable', [
      { Type: 0, ReferenceItems: ref(cycle ? 2 : 1, 0), CommandIndex: 65535, NumActionTracks: 0 },
      { Type: 0, ReferenceItems: ref(1, 1), CommandIndex: 65535, NumActionTracks: 0 },
    ]),
    WaveformTable: table('WaveformTable', [{ Streaming: 0, EncodeType: 0, MemoryAwbId: 9, SamplingRate: 48000, NumSamples: 12 }, { Streaming: 0, EncodeType: 0, MemoryAwbId: 10, SamplingRate: 48000, NumSamples: 12 }]),
    AwbFile: writeAfs2([{ id: 9, bytes: adx }, { id: 10, bytes: adx }]),
  }]);
}

test('cue traversal follows UTF references and selects only the named Default tap instrument', () => {
  const layers = extractCueLayers(fixture(), 'hit');
  assert.deepEqual(layers.map(layer => layer.waveformId), [9]);
  assert.equal(layers[0].sampleRate, 48000);
  assert.throws(() => extractCueLayers(fixture(), 'missing'), /没有 missing/);
});
test('cue traversal rejects recursive synth references', () => {
  assert.throws(() => extractCueLayers(fixture(true), 'hit'), /循环/);
});

const game = process.env.CHUNITHM_GAME_PATH ?? '/mnt/d/chunithm';
const source = path.join(game, 'data/sound/chu.acb');
let available = true; try { await access(source); } catch { available = false; }
test('decrypts real ADX9 cues into transient PCM without clipped noise, and reuses content caches', { skip: !available, timeout: 60000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'chuni-game-audio-test-'));
  try {
    const original = await readFile(source), before = createHash('sha256').update(original).digest('hex');
    const tap = extractCueLayers(original, 'se_touch_tap_jcritical_action');
    assert.equal(tap.length, 1, 'Other tap instrument choices must not play simultaneously.');
    assert.equal(tap[0].bytes.readUInt16BE(0x12), 0x0409, 'The regression fixture must exercise encrypted ADX9.');
    const corrupt = Buffer.from(tap[0].bytes), dataOffset = corrupt.readUInt16BE(2) + 4, frameSize = corrupt[5];
    let corruptFrame = dataOffset;
    while (corrupt.subarray(corruptFrame, corruptFrame + frameSize).every(value => value === 0)) corruptFrame += frameSize;
    corrupt[corruptFrame] ^= 0x10;
    const corruptPath = path.join(temp, 'invalid-scale.adx'), rejectedWav = path.join(temp, 'must-not-exist.wav');
    await writeFile(corruptPath, corrupt);
    await assert.rejects(decodeAdx(corruptPath, rejectedWav), /ADX9 decrypted scale validation failed/);
    await assert.rejects(access(rejectedWav), { code: 'ENOENT' });
    assert.equal(extractCueLayers(original, 'se_air_cut_up').length, 1, 'Speaker and headphone routes must not be duplicated.');
    const imported = await loadGameHitSounds(game, temp);
    assert.equal(Object.keys(imported.sounds).length, 8);
    assert.equal(imported.sounds.airCrush, undefined);
    assert.equal(imported.sounds.hold?.layers.length, 2);
    assert.deepEqual(imported.sounds.hold?.layers, imported.sounds.slide?.layers);
    assert.ok(imported.warnings.some(w => w.includes('AIR-CRUSH')));
    const paths = [...new Set(Object.values(imported.sounds).flatMap(sound => sound.layers.map(layer => layer.path)))];
    assert.equal(paths.length, 8);
    const times = new Map<string, number>();
    for (const file of paths) {
      assert.ok(file.startsWith(temp + path.sep));
      const wav = await readFile(file);
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      let samples = Buffer.alloc(0);
      for (let p = 12; p + 8 <= wav.length;) {
        const size = wav.readUInt32LE(p + 4), tag = wav.toString('ascii', p, p + 4);
        if (tag === 'fmt ') { assert.equal(wav.readUInt16LE(p + 8), 1); assert.equal(wav.readUInt16LE(p + 10), 2); assert.equal(wav.readUInt32LE(p + 12), 48000); }
        if (tag === 'data') samples = wav.subarray(p + 8, p + 8 + size);
        p += 8 + size + (size & 1);
      }
      assert.ok(samples.length > 1000 && samples.some(value => value !== 0), 'Decoded game sound must contain non-silent PCM.');
      let energy = 0, tailEnergy = 0, clipping = 0;
      const count = samples.length / 2, tailStart = Math.floor(count * 0.9);
      for (let i = 0; i < count; i++) {
        const value = samples.readInt16LE(i * 2); energy += value * value;
        if (i >= tailStart) tailEnergy += value * value;
        if (Math.abs(value) >= 32760) clipping++;
      }
      const rms = Math.sqrt(energy / count), tailRms = Math.sqrt(tailEnergy / (count - tailStart));
      // The decoded native EX fire sample contains some saturation (~1.7%).
      // The broken encrypted-as-PCM path clips 5–25% and never decays at its tail.
      assert.ok(clipping / count < 0.03, `ADX9 must be decrypted before PCM conversion; clipped fraction=${clipping / count}, RMS=${rms}`);
      assert.ok(tailRms < rms * 0.2, `A decaying hit must not contain persistent high-energy noise: RMS=${rms}, tail=${tailRms}`);
      times.set(file, (await stat(file)).mtimeMs);
    }
    const again = await loadGameHitSounds(game, temp);
    assert.deepEqual(again, imported);
    for (const file of paths) assert.equal((await stat(file)).mtimeMs, times.get(file));
    await assert.rejects(loadGameHitSounds(game, path.join(game, 'data/sound/exported')), /不能位于原游戏目录/);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
