import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stdout } from 'node:process';

import { buildProcessingReportHtml } from '../apps/photolab/renderer/src/processingReport.ts';

const sha = 'a'.repeat(64);

/** Fixed golden fixture: every field is literal so the report stays reproducible. */
const fixture = {
  project: { id: 'project-sulzberg', name: 'Sulzberg <Survey>', formatVersion: 1 },
  generatedAt: new Date('2026-07-13T08:30:00.000Z'),
  generatedAtSource: 'Project snapshot modifiedUnixMs (last autosave/save timestamp)',
  surveyData: {
    schemaVersion: 2,
    crs: {
      spatialReference: { kind: 'crsBacked' },
      referenceFrame: { target: { horizontal: { crs: { epsg: 25832 } } } },
    },
    alignments: [
      {
        entityId: 'alignment-1',
        name: 'Mission West alignment',
        kind: 'alignment',
        imageCount: 2,
        gsdMetersPerPixel: 0.01875,
        gsdMethod:
          'Mean positive camera height above the median-elevation horizontal plane of optimized sparse tie points, divided by mean (fx, fy) focal length in pixels.',
        footprintBbox: [500000, 5300000, 500120, 5300080],
        footprintBboxAreaSquareMeters: 9600,
        calibrationGroups: [
          {
            groupId: 'calibration-1',
            imageCount: 2,
            seed: { f: 4000, cx: 3000, cy: 2000, k1: -0.01, k2: 0.001, k3: 0, p1: 0, p2: 0 },
            solved: {
              f: 4025,
              cx: 3001,
              cy: 1999,
              k1: -0.009,
              k2: 0.0009,
              k3: 0.00001,
              p1: 0.00002,
              p2: -0.00001,
            },
            refined: {
              f: true,
              cx: true,
              cy: true,
              k1: true,
              k2: true,
              k3: false,
              p1: false,
              p2: false,
            },
            fixed: false,
            sigmas: null,
            correlation: null,
            uncertaintyNote:
              'Unavailable: this GCP optimization snapshot stores observability diagnostics but no intrinsics covariance.',
          },
        ],
        gcpResiduals: [
          {
            pointId: 'gcp-1',
            pointName: 'Control <1>',
            role: 'controlXyz',
            position: [500010, 5300010],
            vectorMeters: [0.001, -0.002],
            heightMeters: 0.003,
          },
          {
            pointId: 'check-1',
            pointName: 'Check 1',
            role: 'checkpointXyz',
            position: [500100, 5300070],
            vectorMeters: [-0.004, 0.003],
            heightMeters: -0.002,
          },
        ],
        gcpOptimizationEntityId: 'gcp-solution-1',
        gcpOptimizationSnapshotSha256: '2'.repeat(64),
      },
    ],
    jobs: [
      {
        jobId: 'job-alignment',
        kind: 'alignPhotos',
        method: 'photolab.jobs.align.start',
        profileName: 'qualityHybrid',
        resolvedPresetName: 'Site quality',
        parameters: {
          resolved: { maximumImageDimension: 9000, keypointsPerMegapixel: 8000 },
        },
      },
    ],
  },
  hardware: {
    operatingSystem: 'linux',
    ramBytes: 32 * 1024 ** 3,
    dedicatedVramBytes: 8 * 1024 ** 3,
    cpu: { physicalCores: 8, logicalCores: 16, supportsAvx2: true },
    cuda: { deviceName: 'Fixture GPU', computeCapability: { major: 8, minor: 6 } },
  },
  jobs: [
    {
      schemaVersion: 1,
      id: 'job-alignment',
      kind: 'alignPhotos',
      configHash: sha,
      inputHash: 'b'.repeat(64),
      state: { kind: 'completed' },
      progress: {
        stage: { kind: 'finalizing', index: 1, stageCount: 2, label: 'Complete' },
        metrics: { completedUnits: 2, totalUnits: 2, completedBytes: 0 },
      },
      createdAtUnixMs: 1_000,
      startedAtUnixMs: 2_000,
      finishedAtUnixMs: 5_500,
      lastCheckpointSequence: 4,
    },
    {
      schemaVersion: 1,
      id: 'job-failed',
      kind: 'buildDem',
      configHash: 'c'.repeat(64),
      inputHash: 'd'.repeat(64),
      state: { kind: 'failed', code: 'fixtureFailure', message: '<grid> unavailable & invalid' },
      progress: {
        stage: { kind: 'rasterization', index: 0, stageCount: 2, label: 'Rasterize' },
        metrics: { completedUnits: 0, totalUnits: 10, completedBytes: 0 },
      },
      createdAtUnixMs: 6_000,
      startedAtUnixMs: 7_000,
      finishedAtUnixMs: 8_000,
    },
    {
      schemaVersion: 1,
      id: 'job-interrupted',
      kind: 'buildOrthomosaic',
      configHash: '9'.repeat(64),
      inputHash: '8'.repeat(64),
      state: {
        kind: 'failed',
        code: 'interruptedRecoverable',
        message: 'Previous process ended; resume is available.',
      },
      progress: {
        stage: { kind: 'rasterization', index: 2, stageCount: 5, label: 'Build tile pyramid' },
        metrics: { completedUnits: 18, totalUnits: 40, completedBytes: 2048 },
      },
      createdAtUnixMs: 9_000,
      startedAtUnixMs: 10_000,
      finishedAtUnixMs: 14_000,
      lastCheckpointSequence: 7,
    },
  ],
  processingSets: [
    {
      schemaVersion: 2,
      entityId: 'processing-set-1',
      name: 'Mission <West>',
      cameraEntityIds: ['camera-1', 'camera-2'],
      membershipSha256: 'e'.repeat(64),
      captureGroupIds: ['capture-1'],
      calibrationGroupIds: ['calibration-1'],
    },
  ],
  captureGroups: [
    {
      schemaVersion: 1,
      entityId: 'capture-1',
      name: 'Flight 1',
      cameraEntityIds: ['camera-1', 'camera-2'],
      membershipSha256: 'f'.repeat(64),
      calibrationGroupIds: ['calibration-1'],
    },
  ],
  calibrationGroups: [
    {
      schemaVersion: 1,
      entityId: 'calibration-1',
      captureGroupId: 'capture-1',
      name: 'Autofocus 1',
      cameraEntityIds: ['camera-1', 'camera-2'],
      membershipSha256: '0'.repeat(64),
      groupingBasis: 'missionAutofocus',
    },
  ],
  alignmentRuns: [
    {
      entityId: 'alignment-1',
      name: 'Mission West alignment',
      jobId: 'align-west',
      publicationSequence: 12,
      cameraEntityIds: ['camera-1', 'camera-2'],
      processingSetId: 'processing-set-1',
      calibrationGroupIds: ['calibration-1'],
      calibrationGroups: [{ groupId: 'calibration-1', cameraEntityIds: ['camera-1', 'camera-2'] }],
      calibrationGroupIntrinsics: [
        {
          groupId: 'calibration-1',
          pinned: false,
          seedFocalPixels: 4000,
          solvedFocalPixels: 4025,
          focalDeltaPixels: 25,
        },
      ],
    },
  ],
  gcpOptimizations: [
    {
      entityId: 'gcp-solution-1',
      optimization: {
        publicationSequence: 14,
        operationId: 'optimize-west',
        inputSha256: '3'.repeat(64),
        artifactSha256: '4'.repeat(64),
        sourceAlignmentEntityId: 'alignment-1',
        processingSetId: 'processing-set-1',
        snapshotSha256: '2'.repeat(64),
        artifact: {
          solver: 'robust-bundle-adjustment',
          result: {
            converged: true,
            iterations: 9,
            finalObjective: 0.125,
            cameras: [{ entityId: 'camera-1' }],
            points: [{ pointId: 'gcp-1', observationCount: 5 }],
            statistics: {
              control: {
                pointCount: 1,
                eastRmsMeters: 0.001,
                northRmsMeters: 0.002,
                horizontalRmsMeters: 0.0022,
                heightRmsMeters: 0.003,
                spatial3dRmsMeters: 0.0037,
                activeComponentRmsMeters: 0.0037,
                reprojectionRmsPixels: 0.25,
                maxActiveComponentMeters: 0.004,
                maxReprojectionPixels: 0.4,
              },
              checkpoint: {
                pointCount: 1,
                activeComponentRmsMeters: 0.006,
                reprojectionRmsPixels: 0.3,
                maxActiveComponentMeters: 0.007,
                maxReprojectionPixels: 0.5,
              },
            },
            residuals: [
              {
                pointId: 'gcp-1',
                role: 'controlXyz',
                eastMeters: 0.001,
                northMeters: -0.002,
                heightMeters: 0.003,
                horizontalMeters: 0.0022,
                spatial3dMeters: 0.0037,
                activeComponentNormMeters: 0.0037,
                reprojectionRmsPixels: 0.25,
                reprojectionMaxPixels: 0.4,
              },
            ],
          },
        },
      },
    },
  ],
  alignmentMerges: [
    {
      schemaVersion: 1,
      entityId: 'merge-1',
      name: 'Joint survey',
      state: 'published',
      inputAlignmentEntityIds: ['alignment-1', 'alignment-2'],
      inputGcpOptimizationEntityIds: ['gcp-solution-1'],
      connections: [
        {
          kind: 'sharedControls',
          alignmentA: 'alignment-1',
          alignmentB: 'alignment-2',
          controlPointIds: ['gcp-1'],
        },
      ],
      connectionEvidence: [
        {
          connectionIndex: 0,
          kind: 'sharedControls',
          crossRunTrackCount: 0,
          controlMisclosure: { east: 0.0123, north: 0.0234, height: 0.0345, count: 1 },
        },
      ],
      mergeProfile: {
        id: 'site-quality',
        name: 'Site quality',
        profile: 'qualityHybrid',
        overrides: { maxImageEdge: 9000 },
      },
      cameraEntityIds: ['camera-1', 'camera-2'],
      lineageSha256: '1'.repeat(64),
    },
  ],
  products: [
    {
      entityId: 'dense-1',
      kind: 'dense',
      format: 'potreeV2',
      relativePath: 'datasets/dense-1/metadata.json',
      pointCount: 1_234_567,
      versionHash: '5'.repeat(64),
      sourceAlignmentEntityId: 'merge-1',
      processingSetId: 'processing-set-1',
      gcpOptimizationEntityId: 'gcp-solution-1',
      gcpOptimizationSnapshotSha256: '2'.repeat(64),
      imageMaskScopeSha256: '6'.repeat(64),
      toolVersions: { mvs: '1.0.0', toolManifestSha256: '7'.repeat(64) },
    },
  ],
  accuracy: {
    label: 'Optimization converged',
    processingSetLabel: 'Mission West',
    alignmentRunLabel: 'alignment-1',
    optimizationSnapshotSha256: '2'.repeat(64),
    cameraCount: 2,
    control: {
      pointCount: 1,
      eastRmsMeters: 0.001,
      northRmsMeters: 0.002,
      horizontalRmsMeters: 0.0022,
      heightRmsMeters: 0.003,
      spatial3dRmsMeters: 0.0037,
      activeComponentRmsMeters: 0.0037,
      reprojectionRmsPixels: 0.25,
      maxActiveComponentMeters: 0.004,
      maxReprojectionPixels: 0.4,
    },
    checkpoint: {
      pointCount: 1,
      activeComponentRmsMeters: 0.006,
      reprojectionRmsPixels: 0.3,
      maxActiveComponentMeters: 0.007,
      maxReprojectionPixels: 0.5,
    },
    residuals: [
      {
        pointId: 'gcp-1',
        pointName: 'Control <1>',
        role: 'controlXyz',
        eastMeters: 0.001,
        northMeters: -0.002,
        heightMeters: 0.003,
        horizontalMeters: 0.0022,
        spatial3dMeters: 0.0037,
        activeComponentNormMeters: 0.0037,
        reprojectionRmsPixels: 0.25,
        reprojectionMaxPixels: 0.4,
        observationCount: 5,
      },
    ],
  },
};

const html = buildProcessingReportHtml(fixture);

const SECTION_HEADINGS = [
  'Survey overview',
  'Camera calibration per group',
  'Processing parameters',
  'GCP accuracy',
  'Merge evidence',
  'Audit annex',
  'Hardware',
  'Processing sets and scope',
  'Alignment lineage',
  'Processing runs',
  'Published products',
  'Ground control and checkpoints',
  'Per-point errors',
];

for (const heading of SECTION_HEADINGS) assert.match(html, new RegExp(heading));

assert.match(html, /Configuration SHA-256/);
assert.match(html, /project-sulzberg/);
assert.match(html, /Sulzberg &lt;Survey&gt;/);
assert.match(html, /Input SHA-256/);
assert.match(html, /Entity version SHA-256/);
assert.match(html, /Mask-scope SHA-256/);
assert.match(html, /Tool versions/);
assert.match(html, /fixtureFailure/);
assert.match(html, /interrupted · recoverable/);
assert.match(html, /resume available from checkpoint 7/);
assert.match(html, /Build tile pyramid/);
assert.match(html, /18 \/ 40/);
assert.match(html, /3\.500 s/);
assert.match(html, /1,234,567/);
assert.match(html, /Source alignment/);
assert.match(html, /GCP revision/);
assert.match(html, /merge-1/);
assert.match(html, /processing-set-1/);
assert.match(html, /alignment-1 ↔ alignment-2 · shared controls: gcp-1/);
assert.match(html, /Site quality/);
assert.match(html, /mean absolute misclosure E 0\.0123 m · N 0\.0234 m · H 0\.0345 m/);
assert.match(html, /camera-1/);
assert.match(html, /Independent alignment runs/);
assert.match(html, /Mission West alignment/);
assert.match(html, /GCP optimizations/);
assert.match(html, /gcp-solution-1/);
assert.match(html, /robust-bundle-adjustment/);
assert.match(html, new RegExp('3'.repeat(64)));
assert.match(html, new RegExp('4'.repeat(64)));
assert.match(html, new RegExp('5'.repeat(64)));
assert.match(html, /Mission &lt;West&gt;/);
assert.match(html, /Control &lt;1&gt;/);
assert.match(html, /0\.0187 m\/px/);
assert.match(html, /4,000 → 4,025/);
assert.match(html, /GSD method/);
assert.match(html, /residual vector map/);
assert.match(html, /Quality Hybrid/);
assert.match(html, /maximumImageDimension = 9000/);
assert.match(html, /&lt;grid&gt; unavailable &amp; invalid/);
assert.doesNotMatch(html, /<script/i);
assert.doesNotMatch(html, /Mission <West>/);

// Golden determinism (WP-F1). A pinned `generatedAt` must make the whole report
// byte-identical across invocations, so re-exporting an unchanged project state
// produces a diff-free artifact a client can re-verify.
const golden = buildProcessingReportHtml(fixture);
const goldenAgain = buildProcessingReportHtml(fixture);
assert.equal(
  goldenAgain,
  golden,
  'buildProcessingReportHtml must be byte-identical for an identical pinned fixture',
);
assert.equal(
  createHash('sha256').update(goldenAgain, 'utf8').digest('hex'),
  createHash('sha256').update(golden, 'utf8').digest('hex'),
);
for (const heading of SECTION_HEADINGS) assert.match(golden, new RegExp(heading));
assert.match(golden, /2026-07-13T08:30:00\.000Z/);
assert.match(golden, /Timestamp source: Project snapshot modifiedUnixMs/);
const unavailable = buildProcessingReportHtml({
  ...fixture,
  surveyData: null,
  surveyDataUnavailableReason: 'Survey data unavailable — query not allowlisted',
});
assert.match(unavailable, /Survey data unavailable — query not allowlisted/);

// `ProcessingReportInput.generatedAt` is required in TypeScript. The package
// typecheck compiles the production caller, so omission is rejected before this
// runtime golden test can execute.

stdout.write('PhotoLab processing report test passed.\n');
