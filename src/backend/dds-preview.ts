/** Decode common legacy DDS jackets to RGBA without executing an external image tool. */
export function decodeDDS(buffer: Buffer): { width: number; height: number; data: Buffer } {
  if (buffer.toString('ascii', 0, 4) !== 'DDS ' || buffer.length < 128) throw new Error('DDS 文件头无效');
  const width = buffer.readUInt32LE(16),
    height = buffer.readUInt32LE(12);
  if (width < 1 || height < 1 || width * height > 16777216) throw new Error('DDS 尺寸不受支持');
  const data = Buffer.alloc(width * height * 4),
    fourcc = buffer.toString('ascii', 84, 88);
  if (!['DXT1', 'DXT3', 'DXT5'].includes(fourcc)) {
    const bytesPerPixel = buffer.readUInt32LE(88) / 8;
    if (![2, 4].includes(bytesPerPixel) || buffer.length < 128 + width * height * bytesPerPixel)
      throw new Error(`不支持的 DDS 格式：${fourcc}`);
    const masks = [92, 96, 100, 104].map(o => buffer.readUInt32LE(o));
    for (let i = 0; i < width * height; i++) {
      const v = bytesPerPixel === 2 ? buffer.readUInt16LE(128 + i * 2) : buffer.readUInt32LE(128 + i * 4);
      for (let k = 0; k < 4; k++) {
        if (!masks[k]) {
          data[i * 4 + k] = k === 3 ? 255 : 0;
          continue;
        }
        const shift = Math.log2((masks[k] & -masks[k]) >>> 0);
        data[i * 4 + k] = Math.round((((v & masks[k]) >>> shift) * 255) / (masks[k] >>> shift));
      }
    }
    return { width, height, data };
  }
  const blockSize = fourcc === 'DXT1' ? 8 : 16;
  const color = (v: number): number[] => [
    Math.round((((v >> 11) & 31) * 255) / 31),
    Math.round((((v >> 5) & 63) * 255) / 63),
    Math.round(((v & 31) * 255) / 31),
    255,
  ];
  let offset = 128;
  for (let by = 0; by < height; by += 4)
    for (let bx = 0; bx < width; bx += 4) {
      if (offset + blockSize > buffer.length) throw new Error('DDS 像素数据不完整');
      const colorOffset = offset + (fourcc === 'DXT1' ? 0 : 8);
      const a = buffer.readUInt16LE(colorOffset),
        b = buffer.readUInt16LE(colorOffset + 2);
      const colors = [color(a), color(b)];
      if (a > b || fourcc !== 'DXT1') {
        colors.push(colors[0].map((v, i) => (i === 3 ? 255 : Math.round((v * 2 + colors[1][i]) / 3))));
        colors.push(colors[0].map((v, i) => (i === 3 ? 255 : Math.round((v + colors[1][i] * 2) / 3))));
      } else {
        colors.push(colors[0].map((v, i) => (i === 3 ? 255 : Math.round((v + colors[1][i]) / 2))));
        colors.push([0, 0, 0, 0]);
      }
      const codes = buffer.readUInt32LE(colorOffset + 4);
      let alphaBits = 0n;
      const alphas = [buffer[offset], buffer[offset + 1]];
      if (fourcc === 'DXT5') {
        for (let i = 0; i < 6; i++) alphaBits |= BigInt(buffer[offset + 2 + i]) << BigInt(i * 8);
        if (alphas[0] > alphas[1])
          for (let i = 1; i <= 6; i++) alphas.push(Math.round(((7 - i) * alphas[0] + i * alphas[1]) / 7));
        else {
          for (let i = 1; i <= 4; i++) alphas.push(Math.round(((5 - i) * alphas[0] + i * alphas[1]) / 5));
          alphas.push(0, 255);
        }
      }
      for (let py = 0; py < 4; py++)
        for (let px = 0; px < 4; px++) {
          const index = py * 4 + px,
            x = bx + px,
            y = by + py;
          if (x >= width || y >= height) continue;
          const c = [...colors[(codes >>> (index * 2)) & 3]];
          if (fourcc === 'DXT3') c[3] = ((buffer[offset + Math.floor(index / 2)] >> ((index % 2) * 4)) & 15) * 17;
          if (fourcc === 'DXT5') c[3] = alphas[Number((alphaBits >> BigInt(index * 3)) & 7n)];
          for (let k = 0; k < 4; k++) data[(y * width + x) * 4 + k] = c[k];
        }
      offset += blockSize;
    }
  return { width, height, data };
}
