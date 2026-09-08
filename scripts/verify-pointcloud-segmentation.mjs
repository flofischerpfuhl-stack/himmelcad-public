#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(
  root,
  '.build/perf/viewer-baseline-datasets/PW_GHT_251215_Orscholz_Deponie-1-1-ff05d6cffc61',
);
const cargo = process.env.CARGO ?? resolve(process.env.HOME ?? '', '.cargo/bin/cargo');

run(cargo, ['test', '-p', 'himmelcad-sidecar', 'segment', '--', '--nocapture']);

if (process.argv.includes('--real-data')) {
  for (const file of ['metadata.json', 'hierarchy.bin', 'octree.bin']) {
    if (!existsSync(resolve(fixture, file))) {
      throw new Error(`G-RW-SEGMENT missing required prepared fixture artifact: ${file}`);
    }
  }
  run(
    cargo,
    [
      'test',
      '-p',
      'himmelcad-sidecar',
      'real_dataset_bakes_a_native_small_cloud_and_cancels_at_each_phase',
      '--',
      '--ignored',
      '--nocapture',
    ],
    { HCAD_SEGMENT_REAL_DATASET: fixture },
  );
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, CARGO_TARGET_DIR: resolve(root, 'target/builder'), ...extraEnvironment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
