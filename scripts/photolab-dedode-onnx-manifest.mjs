#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const modelRoot = join(root, 'vendor', 'dedode', 'onnx');
const output = join(root, 'vendor', 'dedode', 'ONNX_MODELS.json');
const check = process.argv.includes('--check');

const files = collect(modelRoot)
  .map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(modelRoot, path).replaceAll('\\', '/'),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const manifest = `${JSON.stringify(
  {
    schemaVersion: 1,
    backend: 'dedode-v2-g',
    format: 'ONNX external data',
    opset: 17,
    numericMode: 'float32',
    sourceCommit: '6d156183f4dc84cd704ae779eebc8350995c5b06',
    profiles: [
      { width: 784, height: 784, maxKeypoints: 20_000 },
      { width: 1_176, height: 1_176, maxKeypoints: 40_000 },
    ],
    sourceWeights: {
      detector: '4113809dd9e0367af013a45fc2255a6b243ff241cd06520d17a65d9e231bdc17',
      descriptor: 'ef6e3f2911bb3c179960db15545a2137d0746054bb5bad75559524ccab1fee41',
      dinov2: 'd5383ea8f4877b2472eb973e0fd72d557c7da5d3611bd527ceeb1d7162cbf428',
    },
    files,
  },
  null,
  2,
)}\n`;

if (check) {
  if (readFileSync(output, 'utf8') !== manifest) {
    throw new Error('DeDoDe ONNX manifest differs from the model directory');
  }
  process.stdout.write(`DeDoDe ONNX manifest verified: ${files.length} files\n`);
} else {
  writeFileSync(output, manifest);
  process.stdout.write(`DeDoDe ONNX manifest written: ${files.length} files\n`);
}

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    if (!entry.isFile() || statSync(path).size === 0) {
      throw new Error(`invalid model payload: ${relative(root, path)}`);
    }
    return [path];
  });
}
