#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const platform = process.argv[2];
if (!['linux-x64', 'win32-x64'].includes(platform))
  throw new Error(`Unsupported platform: ${platform}`);
const source = resolve(process.argv[3] ?? join(root, '.build', 'colmap-worker', 'colmap'));
const destination = join(root, 'vendor', 'colmap', platform);
const files = collect(destination)
  .filter((path) => basename(path) !== 'VENDOR.json')
  .sort()
  .map((path) => ({
    path: relative(destination, path),
    bytes: readFileSync(path).byteLength,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));

writeFileSync(
  join(destination, 'VENDOR.json'),
  `${JSON.stringify(
    {
      name: 'HimmelCAD COLMAP worker',
      upstream: 'https://github.com/colmap/colmap',
      version: '4.1.0',
      commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      patchSha256: createHash('sha256')
        .update(readFileSync(join(root, 'patches', 'colmap-4.1.0-no-copyleft.patch')))
        .digest('hex'),
      vcpkgCommit: '03e366fb91e38b9432ebd5f8cc79f7c8f55e96ab',
      llvmMingw: '20260407-ucrt',
      platform,
      license: 'BSD-3-Clause and permissive audited transitive closure',
      files,
    },
    null,
    2,
  )}\n`,
);

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
