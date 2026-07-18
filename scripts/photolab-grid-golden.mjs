#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const projDataRoot = join(root, 'vendor', 'proj-data');
const fixtureRoot = join(projDataRoot, 'seta2016');
const expectedHashes = new Map([
  ['seta2016/SeTa2016.gsb', 'd4f021e5cd697e9a68a42bd66e9a7a82910ad7f10d9287542acb13aa3a586d59'],
  [
    'de_lgvl_saarland_SeTa2016.tif',
    '529acdef6f5634669087de3dfc7923ab0100a9a7d94fa5e5b4aadb7ec4226c6c',
  ],
  [
    'seta2016/SaarlaendischeVergleichspunkte_SeTa2016.csv',
    'c9e2f87f83d8a8c4cf8966a511ba266f6c4539613d2f1afa64d91ed4528a2960',
  ],
  [
    'seta2016/Produktinformation_SeTa2016.pdf',
    '92ec105298da07237ff8b0f1b5db20d2582b15df6eeb304e24cb3a56c0de2ab6',
  ],
  [
    'seta2016/de_lgvl_saarland_README.txt',
    '8db9566b7426795872a4312de610056b77c6ef0c52e7cdc6e9b36b58af2d02d6',
  ],
]);

for (const [name, expected] of expectedHashes) {
  const bytes = readFileSync(join(projDataRoot, name));
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== expected) throw new Error(`${name}: SHA-256 mismatch (${observed})`);
}

const rows = readComparisonPoints();
if (rows.length !== 52)
  throw new Error(`expected 52 SeTa2016 comparison points, got ${rows.length}`);
const cct = discoverCct();
const baseProjData = join(
  root,
  '.build',
  'photolab-geo',
  'vcpkg_installed',
  'x64-linux-release',
  'share',
  'proj',
);
const environment = {
  ...process.env,
  PROJ_NETWORK: 'OFF',
  PROJ_DATA: [projDataRoot, fixtureRoot, baseProjData, process.env.PROJ_DATA]
    .filter(Boolean)
    .join(delimiter),
};
const source = rows
  .map(({ sourceEast, sourceNorth }) => `${sourceNorth} ${sourceEast} 0 0`)
  .join('\n');
const converted = await transform(cct, 'de_lgvl_saarland_SeTa2016.tif', source, environment);
const original = await transform(cct, 'SeTa2016.gsb', source, environment);
const schwabenControl = await validateSchwabenControlPoints(cct, environment);
let maximumReferenceResidualMeters = 0;
let maximumFormatDifferenceMeters = 0;
for (let index = 0; index < rows.length; index += 1) {
  const reference = rows[index];
  const convertedPoint = converted[index];
  const originalPoint = original[index];
  maximumReferenceResidualMeters = Math.max(
    maximumReferenceResidualMeters,
    Math.hypot(
      convertedPoint.east - reference.targetEast,
      convertedPoint.north - reference.targetNorth,
    ),
  );
  maximumFormatDifferenceMeters = Math.max(
    maximumFormatDifferenceMeters,
    Math.hypot(
      convertedPoint.east - originalPoint.east,
      convertedPoint.north - originalPoint.north,
    ),
  );
}
if (maximumReferenceResidualMeters > 0.001) {
  throw new Error(`SeTa2016 reference residual exceeds 1 mm (${maximumReferenceResidualMeters} m)`);
}
if (maximumFormatDifferenceMeters > 0.001) {
  throw new Error(
    `SeTa2016 GSB/GeoTIFF difference exceeds 1 mm (${maximumFormatDifferenceMeters} m)`,
  );
}
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      dataset: 'LVGL Saarland SeTa2016 comparison points',
      pointCount: rows.length,
      maximumReferenceResidualMeters,
      maximumFormatDifferenceMeters,
      schwabenControl,
      cct,
      network: 'disabled',
    },
    null,
    2,
  )}\n`,
);

async function validateSchwabenControlPoints(cct, environment) {
  const grid = [
    process.env.HIMMELCAD_SCHWABEN_GRID,
    join(
      root,
      'photolab',
      '01_Transformation',
      'Projektionsgitter',
      'Bayern',
      'kanu_ntv2_schwaben.gsb',
    ),
  ]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
  if (!grid) return { available: false, reason: 'local KANU Schwaben NTv2 grid is not installed' };
  const points = readFileSync(
    join(root, 'photolab/golden/kanu-schwaben-control-points.csv'),
    'utf8',
  )
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [id, sourceEast, sourceNorth, targetEast, targetNorth] = line.split(';');
      return {
        id,
        sourceEast: decimal(sourceEast),
        sourceNorth: decimal(sourceNorth),
        targetEast: decimal(targetEast),
        targetNorth: decimal(targetNorth),
      };
    });
  const input = points
    .map(({ sourceEast, sourceNorth }) => `${sourceEast} ${sourceNorth} 0 0`)
    .join('\n');
  const completed = await runCct(
    cct,
    [
      '--columns',
      '1,2,3,4',
      '--decimals',
      '9',
      '+proj=pipeline',
      '+step',
      '+inv',
      '+proj=tmerc',
      '+lat_0=0',
      '+lon_0=12',
      '+k=1',
      '+x_0=4500000',
      '+y_0=0',
      '+ellps=bessel',
      '+step',
      '+proj=hgridshift',
      `+grids=${grid}`,
      '+step',
      '+proj=utm',
      '+zone=32',
      '+ellps=GRS80',
    ],
    `${input}\n`,
    environment,
  );
  if (completed.status !== 0) {
    throw new Error(`KANU Schwaben: cct failed: ${completed.stderr.trim()}`);
  }
  const transformed = completed.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#')) throw new Error(`KANU Schwaben: ${line}`);
      const fields = line.trim().split(/\s+/);
      return { east: decimal(fields[0]), north: decimal(fields[1]) };
    });
  if (transformed.length !== points.length) {
    throw new Error(`KANU Schwaben: expected ${points.length} results, got ${transformed.length}`);
  }
  const residuals = transformed.map((point, index) =>
    Math.hypot(point.east - points[index].targetEast, point.north - points[index].targetNorth),
  );
  const maximumReferenceResidualMeters = Math.max(...residuals);
  const meanReferenceResidualMeters =
    residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  if (maximumReferenceResidualMeters > 0.007) {
    throw new Error(
      `KANU Schwaben control residual exceeds 7 mm (${maximumReferenceResidualMeters} m)`,
    );
  }
  return {
    available: true,
    grid,
    pointCount: points.length,
    maximumReferenceResidualMeters,
    meanReferenceResidualMeters,
  };
}

function readComparisonPoints() {
  const text = readFileSync(
    join(fixtureRoot, 'SaarlaendischeVergleichspunkte_SeTa2016.csv'),
    'latin1',
  );
  return text
    .split(/\r?\n/)
    .slice(2)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(';');
      if (fields.length < 5) throw new Error(`invalid SeTa2016 CSV row: ${line}`);
      const targetWithZone = decimal(fields[3]);
      return {
        sourceEast: decimal(fields[1]),
        sourceNorth: decimal(fields[2]),
        targetEast: targetWithZone >= 10_000_000 ? targetWithZone % 1_000_000 : targetWithZone,
        targetNorth: decimal(fields[4]),
      };
    });
}

function decimal(value) {
  const parsed = Number.parseFloat(value.replace(',', '.'));
  if (!Number.isFinite(parsed)) throw new Error(`invalid numeric value '${value}'`);
  return parsed;
}

function discoverCct() {
  const candidates = [
    process.env.HIMMELCAD_CCT,
    join(
      root,
      '.build',
      'photolab-proj-tools',
      'vcpkg_installed',
      'x64-linux-release',
      'tools',
      'proj',
      'cct',
    ),
    '/usr/bin/cct',
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('cct is missing; build or install the offline PROJ test runtime');
  return found;
}

async function transform(cct, grid, input, environment) {
  const completed = await runCct(
    cct,
    [
      '--columns',
      '1,2,3,4',
      '--decimals',
      '9',
      '+proj=pipeline',
      '+step',
      '+proj=axisswap',
      '+order=2,1',
      '+step',
      '+inv',
      '+proj=tmerc',
      '+lat_0=0',
      '+lon_0=6',
      '+k=1',
      '+x_0=2500000',
      '+y_0=0',
      '+ellps=bessel',
      '+step',
      '+proj=hgridshift',
      `+grids=${grid}`,
      '+step',
      '+proj=utm',
      '+zone=32',
      '+ellps=GRS80',
    ],
    `${input}\n`,
    environment,
  );
  if (completed.status !== 0) {
    throw new Error(`${grid}: cct failed: ${completed.stderr.trim()}`);
  }
  const points = completed.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#')) throw new Error(`${grid}: ${line}`);
      const fields = line.trim().split(/\s+/);
      return { east: decimal(fields[0]), north: decimal(fields[1]) };
    });
  if (points.length !== rows.length) {
    throw new Error(`${grid}: expected ${rows.length} results, got ${points.length}`);
  }
  return points;
}

function runCct(executable, args, input, environment) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectProcess(new Error(`${executable} did not finish within 30 seconds`));
    }, 30_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectProcess(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveProcess({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
}
