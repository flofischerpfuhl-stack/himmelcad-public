#!/usr/bin/env node
/* global console, process */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'vendor', 'photolab-models', 'colmap-4.1.0');
const force = process.argv.includes('--force');
const artifacts = [
  {
    name: 'aliked-n16rot.onnx',
    sha256: '39c423d0a6f03d39ec89d3d1d61853765c2fb6a8b8381376c703e5758778a547',
  },
  {
    name: 'aliked-n32.onnx',
    sha256: 'a077728a02d2de1a775c66df6de8cfeb7c6b51ca57572c64c680131c988c8b3c',
  },
  {
    name: 'aliked-lightglue.onnx',
    sha256: 'b9a5de7204648b18a8cf5dcac819f9d30de1a5961ef03756803c8b86c2dceb8d',
  },
  {
    name: 'sift-lightglue.onnx',
    sha256: 'e0500228472b43f92b3d36881a09b3310d3b058b56187b246cc7b9ab6429096e',
  },
];

await mkdir(destination, { recursive: true });
for (const artifact of artifacts) {
  const path = resolve(destination, artifact.name);
  if (!force && existsSync(path) && (await sha256(path)) === artifact.sha256) {
    console.log(`[photolab-models] ${artifact.name}: verified`);
    continue;
  }
  const url = `https://github.com/colmap/colmap/releases/download/3.13.0/${artifact.name}`;
  const temporary = `${path}.download`;
  await rm(temporary, { force: true });
  console.log(`[photolab-models] ${artifact.name}: downloading pinned upstream artifact`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  await finished(
    Readable.fromWeb(response.body).pipe(createWriteStream(temporary, { flags: 'wx' })),
  );
  const observed = await sha256(temporary);
  if (observed !== artifact.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`${artifact.name}: SHA-256 mismatch (${observed})`);
  }
  await rename(temporary, path);
  console.log(`[photolab-models] ${artifact.name}: installed`);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
