export function sineWav(seconds = 2, frequency = 440): Buffer {
  const sampleRate = 48000,
    frames = Math.round(seconds * sampleRate),
    b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((i * frequency * 2 * Math.PI) / sampleRate) * 16000);
    b.writeInt16LE(sample, 44 + i * 4);
    b.writeInt16LE(sample, 46 + i * 4);
  }
  return b;
}
