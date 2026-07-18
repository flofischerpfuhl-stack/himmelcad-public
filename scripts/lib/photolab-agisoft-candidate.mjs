/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- JSON is untyped at this boundary and every consumed field is validated before use. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { cwd } from 'node:process';

const GCP_COMPONENTS = [
  ['east', 'eastRmsMeters'],
  ['north', 'northRmsMeters'],
  ['height', 'heightRmsMeters'],
  ['horizontal', 'horizontalRmsMeters'],
  ['spatial3d', 'spatial3dRmsMeters'],
];

/** Error raised when a PhotoLab candidate does not satisfy the golden contract. */
export class AgisoftCandidateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgisoftCandidateValidationError';
  }
}

/**
 * Validates one PhotoLab E2E result and the product manifests it published.
 * Runtime ratios are reported for diagnostics because the reference
 * workstation differs. Golden quality acceptance is intentionally independent
 * of a Fast-profile ceiling because the frozen candidate profile is Quality
 * Hybrid.
 */
export function validateAgisoftCandidate(candidate, reference, options = {}) {
  requireRecord(candidate, 'candidate');
  requireRecord(reference, 'reference baseline');
  assertEqual(candidate.schemaVersion, 1, 'candidate schema version');
  if (candidate.success !== true) reject('candidate run did not complete successfully');
  if (candidate.goldenAgisoft !== true) reject('candidate was not produced by --golden-agisoft');
  assertEqual(
    candidate.profile,
    reference.candidateContract.requiredProfile,
    'candidate alignment profile',
  );
  assertEqual(candidate.imageCount, reference.images.total, 'candidate source image count');

  const metrics = candidate.candidateMetrics;
  requireRecord(metrics, 'candidateMetrics');
  const targetEpsg = parseReferenceEpsg(reference.referenceFrame.horizontalCrs);
  assertEqual(metrics.targetEpsg, targetEpsg, 'candidate target EPSG');
  const targetVerticalEpsg = parseReferenceEpsg(reference.referenceFrame.verticalCrs);
  assertEqual(metrics.targetVerticalEpsg, targetVerticalEpsg, 'candidate target vertical EPSG');
  const projectRoot = resolveProjectRoot(candidate, options.candidatePath);
  const products = inspectCandidateProducts(
    candidate.products,
    projectRoot,
    reference,
    targetEpsg,
    targetVerticalEpsg,
    metrics,
  );
  validateReportedProductMetrics(metrics, products);
  validateComparisonCompatibility(products, reference);
  validateAlignmentEvidence(metrics, products.sparse);

  assertEqual(
    candidate.alignedCameraCount,
    metrics.alignedImages,
    'candidate aligned-camera metric',
  );
  assertFinite(metrics.alignedImages, 'aligned image count');
  const alignedRatio = metrics.alignedImages / reference.images.total;
  assertMaximumOrMinimum(
    alignedRatio,
    reference.acceptance.alignedImageRatioMinimum,
    'minimum',
    'aligned image ratio',
  );
  assertMaximumOrMinimum(
    metrics.reprojectionRmsPixels,
    reference.acceptance.reprojectionRmsPixelsMaximum,
    'maximum',
    'alignment reprojection RMS',
  );

  const gcp = validateGcpStatistics(metrics.gcpStatistics, reference);
  validateGcpArtifactEvidence(projectRoot, metrics, gcp, reference);
  assertNear(
    metrics.controlSpatial3dRmseMeters,
    gcp.control.spatial3dRmsMeters,
    1e-12,
    'reported control 3D RMSE',
  );
  assertNear(
    metrics.checkpointSpatial3dRmseMeters,
    gcp.checkpoint.spatial3dRmsMeters,
    1e-12,
    'reported checkpoint 3D RMSE',
  );
  validateProductQuality(products, metrics, reference);
  const runtime = validateRuntime(candidate, metrics.runtimeSeconds, reference);

  return {
    status: 'accepted',
    alignedImageRatio: alignedRatio,
    alignmentReprojectionRmsPixels: metrics.reprojectionRmsPixels,
    gcp,
    products,
    runtime,
  };
}

function validateGcpStatistics(statistics, reference) {
  requireRecord(statistics, 'candidate metric: GCP statistics');
  const result = {};
  for (const [kind, expectedCount, referenceRmse] of [
    ['control', reference.gcps.controls, reference.gcps.controlRmseMeters],
    ['checkpoint', reference.gcps.checkpoints, reference.gcps.checkpointRmseMeters],
  ]) {
    const values = statistics[kind];
    requireRecord(values, `candidate metric: GCP ${kind} statistics`);
    assertEqual(values.pointCount, expectedCount, `candidate GCP ${kind} point count`);
    const observed = { pointCount: values.pointCount };
    for (const [referenceKey, candidateKey] of GCP_COMPONENTS) {
      const value = values[candidateKey];
      assertMaximumOrMinimum(
        value,
        referenceRmse[referenceKey],
        'maximum',
        `GCP ${kind} ${referenceKey} RMSE`,
      );
      observed[candidateKey] = value;
    }
    assertFinite(values.reprojectionRmsPixels, `GCP ${kind} pixel RMS`);
    if (values.reprojectionRmsPixels < 0) reject(`GCP ${kind} pixel RMS must not be negative`);
    assertMaximumOrMinimum(
      values.reprojectionRmsPixels,
      reference.acceptance[`${kind}ReprojectionRmsPixelsMaximum`],
      'maximum',
      `GCP ${kind} pixel RMS`,
    );
    observed.reprojectionRmsPixels = values.reprojectionRmsPixels;
    result[kind] = observed;
  }
  return result;
}

function validateAlignmentEvidence(metrics, sparse) {
  requireRecord(metrics.alignmentEvidence, 'candidate metric: alignment evidence');
  const evidence = metrics.alignmentEvidence;
  assertEqual(evidence.jobId, sparse.jobId, 'alignment evidence job id');
  assertEqual(evidence.registeredImages, sparse.registeredImages, 'alignment registered images');
  assertEqual(evidence.registeredImages, metrics.alignedImages, 'alignment evidence image count');
  assertEqual(evidence.sparsePoints, sparse.pointCount, 'alignment evidence sparse points');
  assertEqual(evidence.observations, sparse.observations, 'alignment evidence observations');
  assertNear(
    evidence.reprojectionRmsPixels,
    sparse.reprojectionRmsPixels,
    1e-12,
    'alignment evidence reprojection RMS',
  );
  assertNear(
    metrics.reprojectionRmsPixels,
    sparse.reprojectionRmsPixels,
    1e-12,
    'reported alignment reprojection RMS',
  );
}

function validateGcpArtifactEvidence(projectRoot, metrics, validatedStatistics, reference) {
  const evidence = metrics.gcpOptimizationEvidence;
  requireRecord(evidence, 'candidate metric: GCP optimization evidence');
  if (typeof evidence.operationId !== 'string' || evidence.operationId.length === 0)
    reject('candidate GCP optimization operation id is missing');
  if (!/^[0-9a-f]{64}$/.test(evidence.artifactSha256 ?? ''))
    reject('candidate GCP optimization artifact hash is missing or invalid');
  assertEqual(
    evidence.sourceAlignmentEntityId,
    metrics.sourceAlignmentEntityId,
    'GCP optimization source alignment lineage',
  );
  assertEqual(
    evidence.processingSetId ?? null,
    metrics.processingSetId ?? null,
    'GCP optimization processing-set lineage',
  );

  const manifest = readJsonFile(resolve(projectRoot, 'manifest.json'), 'project manifest');
  requireRecord(manifest.entities, 'project manifest entities');
  const matches = Object.values(manifest.entities).filter(
    (entity) =>
      entity?.kind === 'AlignmentRun' &&
      [
        entity.id?.endsWith(`:alignment-gcp:${evidence.operationId}`) === true,
        entity.name === `GCP-optimized Alignment · ${evidence.operationId}`,
      ].includes(true),
  );
  if (matches.length !== 1)
    reject('project manifest does not identify exactly one GCP optimization artifact');
  const versionHash = matches[0].versionHash;
  if (!/^[0-9a-f]{64}$/.test(versionHash ?? ''))
    reject('GCP optimization entity has an invalid version hash');
  const record = readHashedJsonObject(
    projectRoot,
    versionHash,
    'GCP optimization publication record',
  );
  assertEqual(record.operationId, evidence.operationId, 'GCP optimization record operation id');
  assertEqual(
    record.artifactSha256,
    evidence.artifactSha256,
    'GCP optimization record artifact hash',
  );
  assertEqual(
    record.sourceAlignmentEntityId,
    evidence.sourceAlignmentEntityId,
    'GCP optimization record source alignment',
  );
  assertEqual(
    record.snapshotSha256,
    evidence.snapshotSha256,
    'GCP optimization record snapshot hash',
  );
  assertEqual(
    record.artifact?.snapshotSha256,
    evidence.snapshotSha256,
    'GCP optimization artifact snapshot hash',
  );
  const artifactStatistics = record.artifact?.result?.statistics;
  requireRecord(artifactStatistics, 'GCP optimization artifact statistics');
  for (const kind of ['control', 'checkpoint']) {
    const artifact = artifactStatistics[kind];
    const reported = validatedStatistics[kind];
    requireRecord(artifact, `GCP optimization artifact ${kind} statistics`);
    assertEqual(artifact.pointCount, reported.pointCount, `GCP artifact ${kind} point count`);
    for (const [, key] of GCP_COMPONENTS) {
      assertNear(artifact[key], reported[key], 1e-12, `GCP artifact ${kind} ${key}`);
    }
    assertNear(
      artifact.reprojectionRmsPixels,
      reported.reprojectionRmsPixels,
      1e-12,
      `GCP artifact ${kind} pixel RMS`,
    );
  }
  validateGcpObservationEvidence(projectRoot, evidence.snapshotSha256, metrics, reference);
}

function validateGcpObservationEvidence(projectRoot, snapshotHash, metrics, reference) {
  if (!/^[0-9a-f]{64}$/.test(snapshotHash ?? ''))
    reject('candidate GCP optimization snapshot hash is missing or invalid');
  const expected = reference.gcps.manualObservationEvidence;
  requireRecord(expected, 'reference GCP manual-observation evidence');
  const evidence = metrics.gcpObservationEvidence;
  requireRecord(evidence, 'candidate metric: GCP observation evidence');
  assertEqual(evidence.schemaVersion, 1, 'GCP observation evidence schema version');
  requireRecord(evidence.source, 'candidate GCP observation source evidence');
  for (const key of ['gcpCsvSha256', 'chunkDocumentSha256', 'frameDocumentSha256']) {
    assertEqual(evidence.source[key], expected.source[key], `GCP observation source ${key}`);
  }
  assertEqual(
    evidence.manualObservationCount,
    expected.manualObservationCount,
    'GCP manual observation count',
  );
  assertEqual(
    evidence.observationSetSha256,
    expected.observationSetSha256,
    'GCP manual observation set hash',
  );
  assertStringArrayEqual(
    evidence.controlPointNames,
    expected.controlPointNames,
    'GCP control point names',
  );
  assertStringArrayEqual(
    evidence.checkpointPointNames,
    expected.checkpointPointNames,
    'GCP checkpoint point names',
  );
  requireRecord(evidence.pointObservationCounts, 'candidate GCP point observation counts');
  for (const [name, count] of Object.entries(expected.pointObservationCounts)) {
    assertEqual(evidence.pointObservationCounts[name], count, `GCP ${name} observation count`);
  }

  const snapshot = readHashedJsonObject(projectRoot, snapshotHash, 'GCP optimization snapshot');
  assertEqual(snapshot.schemaVersion, 1, 'GCP optimization snapshot schema version');
  requireRecord(snapshot.scope, 'GCP optimization snapshot scope');
  if (!Array.isArray(snapshot.scope.cameraReferenceImageIds))
    reject('GCP optimization snapshot camera-reference scope must be an array');
  assertEqual(
    snapshot.scope.cameraReferenceImageIds.length,
    0,
    'GCP optimization snapshot camera-reference prior count',
  );
  if (!Array.isArray(snapshot.points)) reject('GCP optimization snapshot points must be an array');
  if (!Array.isArray(snapshot.observations))
    reject('GCP optimization snapshot observations must be an array');
  assertEqual(
    snapshot.points.length,
    reference.gcps.total,
    'GCP optimization snapshot point count',
  );
  assertEqual(
    snapshot.observations.length,
    expected.manualObservationCount,
    'GCP optimization snapshot observation count',
  );

  const controlNames = new Set(expected.controlPointNames);
  const checkpointNames = new Set(expected.checkpointPointNames);
  for (const record of snapshot.points) {
    const point = record?.point;
    requireRecord(point, 'GCP optimization snapshot point');
    assertEqual(point.id, point.name, `GCP snapshot point ${String(point.id)} immutable id`);
    const expectedParticipation = controlNames.has(point.name)
      ? 'control'
      : checkpointNames.has(point.name)
        ? 'checkpoint'
        : null;
    if (expectedParticipation == null)
      reject(`GCP snapshot contains an unknown point: ${point.name}`);
    assertEqual(
      record.participation,
      expectedParticipation,
      `GCP snapshot ${point.name} participation`,
    );
  }

  const observedCounts = Object.fromEntries(
    [...controlNames, ...checkpointNames].map((name) => [name, 0]),
  );
  const observationKeys = new Set();
  for (const observation of snapshot.observations) {
    if (!(observation.pointId in observedCounts))
      reject(`GCP snapshot observation references an unknown point: ${observation.pointId}`);
    assertPositiveInteger(observation.imageId, `GCP ${observation.pointId} observation image id`);
    assertEqual(observation.state?.state, 'manual', `GCP ${observation.pointId} observation state`);
    const coordinate = observation.state?.coordinate;
    requireRecord(coordinate, `GCP ${observation.pointId} observation coordinate`);
    assertFinite(coordinate.xPixels, `GCP ${observation.pointId} observation x`);
    assertFinite(coordinate.yPixels, `GCP ${observation.pointId} observation y`);
    if (
      coordinate.xPixels < 0 ||
      coordinate.xPixels >= reference.images.widthPixels ||
      coordinate.yPixels < 0 ||
      coordinate.yPixels >= reference.images.heightPixels
    ) {
      reject(`GCP ${observation.pointId} observation is outside the source image`);
    }
    const key = `${observation.pointId}:${observation.imageId}`;
    if (observationKeys.has(key)) reject(`GCP snapshot contains a duplicate observation: ${key}`);
    observationKeys.add(key);
    observedCounts[observation.pointId] += 1;
  }
  for (const [name, count] of Object.entries(expected.pointObservationCounts)) {
    assertEqual(observedCounts[name], count, `GCP snapshot ${name} observation count`);
  }
}

function validateComparisonCompatibility(products, reference) {
  assertComparableResolution(
    products.dem.resolutionMetersPerPixel,
    reference.dem.resolutionMetersPerPixel,
    reference.acceptance.demResolutionRelativeTolerance,
    'DEM',
  );
  assertComparableResolution(
    products.orthomosaic.resolutionMetersPerPixel,
    reference.orthomosaic.resolutionMetersPerPixel,
    reference.acceptance.orthomosaicResolutionRelativeTolerance,
    'orthomosaic',
  );
}

function inspectCandidateProducts(
  productList,
  projectRoot,
  reference,
  targetEpsg,
  targetVerticalEpsg,
  metrics,
) {
  if (!Array.isArray(productList)) reject('candidate products must be an array');
  const contract = reference.candidateContract;
  if (!Array.isArray(contract?.requiredProductKinds)) {
    reject('reference baseline has no required product contract');
  }
  const publications = Object.fromEntries(
    contract.requiredProductKinds.map((kind) => [
      kind,
      productList.filter((product) => product?.kind === kind),
    ]),
  );
  requireRecord(metrics.selectedProductEntityIds, 'candidate metric: selected product entities');
  const selected = {};
  for (const kind of contract.requiredProductKinds) {
    if (publications[kind].length === 0) reject(`candidate product is missing: ${kind}`);
    const entityId = metrics.selectedProductEntityIds[kind];
    if (typeof entityId !== 'string' || entityId.length === 0) {
      reject(`candidate selected product is missing: ${kind}`);
    }
    const matches = publications[kind].filter((product) => product.entityId === entityId);
    if (matches.length !== 1) {
      reject(`candidate selected product ${kind} does not identify exactly one publication`);
    }
    selected[kind] = matches[0];
  }
  const lineage = validateProductLineage(selected, metrics);

  const sparse = readAlignmentProduct(selected.sparse, projectRoot);
  const dense = readDenseProduct(selected.dense, projectRoot, reference);
  const depth = readDepthProduct(selected.depth, projectRoot);
  assertEqual(depth.jobId, dense.jobId, 'golden depth-map and dense-fusion job');
  validateGoldenMvsSettings(depth.settings, reference);
  const dem = readRasterProduct(selected.dem, projectRoot, 'DEM', targetEpsg, targetVerticalEpsg);
  const orthomosaic = readRasterProduct(
    selected.orthomosaic,
    projectRoot,
    'orthomosaic',
    targetEpsg,
    targetVerticalEpsg,
  );
  const mesh = readTiledProduct(selected.mesh, projectRoot, 'mesh', 'vertexCount');
  const gaussianSplat = readTiledProduct(
    selected.gaussianSplat,
    projectRoot,
    'Gaussian splat',
    'splatCount',
  );

  requireXyOverlap(dense.bounds, dem.bounds, 'dense cloud and DEM');
  requireXyOverlap(dense.bounds, mesh.bounds, 'dense cloud and mesh');
  requireXyOverlap(sparse.bounds, gaussianSplat.bounds, 'sparse cloud and Gaussian splat');
  requireXyOverlap(dem.bounds, orthomosaic.bounds, 'DEM and orthomosaic');

  return {
    lineage,
    sparse: { publicationCount: publications.sparse.length, ...sparse },
    depth: { publicationCount: publications.depth.length, ...depth },
    dense: { publicationCount: publications.dense.length, ...dense },
    dem: { publicationCount: publications.dem.length, ...dem },
    orthomosaic: { publicationCount: publications.orthomosaic.length, ...orthomosaic },
    mesh: { publicationCount: publications.mesh.length, ...mesh },
    gaussianSplat: {
      publicationCount: publications.gaussianSplat.length,
      ...gaussianSplat,
    },
  };
}

function validateProductLineage(selected, metrics) {
  if (typeof metrics.sourceAlignmentEntityId !== 'string' || !metrics.sourceAlignmentEntityId) {
    reject('candidate metric: source alignment entity is missing');
  }
  const expectedProcessingSet = metrics.processingSetId ?? null;
  for (const [kind, product] of Object.entries(selected)) {
    assertEqual(
      product.sourceAlignmentEntityId,
      metrics.sourceAlignmentEntityId,
      `${kind} source alignment lineage`,
    );
    assertEqual(
      product.processingSetId ?? null,
      expectedProcessingSet,
      `${kind} processing-set lineage`,
    );
  }
  return {
    sourceAlignmentEntityId: metrics.sourceAlignmentEntityId,
    processingSetId: expectedProcessingSet,
  };
}

function readAlignmentProduct(product, projectRoot) {
  const pointProduct = readPointProduct(product, projectRoot, 'sparse');
  const match = /^colmap\/([^/]+)\//.exec(product.relativePath);
  if (!match) reject('sparse product path does not identify its alignment job');
  const summary = readJsonFile(
    resolve(projectRoot, 'datasets', 'colmap', match[1], 'output-summary.json'),
    'alignment output summary',
  );
  if (!Array.isArray(summary.mappingCandidates)) {
    reject('alignment output summary has no mapping candidates');
  }
  const selected = summary.mappingCandidates.filter((candidate) => candidate?.selected === true);
  if (selected.length !== 1) reject('alignment output summary must select exactly one candidate');
  assertEqual(summary.jobId, match[1], 'alignment summary job id');
  assertEqual(selected[0].points3d, pointProduct.pointCount, 'alignment sparse point count');
  return {
    ...pointProduct,
    jobId: match[1],
    registeredImages: selected[0].registeredImages,
    observations: selected[0].observations,
    reprojectionRmsPixels: selected[0].meanReprojectionError,
  };
}

function readPointProduct(product, projectRoot, label) {
  const manifest = readProductJson(product, projectRoot, label);
  assertPositiveInteger(manifest.points, `${label} point count`);
  if (product.pointCount != null) {
    assertEqual(product.pointCount, manifest.points, `${label} publication point count`);
  }
  const bounds = normalizeArrayBounds(manifest.boundingBox, 3, `${label} bounds`);
  return { pointCount: manifest.points, bounds };
}

function readDepthProduct(product, projectRoot) {
  const manifest = readProductJson(product, projectRoot, 'depth');
  if (!Array.isArray(manifest.depthImages)) reject('depth manifest has no depthImages array');
  assertPositiveInteger(manifest.depthImages.length, 'depth image count');
  const request = readMvsRequest(product, projectRoot, 'depth');
  if (request.fuseDensePointCloud !== true) {
    reject('selected golden depth maps must be the exact maps consumed by dense fusion');
  }
  return {
    imageCount: manifest.depthImages.length,
    jobId: request.jobId,
    settings: request.settings,
  };
}

function readDenseProduct(product, projectRoot, reference) {
  const pointProduct = readPointProduct(product, projectRoot, 'dense');
  const request = readMvsRequest(product, projectRoot, 'dense');
  if (request.fuseDensePointCloud !== true) reject('dense MVS request did not enable fusion');
  const output = readJsonFile(
    resolve(projectRoot, 'datasets', 'mvs', request.jobId, 'output', 'index.json'),
    'dense MVS output index',
  );
  assertEqual(output.schemaVersion, 1, 'dense MVS output schema');
  assertEqual(output.jobId, request.jobId, 'dense MVS output job id');
  requireRecord(output.densePointCloud, 'dense MVS point-cloud record');
  const fusion = validateDenseFusionEvidence(
    output.densePointCloud.fusion,
    pointProduct.pointCount,
    reference,
  );
  return { ...pointProduct, jobId: request.jobId, settings: request.settings, fusion };
}

function validateDenseFusionEvidence(evidence, pointCount, reference) {
  requireRecord(evidence, 'dense MVS fusion evidence');
  assertEqual(
    evidence.algorithm,
    reference.denseCloud.fusion.requiredAlgorithm,
    'dense MVS fusion algorithm',
  );
  assertPositiveInteger(evidence.rawSampleCount, 'dense MVS raw sample count');
  assertPositiveInteger(evidence.fusedSampleCount, 'dense MVS fused sample count');
  assertEqual(evidence.fusedSampleCount, pointCount, 'dense MVS fused point count');
  if (evidence.rawSampleCount <= evidence.fusedSampleCount) {
    reject('dense MVS evidence does not prove cross-view deduplication');
  }
  for (const [key, label] of [
    ['voxelSizeMeters', 'voxel size'],
    ['minimumRepresentativePixelFootprintMeters', 'minimum pixel footprint'],
    ['medianRepresentativePixelFootprintMeters', 'median pixel footprint'],
    ['maximumRepresentativePixelFootprintMeters', 'maximum pixel footprint'],
  ]) {
    assertFinite(evidence[key], `dense MVS ${label}`);
    if (evidence[key] <= 0) reject(`dense MVS ${label} must be positive`);
  }
  assertNear(
    evidence.voxelSizeMeters,
    evidence.medianRepresentativePixelFootprintMeters,
    1e-12,
    'dense MVS footprint-derived voxel size',
  );
  if (
    evidence.minimumRepresentativePixelFootprintMeters >
      evidence.medianRepresentativePixelFootprintMeters ||
    evidence.medianRepresentativePixelFootprintMeters >
      evidence.maximumRepresentativePixelFootprintMeters
  ) {
    reject('dense MVS representative pixel footprints are not ordered');
  }
  assertPositiveInteger(evidence.externalSortRuns, 'dense MVS external-sort run count');
  assertPositiveInteger(evidence.maximumBufferedSamples, 'dense MVS sample buffer bound');
  if (evidence.maximumBufferedSamples > 2_000_000) {
    reject('dense MVS sample buffer bound exceeds the release contract');
  }
  return evidence;
}

function readMvsRequest(product, projectRoot, label) {
  const match = /^mvs\/([^/]+)\//.exec(product.relativePath);
  if (!match) reject(`${label} product path does not identify its MVS job`);
  const request = readJsonFile(
    resolve(projectRoot, 'datasets', 'mvs', match[1], 'request.json'),
    `${label} MVS request`,
  );
  assertEqual(request.schemaVersion, 1, `${label} MVS request schema`);
  assertEqual(request.jobId, match[1], `${label} MVS request job id`);
  requireRecord(request.settings, `${label} MVS request settings`);
  return request;
}

function validateGoldenMvsSettings(settings, reference) {
  assertEqual(
    settings.maximumImageDimension,
    reference.depth.effectiveMaximumImageDimension,
    'golden MVS maximum image dimension',
  );
  assertEqual(settings.matchingViews, reference.depth.maximumNeighbors, 'golden MVS neighbours');
  assertEqual(settings.minimumConsistentViews, 2, 'golden MVS minimum consistent views');
  assertNear(settings.minimumConfidence, 0.2, 1e-12, 'golden MVS minimum confidence');
  assertNear(settings.geometricRelativeTolerance, 0.025, 1e-12, 'golden MVS geometric tolerance');
  assertEqual(settings.retainConfidenceAttribute, true, 'golden MVS confidence retention');
  assertEqual(settings.calculateColors, true, 'golden MVS colour calculation');
}

function readRasterProduct(product, projectRoot, label, targetEpsg, targetVerticalEpsg) {
  const manifest = readProductJson(product, projectRoot, label);
  requireRecord(manifest.grid, `${label} grid`);
  requireRecord(manifest.crs, `${label} CRS`);
  const horizontal = `EPSG:${targetEpsg}`;
  const vertical = `EPSG:${targetVerticalEpsg}`;
  const compound = `${horizontal}+${targetVerticalEpsg}`;
  if (![horizontal, compound].includes(manifest.crs.horizontal))
    reject(
      `${label} horizontal CRS: expected ${horizontal}, observed ${String(manifest.crs.horizontal)}`,
    );
  assertEqual(manifest.crs.vertical, `normal-height:${vertical}`, `${label} vertical CRS`);
  assertEqual(manifest.crs.gdalSrs, compound, `${label} GDAL compound CRS`);
  if (!/^[0-9a-f]{64}$/.test(manifest.crs.canonicalWktSha256 ?? ''))
    reject(`${label} canonical WKT hash is missing or invalid`);
  const grid = manifest.grid;
  assertPositiveInteger(grid.widthPixels, `${label} width`);
  assertPositiveInteger(grid.heightPixels, `${label} height`);
  assertPositive(grid.gsd, `${label} resolution`);
  const bounds = normalizeRasterBounds(grid.bounds, `${label} bounds`);
  assertGridExtent(grid.widthPixels, grid.gsd, bounds, 0, `${label} width/georeference`);
  assertGridExtent(grid.heightPixels, grid.gsd, bounds, 1, `${label} height/georeference`);
  return {
    widthPixels: grid.widthPixels,
    heightPixels: grid.heightPixels,
    resolutionMetersPerPixel: grid.gsd,
    bounds,
    canonicalWktSha256: manifest.crs.canonicalWktSha256,
  };
}

function readTiledProduct(product, projectRoot, label, countKey) {
  const manifest = readProductJson(product, projectRoot, label);
  if (!Array.isArray(manifest.tiles) || manifest.tiles.length === 0) {
    reject(`${label} manifest has no tiles`);
  }
  const root = manifest.tiles.find((tile) => tile.id === manifest.rootTileId);
  if (!root) reject(`${label} root tile is missing`);
  const leaves = manifest.tiles.filter(
    (tile) => !Array.isArray(tile.children) || tile.children.length === 0,
  );
  const count = leaves.reduce((total, tile) => {
    assertPositiveInteger(tile[countKey], `${label} tile ${tile.id} ${countKey}`);
    return total + tile[countKey];
  }, 0);
  const bounds = normalizeObjectBounds(root.bounds, 3, `${label} bounds`);
  const result = { tileCount: manifest.tiles.length, bounds };
  result[countKey] = count;
  if (countKey === 'vertexCount') {
    const triangleCount = leaves.reduce((total, tile) => {
      assertPositiveInteger(tile.indexCount, `${label} tile ${tile.id} indexCount`);
      if (tile.indexCount % 3 !== 0)
        reject(`${label} tile ${tile.id} indexCount is not triangular`);
      return total + tile.indexCount / 3;
    }, 0);
    result.triangleCount = triangleCount;
  }
  return result;
}

function validateReportedProductMetrics(metrics, products) {
  assertEqual(metrics.depthImageCount, products.depth.imageCount, 'reported depth image count');
  assertEqual(metrics.densePointCount, products.dense.pointCount, 'reported dense point count');
  requireRecord(metrics.denseFusionEvidence, 'candidate metric: dense fusion evidence');
  for (const key of [
    'algorithm',
    'rawSampleCount',
    'fusedSampleCount',
    'externalSortRuns',
    'maximumBufferedSamples',
  ]) {
    assertEqual(
      metrics.denseFusionEvidence[key],
      products.dense.fusion[key],
      `reported dense fusion ${key}`,
    );
  }
  for (const key of [
    'voxelSizeMeters',
    'minimumRepresentativePixelFootprintMeters',
    'medianRepresentativePixelFootprintMeters',
    'maximumRepresentativePixelFootprintMeters',
  ]) {
    assertNear(
      metrics.denseFusionEvidence[key],
      products.dense.fusion[key],
      1e-12,
      `reported dense fusion ${key}`,
    );
  }
  assertNear(
    metrics.orthomosaicResolutionMetersPerPixel,
    products.orthomosaic.resolutionMetersPerPixel,
    1e-12,
    'reported orthomosaic resolution',
  );
  const reportedBounds = normalizeArrayBounds(
    metrics.orthomosaicBounds,
    2,
    'reported orthomosaic bounds',
  );
  assertNearArray(reportedBounds.min, products.orthomosaic.bounds.min, 1e-8, 'reported bounds min');
  assertNearArray(reportedBounds.max, products.orthomosaic.bounds.max, 1e-8, 'reported bounds max');
  validateRasterEvidence(metrics.rasterStatistics, products, metrics.orthomosaicValidFraction);
}

function validateRasterEvidence(statistics, products, reportedValidFraction) {
  requireRecord(statistics, 'candidate metric: raster statistics');
  for (const [kind, label] of [
    ['dem', 'DEM'],
    ['orthomosaic', 'orthomosaic'],
  ]) {
    const evidence = statistics[kind];
    requireRecord(evidence, `candidate metric: ${label} raster statistics`);
    const product = products[kind];
    assertEqual(evidence.widthPixels, product.widthPixels, `${label} COG width`);
    assertEqual(evidence.heightPixels, product.heightPixels, `${label} COG height`);
    assertNear(
      evidence.resolutionMetersPerPixel,
      product.resolutionMetersPerPixel,
      1e-12,
      `${label} COG resolution`,
    );
    const bounds = normalizeArrayBounds(evidence.bounds, 2, `${label} COG bounds`);
    assertNearArray(bounds.min, product.bounds.min, 1e-8, `${label} COG bounds min`);
    assertNearArray(bounds.max, product.bounds.max, 1e-8, `${label} COG bounds max`);
    assertEqual(
      evidence.canonicalWktSha256,
      product.canonicalWktSha256,
      `${label} COG canonical WKT hash`,
    );
    assertPositiveInteger(evidence.bandCount, `${label} COG band count`);
  }
  assertNear(
    statistics.orthomosaic.validFraction,
    reportedValidFraction,
    1e-12,
    'orthomosaic COG valid fraction',
  );
}

function validateProductQuality(products, metrics, reference) {
  assertEqual(products.depth.imageCount, reference.images.total, 'candidate depth image count');
  const denseRelativeError =
    Math.abs(products.dense.pointCount - reference.denseCloud.reportPointCount) /
    reference.denseCloud.reportPointCount;
  if (denseRelativeError > reference.acceptance.densePointCountRelativeTolerance) {
    reject(
      `dense point count relative error ${denseRelativeError} exceeds ${reference.acceptance.densePointCountRelativeTolerance}`,
    );
  }
  assertReferenceCoverage(
    products.orthomosaic.bounds,
    reference.orthomosaic.bounds,
    reference.acceptance.orthomosaicBoundsToleranceMeters,
    reference.acceptance.orthomosaicBoundsExpansionMaximumPixels *
      products.orthomosaic.resolutionMetersPerPixel,
    'candidate orthomosaic bounds',
  );
  assertFinite(metrics.orthomosaicValidFraction, 'orthomosaic valid-pixel fraction');
  if (metrics.orthomosaicValidFraction < reference.acceptance.orthomosaicValidFractionMinimum) {
    reject(
      `orthomosaic valid-pixel fraction ${metrics.orthomosaicValidFraction} is below ${reference.acceptance.orthomosaicValidFractionMinimum}`,
    );
  }
}

function assertReferenceCoverage(actual, expected, missingTolerance, expansionMaximum, label) {
  for (let axis = 0; axis < expected.min.length; axis += 1) {
    if (actual.min[axis] > expected.min[axis] + missingTolerance)
      reject(`${label} misses the reference minimum on axis ${axis}`);
    if (actual.max[axis] < expected.max[axis] - missingTolerance)
      reject(`${label} misses the reference maximum on axis ${axis}`);
    if (expected.min[axis] - actual.min[axis] > expansionMaximum + missingTolerance)
      reject(`${label} expands too far below the reference on axis ${axis}`);
    if (actual.max[axis] - expected.max[axis] > expansionMaximum + missingTolerance)
      reject(`${label} expands too far above the reference on axis ${axis}`);
  }
}

function assertComparableResolution(actual, expected, tolerance, label) {
  assertPositive(actual, `${label} resolution`);
  assertPositive(expected, `${label} reference resolution`);
  const relativeError = Math.abs(actual - expected) / expected;
  if (relativeError > tolerance) {
    reject(
      `${label} comparison setting is incompatible: resolution ${actual} differs from ${expected} by ${relativeError}; allowed relative difference is ${tolerance}`,
    );
  }
}

function validateRuntime(candidate, runtimeSeconds, reference) {
  requireRecord(runtimeSeconds, 'candidate metric: runtimeSeconds');
  const referenceSeconds = {
    alignment:
      reference.referencePerformance.alignmentMatchingSeconds +
      reference.referencePerformance.alignmentMappingSeconds +
      reference.referencePerformance.alignmentOptimizationSeconds,
    gcpOptimization: reference.referencePerformance.alignmentOptimizationSeconds,
    depth: reference.referencePerformance.depthSeconds,
    denseCloud: reference.referencePerformance.denseCloudSeconds,
    dem: reference.referencePerformance.demSeconds,
    orthomosaic: reference.referencePerformance.orthomosaicSeconds,
  };
  const stages = {};
  for (const stage of reference.candidateContract.requiredRuntimeStages) {
    const seconds = runtimeSeconds[stage];
    assertPositive(seconds, `runtime ${stage}`);
    const agisoftSeconds = referenceSeconds[stage] ?? null;
    stages[stage] = {
      agisoftSeconds,
      candidateSeconds: seconds,
      ratio: agisoftSeconds == null ? null : seconds / agisoftSeconds,
    };
  }
  return {
    note: 'Ratios are informational because the Agisoft report used a faster workstation.',
    stages,
  };
}

function resolveProjectRoot(candidate, candidatePath) {
  if (typeof candidate.projectPath !== 'string' || candidate.projectPath.length === 0) {
    reject('candidate projectPath is missing');
  }
  const base = candidatePath ? dirname(resolve(candidatePath)) : cwd();
  const root = isAbsolute(candidate.projectPath)
    ? resolve(candidate.projectPath)
    : resolve(base, candidate.projectPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    reject(`candidate project directory is missing: ${root}`);
  }
  return root;
}

function readProductJson(product, projectRoot, label) {
  requireRecord(product, `${label} product publication`);
  if (typeof product.relativePath !== 'string' || product.relativePath.length === 0) {
    reject(`${label} product relativePath is missing`);
  }
  const datasetRoot = resolve(projectRoot, 'datasets');
  const path = resolve(datasetRoot, product.relativePath);
  const traversal = relative(datasetRoot, path);
  if (traversal.startsWith('..') || isAbsolute(traversal)) {
    reject(`${label} product path escapes the project datasets directory`);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    reject(`${label} product manifest is missing: ${path}`);
  }
  return readJsonFile(path, `${label} product manifest`);
}

function readJsonFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) reject(`${label} is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    reject(`${label} is invalid JSON: ${error.message}`);
  }
}

function readHashedJsonObject(projectRoot, hash, label) {
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) reject(`${label} hash is missing or invalid`);
  const path = resolve(projectRoot, 'objects', hash.slice(0, 2), hash.slice(2));
  if (!existsSync(path) || !statSync(path).isFile()) reject(`${label} is missing: ${path}`);
  const bytes = readFileSync(path);
  assertEqual(createHash('sha256').update(bytes).digest('hex'), hash, `${label} content hash`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    reject(`${label} is invalid JSON: ${error.message}`);
  }
}

function normalizeArrayBounds(bounds, dimensions, label) {
  requireRecord(bounds, label);
  if (!Array.isArray(bounds.min) || !Array.isArray(bounds.max)) {
    reject(`${label} must contain min/max arrays`);
  }
  return validateBounds({ min: bounds.min, max: bounds.max }, dimensions, label);
}

function normalizeObjectBounds(bounds, dimensions, label) {
  requireRecord(bounds, label);
  const axes = ['x', 'y', 'z'].slice(0, dimensions);
  return validateBounds(
    { min: axes.map((axis) => bounds.min?.[axis]), max: axes.map((axis) => bounds.max?.[axis]) },
    dimensions,
    label,
  );
}

function normalizeRasterBounds(bounds, label) {
  requireRecord(bounds, label);
  return validateBounds(
    {
      min: [bounds.minimumEast, bounds.minimumNorth],
      max: [bounds.maximumEast, bounds.maximumNorth],
    },
    2,
    label,
  );
}

function validateBounds(bounds, dimensions, label) {
  if (bounds.min.length !== dimensions || bounds.max.length !== dimensions) {
    reject(`${label} must have ${dimensions} dimensions`);
  }
  for (let index = 0; index < dimensions; index += 1) {
    assertFinite(bounds.min[index], `${label} minimum[${index}]`);
    assertFinite(bounds.max[index], `${label} maximum[${index}]`);
    if (bounds.max[index] <= bounds.min[index]) {
      reject(`${label}[${index}] is empty or reversed`);
    }
  }
  return { min: [...bounds.min], max: [...bounds.max] };
}

function assertGridExtent(pixels, resolution, bounds, axis, label) {
  const expected = pixels * resolution;
  const observed = bounds.max[axis] - bounds.min[axis];
  // Reference exports can round displayed corner coordinates while retaining
  // the full geotransform. Half a pixel catches broken manifests without
  // rejecting that harmless presentation rounding.
  assertNear(observed, expected, Math.max(1e-8, resolution * 0.5), label);
}

function requireXyOverlap(left, right, label) {
  if (
    Math.min(left.max[0], right.max[0]) <= Math.max(left.min[0], right.min[0]) ||
    Math.min(left.max[1], right.max[1]) <= Math.max(left.min[1], right.min[1])
  ) {
    reject(`${label} bounds do not overlap in XY`);
  }
}

function parseReferenceEpsg(value) {
  const match = /^EPSG:(\d+)$/.exec(value);
  if (!match) reject(`unsupported reference CRS: ${String(value)}`);
  return Number(match[1]);
}

function requireRecord(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    reject(`${label} must be an object`);
  }
}

function assertMaximumOrMinimum(value, limit, direction, label) {
  assertFinite(value, label);
  assertFinite(limit, `${label} limit`);
  if (direction === 'minimum' ? value < limit : value > limit) {
    reject(`${label} ${value} violates ${direction} ${limit}`);
  }
}

function assertPositive(value, label) {
  assertFinite(value, label);
  if (value <= 0) reject(`${label} must be greater than zero`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(`${label} must be a positive integer`);
}

function assertFinite(value, label) {
  if (!Number.isFinite(value)) reject(`candidate metric is missing or invalid: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) reject(`${label}: expected ${expected}, observed ${actual}`);
}

function assertNear(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    reject(`${label}: expected ${expected} ± ${tolerance}, observed ${actual}`);
  }
}

function assertNearArray(actual, expected, tolerance, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    reject(`${label}: array dimensions differ`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    assertNear(actual[index], expected[index], tolerance, `${label}[${index}]`);
  }
}

function assertStringArrayEqual(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) reject(`${label} must be arrays`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assertEqual(JSON.stringify(left), JSON.stringify(right), label);
}

function reject(message) {
  throw new AgisoftCandidateValidationError(message);
}
