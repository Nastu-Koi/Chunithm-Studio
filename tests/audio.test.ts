import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAudio, encodeHca, decodeGameAudio } from '../src/backend/audio';
import { parseUtf, writeUtf, writeAfs2, parseAfs2, buildCueBank, verifyCueBank } from '../src/backend/cri';
import { sineWav } from './audio-fixture';

const game = process.env.CHUNITHM_GAME_PATH ?? '/mnt/d/chunithm';
const template = path.join(game, 'data/A000/cueFile/cueFile002892/music2892.acb');
let available = true;
try {
  await access(template);
} catch {
  available = false;
}

test('UTF preserves constants, zero values, 64-bit integers and binary payloads when rewritten', () => {
  const table = {
    name: 'synthetic',
    version: 1,
    columns: [
      { name: 'id', type: 4, storage: 0x30 },
      { name: 'title', type: 10, storage: 0x50 },
      { name: 'blob', type: 11, storage: 0x50 },
      { name: 'wide', type: 6, storage: 0x50 },
    ],
    rows: [{ id: 8, title: '自制曲<&>', blob: Buffer.from([0, 255, 1]), wide: 9007199254740993n }],
  };
  const parsed = parseUtf(writeUtf(table));
  assert.equal(parsed.name, table.name);
  assert.deepEqual(parsed.rows, table.rows);
  const damaged = writeUtf(table);
  damaged.writeUInt32BE(0xffffff00, 16);
  assert.throws(() => parseUtf(damaged));
});
test('AFS2 aligns audio blocks and retains IDs, including multiple unequal entries', () => {
  const entries = [
    { id: 4, bytes: Buffer.alloc(19, 0xaa) },
    { id: 12, bytes: Buffer.alloc(53, 0xbb) },
  ];
  assert.deepEqual(parseAfs2(writeAfs2(entries)).entries, entries);
});
test(
  'audio offset shifts the normalized WAV by exactly the rounded number of 48 kHz samples',
  { timeout: 60000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'chuni-offset-'));
    try {
      const input = path.join(temp, 'input.wav'),
        source = sineWav(1);
      await writeFile(input, source);
      const frames = async (offset: number) => {
        const file = path.join(temp, `out${offset}.wav`);
        await prepareAudio(input, file, offset);
        const bytes = await readFile(file),
          data = bytes.indexOf(Buffer.from('data')) + 8;
        return { count: bytes.readUInt32LE(data - 4) / 4, at: (frame: number) => bytes.readInt16LE(data + frame * 4) };
      };
      const original = (frame: number) => source.readInt16LE(44 + frame * 4),
        shift = Math.round(0.0123 * 48000);
      const delayed = await frames(0.0123);
      assert.equal(delayed.count, 48000 + shift);
      for (let frame = 0; frame < shift; frame++) assert.equal(delayed.at(frame), 0);
      for (const frame of [1, 25, 100, 4000, 47999]) assert.equal(delayed.at(frame + shift), original(frame));
      const trimmed = await frames(-0.0123);
      assert.equal(trimmed.count, 48000 - shift);
      for (const frame of [0, 25, 100, 4000]) assert.equal(trimmed.at(frame), original(frame + shift));
      const unchanged = await frames(0.000004);
      assert.equal(unchanged.count, 48000);
      assert.equal(unchanged.at(100), original(100));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
test('installed ACB round-trips without changing any nested resource bytes', { skip: !available }, async () => {
  const original = parseUtf(await readFile(template));
  assert.deepEqual(parseUtf(writeUtf(original)).rows, original.rows);
});
test(
  'real HCA encode, UTF/AFS2 rebuild, preview update and decode preserve dimensions and waveform',
  { skip: !available, timeout: 120000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'chuni-audio-'));
    try {
      const input = path.join(temp, 'input.wav'),
        wav = path.join(temp, 'normalized.wav'),
        hca = path.join(temp, 'encoded.hca');
      await writeFile(input, sineWav(2));
      await prepareAudio(input, wav);
      const info = await encodeHca(wav, hca);
      assert.equal(info.sampleRate, 48000);
      assert.equal(info.channels, 2);
      assert.equal(info.sampleCount, 96000);
      const bank = buildCueBank(await readFile(template), await readFile(hca), 'music7000', info, 0.25, 1.25);
      verifyCueBank(bank.acb, bank.awb, 'music7000', info, 0.25, 1.25);
      const bad = Buffer.from(bank.awb);
      bad[bad.length - 1] ^= 1;
      assert.throws(() => verifyCueBank(bank.acb, bad, 'music7000', info, 0.25, 1.25), /哈希/);
      const acb = path.join(temp, 'music7000.acb'),
        awb = path.join(temp, 'music7000.awb'),
        decoded = path.join(temp, 'decoded.wav');
      await writeFile(acb, bank.acb);
      await writeFile(awb, bank.awb);
      await decodeGameAudio(acb, awb, decoded);
      const decodedPcm = await readFile(decoded);
      const dataOffset = decodedPcm.indexOf(Buffer.from('data')) + 8;
      assert.ok(dataOffset >= 8);
      assert.equal(decodedPcm.readUInt32LE(dataOffset - 4), 96000 * 4);
      let energy = 0,
        error = 0;
      for (let i = 2000; i < 90000; i++) {
        const expected = Math.sin((i * 440 * 2 * Math.PI) / 48000) * 16000,
          actual = decodedPcm.readInt16LE(dataOffset + i * 4);
        energy += expected ** 2;
        error += (actual - expected) ** 2;
      }
      assert.ok(
        10 * Math.log10(energy / error) > 20,
        'Decoded HCA must preserve the generated waveform, not only its header.',
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
