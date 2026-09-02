#!/usr/bin/env node

/**
 * Unit tests for the dependency-free PNG codec and pixel comparator that backs
 * the PhotoLab visual-regression baselines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { compareImages, comparePngBuffers, decodePng, encodePng } from './lib/png-compare.mjs';

const solid = (width, height, [red, green, blue, alpha = 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = red;
    data[index * 4 + 1] = green;
    data[index * 4 + 2] = blue;
    data[index * 4 + 3] = alpha;
  }
  return { width, height, data };
};

const withBlock = (image, x0, y0, blockWidth, blockHeight, [red, green, blue, alpha = 255]) => {
  const data = Uint8Array.from(image.data);
  for (let y = y0; y < y0 + blockHeight; y += 1)
    for (let x = x0; x < x0 + blockWidth; x += 1) {
      const target = (y * image.width + x) * 4;
      data[target] = red;
      data[target + 1] = green;
      data[target + 2] = blue;
      data[target + 3] = alpha;
    }
  return { width: image.width, height: image.height, data };
};

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

const crc32 = (buffer) => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const chunk = (type, payload) => {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
};

/** Builds a truecolour (colour type 2) PNG whose scanlines use every filter. */
const buildFilteredTruecolourPng = (width, height, pixelAt) => {
  const stride = width * 3;
  const raw = [];
  const previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixelAt(x, y);
      line[x * 3] = red;
      line[x * 3 + 1] = green;
      line[x * 3 + 2] = blue;
    }
    const filterType = y % 5;
    const encoded = new Uint8Array(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= 3 ? line[index - 3] : 0;
      const above = previous[index];
      const upperLeft = index >= 3 ? previous[index - 3] : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = above;
      else if (filterType === 3) predictor = (left + above) >> 1;
      else if (filterType === 4) {
        const estimate = left + above - upperLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceAbove = Math.abs(estimate - above);
        const distanceUpperLeft = Math.abs(estimate - upperLeft);
        predictor =
          distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft
            ? left
            : distanceAbove <= distanceUpperLeft
              ? above
              : upperLeft;
      }
      encoded[index] = (line[index] - predictor) & 0xff;
    }
    raw.push(Buffer.from([filterType]), Buffer.from(encoded));
    previous.set(line);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

test('encode/decode round-trips RGBA pixels', () => {
  const image = withBlock(solid(9, 7, [10, 20, 30, 255]), 2, 3, 4, 2, [200, 100, 50, 128]);
  const decoded = decodePng(encodePng(image));
  assert.equal(decoded.width, 9);
  assert.equal(decoded.height, 7);
  assert.deepEqual([...decoded.data], [...image.data]);
});

test('encoding is deterministic for identical pixels', () => {
  const image = withBlock(solid(16, 16, [1, 2, 3, 255]), 4, 4, 8, 8, [250, 240, 230, 255]);
  assert.ok(encodePng(image).equals(encodePng({ ...image, data: Uint8Array.from(image.data) })));
});

test('decodes every PNG scanline filter in a truecolour image', () => {
  const pixelAt = (x, y) => [(x * 17 + y * 3) & 0xff, (x * 5 + y * 29) & 0xff, (x ^ y) & 0xff];
  const decoded = decodePng(buildFilteredTruecolourPng(12, 10, pixelAt));
  for (let y = 0; y < 10; y += 1)
    for (let x = 0; x < 12; x += 1) {
      const target = (y * 12 + x) * 4;
      assert.deepEqual(
        [decoded.data[target], decoded.data[target + 1], decoded.data[target + 2]],
        pixelAt(x, y),
        `pixel ${x},${y}`,
      );
      assert.equal(decoded.data[target + 3], 255);
    }
});

test('identical images report zero differing pixels', () => {
  const image = withBlock(solid(40, 20, [12, 34, 56, 255]), 5, 5, 10, 10, [200, 10, 10, 255]);
  const result = comparePngBuffers(encodePng(image), encodePng(image));
  assert.equal(result.sizeMismatch, false);
  assert.equal(result.differingPixels, 0);
  assert.equal(result.ratio, 0);
  assert.equal(result.maxChannelDelta, 0);
});

test('one changed block reports exactly its pixel share', () => {
  const baseline = solid(100, 100, [0, 0, 0, 255]);
  const actual = withBlock(baseline, 10, 10, 20, 5, [255, 255, 255, 255]);
  const result = compareImages(actual, baseline);
  assert.equal(result.differingPixels, 100);
  assert.equal(result.totalPixels, 10_000);
  assert.equal(result.ratio, 0.01);
  assert.equal(result.maxChannelDelta, 255);
});

test('per-channel tolerance absorbs sub-threshold jitter and catches the next step', () => {
  const baseline = solid(20, 20, [100, 100, 100, 255]);
  const withinTolerance = solid(20, 20, [116, 100, 100, 255]);
  const beyondTolerance = solid(20, 20, [117, 100, 100, 255]);
  assert.equal(compareImages(withinTolerance, baseline).differingPixels, 0);
  assert.equal(compareImages(withinTolerance, baseline).maxChannelDelta, 16);
  assert.equal(compareImages(beyondTolerance, baseline).differingPixels, 400);
  const strict = compareImages(withinTolerance, baseline, { channelTolerance: 0 });
  assert.equal(strict.differingPixels, 400);
});

test('the 0.1 % release threshold separates jitter from a layout shift', () => {
  const baseline = solid(1000, 100, [20, 20, 20, 255]);
  const jitter = withBlock(baseline, 0, 0, 99, 1, [255, 255, 255, 255]);
  const shift = withBlock(baseline, 0, 0, 101, 1, [255, 255, 255, 255]);
  assert.ok(compareImages(jitter, baseline).ratio <= 0.001);
  assert.ok(compareImages(shift, baseline).ratio > 0.001);
});

test('a size mismatch is flagged and the extra area counts as differing', () => {
  const baseline = solid(10, 10, [0, 0, 0, 255]);
  const actual = solid(12, 10, [0, 0, 0, 255]);
  const result = compareImages(actual, baseline);
  assert.equal(result.sizeMismatch, true);
  assert.equal(result.width, 12);
  assert.equal(result.differingPixels, 20);
});

test('the diff image marks differing pixels magenta and is itself a valid PNG', () => {
  const baseline = solid(30, 30, [0, 0, 0, 255]);
  const actual = withBlock(baseline, 0, 0, 3, 3, [255, 255, 255, 255]);
  const result = compareImages(actual, baseline);
  const diff = decodePng(encodePng(result.diff));
  assert.deepEqual([diff.data[0], diff.data[1], diff.data[2], diff.data[3]], [255, 0, 255, 255]);
  const untouched = (29 * 30 + 29) * 4;
  assert.deepEqual(
    [diff.data[untouched], diff.data[untouched + 1], diff.data[untouched + 2]],
    [178, 178, 178],
  );
});

test('unsupported PNG variants fail loudly instead of guessing', () => {
  assert.throws(() => decodePng(Buffer.alloc(8)), /signature mismatch/);
  const png = encodePng(solid(4, 4, [1, 2, 3, 255]));
  const interlaced = Buffer.from(png);
  interlaced[8 + 8 + 12] = 1;
  assert.throws(() => decodePng(interlaced), /interlaced/);
});
