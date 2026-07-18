#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- These tests deliberately mutate parsed JSON fixtures. */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  AgisoftCandidateValidationError,
  validateAgisoftCandidate,
} from './lib/photolab-agisoft-candidate.mjs';
import {
  AGISOFT_HIGH_DEPTH_CONTRACT,
  agisoftGoldenMvsConfiguration,
} from './lib/photolab-agisoft-products.mjs';

const workspace = resolve(import.meta.dirname, '..');
const baseline = readJson('photolab/golden/agisoft-sulzberg-baseline.json');
const candidatePath = resolve(
  workspace,
  'scripts/fixtures/photolab-agisoft-candidate/accepted-result.json',
);
const acceptedCandidate = JSON.parse(readFileSync(candidatePath, 'utf8'));

void test('accepts a complete candidate and reports product counts, bounds, and runtime ratios', () => {
  const comparison = validate(acceptedCandidate);
  assert.equal(comparison.status, 'accepted');
  assert.equal(comparison.products.depth.imageCount, 135);
  assert.equal(comparison.products.dense.pointCount, 59_642_494);
  assert.deepEqual(comparison.products.orthomosaic.bounds, baseline.orthomosaic.bounds);
  assert.equal(comparison.products.mesh.triangleCount, 1_000_000);
  assert.equal(comparison.products.gaussianSplat.splatCount, 156_158);
  assert.equal(comparison.gcp.control.pointCount, 4);
  assert.equal(comparison.gcp.checkpoint.pointCount, 2);
  assert.equal(comparison.runtime.stages.alignment.candidateSeconds, 1500);
  assert.equal(comparison.runtime.stages.alignment.agisoftSeconds, 246);
});

void test('rejects legacy candidates without separate GCP statistics', () => {
  const candidate = clone(acceptedCandidate);
  delete candidate.candidateMetrics.gcpStatistics;
  assertRejected(candidate, 'candidate metric: GCP statistics must be an object');
});

void test('requires the Quality Hybrid profile for the golden quality claim', () => {
  const candidate = clone(acceptedCandidate);
  candidate.profile = 'fast';
  assertRejected(candidate, 'candidate alignment profile: expected qualityHybrid, observed fast');
});

void test('requires the frozen golden E2E preset', () => {
  const candidate = clone(acceptedCandidate);
  candidate.goldenAgisoft = false;
  assertRejected(candidate, 'candidate was not produced by --golden-agisoft');
});

void test('maps Metashape High to linear downscale two with mild 16-view depth maps', () => {
  assert.deepEqual(agisoftGoldenMvsConfiguration('depth'), {
    kind: 'depth',
    imageDownscale: 2,
    filter: 'mild',
    maximumNeighbors: 16,
    reuseCompatibleMaps: true,
  });
  assert.deepEqual(agisoftGoldenMvsConfiguration('dense'), {
    kind: 'dense',
    imageDownscale: 2,
    filter: 'mild',
    maximumNeighbors: 16,
    minimumViews: 2,
    retainConfidence: true,
    calculateColors: true,
  });
  assert.equal(AGISOFT_HIGH_DEPTH_CONTRACT.effectiveMaximumImageDimension, 2640);
});

void test('rejects a lower-resolution MVS request even if its point count matches', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'photolab-agisoft-mvs-scale-'));
  try {
    cpSync(resolve(candidatePath, '..'), temporaryRoot, { recursive: true });
    const temporaryCandidatePath = join(temporaryRoot, 'accepted-result.json');
    const candidate = JSON.parse(readFileSync(temporaryCandidatePath, 'utf8'));
    const requestPath = join(temporaryRoot, 'project.hcad/datasets/mvs/dense-golden/request.json');
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    request.settings.maximumImageDimension = 660;
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    assert.throws(
      () =>
        validateAgisoftCandidate(candidate, baseline, {
          candidatePath: temporaryCandidatePath,
        }),
      (error) =>
        error instanceof AgisoftCandidateValidationError &&
        error.message === 'golden MVS maximum image dimension: expected 2640, observed 660',
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

void test('requires artifact-backed geometric cross-view fusion evidence', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'photolab-agisoft-fusion-evidence-'));
  try {
    cpSync(resolve(candidatePath, '..'), temporaryRoot, { recursive: true });
    const temporaryCandidatePath = join(temporaryRoot, 'accepted-result.json');
    const candidate = JSON.parse(readFileSync(temporaryCandidatePath, 'utf8'));
    const outputPath = join(
      temporaryRoot,
      'project.hcad/datasets/mvs/dense-golden/output/index.json',
    );
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    output.densePointCloud.fusion.rawSampleCount = output.densePointCloud.fusion.fusedSampleCount;
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    assert.throws(
      () =>
        validateAgisoftCandidate(candidate, baseline, {
          candidatePath: temporaryCandidatePath,
        }),
      (error) =>
        error instanceof AgisoftCandidateValidationError &&
        error.message === 'dense MVS evidence does not prove cross-view deduplication',
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

void test('rejects reported fusion evidence that differs from the published MVS output', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.denseFusionEvidence.externalSortRuns += 1;
  assertRejected(candidate, 'reported dense fusion externalSortRuns: expected 1492, observed 1493');
});

void test('checks checkpoint components independently from control statistics', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.gcpStatistics.checkpoint.heightRmsMeters = 0.02;
  assertRejected(candidate, 'GCP checkpoint height RMSE 0.02 violates maximum 0.00784287');
});

void test('checks control and checkpoint pixel RMS against the report independently', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.gcpStatistics.control.reprojectionRmsPixels = 0.8;
  assertRejected(candidate, 'GCP control pixel RMS 0.8 violates maximum 0.758');
});

void test('rejects a missing required product with its product kind', () => {
  const candidate = clone(acceptedCandidate);
  candidate.products = candidate.products.filter((product) => product.kind !== 'gaussianSplat');
  assertRejected(candidate, 'candidate product is missing: gaussianSplat');
});

void test('rejects products assembled from different alignment lineages', () => {
  const candidate = clone(acceptedCandidate);
  candidate.products.find((product) => product.kind === 'mesh').sourceAlignmentEntityId =
    'foreign-alignment';
  assertRejected(
    candidate,
    'mesh source alignment lineage: expected project-golden:compute:alignment-quality:1, observed foreign-alignment',
  );
});

void test('pins GCP statistics to the published optimization artifact', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.gcpOptimizationEvidence.artifactSha256 = 'e'.repeat(64);
  assertRejected(
    candidate,
    `GCP optimization record artifact hash: expected ${'e'.repeat(64)}, observed ${'b'.repeat(64)}`,
  );
});

void test('requires the exact Agisoft manual-observation provenance', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.gcpObservationEvidence.source.frameDocumentSha256 = 'e'.repeat(64);
  assertRejected(
    candidate,
    `GCP observation source frameDocumentSha256: expected ${baseline.gcps.manualObservationEvidence.source.frameDocumentSha256}, observed ${'e'.repeat(64)}`,
  );
});

void test('pins the GCP snapshot bytes as well as its published statistics', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'photolab-agisoft-gcp-snapshot-'));
  try {
    cpSync(resolve(candidatePath, '..'), temporaryRoot, { recursive: true });
    const temporaryCandidatePath = join(temporaryRoot, 'accepted-result.json');
    const candidate = JSON.parse(readFileSync(temporaryCandidatePath, 'utf8'));
    const hash = candidate.candidateMetrics.gcpOptimizationEvidence.snapshotSha256;
    const snapshotPath = join(
      temporaryRoot,
      'project.hcad/objects',
      hash.slice(0, 2),
      hash.slice(2),
    );
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    snapshot.observations[0].state.coordinate.xPixels += 1;
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    assert.throws(
      () =>
        validateAgisoftCandidate(candidate, baseline, {
          candidatePath: temporaryCandidatePath,
        }),
      (error) =>
        error instanceof AgisoftCandidateValidationError &&
        error.message.startsWith('GCP optimization snapshot content hash: expected '),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

void test('cross-checks raster COG evidence with the manifest CRS and grid', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.rasterStatistics.orthomosaic.canonicalWktSha256 = 'e'.repeat(64);
  assertRejected(
    candidate,
    `orthomosaic COG canonical WKT hash: expected ${'d'.repeat(64)}, observed ${'e'.repeat(64)}`,
  );
});

void test('rejects metrics that disagree with published product manifests', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.depthImageCount = 134;
  assertRejected(candidate, 'reported depth image count: expected 135, observed 134');
});

void test('requires the golden project CRS instead of bypassing bounds checks', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.targetEpsg = 25832;
  assertRejected(candidate, 'candidate target EPSG: expected 31468, observed 25832');
});

void test('rejects downscaled smoke rasters as incomparable before making quality claims', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'photolab-agisoft-candidate-'));
  try {
    cpSync(resolve(candidatePath, '..'), temporaryRoot, { recursive: true });
    const temporaryCandidatePath = join(temporaryRoot, 'accepted-result.json');
    const candidate = JSON.parse(readFileSync(temporaryCandidatePath, 'utf8'));
    const manifestPath = join(temporaryRoot, 'project.hcad/datasets/dem/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.grid.gsd = 0.25;
    manifest.grid.bounds.maximumEast =
      manifest.grid.bounds.minimumEast + manifest.grid.widthPixels * manifest.grid.gsd;
    manifest.grid.bounds.maximumNorth =
      manifest.grid.bounds.minimumNorth + manifest.grid.heightPixels * manifest.grid.gsd;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    candidate.candidateMetrics.rasterStatistics.dem.resolutionMetersPerPixel = 0.25;
    candidate.candidateMetrics.rasterStatistics.dem.bounds = {
      min: [manifest.grid.bounds.minimumEast, manifest.grid.bounds.minimumNorth],
      max: [manifest.grid.bounds.maximumEast, manifest.grid.bounds.maximumNorth],
    };
    assert.throws(
      () =>
        validateAgisoftCandidate(candidate, baseline, {
          candidatePath: temporaryCandidatePath,
        }),
      (error) =>
        error instanceof AgisoftCandidateValidationError &&
        error.message.startsWith(
          'DEM comparison setting is incompatible: resolution 0.25 differs from 0.015 by ',
        ) &&
        error.message.endsWith('; allowed relative difference is 0.02'),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

void test('cross-checks alignment counts and reprojection RMS with the COLMAP summary', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'photolab-agisoft-alignment-'));
  try {
    cpSync(resolve(candidatePath, '..'), temporaryRoot, { recursive: true });
    const temporaryCandidatePath = join(temporaryRoot, 'accepted-result.json');
    const candidate = JSON.parse(readFileSync(temporaryCandidatePath, 'utf8'));
    const summaryPath = join(
      temporaryRoot,
      'project.hcad/datasets/colmap/alignment-quality/output-summary.json',
    );
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    summary.mappingCandidates[0].registeredImages = 134;
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    assert.throws(
      () =>
        validateAgisoftCandidate(candidate, baseline, {
          candidatePath: temporaryCandidatePath,
        }),
      (error) =>
        error instanceof AgisoftCandidateValidationError &&
        error.message === 'alignment registered images: expected 134, observed 135',
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

void test('requires every product runtime', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.runtimeSeconds.mesh = null;
  assertRejected(candidate, 'candidate metric is missing or invalid: runtime mesh');
});

void test('rejects reversed product bounds', () => {
  const candidate = clone(acceptedCandidate);
  candidate.candidateMetrics.orthomosaicBounds = {
    min: [...baseline.orthomosaic.bounds.max],
    max: [...baseline.orthomosaic.bounds.min],
  };
  assertRejected(candidate, 'reported orthomosaic bounds[0] is empty or reversed');
});

void test('rejects paths outside the project datasets directory', () => {
  const candidate = clone(acceptedCandidate);
  candidate.products.find((product) => product.kind === 'sparse').relativePath = '../manifest.json';
  assertRejected(candidate, 'sparse product path escapes the project datasets directory');
});

function validate(candidate) {
  return validateAgisoftCandidate(candidate, baseline, { candidatePath });
}

function assertRejected(candidate, message) {
  assert.throws(
    () => validate(candidate),
    (error) => error instanceof AgisoftCandidateValidationError && error.message === message,
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(workspace, relativePath), 'utf8'));
}
