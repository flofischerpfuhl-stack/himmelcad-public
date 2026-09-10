#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  deterministicStrideIndices,
  meanNearestNeighbourSpacing,
  oracleSampleIndices,
  readPlyHeader,
  streamPlySamples,
} from './lib/photolab-ply.mjs';
import { readGltfPositionSamples } from './lib/photolab-gltf.mjs';

const execFileAsync = promisify(execFile);
const GDAL_INFO = '/usr/bin/gdalinfo';
const GDAL_LOCATION_INFO = '/usr/bin/gdallocationinfo';
// The gate contract specifies 10,000 points as the bounded spacing estimator.
const SPACING_SAMPLE_LIMIT = 10_000;
// Raster metadata is normally kilobytes; 16 MiB permits long compound-CRS WKT
// and metadata while keeping child-process output bounded.
const GDAL_INFO_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
// One centimetre is the product-matrix floor: smaller floating-point quanta are
// not a meaningful cross-renderer elevation-pick tolerance for this gate.
const MINIMUM_DEM_TOLERANCE_METRES = 0.01;
// A bilinear DEM mesh may differ from a cell lookup across the full cell;
// one cell is therefore the explicit cross-renderer interpolation allowance.
const MESH_INTERPOLATION_TOLERANCE_CELLS = 1;

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--project' || argument === '--out') {
      if (!argv[index + 1]) throw new Error(`${argument} requires a path`);
      values[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!values.project || !values.out) {
    throw new Error(
      'Usage: node scripts/photolab-g1c-oracle.mjs --project <project.hcad> --out <dir>',
    );
  }
  return values;
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function collectStringValues(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStringValues(item, result));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStringValues(item, result));
  }
  return result;
}

async function safeReferencedFile(projectPath, manifest, suffixes) {
  const projectRoot = path.resolve(projectPath);
  for (const reference of collectStringValues(manifest)) {
    const normalized = reference.replaceAll('\\', '/');
    if (!suffixes.some((suffix) => normalized.endsWith(suffix))) continue;
    const candidate = path.resolve(projectRoot, normalized);
    if (candidate !== projectRoot && !candidate.startsWith(`${projectRoot}${path.sep}`)) continue;
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function jobIdFromEntity(entityId, kind) {
  if (typeof entityId !== 'string') return null;
  const expression =
    kind === 'sparse'
      ? /:compute:([^:]+):\d+$/
      : kind === 'dense'
        ? /:dense:([^:]+)$/
        : /:raster:([^:]+)$/;
  return entityId.match(expression)?.[1] ?? null;
}

async function resolvePointSource(projectPath, manifest, kind) {
  const direct = await safeReferencedFile(projectPath, manifest, ['.ply']);
  if (direct) return direct;
  const payload = manifest.lineage?.payload ?? {};
  const jobId = jobIdFromEntity(payload.product_entity_id ?? manifest.product?.entity_id, kind);
  if (!jobId) throw new Error(`Cannot derive the ${kind} source job from package lineage`);
  const relative =
    kind === 'dense'
      ? path.join('datasets', 'mvs', jobId, 'output', 'dense.ply')
      : path.join('datasets', 'colmap', jobId, 'sparse-potree', 'export.ply');
  const candidate = path.join(projectPath, relative);
  if (!(await exists(candidate)))
    throw new Error(`Referenced ${kind} PLY does not exist: ${relative}`);
  return candidate;
}

async function resolveRasterSource(projectPath, manifest) {
  const direct = await safeReferencedFile(projectPath, manifest, ['.cog.tif', '.tif', '.tiff']);
  if (direct) return direct;
  const payload = manifest.lineage?.payload ?? {};
  const jobId = jobIdFromEntity(payload.product_entity_id ?? manifest.product?.entity_id, 'dem');
  if (!jobId) throw new Error('Cannot derive the DEM source job from package lineage');
  for (const name of ['product.cog.tif', 'base.tif']) {
    const candidate = path.join(projectPath, 'datasets', 'raster', jobId, name);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Referenced DEM raster does not exist for job ${jobId}`);
}

async function hashFile(filePath, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function classificationDetails(plyPath, samples, signal) {
  const directory = path.dirname(plyPath);
  const currentPath = path.join(directory, 'dense.classification.bin');
  if (!(await exists(currentPath))) {
    return {
      samples: samples.map((sample) => ({ ...sample, class_byte: null })),
      snapshot: { current: null, equals: null, reason: 'dense.classification.bin is not present' },
    };
  }
  const fileStats = await stat(currentPath);
  const requiredLength = samples.at(-1)?.index + 1 || 0;
  if (fileStats.size < requiredLength)
    throw new Error('Dense classification is shorter than the PLY');
  const handle = await open(currentPath, 'r');
  const classified = [];
  try {
    for (const sample of samples) {
      const byte = Buffer.alloc(1);
      const { bytesRead } = await handle.read(byte, 0, 1, sample.index);
      if (bytesRead !== 1) throw new Error(`Cannot read classification at point ${sample.index}`);
      classified.push({ ...sample, class_byte: byte[0] });
    }
  } finally {
    await handle.close();
  }

  const currentHash = await hashFile(currentPath, signal);
  const candidates = (await readdir(directory))
    .filter((name) => /^dense\.classification\.[0-9a-f]{16}\.bin$/.test(name))
    .sort();
  let equalName = null;
  for (const name of candidates) {
    const candidatePath = path.join(directory, name);
    const candidateStats = await stat(candidatePath);
    if (
      candidateStats.size === fileStats.size &&
      (await hashFile(candidatePath, signal)) === currentHash
    ) {
      equalName = name;
      break;
    }
  }
  return {
    samples: classified,
    snapshot: {
      current: path.basename(currentPath),
      sha256: currentHash,
      equals: equalName,
      reason: equalName ? null : 'No hash-named classification snapshot is byte-identical',
    },
  };
}

async function analysePointCloud(plyPath, kind, signal) {
  const header = await readPlyHeader(plyPath);
  const oracleIndices = oracleSampleIndices(header.vertexCount);
  const spacingIndices = deterministicStrideIndices(header.vertexCount, SPACING_SAMPLE_LIMIT);
  const combined = [...new Set([...oracleIndices, ...spacingIndices])].sort(
    (left, right) => left - right,
  );
  const extracted = await streamPlySamples(plyPath, combined, header, { signal });
  const byIndex = new Map(extracted.map((sample) => [sample.index, sample]));
  const oracleSamples = oracleIndices.map((index) => byIndex.get(index));
  const spacingSamples = spacingIndices.map((index) => byIndex.get(index));
  const spacing = meanNearestNeighbourSpacing(spacingSamples);
  const classification =
    kind === 'dense'
      ? await classificationDetails(plyPath, oracleSamples, signal)
      : { samples: oracleSamples, snapshot: null };
  return {
    point_count: header.vertexCount,
    samples: classification.samples,
    classification_snapshot: classification.snapshot,
    tolerance: {
      pick_distance: spacing,
      basis: 'mean nearest-neighbour spacing from a deterministic stride sample',
      spacing_sample_count: spacingSamples.length,
    },
  };
}

function projectCrs(payload, gdalInfo = null) {
  return (
    payload.reference_frame?.project_reference_frame?.target?.horizontal?.crs?.value ??
    gdalInfo?.coordinateSystem?.wkt?.match(/ID\["EPSG",(\d+)\]/)?.[1]?.replace(/^/, 'EPSG:') ??
    null
  );
}

function invertGeoTransform(geoTransform, x, y) {
  const [originX, xx, xy, originY, yx, yy] = geoTransform;
  const determinant = xx * yy - xy * yx;
  if (determinant === 0) throw new Error('Raster geotransform is not invertible');
  const dx = x - originX;
  const dy = y - originY;
  return [(dx * yy - dy * xy) / determinant, (dy * xx - dx * yx) / determinant];
}

function cellCentre(geoTransform, column, row) {
  return [
    geoTransform[0] + (column + 0.5) * geoTransform[1] + (row + 0.5) * geoTransform[2],
    geoTransform[3] + (column + 0.5) * geoTransform[4] + (row + 0.5) * geoTransform[5],
  ];
}

function float32Quantum(value) {
  const magnitude = Math.abs(value || 1);
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, magnitude, false);
  const bits = view.getUint32(0, false);
  view.setUint32(0, bits + 1, false);
  return view.getFloat32(0, false) - Math.fround(magnitude);
}

function float64Quantum(value) {
  const magnitude = Math.abs(value || 1);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude, false);
  view.setBigUint64(0, view.getBigUint64(0, false) + 1n, false);
  return view.getFloat64(0, false) - magnitude;
}

function verticalQuantum(dataType, magnitude) {
  if (/^(Byte|Int8|UInt16|Int16|UInt32|Int32|UInt64|Int64)$/.test(dataType)) return 1;
  if (dataType === 'Float32') return float32Quantum(magnitude);
  if (dataType === 'Float64') return float64Quantum(magnitude);
  throw new Error(`Unsupported raster data type for a vertical tolerance: ${dataType}`);
}

let valxySupport;
async function supportsValxy(signal) {
  if (valxySupport !== undefined) return valxySupport;
  try {
    const { stdout, stderr } = await execFileAsync(GDAL_LOCATION_INFO, ['--help'], {
      encoding: 'utf8',
      signal,
    });
    valxySupport = `${stdout}${stderr}`.includes('-valxy');
  } catch (error) {
    valxySupport = `${error.stdout ?? ''}${error.stderr ?? ''}`.includes('-valxy');
  }
  return valxySupport;
}

async function gdalValue(rasterPath, x, y, signal) {
  const valueFlag = (await supportsValxy(signal)) ? '-valxy' : '-valonly';
  const { stdout } = await execFileAsync(
    GDAL_LOCATION_INFO,
    [valueFlag, '-geoloc', rasterPath, String(x), String(y)],
    { encoding: 'utf8', signal },
  );
  const numbers = stdout.trim().match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  return numbers?.length ? Number(numbers.at(-1)) : null;
}

async function rasterInfo(rasterPath, signal) {
  const { stdout } = await execFileAsync(GDAL_INFO, ['-json', rasterPath], {
    encoding: 'utf8',
    maxBuffer: GDAL_INFO_MAX_BUFFER_BYTES,
    signal,
  });
  return JSON.parse(stdout);
}

async function validityBytesForRaster(rasterPath, manifest) {
  if (!manifest.lineage?.payload?.dem_facts?.validity) return null;
  const rasterDirectory = path.dirname(rasterPath);
  for (const relative of [path.join('view', 'validity.bin'), path.join('viewer', 'validity.bin')]) {
    const candidate = path.join(rasterDirectory, relative);
    if (await exists(candidate)) return readFile(candidate);
  }
  return null;
}

function noDataAt(info, validityBytes, sourceNoData, x, y, value) {
  const [pixelX, pixelY] = invertGeoTransform(info.geoTransform, x, y);
  const column = Math.floor(pixelX);
  const row = Math.floor(pixelY);
  if (column < 0 || row < 0 || column >= info.size[0] || row >= info.size[1]) return true;
  if (validityBytes) {
    const index = row * info.size[0] + column;
    return ((validityBytes[index >> 3] >> (index & 7)) & 1) === 0;
  }
  if (value === null || !Number.isFinite(value)) return true;
  if (sourceNoData?.kind === 'numeric') return value === Number(sourceNoData.value);
  return false;
}

async function analyseDem(rasterPath, manifest, denseSamples, signal) {
  const info = await rasterInfo(rasterPath, signal);
  const band = info.bands?.[0];
  if (!band || !info.geoTransform || !info.size)
    throw new Error('GDAL returned incomplete raster metadata');
  const [width, height] = info.size;
  const fixedCells = [
    ['upper-left interior', 0, 0],
    ['upper-right interior', width - 1, 0],
    ['lower-left interior', 0, height - 1],
    ['lower-right interior', width - 1, height - 1],
    ['centre', (width - 1) / 2, (height - 1) / 2],
  ].map(([label, column, row]) => ({ label, xy: cellCentre(info.geoTransform, column, row) }));
  const requested = [
    ...denseSamples.map((sample) => ({
      label: `dense point ${sample.index}`,
      point_index: sample.index,
      xy: sample.xyz.slice(0, 2),
    })),
    ...fixedCells,
  ];
  const validityBytes = await validityBytesForRaster(rasterPath, manifest);
  const demFacts = manifest.lineage?.payload?.dem_facts ?? {};
  const samples = [];
  for (const request of requested) {
    const value = await gdalValue(rasterPath, request.xy[0], request.xy[1], signal);
    const noData = noDataAt(
      info,
      validityBytes,
      demFacts.source_no_data,
      request.xy[0],
      request.xy[1],
      value,
    );
    samples.push({ ...request, value: noData ? null : value, no_data: noData });
  }
  const magnitude = Math.max(
    1,
    Math.abs(Number(band.minimum ?? band.min ?? 0)),
    Math.abs(Number(band.maximum ?? band.max ?? 0)),
  );
  const quantum = verticalQuantum(band.type, magnitude);
  return {
    raster: path.basename(rasterPath),
    crs: projectCrs(manifest.lineage?.payload ?? {}, info),
    resolution: {
      x: Math.hypot(info.geoTransform[1], info.geoTransform[4]),
      y: Math.hypot(info.geoTransform[2], info.geoTransform[5]),
      unit: 'metre',
    },
    data_type: band.type,
    source_no_data: demFacts.source_no_data ?? null,
    validity: demFacts.validity ?? null,
    surface: demFacts.surface ?? null,
    ground_classification: demFacts.ground_classification ?? null,
    samples,
    tolerance: {
      elevation: Math.max(quantum / 2, MINIMUM_DEM_TOLERANCE_METRES),
      vertical_quantum: quantum,
      minimum: MINIMUM_DEM_TOLERANCE_METRES,
      basis: 'maximum of half the raster data-type quantum and 0.01 metre',
    },
  };
}

function jsonPath(parts) {
  return parts
    .map((part, index) => (typeof part === 'number' ? `[${part}]` : `${index ? '.' : ''}${part}`))
    .join('');
}

function discoverNamedValues(value, predicate, parts = [], result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => discoverNamedValues(item, predicate, [...parts, index], result));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const itemParts = [...parts, key];
      if (predicate(key, item)) result.push({ key: jsonPath(itemParts), value: item });
      discoverNamedValues(item, predicate, itemParts, result);
    }
  }
  return result;
}

function normalizedJsonKey(key) {
  return key.replace(/\[\d+\]/gu, '[]');
}

function discoverTileIndex(kernelManifest) {
  const candidates = discoverNamedValues(
    kernelManifest,
    (key, value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => item && typeof item === 'object') &&
      value.some((item) =>
        Object.keys(item).some((itemKey) => /^(?:bounds|contents?|uri|id)$/iu.test(itemKey)),
      ),
  );
  candidates.sort((left, right) => {
    const leftNamed = /(?:^|\.)(?:tiles|tileIndex)$/iu.test(left.key) ? 1 : 0;
    const rightNamed = /(?:^|\.)(?:tiles|tileIndex)$/iu.test(right.key) ? 1 : 0;
    return rightNamed - leftNamed || left.key.localeCompare(right.key);
  });
  return candidates[0] ?? null;
}

function firstGltfReference(value, parts = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = firstGltfReference(value[index], [...parts, index]);
      if (result) return result;
    }
  } else if (value && typeof value === 'object') {
    if (
      typeof value.uri === 'string' &&
      (/^gltf$/iu.test(value.kind ?? '') || /\.(?:gltf|glb)$/iu.test(value.uri))
    ) {
      return { uri: value.uri, key: jsonPath([...parts, 'uri']) };
    }
    for (const [key, item] of Object.entries(value)) {
      const result = firstGltfReference(item, [...parts, key]);
      if (result) return result;
    }
  }
  return null;
}

function firstTransform(value, parts = []) {
  if (!value || typeof value !== 'object') return null;
  for (const preferred of ['contentTransform', 'transform', 'matrix']) {
    if (
      Array.isArray(value[preferred]) &&
      value[preferred].length === 16 &&
      value[preferred].every(Number.isFinite)
    ) {
      return { matrix: value[preferred], key: jsonPath([...parts, preferred]) };
    }
  }
  return null;
}

function triangleCountDetails(tileIndex) {
  for (const name of ['triangleCount', 'primitiveCount']) {
    const entries = discoverNamedValues(
      tileIndex.value,
      (key, value) => key === name && Number.isSafeInteger(value) && value >= 0,
    );
    if (entries.length > 0) {
      return {
        key: normalizedJsonKey(`${tileIndex.key}${entries[0].key}`),
        total: entries.reduce((sum, entry) => sum + entry.value, 0),
      };
    }
  }
  return { key: null, total: null };
}

async function countFiles(directory) {
  if (!(await exists(directory))) return 0;
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countFiles(path.join(directory, entry.name)) : 1;
  }
  return count;
}

function safePackagePath(packagePath, relativePath, label) {
  const root = path.resolve(packagePath);
  const candidate = path.resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the product package`);
  }
  return candidate;
}

function datasetRootPath(manifest) {
  const dataset = manifest.datasets?.find(
    (item) => item.content_kind === 'gltf' && item.format_id === 'himmelcad-prepared-hierarchy@1',
  );
  if (!dataset?.root_path) throw new Error('Mesh package has no glTF dataset root_path');
  return dataset.root_path;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function chooseDemPackage(meshItem, demItems) {
  if (demItems.length === 0) throw new Error('Mesh oracle requires a ready DEM package');
  const referenced = new Set(collectStringValues(meshItem.manifest));
  const explicit = demItems.find((item) => {
    const entityId =
      item.manifest.lineage?.payload?.product_entity_id ?? item.manifest.product?.entity_id;
    return referenced.has(entityId);
  });
  if (explicit) return { item: explicit, basis: 'mesh manifest DEM entity reference' };

  const meshPayload = meshItem.manifest.lineage?.payload ?? {};
  const lineageMatches = demItems.filter((item) => {
    const payload = item.manifest.lineage?.payload ?? {};
    return (
      meshPayload.source_alignment_entity_id &&
      payload.source_alignment_entity_id === meshPayload.source_alignment_entity_id &&
      stableJson(payload.processing_set_choice) === stableJson(meshPayload.processing_set_choice)
    );
  });
  const candidates = lineageMatches.length > 0 ? lineageMatches : demItems;
  const item = [...candidates].sort(
    (left, right) =>
      (right.ready.publication_generation ?? 0) - (left.ready.publication_generation ?? 0) ||
      path.basename(right.packagePath).localeCompare(path.basename(left.packagePath)),
  )[0];
  return {
    item,
    basis:
      lineageMatches.length > 0
        ? 'matching source alignment and processing set'
        : 'newest ready DEM package in the project',
  };
}

async function interpolationSetting(meshItem) {
  const fallback = path.join(meshItem.packagePath, 'dataset', 'preparation.json');
  const references = collectStringValues(meshItem.manifest).filter((value) =>
    value.replaceAll('\\', '/').endsWith('preparation.json'),
  );
  let preparationPath = null;
  for (const reference of [...references, 'dataset/preparation.json']) {
    const candidate = safePackagePath(meshItem.packagePath, reference, 'Mesh preparation path');
    if (await exists(candidate)) {
      preparationPath = candidate;
      break;
    }
  }
  if (!preparationPath && (await exists(fallback))) preparationPath = fallback;
  if (preparationPath) {
    const preparation = JSON.parse(await readFile(preparationPath, 'utf8'));
    const match = discoverNamedValues(
      preparation,
      (key, value) =>
        key.replaceAll(/[-_]/gu, '').toLowerCase() === 'interpolateholes' &&
        typeof value === 'boolean',
    )[0];
    if (match) {
      return {
        enabled: match.value,
        source: `${path.relative(meshItem.packagePath, preparationPath).replaceAll(path.sep, '/')}:${match.key}`,
      };
    }
  }
  const lineageMatch = discoverNamedValues(
    meshItem.manifest.lineage?.payload,
    (key, value) =>
      key.replaceAll(/[-_]/gu, '').toLowerCase() === 'interpolateholes' &&
      typeof value === 'boolean',
  )[0];
  return lineageMatch
    ? { enabled: lineageMatch.value, source: `lineage.payload:${lineageMatch.key}` }
    : { enabled: false, source: 'not present; treated as false' };
}

async function analyseMesh(meshItem, demItem, demAnalysis, demResolutionBasis) {
  const rootRelative = datasetRootPath(meshItem.manifest);
  const kernelPath = safePackagePath(meshItem.packagePath, rootRelative, 'Mesh dataset root_path');
  const kernelManifest = JSON.parse(await readFile(kernelPath, 'utf8'));
  const bounds = discoverNamedValues(
    kernelManifest,
    (key, value) => /(?:bounds|extent)/iu.test(key) && value && typeof value === 'object',
  );
  const tileIndex = discoverTileIndex(kernelManifest);
  if (!tileIndex) throw new Error('Kernel manifest has no discoverable tile index');
  const firstTile = tileIndex.value[0];
  const gltfReference = firstGltfReference(firstTile, [tileIndex.key, 0]);
  if (!gltfReference) throw new Error('First kernel tile has no glTF or GLB content');
  const gltfPath = safePackagePath(
    meshItem.packagePath,
    path.join(path.dirname(rootRelative), gltfReference.uri),
    'Mesh tile URI',
  );
  const tileTransform = firstTransform(firstTile, [tileIndex.key, 0]);
  const vertexSample = await readGltfPositionSamples(gltfPath, {
    tileTransform: tileTransform?.matrix,
  });
  vertexSample.source = path.relative(meshItem.packagePath, gltfPath).replaceAll(path.sep, '/');
  vertexSample.transform.tile_source = tileTransform?.key ?? 'identity (no kernel tile transform)';

  const interpolation = await interpolationSetting(meshItem);
  const samples = demAnalysis.samples
    .filter((sample) => sample.point_index !== undefined || sample.label === 'centre')
    .map((sample) => {
      if (sample.no_data && interpolation.enabled) {
        return {
          ...sample,
          source_dem_no_data: true,
          no_data: false,
          elevation_asserted: false,
          note: 'filled by interpolation, elevation not asserted',
        };
      }
      return { ...sample, source_dem_no_data: sample.no_data, elevation_asserted: !sample.no_data };
    });
  const cellSize = Math.max(demAnalysis.resolution.x, demAnalysis.resolution.y);
  const triangles = triangleCountDetails(tileIndex);
  return {
    crs: demAnalysis.crs,
    source_dem_package_id: packageIdentity(demItem).id,
    source_dem_entity_id:
      demItem.manifest.lineage?.payload?.product_entity_id ?? demItem.manifest.product?.entity_id,
    source_dem_resolution_basis: demResolutionBasis,
    resolution: demAnalysis.resolution,
    interpolate_holes: interpolation,
    tile_count: tileIndex.value.length,
    texture_count: await countFiles(path.join(path.dirname(kernelPath), 'textures')),
    kernel_manifest: {
      path: rootRelative.replaceAll(path.sep, '/'),
      bounds_keys: [...new Set(bounds.map((entry) => normalizedJsonKey(entry.key)))],
      bounds,
      tile_index_key: tileIndex.key,
      tile_count: tileIndex.value.length,
      triangle_count_key: triangles.key,
      total_triangle_count: triangles.total,
    },
    samples,
    tolerances: {
      elevation: Math.max(
        demAnalysis.tolerance.elevation,
        cellSize * MESH_INTERPOLATION_TOLERANCE_CELLS,
      ),
      dem_elevation: demAnalysis.tolerance.elevation,
      cell_interpolation: cellSize * MESH_INTERPOLATION_TOLERANCE_CELLS,
      basis: 'maximum of DEM tolerance and one DEM cell',
    },
    vertex_sample: vertexSample,
  };
}

async function discoverPackages(projectPath) {
  const root = path.join(projectPath, '.photolab', 'product-import-packages');
  const entries = await readdir(root, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith('product-')) continue;
    const packagePath = path.join(root, entry.name);
    if (!(await exists(path.join(packagePath, 'ready.json')))) continue;
    const [ready, manifest] = await Promise.all([
      readFile(path.join(packagePath, 'ready.json'), 'utf8').then(JSON.parse),
      readFile(path.join(packagePath, 'manifest.json'), 'utf8').then(JSON.parse),
    ]);
    packages.push({ packagePath, ready, manifest });
  }
  return packages;
}

function packageIdentity(item) {
  const payload = item.manifest.lineage?.payload ?? {};
  return {
    id: item.manifest.manifest_id ?? item.ready.manifest_id ?? path.basename(item.packagePath),
    sha256: item.manifest.package_sha256 ?? item.ready.package_sha256 ?? null,
    kind: payload.product_kind ?? item.manifest.product?.kind ?? null,
    format: payload.normalized_format_id ?? item.ready.normalized_format_id ?? null,
  };
}

function unsupportedReason(identity) {
  if (['sparse', 'dense'].includes(identity.kind) && identity.format === 'potree@2') return null;
  if (
    ['dem', 'mesh'].includes(identity.kind) &&
    identity.format === 'himmelcad-prepared-hierarchy@1'
  )
    return null;
  return `Unsupported oracle combination: ${identity.kind ?? 'unknown kind'} + ${identity.format ?? 'unknown format'}`;
}

export async function buildOracle(projectInput, options = {}) {
  const projectPath = path.resolve(projectInput);
  const packageItems = await discoverPackages(projectPath);
  if (packageItems.length === 0) throw new Error('No ready PhotoLab product packages were found');
  const identities = packageItems.map(packageIdentity);
  const denseItem = packageItems
    .map((item, index) => ({ item, identity: identities[index] }))
    .filter(({ identity }) => identity.kind === 'dense' && identity.format === 'potree@2')
    .sort(
      (left, right) =>
        (right.item.ready.publication_generation ?? 0) -
        (left.item.ready.publication_generation ?? 0),
    )[0]?.item;
  const demItems = packageItems
    .map((item, index) => ({ item, identity: identities[index] }))
    .filter(
      ({ identity }) =>
        identity.kind === 'dem' && identity.format === 'himmelcad-prepared-hierarchy@1',
    )
    .map(({ item }) => item);
  const pointCache = new Map();
  const demCache = new Map();
  async function cachedPointAnalysis(item, kind) {
    const plyPath = await resolvePointSource(projectPath, item.manifest, kind);
    if (!pointCache.has(plyPath)) {
      pointCache.set(plyPath, analysePointCloud(plyPath, kind, options.signal));
    }
    return { plyPath, analysis: await pointCache.get(plyPath) };
  }
  async function cachedDemAnalysis(item) {
    if (!demCache.has(item.packagePath)) {
      demCache.set(
        item.packagePath,
        (async () => {
          let denseAnalysis;
          if (denseItem) denseAnalysis = (await cachedPointAnalysis(denseItem, 'dense')).analysis;
          else {
            const directDensePath = await safeReferencedFile(projectPath, item.manifest, [
              'dense.ply',
            ]);
            if (!directDensePath)
              throw new Error(
                `DEM package ${packageIdentity(item).id} has no dense-cloud reference`,
              );
            if (!pointCache.has(directDensePath)) {
              pointCache.set(
                directDensePath,
                analysePointCloud(directDensePath, 'dense', options.signal),
              );
            }
            denseAnalysis = await pointCache.get(directDensePath);
          }
          const rasterPath = await resolveRasterSource(projectPath, item.manifest);
          return {
            rasterPath,
            analysis: await analyseDem(
              rasterPath,
              item.manifest,
              denseAnalysis.samples,
              options.signal,
            ),
          };
        })(),
      );
    }
    return demCache.get(item.packagePath);
  }

  const outputPackages = [];
  for (let index = 0; index < packageItems.length; index += 1) {
    const item = packageItems[index];
    const identity = identities[index];
    const reason = unsupportedReason(identity);
    if (reason) {
      outputPackages.push({ ...identity, skipped_reason: reason, samples: [], tolerances: null });
      continue;
    }
    const payload = item.manifest.lineage?.payload ?? {};
    if (identity.kind === 'sparse' || identity.kind === 'dense') {
      const { plyPath, analysis } = await cachedPointAnalysis(item, identity.kind);
      outputPackages.push({
        ...identity,
        crs: projectCrs(payload),
        source: path.relative(projectPath, plyPath).replaceAll(path.sep, '/'),
        point_count: analysis.point_count,
        samples: analysis.samples,
        classification_snapshot: analysis.classification_snapshot,
        tolerances: analysis.tolerance,
      });
    } else if (identity.kind === 'dem') {
      const { rasterPath, analysis } = await cachedDemAnalysis(item);
      outputPackages.push({
        ...identity,
        source: path.relative(projectPath, rasterPath).replaceAll(path.sep, '/'),
        crs: analysis.crs,
        resolution: analysis.resolution,
        data_type: analysis.data_type,
        source_no_data: analysis.source_no_data,
        validity: analysis.validity,
        surface: analysis.surface,
        ground_classification: analysis.ground_classification,
        samples: analysis.samples,
        tolerances: analysis.tolerance,
      });
    } else {
      const demSelection = chooseDemPackage(item, demItems);
      const { analysis: demAnalysis } = await cachedDemAnalysis(demSelection.item);
      outputPackages.push({
        ...identity,
        ...(await analyseMesh(item, demSelection.item, demAnalysis, demSelection.basis)),
      });
    }
  }
  const latest = packageItems.reduce((left, right) =>
    (right.ready.publication_generation ?? 0) > (left.ready.publication_generation ?? 0)
      ? right
      : left,
  );
  return {
    schema_id: 'hcad.photolab-g1c-oracle@1',
    project_fingerprint:
      latest.manifest.source?.project_fingerprint ??
      latest.manifest.lineage?.payload?.source_project_fingerprint,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    packages: outputPackages,
  };
}

function markdownCell(value) {
  if (value === null || value === undefined) return '—';
  return String(value).replaceAll('|', '\\|');
}

export function renderOracleMarkdown(oracle) {
  const lines = [
    '# PhotoLab G1c numeric oracle',
    '',
    `Project fingerprint: \`${oracle.project_fingerprint}\`  `,
    `Generated at: \`${oracle.generated_at}\``,
    '',
  ];
  for (const item of oracle.packages) {
    lines.push(`## ${item.kind ?? 'Unknown'} — ${item.id}`, '');
    if (item.skipped_reason) {
      lines.push(
        '| Format | Status |',
        '| --- | --- |',
        `| ${markdownCell(item.format)} | Skipped: ${markdownCell(item.skipped_reason)} |`,
        '',
      );
      continue;
    }
    if (item.kind === 'dem') {
      lines.push('| Sample | X | Y | Elevation | NoData |', '| --- | ---: | ---: | ---: | :---: |');
      for (const sample of item.samples) {
        lines.push(
          `| ${markdownCell(sample.label)} | ${sample.xy[0]} | ${sample.xy[1]} | ${markdownCell(sample.value)} | ${sample.no_data ? 'yes' : 'no'} |`,
        );
      }
      lines.push(
        '',
        `Elevation tolerance: ${item.tolerances.elevation} m; resolution: ${item.resolution.x} × ${item.resolution.y} m; CRS: ${markdownCell(item.crs)}.`,
        '',
      );
    } else if (item.kind === 'mesh') {
      lines.push(
        '| Package SHA-256 | Tiles | Textures | Total triangles |',
        '| --- | ---: | ---: | ---: |',
        `| ${markdownCell(item.sha256)} | ${item.tile_count} | ${item.texture_count} | ${markdownCell(item.kernel_manifest.total_triangle_count)} |`,
        '',
        `Kernel tile-index key: \`${item.kernel_manifest.tile_index_key}\`; triangle-count key: \`${markdownCell(item.kernel_manifest.triangle_count_key)}\`.`,
        '',
        '| Kernel-manifest bounds key | Value |',
        '| --- | --- |',
      );
      for (const bounds of item.kernel_manifest.bounds) {
        lines.push(`| \`${bounds.key}\` | \`${markdownCell(JSON.stringify(bounds.value))}\` |`);
      }
      lines.push(
        '',
        '| Surface sample | X | Y | Elevation | NoData | Elevation asserted | Note |',
        '| --- | ---: | ---: | ---: | :---: | :---: | --- |',
      );
      for (const sample of item.samples) {
        lines.push(
          `| ${markdownCell(sample.label)} | ${sample.xy[0]} | ${sample.xy[1]} | ${markdownCell(sample.value)} | ${sample.no_data ? 'yes' : 'no'} | ${sample.elevation_asserted ? 'yes' : 'no'} | ${markdownCell(sample.note)} |`,
        );
      }
      lines.push(
        '',
        `Elevation tolerance: ${item.tolerances.elevation} m; DEM package: \`${item.source_dem_package_id}\` (${item.source_dem_resolution_basis}); interpolate holes: ${item.interpolate_holes.enabled ? 'yes' : 'no'} (${item.interpolate_holes.source}).`,
        '',
        '| Vertex index | Local X | Local Y | Local Z | Project X | Project Y | Project Z |',
        '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      );
      for (const sample of item.vertex_sample.samples) {
        lines.push(
          `| ${sample.index} | ${sample.local_xyz[0]} | ${sample.local_xyz[1]} | ${sample.local_xyz[2]} | ${sample.xyz[0]} | ${sample.xyz[1]} | ${sample.xyz[2]} |`,
        );
      }
      lines.push(
        '',
        `Vertex transform: ${item.vertex_sample.transform.order}; tile source: \`${item.vertex_sample.transform.tile_source}\`; glTF node: ${markdownCell(item.vertex_sample.transform.node_index)}; combined column-major matrix: \`${JSON.stringify(item.vertex_sample.transform.combined)}\`.`,
        '',
      );
    } else {
      lines.push(
        '| Index | X | Y | Z | RGB | Class |',
        '| ---: | ---: | ---: | ---: | --- | ---: |',
      );
      for (const sample of item.samples) {
        lines.push(
          `| ${sample.index} | ${sample.xyz[0]} | ${sample.xyz[1]} | ${sample.xyz[2]} | ${markdownCell(sample.rgb?.join(', '))} | ${markdownCell(sample.class_byte)} |`,
        );
      }
      lines.push(
        '',
        `Pick tolerance (mean nearest-neighbour spacing): ${item.tolerances.pick_distance}.`,
        '',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function writeOracle(projectPath, outputPath, options = {}) {
  const oracle = await buildOracle(projectPath, options);
  const outputDirectory = path.resolve(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const markdownTemp = path.join(outputDirectory, `.oracle.md.${nonce}.tmp`);
  const jsonTemp = path.join(outputDirectory, `.oracle.json.${nonce}.tmp`);
  try {
    await writeFile(markdownTemp, renderOracleMarkdown(oracle), 'utf8');
    await rename(markdownTemp, path.join(outputDirectory, 'oracle.md'));
    await writeFile(jsonTemp, `${JSON.stringify(oracle, null, 2)}\n`, 'utf8');
    // oracle.json is the ready record and becomes visible only after oracle.md.
    await rename(jsonTemp, path.join(outputDirectory, 'oracle.json'));
  } finally {
    await Promise.all([rm(markdownTemp, { force: true }), rm(jsonTemp, { force: true })]);
  }
  return oracle;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const oracle = await writeOracle(values.project, values.out, { signal: controller.signal });
    process.stdout.write(
      `Wrote ${oracle.packages.length} package oracles to ${path.resolve(values.out)}\n`,
    );
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
