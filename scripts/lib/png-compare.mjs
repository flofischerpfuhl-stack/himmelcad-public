/**
 * Dependency-free PNG decode/encode and pixel comparison for the PhotoLab
 * visual-regression baselines.
 *
 * Scope is deliberately narrow: 8-bit non-interlaced PNGs in greyscale,
 * greyscale+alpha, truecolour and truecolour+alpha, which is exactly what
 * Chromium writes for `page.screenshot()`. Anything else throws instead of
 * silently guessing, so a baseline can never pass by accident.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (0xed_b8_83_20 ^ (value >>> 1)) >>> 0 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xff_ff_ff_ff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

/**
 * Decode a PNG into straight RGBA bytes.
 *
 * @param {Buffer|Uint8Array} input raw PNG file contents.
 * @returns {{width: number, height: number, data: Uint8Array}} RGBA pixels.
 */
export function decodePng(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE))
    throw new Error('Not a PNG file: signature mismatch');
  let offset = 8;
  let header;
  let palette;
  let paletteAlpha;
  const idatParts = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`Truncated PNG chunk ${type}`);
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR')
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') paletteAlpha = Buffer.from(data);
    else if (type === 'IDAT') idatParts.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (!header) throw new Error('PNG has no IHDR chunk');
  if (header.bitDepth !== 8)
    throw new Error(`Unsupported PNG bit depth ${header.bitDepth} (only 8 is supported)`);
  if (header.interlace !== 0) throw new Error('Unsupported interlaced PNG');
  const indexed = header.colorType === 3;
  const channels = indexed ? 1 : CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${header.colorType}`);
  if (indexed && !palette) throw new Error('Indexed PNG without PLTE chunk');
  if (idatParts.length === 0) throw new Error('PNG has no IDAT data');

  const raw = inflateSync(Buffer.concat(idatParts));
  const { width, height } = header;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height)
    throw new Error(`PNG IDAT is short: ${raw.length} bytes for ${(stride + 1) * height} expected`);

  const scanlines = Buffer.allocUnsafe(stride * height);
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filterType = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const current = scanlines.subarray(row * stride, (row + 1) * stride);
    for (let index = 0; index < stride; index += 1) {
      const rawByte = line[index];
      const left = index >= channels ? current[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      let value;
      if (filterType === 0) value = rawByte;
      else if (filterType === 1) value = rawByte + left;
      else if (filterType === 2) value = rawByte + above;
      else if (filterType === 3) value = rawByte + ((left + above) >> 1);
      else if (filterType === 4) value = rawByte + paethPredictor(left, above, upperLeft);
      else throw new Error(`Unsupported PNG filter type ${filterType} on row ${row}`);
      current[index] = value & 0xff;
    }
    previous = current;
  }

  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (indexed) {
      const entry = scanlines[source] * 3;
      data[target] = palette[entry];
      data[target + 1] = palette[entry + 1];
      data[target + 2] = palette[entry + 2];
      data[target + 3] = paletteAlpha?.[scanlines[source]] ?? 255;
    } else if (channels === 1) {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source];
      data[target + 2] = scanlines[source];
      data[target + 3] = 255;
    } else if (channels === 2) {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source];
      data[target + 2] = scanlines[source];
      data[target + 3] = scanlines[source + 1];
    } else if (channels === 3) {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source + 1];
      data[target + 2] = scanlines[source + 2];
      data[target + 3] = 255;
    } else {
      data[target] = scanlines[source];
      data[target + 1] = scanlines[source + 1];
      data[target + 2] = scanlines[source + 2];
      data[target + 3] = scanlines[source + 3];
    }
  }
  return { width, height, data };
}

function chunk(type, payload) {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

/**
 * Encode straight RGBA bytes as a deterministic 8-bit RGBA PNG.
 *
 * Every scanline uses filter 0 and a fixed deflate level, so the same pixels
 * always produce the same bytes.
 *
 * @param {{width: number, height: number, data: Uint8Array}} image RGBA pixels.
 * @returns {Buffer} PNG file contents.
 */
export function encodePng({ width, height, data }) {
  if (data.length !== width * height * 4)
    throw new Error(`RGBA buffer length ${data.length} does not match ${width}x${height}`);
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Compare two decoded RGBA images pixel by pixel.
 *
 * A pixel counts as differing when any of its four channels deviates by more
 * than `channelTolerance`. The tolerance absorbs the sub-visual antialiasing
 * jitter Chromium produces between runs without hiding a real layout shift,
 * which always moves whole glyph or border runs far beyond it.
 *
 * @param {{width: number, height: number, data: Uint8Array}} actual captured image.
 * @param {{width: number, height: number, data: Uint8Array}} baseline stored image.
 * @param {{channelTolerance?: number}} [options] comparison options.
 * @returns {{sizeMismatch: boolean, width: number, height: number, totalPixels: number,
 *   differingPixels: number, ratio: number, maxChannelDelta: number,
 *   diff: {width: number, height: number, data: Uint8Array}}} comparison result.
 */
export function compareImages(actual, baseline, { channelTolerance = 16 } = {}) {
  const sizeMismatch = actual.width !== baseline.width || actual.height !== baseline.height;
  const width = Math.max(actual.width, baseline.width);
  const height = Math.max(actual.height, baseline.height);
  const totalPixels = width * height;
  const diff = new Uint8Array(totalPixels * 4);
  let differingPixels = 0;
  let maxChannelDelta = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const inActual = x < actual.width && y < actual.height;
      const inBaseline = x < baseline.width && y < baseline.height;
      let differs = !inActual || !inBaseline;
      let grey = 255;
      if (inActual) {
        const source = (y * actual.width + x) * 4;
        grey = Math.round(
          (actual.data[source] * 0.299 +
            actual.data[source + 1] * 0.587 +
            actual.data[source + 2] * 0.114) *
            0.3 +
            178,
        );
        if (inBaseline) {
          const other = (y * baseline.width + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            const delta = Math.abs(actual.data[source + channel] - baseline.data[other + channel]);
            if (delta > maxChannelDelta) maxChannelDelta = delta;
            if (delta > channelTolerance) differs = true;
          }
        }
      }
      if (differs) {
        differingPixels += 1;
        diff[target] = 255;
        diff[target + 1] = 0;
        diff[target + 2] = 255;
      } else {
        diff[target] = grey;
        diff[target + 1] = grey;
        diff[target + 2] = grey;
      }
      diff[target + 3] = 255;
    }
  return {
    sizeMismatch,
    width,
    height,
    totalPixels,
    differingPixels,
    ratio: totalPixels === 0 ? 0 : differingPixels / totalPixels,
    maxChannelDelta,
    diff: { width, height, data: diff },
  };
}

/**
 * Compare two PNG buffers.
 *
 * @param {Buffer|Uint8Array} actualPng captured PNG bytes.
 * @param {Buffer|Uint8Array} baselinePng stored PNG bytes.
 * @param {{channelTolerance?: number}} [options] comparison options.
 * @returns {ReturnType<typeof compareImages>} comparison result.
 */
export function comparePngBuffers(actualPng, baselinePng, options) {
  return compareImages(decodePng(actualPng), decodePng(baselinePng), options);
}
