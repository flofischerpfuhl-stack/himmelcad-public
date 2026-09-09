#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';

if (process.argv[2] !== '--gate' || process.argv[3] !== 'G-MT-5') {
  console.error('usage: node scripts/verify-mesh-terrain-scale.mjs --gate G-MT-5');
  process.exit(2);
}

const root = process.env.HCAD_MESH_TERRAIN_SCALE_FIXTURE?.trim();
const machine = {
  measuredAt: new Date().toISOString(),
  loadAverage: loadavg(),
  memoryGiB: { total: totalmem() / 2 ** 30, free: freemem() / 2 ** 30 },
  uptime: command('uptime'),
  adapter: command('nvidia-smi', [
    '--query-gpu=name,driver_version,memory.total',
    '--format=csv,noheader',
  ]),
  presentSource: null,
};

if (!root) {
  console.log(JSON.stringify({
    gate: 'G-MT-5',
    status: 'NOT RUN',
    reason: 'HCAD_MESH_TERRAIN_SCALE_FIXTURE is unset; no 500M-logical-point fixture exists',
    machine,
  }, null, 2));
  process.exit(0);
}

const fixture = resolve(root);
const required = ['metadata.json', 'hierarchy.bin', 'octree.bin'];
const missing = required.filter((name) => !existsSync(resolve(fixture, name)));
if (missing.length > 0) {
  console.log(JSON.stringify({
    gate: 'G-MT-5',
    status: 'NOT RUN',
    reason: `fixture is incomplete: ${missing.join(', ')}`,
    fixture,
    machine,
  }, null, 2));
  process.exit(0);
}

const metadata = JSON.parse(readFileSync(resolve(fixture, 'metadata.json'), 'utf8'));
if (!Number.isSafeInteger(metadata.points) || metadata.points < 500_000_000) {
  console.log(JSON.stringify({
    gate: 'G-MT-5',
    status: 'NOT RUN',
    reason: `fixture has ${String(metadata.points)} logical points; gate requires at least 500000000`,
    fixture,
    machine,
  }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({
  gate: 'G-MT-5',
  status: 'FAIL',
  reason: 'fixture exists, but no landed scale runner exposes MT-D17 progress, cancellation, checkpoint/resume, publication, RSS, disk, navigation, and error-list probes',
  fixture,
  logicalPoints: metadata.points,
  machine,
}, null, 2));
process.exit(1);

function command(file, args = []) {
  try {
    return execFileSync(file, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
