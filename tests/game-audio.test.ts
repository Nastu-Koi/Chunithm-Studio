import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractCue, extractCueLayers, loadGameHitSounds } from '../src/backend/game-audio';
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
    assert.equal(Object.keys(imported.sounds).length, 13);
    assert.equal(imported.sounds.airCrush?.cueName, 'se_air_cut_break');
    assert.equal(imported.sounds.ex?.cueName, 'se_touch_chara_laser');
    assert.equal(imported.sounds.hold?.layers.length, 2);
    assert.deepEqual(imported.sounds.hold?.layers, imported.sounds.slide?.layers);
    assert.ok(imported.warnings.some(w => w.includes('循环音')));
    // Loop waveforms are the only samples that do not decay by themselves; the TAP judgement borrows 50 ms of one.
    const sustained = new Set(Object.values(imported.sounds).flatMap(sound => sound.layers.filter(layer => layer.loop).map(layer => layer.path)));
    assert.equal(sustained.size, 2);
    assert.ok(sustained.has(imported.sounds.tap!.layers[1].path));
    const paths = [...new Set(Object.values(imported.sounds).flatMap(sound => sound.layers.map(layer => layer.path)))];
    assert.equal(paths.length, 12);
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
      if (!sustained.has(file)) assert.ok(tailRms < rms * 0.2, `A decaying hit must not contain persistent high-energy noise: RMS=${rms}, tail=${tailRms}`);
      times.set(file, (await stat(file)).mtimeMs);
    }
    const again = await loadGameHitSounds(game, temp);
    assert.deepEqual(again, imported);
    for (const file of paths) assert.equal((await stat(file)).mtimeMs, times.get(file));
    await assert.rejects(loadGameHitSounds(game, path.join(game, 'data/sound/exported')), /不能位于原游戏目录/);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

const config = path.join(game, 'data/sound/chu.acf');
let configured = available; try { await access(config); } catch { configured = false; }
test('real cues carry their volumes, cue limits and the category limits of the config file', { skip: !configured }, async () => {
  const acb = await readFile(source), acf = await readFile(config);
  const cue = (name: string) => { const result = extractCue(acb, name, acf); return { gains: result.layers.map(layer => Number(layer.gain.toFixed(4))), limits: result.limits, unsupported: result.unsupported }; };
  // Phone_1pass send x cue volume x SE_Game 0.75 x Phone_1pass bus 0.5.
  assert.deepEqual(cue('se_touch_flick_jcritical'), { gains: [.3], limits: [{ key: 'cue:se_touch_flick_jcritical', max: 1 }], unsupported: [] });
  assert.deepEqual(cue('se_touch_chara_laser'), { gains: [.366], limits: [{ key: 'cue:se_touch_chara_laser', max: 1 }], unsupported: [11] });
  // HOLD and SLIDE have no cue limit of their own: they share one voice through their category.
  for (const name of ['se_touch_hold_jcritical', 'se_touch_slide_jcritical'])
    assert.deepEqual(cue(name), { gains: [.3, .3], limits: [{ key: 'category:Limit_HoldSlideCritical', max: 1 }], unsupported: [] });
  assert.deepEqual(cue('se_touch_tap_jcritical_action').limits, [{ key: 'cue:se_touch_tap_jcritical_action', max: 1 }, { key: 'category:Limit_Tap', max: 1 }]);
  assert.deepEqual(cue('se_touch_tap_jcritical_action').gains, [.57]);
  // Without the config file only the bank's own parameters apply.
  assert.deepEqual(extractCue(acb, 'se_touch_flick_jcritical').layers.map(layer => layer.gain), [.8]);
});

test('real cues carry their pitch, envelope and the cues their action tracks start and stop', { skip: !configured }, async () => {
  const acb = await readFile(source), acf = await readFile(config);
  const layers = (name: string) => extractCue(acb, name, acf).layers.map(layer => ({ wave: layer.waveformId, rate: Number(layer.playbackRate.toFixed(4)), envelope: layer.envelope, stopAfter: layer.stopAfter }));
  // Pitch in cents: FLICK +500, AIR down +200; the AIR hold beat reuses the FLICK waveform unpitched.
  assert.deepEqual(layers('se_touch_flick_jcritical'), [{ wave: 67, rate: 1.3348, envelope: undefined, stopAfter: undefined }]);
  assert.deepEqual(layers('se_air_hold_beat'), [{ wave: 67, rate: 1, envelope: undefined, stopAfter: undefined }]);
  assert.equal(layers('se_air_cut_down')[0].rate, 1.1225);
  // HOLD: 20 ms at full level, then each layer decays to its own sustain level; a stop releases over 500 ms.
  assert.deepEqual(layers('se_touch_hold_jcritical').map(layer => layer.envelope), [
    { attack: 0, hold: .02, decay: .1, sustain: .4, release: .5 }, { attack: 0, hold: .02, decay: .13, sustain: .1, release: .5 }]);
  // The TAP judgement the game plays has no waveform of its own: it starts two cues and stops both 50 ms later.
  const tap = extractCue(acb, 'se_touch_tap_jcritical', acf);
  assert.deepEqual(layers('se_touch_tap_jcritical'), [
    { wave: 286, rate: 1.1225, envelope: { attack: 0, hold: 0, decay: 0, sustain: 1, release: .5 }, stopAfter: .05 },
    { wave: 283, rate: 1, envelope: { attack: 0, hold: 0, decay: 0, sustain: 1, release: .5 }, stopAfter: .05 }]);
  // A HOLD start: the loop on one of its four equal tracks, and the whole TAP sample, each under its own limits.
  const start = extractCue(acb, 'se_touch_hold_jcritical_loop', acf);
  assert.deepEqual(start.layers.map(layer => [layer.waveformId, Number(layer.gain.toFixed(4)), layer.stopAfter, layer.group, layer.loop && [Number(layer.loop.start.toFixed(3)), Number(layer.loop.end.toFixed(3))]]),
    [[283, .3375, undefined, 1, [2.048, 2.904]], [286, .57, undefined, 2, undefined]]);
  assert.deepEqual(start.limits, [{ key: 'cue:se_touch_hold_loop', max: 4, group: 1 }, { key: 'cue:se_touch_tap_jcritical_action', max: 1, group: 2 }, { key: 'category:Limit_Tap', max: 1, group: 2 }]);
  assert.deepEqual(tap.layers.map(layer => Number(layer.gain.toFixed(4))), [.57, .1125]);
  assert.deepEqual(tap.limits.map(limit => limit.group), [undefined, 1, 1, 2]);
  assert.deepEqual(tap.limits.map(limit => limit.key), ['cue:se_touch_tap_jcritical', 'cue:se_touch_tap_jcritical_action', 'category:Limit_Tap', 'cue:se_touch_tap_loop_action']);
  assert.deepEqual(tap.notes, ['aisac:se_touch_tap_jcritical_action', 'aisac:se_touch_tap_loop_action', 'curve:se_touch_tap_loop_action']);
});
