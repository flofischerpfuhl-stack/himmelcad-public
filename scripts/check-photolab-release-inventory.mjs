#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const platform = process.argv[2] ?? (process.platform === 'win32' ? 'win32-x64' : 'linux-x64');
if (!['linux-x64', 'win32-x64'].includes(platform)) fail(`unsupported platform: ${platform}`);

const roots = [
  join(workspace, `vendor/colmap/${platform}`),
  join(workspace, `vendor/brush/${platform}`),
  join(workspace, `vendor/potreeconverter/${platform}`),
  join(workspace, 'vendor/photolab-models'),
  join(workspace, `vendor/dedode/${platform === 'linux-x64' ? 'dev' : platform}`),
  join(workspace, `.build/photolab-runtime/${platform}/workers/geo`),
];
const requiredExecutables = [
  join(workspace, `target/release/himmelcad-sidecar${platform === 'win32-x64' ? '.exe' : ''}`),
  join(workspace, `target/release/himmelcad-portable-mvs${platform === 'win32-x64' ? '.exe' : ''}`),
];

for (const path of [...roots, ...requiredExecutables]) {
  if (!existsSync(path)) fail(`required release input is missing: ${relative(workspace, path)}`);
}

const forbiddenNames =
  /(?:^|[-_.])(gomp|gfortran|quadmath|iomp5)(?:[-_.]|$)|(?:^|[-_.])(gpl|agpl|lgpl)(?:[-_.]|$)/i;
const forbiddenDependency = /lib(?:gomp|gfortran|quadmath|iomp5)(?:\.so|\.dll|\.dylib)/i;
const files = [...requiredExecutables, ...roots.flatMap(collectFiles)].sort();
const inventory = [];

for (const path of files) {
  const relativePath = relative(workspace, path);
  if (forbiddenNames.test(basename(path)))
    fail(`forbidden runtime or license family in release input: ${relativePath}`);
  const bytes = readFileSync(path);
  const record = {
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (
    platform === 'linux-x64' &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    const dependencies = dynamicDependencies(path);
    const forbidden = dependencies.find((dependency) => forbiddenDependency.test(dependency));
    if (forbidden) fail(`${relativePath} links forbidden runtime ${forbidden}`);
    record.dynamicDependencies = dependencies;
  }
  inventory.push(record);
}

const outputDirectory = join(workspace, '.build/release-inventory');
mkdirSync(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, `photolab-${platform}.json`);
writeFileSync(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, product: 'HimmelCAD PhotoLab', platform, files: inventory }, null, 2)}\n`,
);
process.stdout.write(
  `PhotoLab release inventory passed: ${inventory.length} files · ${relative(workspace, outputPath)}\n`,
);

function collectFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.venv' || entry.name === '__pycache__' || entry.name.endsWith('.pyc'))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output;
}

function dynamicDependencies(path) {
  let output;
  try {
    output = execFileSync('ldd', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? '';
    if (stderr.includes('not a dynamic executable')) return [];
    fail(`ldd failed for ${relative(workspace, path)}: ${stderr.trim()}`);
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((value) => value && value !== 'statically');
}

function fail(message) {
  process.stderr.write(`PhotoLab release inventory failed: ${message}\n`);
  process.exit(1);
}
