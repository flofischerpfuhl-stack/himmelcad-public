import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const screenshots = path.join(repoRoot, 'target/viewer-kernel-e2e/screenshots');
const webGpuPath = path.join(screenshots, 'entity-zoo-webgpu-real-opened.png');
const webGl2Path = path.join(screenshots, 'entity-zoo-webgl2-real-opened.png');

const webGpu = decodePng(await readFile(webGpuPath));
const webGl2 = decodePng(await readFile(webGl2Path));
assert.equal(webGpu.width, webGl2.width);
assert.equal(webGpu.height, webGl2.height);

const background = { x: 900, y: 100, width: 64, height: 64 };
const opaqueRegions = [
  { name: 'outer-ground', x: 1016, y: 516, width: 8, height: 8 },
  { name: 'pink-wall', x: 696, y: 496, width: 8, height: 8 },
  {
    name: 'purple-solid',
    x: 826,
    y: 351,
    width: 8,
    height: 8,
    expected: [200 / 255, 124 / 255, 250 / 255],
  },
];
const materialPixels = [
  { name: 'blue-solid', x: 700, y: 400, expected: [129, 191, 243] },
  { name: 'pink-solid', x: 520, y: 290, expected: [246, 144, 221] },
];

const webGpuBackground = regionMean(webGpu, background);
const webGl2Background = regionMean(webGl2, background);
const expectedClear = [22 / 255, 31 / 255, 43 / 255];
assertChannelsClose(webGpuBackground, expectedClear, 2 / 255, 'WebGPU linear clear transfer');
assertChannelsClose(webGl2Background, expectedClear, 2 / 255, 'WebGL2 linear clear transfer');
assertChannelsClose(webGpuBackground, webGl2Background, 1 / 255, 'backend clear parity');

const regions = {};
for (const region of opaqueRegions) {
  const webGpuMean = regionMean(webGpu, region);
  const webGl2Mean = regionMean(webGl2, region);
  assertChannelsClose(webGpuMean, webGl2Mean, 3 / 255, `${region.name} color parity`);
  if (region.expected !== undefined) {
    assertChannelsClose(webGpuMean, region.expected, 3 / 255, `${region.name} WebGPU color`);
    assertChannelsClose(webGl2Mean, region.expected, 3 / 255, `${region.name} WebGL2 color`);
  }
  regions[region.name] = { webGpu: webGpuMean, webGl2: webGl2Mean };
}
const pixels = {};
for (const probe of materialPixels) {
  const webGpuPixel = pixelRgb(webGpu, probe.x, probe.y);
  const webGl2Pixel = pixelRgb(webGl2, probe.x, probe.y);
  const expected = probe.expected.map((channel) => channel / 255);
  assertChannelsClose(webGpuPixel, expected, 1 / 255, `${probe.name} WebGPU pixel`);
  assertChannelsClose(webGl2Pixel, expected, 1 / 255, `${probe.name} WebGL2 pixel`);
  assertChannelsClose(webGpuPixel, webGl2Pixel, 1 / 255, `${probe.name} pixel parity`);
  pixels[probe.name] = { webGpu: webGpuPixel, webGl2: webGl2Pixel };
}

let squaredError = 0;
const webGpuGlobal = [0, 0, 0];
const webGl2Global = [0, 0, 0];
const pixelCount = webGpu.width * webGpu.height;
for (let offset = 0; offset < webGpu.pixels.byteLength; offset += webGpu.channels) {
  for (let channel = 0; channel < 3; channel += 1) {
    const left = webGpu.pixels[offset + channel] / 255;
    const right = webGl2.pixels[offset + channel] / 255;
    const error = left - right;
    squaredError += error * error;
    webGpuGlobal[channel] += left;
    webGl2Global[channel] += right;
  }
}
const rmse = Math.sqrt(squaredError / (pixelCount * 3));
const webGpuMean = webGpuGlobal.map((sum) => sum / pixelCount);
const webGl2Mean = webGl2Global.map((sum) => sum / pixelCount);
assert(
  rmse <= 0.03,
  `cross-backend frame RMSE ${rmse.toFixed(6)} exceeds transparency/rasterization tolerance`,
);
assertChannelsClose(webGpuMean, webGl2Mean, 0.02, 'global frame mean parity');

process.stdout.write(`${JSON.stringify({
  rmse,
  background: { webGpu: webGpuBackground, webGl2: webGl2Background },
  globalMean: { webGpu: webGpuMean, webGl2: webGl2Mean },
  regions,
  pixels,
}, null, 2)}\n`);

function assertChannelsClose(actual, expected, tolerance, label) {
  for (let channel = 0; channel < 3; channel += 1) {
    assert(
      Math.abs(actual[channel] - expected[channel]) <= tolerance,
      `${label} channel ${channel} differs: ${actual[channel]} versus ${expected[channel]} ` +
        `(tolerance ${tolerance})`,
    );
  }
}

function regionMean(image, region) {
  assert(region.x >= 0 && region.y >= 0);
  assert(region.x + region.width <= image.width);
  assert(region.y + region.height <= image.height);
  const sum = [0, 0, 0];
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      for (let channel = 0; channel < 3; channel += 1) {
        sum[channel] += image.pixels[offset + channel] / 255;
      }
    }
  }
  const samples = region.width * region.height;
  return sum.map((value) => value / samples);
}

function pixelRgb(image, x, y) {
  assert(x >= 0 && x < image.width && y >= 0 && y < image.height);
  const offset = (y * image.width + x) * image.channels;
  return [0, 1, 2].map((channel) => image.pixels[offset + channel] / 255);
}

function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed = [];
  for (let offset = 8; offset < png.byteLength;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'screenshot must use 8-bit PNG samples');
      assert.equal(data[12], 0, 'screenshot must not be interlaced');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert(channels !== 0, `unsupported screenshot PNG color type ${String(data[9])}`);
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const encoded = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[row * (stride + 1)];
    for (let column = 0; column < stride; column += 1) {
      const source = encoded[row * (stride + 1) + 1 + column];
      const output = row * stride + column;
      const left = column >= channels ? pixels[output - channels] : 0;
      const up = row > 0 ? pixels[output - stride] : 0;
      const upperLeft = row > 0 && column >= channels ? pixels[output - stride - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : filter === 4 ? paeth(left, up, upperLeft)
                : Number.NaN;
      assert(Number.isFinite(predictor), `unsupported screenshot PNG filter ${String(filter)}`);
      pixels[output] = (source + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance ? up : upperLeft;
}
