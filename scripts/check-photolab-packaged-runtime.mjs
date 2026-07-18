#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const platform = process.argv[2];
if (!['linux-x64', 'win32-x64'].includes(platform)) {
  fail('usage: check-photolab-packaged-runtime.mjs <linux-x64|win32-x64> <resources-directory>');
}

const resources = resolve(process.argv[3] ?? '');
if (!process.argv[3] || !existsSync(resources)) {
  fail(`packaged resources directory is missing: ${process.argv[3] ?? '<not provided>'}`);
}

const inventoryPath = join(resources, 'RELEASE_INVENTORY.json');
if (!existsSync(inventoryPath)) fail('packaged RELEASE_INVENTORY.json is missing');

let inventory;
try {
  inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
} catch (error) {
  fail(`packaged release inventory is invalid JSON: ${error.message}`);
}
if (
  inventory.schemaVersion !== 1 ||
  inventory.product !== 'HimmelCAD PhotoLab' ||
  inventory.platform !== platform ||
  !Array.isArray(inventory.files)
) {
  fail('packaged release inventory has the wrong product, platform or schema');
}

for (const record of inventory.files) {
  if (
    typeof record.path !== 'string' ||
    typeof record.bytes !== 'number' ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  ) {
    fail('packaged release inventory contains an invalid file record');
  }
  const packagedPath = mapInventoryPath(record.path);
  if (!existsSync(packagedPath)) {
    fail(
      `inventoried runtime file is missing from the package: ${relative(resources, packagedPath)}`,
    );
  }
  const bytes = readFileSync(packagedPath);
  if (bytes.byteLength !== record.bytes) {
    fail(`packaged runtime size differs from inventory: ${relative(resources, packagedPath)}`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== record.sha256) {
    fail(`packaged runtime hash differs from inventory: ${relative(resources, packagedPath)}`);
  }
}

process.stdout.write(
  `PhotoLab packaged runtime passed: ${inventory.files.length} files · ${relative(workspace, resources)}\n`,
);

function mapInventoryPath(path) {
  const runtimePrefix = `.build/photolab-runtime/${platform}/workers/`;
  if (path.startsWith(`${runtimePrefix}dedode/`)) {
    return join(
      resources,
      `vendor/dedode/${platform}`,
      path.slice(`${runtimePrefix}dedode/`.length),
    );
  }
  if (path.startsWith(`${runtimePrefix}geo/`)) {
    return join(resources, 'workers/geo', path.slice(`${runtimePrefix}geo/`.length));
  }
  if (path.startsWith(`${runtimePrefix}colmap/`)) {
    return join(
      resources,
      `vendor/colmap/${platform}`,
      path.slice(`${runtimePrefix}colmap/`.length),
    );
  }
  if (path.startsWith('vendor/')) return join(resources, path);
  if (path.startsWith('target/')) return join(resources, basename(path));
  fail(`release inventory path has no package mapping: ${path}`);
}

function fail(message) {
  process.stderr.write(`PhotoLab packaged runtime failed: ${message}\n`);
  process.exit(1);
}
