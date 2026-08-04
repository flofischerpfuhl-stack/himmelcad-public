#!/usr/bin/env node
/* global fetch */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const root = resolve(import.meta.dirname, '..');
const version = '20260407';
const directoryName = `llvm-mingw-${version}-ucrt-ubuntu-22.04-x86_64`;
const buildRoot = join(root, '.build', 'llvm-mingw');
const destination = join(buildRoot, directoryName);
const archive = join(buildRoot, 'toolchain.tar.xz');
const url = `https://github.com/mstorsjo/llvm-mingw/releases/download/${version}/${directoryName}.tar.xz`;
const expectedSha256 = 'c39aeb4823bbc89ce2a40820964a114614a524c2cb7be1e3dafd16f780fa39b1';

if (existsSync(join(destination, 'bin', 'x86_64-w64-mingw32-clang'))) {
  process.stdout.write(`Pinned LLVM-MinGW already present: ${destination}\n`);
  process.exit(0);
}

await mkdir(buildRoot, { recursive: true });
if (!existsSync(archive) || (await sha256(archive)) !== expectedSha256) {
  await rm(archive, { force: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(archive, { flags: 'wx' })));
}

const observedSha256 = await sha256(archive);
if (observedSha256 !== expectedSha256) {
  throw new Error(`LLVM-MinGW SHA-256 mismatch: expected ${expectedSha256}, got ${observedSha256}`);
}

const extraction = spawnSync('tar', ['-xJf', archive, '-C', buildRoot], { stdio: 'inherit' });
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) process.exit(extraction.status ?? 1);
if (!existsSync(join(destination, 'bin', 'x86_64-w64-mingw32-clang'))) {
  throw new Error(`LLVM-MinGW extraction did not create ${destination}`);
}
process.stdout.write(`Pinned LLVM-MinGW installed: ${destination}\n`);

/** @param {string} path */
async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
