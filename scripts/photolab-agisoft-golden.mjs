#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const baselinePath = join(workspace, 'photolab/golden/agisoft-sulzberg-baseline.json');
const defaultRoot = join(workspace, 'photolab/Agisoft Exampleprojects');
const argumentsMap = parseArguments(process.argv.slice(2));
const datasetRoot = resolve(
  argumentsMap.dataset ?? process.env.PHOTOLAB_AGISOFT_GOLDEN_ROOT ?? defaultRoot,
);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const projectRoot = join(datasetRoot, baseline.projectRelativePath);

assertDirectory(projectRoot, 'Agisoft project root');
const photosRoot = join(projectRoot, '01_Photos');
const exportRoot = join(projectRoot, '02_Export');
const projectFilesRoot = join(projectRoot, `${baseline.projectRelativePath}.files`);
const photos = collectFiles(photosRoot).filter((path) => /\.(jpe?g|tiff?)$/i.test(path));
assertEqual(photos.length, baseline.images.total, 'source image count');

const required = {
  report: findSingle(exportRoot, /^Bericht_.*\.pdf$/i),
  orthomosaic: findSingle(exportRoot, /^Orthophoto_GHT_ORIGINAL_.*\.tif$/i),
  denseCloud: findSingle(exportRoot, /^PW_GHT_ORIGINAL_.*\.las$/i),
  gcpCsv: findSingle(join(projectRoot, '03_Bodenkontrollpunkte'), /\.csv$/i),
  projectZip: join(projectFilesRoot, 'project.zip'),
  chunkZip: join(projectFilesRoot, '0/chunk.zip'),
  frameZip: join(projectFilesRoot, '0/0/frame.zip'),
  pointCloudZip: join(projectFilesRoot, '0/0/point_cloud/point_cloud.zip'),
  denseCloudArchive: join(projectFilesRoot, '0/0/dense_cloud/dense_cloud.oc3'),
  elevationMetadata: join(projectFilesRoot, '0/0/elevation/elevation.zip'),
  orthomosaicMetadata: join(projectFilesRoot, '0/0/orthomosaic/orthomosaic.zip'),
};
for (const [name, path] of Object.entries(required)) assertFile(path, name);

const zipInventory = {};
for (const key of [
  'projectZip',
  'chunkZip',
  'frameZip',
  'pointCloudZip',
  'elevationMetadata',
  'orthomosaicMetadata',
]) {
  zipInventory[key] = safeZipEntries(required[key]);
}
const chunkXml = readZipEntry(required.chunkZip, 'doc.xml');
const sensorResolution = /<resolution width="(\d+)" height="(\d+)"\/>/.exec(chunkXml);
if (!sensorResolution) fail('chunk metadata has no sensor resolution');
assertEqual(Number(sensorResolution[1]), baseline.images.widthPixels, 'sensor width');
assertEqual(Number(sensorResolution[2]), baseline.images.heightPixels, 'sensor height');
const cameraCount = countMatches(chunkXml, /<camera\b/g);
assertEqual(cameraCount, baseline.images.total, 'camera count in chunk metadata');

const gcpRows = readFileSync(required.gcpCsv, 'utf8').trim().split(/\r?\n/).filter(Boolean);
assertEqual(gcpRows.length, baseline.gcps.total, 'GCP CSV row count');

const las = readLasHeader(required.denseCloud);
assertEqual(las.pointCount, baseline.denseCloud.exportedLasPointCount, 'exported LAS point count');
assertNearArray(las.bounds.min, baseline.denseCloud.bounds.min, 0.0001, 'LAS minimum bounds');
assertNearArray(las.bounds.max, baseline.denseCloud.bounds.max, 0.0001, 'LAS maximum bounds');

const gdal = JSON.parse(run('gdalinfo', ['-json', required.orthomosaic]));
assertEqual(gdal.size[0], baseline.orthomosaic.widthPixels, 'orthomosaic width');
assertEqual(gdal.size[1], baseline.orthomosaic.heightPixels, 'orthomosaic height');
assertNear(
  Math.abs(gdal.geoTransform[1]),
  baseline.orthomosaic.resolutionMetersPerPixel,
  1e-12,
  'orthomosaic resolution',
);
assertEqual(gdal.bands.length, baseline.orthomosaic.bands, 'orthomosaic band count');
assertEqual(
  gdal.bands[0]?.overviews?.length ?? 0,
  baseline.orthomosaic.overviewLevels,
  'orthomosaic overview levels',
);
if (!gdal.coordinateSystem?.wkt?.includes('ID["EPSG",31468]'))
  fail('orthomosaic CRS is not EPSG:31468');

const observation = {
  schemaVersion: 1,
  datasetId: baseline.datasetId,
  datasetRoot,
  imageCount: photos.length,
  cameraCount,
  gcpCount: gcpRows.length,
  orthomosaic: {
    size: gdal.size,
    resolutionMetersPerPixel: Math.abs(gdal.geoTransform[1]),
    bandCount: gdal.bands.length,
    overviewLevels: gdal.bands[0]?.overviews?.length ?? 0,
  },
  denseCloud: las,
  archives: Object.fromEntries(
    Object.entries(zipInventory).map(([key, entries]) => [
      key,
      { entryCount: entries.length, entries },
    ]),
  ),
};

if (argumentsMap.candidate)
  compareCandidate(JSON.parse(readFileSync(resolve(argumentsMap.candidate), 'utf8')), baseline);
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--dataset' || value === '--candidate') {
      const next = values[index + 1];
      if (!next) fail(`${value} requires a path`);
      result[value.slice(2)] = next;
      index += 1;
    } else fail(`unknown argument: ${value}`);
  }
  return result;
}

function collectFiles(root) {
  assertDirectory(root, root);
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output.sort();
}

function findSingle(root, pattern) {
  const matches = collectFiles(root).filter((path) => pattern.test(path.split(/[\\/]/).at(-1)));
  if (matches.length !== 1) fail(`expected one ${pattern} below ${root}, found ${matches.length}`);
  return matches[0];
}

function safeZipEntries(path) {
  const entries = run('unzip', ['-Z1', path]).split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..')) {
      fail(`unsafe ZIP entry in ${path}: ${entry}`);
    }
  }
  return entries.sort();
}

function readZipEntry(path, entry) {
  if (!safeZipEntries(path).includes(entry)) fail(`${path} does not contain ${entry}`);
  return run('unzip', ['-p', path, entry], 32 * 1024 * 1024);
}

function readLasHeader(path) {
  const descriptor = openSync(path, 'r');
  const bytes = Buffer.alloc(375);
  try {
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length)
      fail('LAS header is truncated');
  } finally {
    closeSync(descriptor);
  }
  if (bytes.toString('ascii', 0, 4) !== 'LASF') fail('invalid LAS signature');
  const version = `${bytes[24]}.${bytes[25]}`;
  const legacyCount = bytes.readUInt32LE(107);
  const extendedCount = version === '1.4' ? Number(bytes.readBigUInt64LE(247)) : 0;
  return {
    version,
    pointFormat: bytes[104] & 0x3f,
    pointRecordBytes: bytes.readUInt16LE(105),
    pointCount: extendedCount || legacyCount,
    bounds: {
      min: [bytes.readDoubleLE(187), bytes.readDoubleLE(203), bytes.readDoubleLE(219)],
      max: [bytes.readDoubleLE(179), bytes.readDoubleLE(195), bytes.readDoubleLE(211)],
    },
  };
}

function compareCandidate(candidate, reference) {
  candidate = { ...candidate, ...(candidate.candidateMetrics ?? {}) };
  const checks = [
    [
      'aligned image ratio',
      candidate.alignedImages / reference.images.total,
      reference.acceptance.alignedImageRatioMinimum,
      'minimum',
    ],
    [
      'reprojection RMS',
      candidate.reprojectionRmsPixels,
      reference.acceptance.reprojectionRmsPixelsMaximum,
      'maximum',
    ],
    [
      'control spatial RMSE',
      candidate.controlSpatial3dRmseMeters,
      reference.acceptance.controlSpatial3dRmseMetersMaximum,
      'maximum',
    ],
    [
      'checkpoint spatial RMSE',
      candidate.checkpointSpatial3dRmseMeters,
      reference.acceptance.checkpointSpatial3dRmseMetersMaximum,
      'maximum',
    ],
  ];
  for (const [label, value, limit, direction] of checks) {
    if (!Number.isFinite(value)) fail(`candidate metric is missing: ${label}`);
    if (direction === 'minimum' ? value < limit : value > limit)
      fail(`${label} ${value} violates ${direction} ${limit}`);
  }
  assertEqual(candidate.depthImageCount, reference.images.total, 'candidate depth image count');
  if (!Number.isFinite(candidate.densePointCount)) fail('candidate metric is missing: dense point count');
  const denseRelativeError =
    Math.abs(candidate.densePointCount - reference.denseCloud.reportPointCount) /
    reference.denseCloud.reportPointCount;
  if (denseRelativeError > reference.acceptance.densePointCountRelativeTolerance) {
    fail(
      `dense point count relative error ${denseRelativeError} exceeds ${reference.acceptance.densePointCountRelativeTolerance}`,
    );
  }
  if (!Number.isFinite(candidate.orthomosaicResolutionMetersPerPixel))
    fail('candidate metric is missing: orthomosaic resolution');
  const resolutionRelativeError =
    Math.abs(
      candidate.orthomosaicResolutionMetersPerPixel -
        reference.orthomosaic.resolutionMetersPerPixel,
    ) / reference.orthomosaic.resolutionMetersPerPixel;
  if (resolutionRelativeError > reference.acceptance.orthomosaicResolutionRelativeTolerance) {
    fail(
      `orthomosaic resolution relative error ${resolutionRelativeError} exceeds ${reference.acceptance.orthomosaicResolutionRelativeTolerance}`,
    );
  }
  if (candidate.targetEpsg === 31468) {
    if (!candidate.orthomosaicBounds) fail('candidate metric is missing: orthomosaic bounds');
    assertNearArray(
      candidate.orthomosaicBounds.min,
      reference.orthomosaic.bounds.min,
      reference.acceptance.orthomosaicBoundsToleranceMeters,
      'candidate orthomosaic minimum bounds',
    );
    assertNearArray(
      candidate.orthomosaicBounds.max,
      reference.orthomosaic.bounds.max,
      reference.acceptance.orthomosaicBoundsToleranceMeters,
      'candidate orthomosaic maximum bounds',
    );
  }
}

function run(command, args, maxBuffer = 64 * 1024 * 1024) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const details = error?.stderr?.toString().trim();
    fail(`${command} failed${details ? `: ${details}` : ''}`);
  }
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function assertFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label} is missing: ${path}`);
}

function assertDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`${label} is missing: ${path}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, observed ${actual}`);
}

function assertNear(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    fail(`${label}: expected ${expected} ± ${tolerance}, observed ${actual}`);
  }
}

function assertNearArray(actual, expected, tolerance, label) {
  for (let index = 0; index < expected.length; index += 1) {
    assertNear(actual[index], expected[index], tolerance, `${label}[${index}]`);
  }
}

function fail(message) {
  process.stderr.write(`PhotoLab Agisoft golden check failed: ${message}\n`);
  process.exit(1);
}
