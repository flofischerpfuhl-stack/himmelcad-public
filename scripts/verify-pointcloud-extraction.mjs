#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const requestedGate = process.argv.includes('--gate')
  ? process.argv[process.argv.indexOf('--gate') + 1]
  : null;
if (requestedGate && requestedGate !== 'G-RW-EXTRACT-GROUND-FLOOR') {
  throw new Error(`unsupported gate: ${requestedGate}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(
  root,
  '.build/perf/viewer-baseline-datasets/PW_GHT_251215_Orscholz_Deponie-1-1-ff05d6cffc61',
);
for (const file of ['metadata.json', 'hierarchy.bin', 'octree.bin']) {
  if (!existsSync(resolve(fixture, file))) {
    throw new Error(`G-RW-EXTRACT-GROUND-FLOOR missing required outdoor fixture artifact: ${file}`);
  }
}

const cargo = process.env.CARGO ?? resolve(process.env.HOME ?? '', '.cargo/bin/cargo');
const common = ['test', '-p', 'himmelcad-sidecar', 'ground', '--', '--nocapture'];
run(cargo, common);

if (process.argv.includes('--real-data') || requestedGate) {
  run(
    cargo,
    [
      'test',
      '-p',
      'himmelcad-sidecar',
      'outdoor_ground_real_dataset_cancels_at_every_phase_without_a_ready_dataset',
      '--',
      '--ignored',
      '--nocapture',
    ],
    { HCAD_GROUND_REAL_DATASET: fixture },
  );
  run(
    cargo,
    [
      'test',
      '-p',
      'himmelcad-sidecar',
      'outdoor_ground_real_dataset_floor',
      '--',
      '--ignored',
      '--nocapture',
    ],
    { HCAD_GROUND_REAL_DATASET: fixture },
  );
  console.log(
    'Outdoor ground subset passed. Synthetic floor assertions passed; the large fixture has no reviewed label manifest, so no large-fixture precision/recall is claimed.',
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
