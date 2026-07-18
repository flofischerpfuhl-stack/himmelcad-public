import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  assertCancellationLatencies,
  assertCompatibleResume,
  assertIncompatibleCheckpointRejected,
  assertNoPartialPublication,
  CancellationTracker,
  canonicalCancellationStage,
  capturePublicationState,
  immutableResumeIdentity,
  REQUIRED_CANCELLATION_STAGES,
  resumeCompatibility,
  stageMatchesCancellationTarget,
} from './lib/photolab-e2e-contracts.mjs';

const representativeStages = {
  aliked: 'Extract ALIKED',
  sift: 'Extract SIFT',
  dedode: 'Extract DeDoDe',
  mapper: 'Build hybrid reconstructions · GLOMAP global mapper',
  mvs: 'Build depth maps · portable MVS',
  raster: 'Build orthomosaic raster pyramid',
  mesh: 'Build mesh',
  splat: 'Train Gaussian Splat · Brush',
};
assert.deepEqual(Object.keys(representativeStages), [...REQUIRED_CANCELLATION_STAGES]);

for (const [target, label] of Object.entries(representativeStages)) {
  assert.equal(canonicalCancellationStage(target), target);
  assert.equal(
    stageMatchesCancellationTarget(target, label),
    true,
    `${target} must match ${label}`,
  );
}
assert.equal(stageMatchesCancellationTarget('aliked', representativeStages.sift), false);
assert.throws(() => canonicalCancellationStage('unknown-stage'), /Unknown cancellation stage/);

const clock = [1_000, 1_012, 1_150];
const tracker = new CancellationTracker({
  target: 'mvs',
  afterUnits: 3,
  now: () => clock.shift(),
});
const runningMvs = {
  id: 'job-depth',
  state: { kind: 'running' },
  progress: {
    stage: { label: 'Build depth maps · portable MVS' },
    metrics: { completedUnits: 3 },
  },
};
assert.equal(tracker.shouldRequest(runningMvs), true);
await tracker.request(runningMvs, async (jobId) => ({
  job: { id: jobId, state: { kind: 'cancelRequested' } },
}));
assert.equal(tracker.result.acknowledgementLatencyMs, 12);
assert.equal(tracker.result.acknowledgedState, 'cancelRequested');
assert.doesNotThrow(() =>
  assertCancellationLatencies(tracker.result, {
    maximumAcknowledgementMs: 20,
    maximumTerminalMs: 200,
  }),
);
assert.equal(tracker.shouldRequest(runningMvs), false);
tracker.recordTerminal({ state: { kind: 'cancelled' } });
assert.equal(tracker.result.latencyMs, 150);
assert.equal(tracker.result.terminalLatencyMs, 150);
assert.equal(tracker.result.terminalState, 'cancelled');
assert.doesNotThrow(() =>
  assertCancellationLatencies(tracker.result, {
    maximumAcknowledgementMs: 20,
    maximumTerminalMs: 200,
    requireTerminal: true,
  }),
);
assert.throws(
  () =>
    assertCancellationLatencies(tracker.result, {
      maximumAcknowledgementMs: 10,
      maximumTerminalMs: 200,
    }),
  /acknowledgement took/,
);
assert.throws(
  () =>
    assertCancellationLatencies(tracker.result, {
      maximumAcknowledgementMs: 20,
      maximumTerminalMs: 100,
      requireTerminal: true,
    }),
  /to terminate/,
);

const invalidAckTracker = new CancellationTracker({ target: 'sift', now: () => 1_000 });
await assert.rejects(
  invalidAckTracker.request(
    {
      id: 'job-sift',
      state: { kind: 'running' },
      progress: { stage: { label: 'Extract SIFT' }, metrics: { completedUnits: 1 } },
    },
    async () => ({ job: { id: 'another-job', state: { kind: 'cancelRequested' } } }),
  ),
  /belongs to/,
);

const snapshot = {
  manifest: {
    autosaveGeneration: 7,
    activeRuns: [],
    entities: {
      image: { id: 'image', kind: 'CameraImage', versionHash: 'source' },
      sparse: {
        id: 'sparse',
        kind: 'PointCloud',
        versionHash: 'sparse-hash',
        parent: 'products',
      },
    },
  },
};
const products = [
  { entityId: 'sparse', kind: 'sparse', sha256: 'sparse-hash', relativePath: 'sparse' },
];
const before = capturePublicationState(snapshot, products);
const journalOnlyChange = capturePublicationState(
  { manifest: { ...snapshot.manifest, autosaveGeneration: 8 } },
  products,
);
assert.doesNotThrow(() => assertNoPartialPublication(before, journalOnlyChange));
const partialProduct = capturePublicationState(
  {
    manifest: {
      ...snapshot.manifest,
      entities: {
        ...snapshot.manifest.entities,
        depth: { id: 'depth', kind: 'DepthMap', versionHash: 'partial-depth' },
      },
    },
  },
  [...products, { entityId: 'depth', kind: 'depth', sha256: 'partial-depth' }],
);
assert.throws(
  () => assertNoPartialPublication(before, partialProduct),
  /changed published products/,
);
const manifestOnlyProduct = capturePublicationState(
  {
    manifest: {
      ...snapshot.manifest,
      entities: {
        ...snapshot.manifest.entities,
        depth: { id: 'depth', kind: 'DepthMap', versionHash: 'partial-depth' },
      },
    },
  },
  products,
);
assert.throws(
  () => assertNoPartialPublication(before, manifestOnlyProduct),
  /changed published products/,
);
const catalogOnlyProduct = capturePublicationState(snapshot, [
  ...products,
  { entityId: 'depth', kind: 'depth', sha256: 'partial-depth' },
]);
assert.throws(
  () => assertNoPartialPublication(before, catalogOnlyProduct),
  /changed published products/,
);
const leakedActiveRun = capturePublicationState(
  { manifest: { ...snapshot.manifest, activeRuns: ['cancelled-job'] } },
  products,
);
assert.throws(
  () => assertNoPartialPublication(before, leakedActiveRun),
  /changed published products/,
);

const cancelledJob = {
  kind: 'buildDepthMaps',
  configHash: 'a'.repeat(64),
  inputHash: 'b'.repeat(64),
};
const resumeIdentity = immutableResumeIdentity(cancelledJob);
assert.doesNotThrow(() => assertCompatibleResume(resumeIdentity, { ...resumeIdentity }));
assert.deepEqual(resumeCompatibility(resumeIdentity, { ...resumeIdentity }), {
  compatible: true,
  mismatches: [],
});
for (const key of ['kind', 'configHash', 'inputHash']) {
  const incompatible = { ...resumeIdentity, [key]: `changed-${key}` };
  assert.deepEqual(assertIncompatibleCheckpointRejected(resumeIdentity, incompatible), [key]);
  assert.throws(() => assertCompatibleResume(resumeIdentity, incompatible), new RegExp(key));
}
assert.throws(() => immutableResumeIdentity({ kind: 'buildDepthMaps' }), /does not expose/);

const e2eCli = resolve(import.meta.dirname, 'photolab-e2e.mjs');
assertCliFailure(['--verify-resume'], /requires --reuse/);
assertCliFailure(
  ['--reuse', '--verify-resume', '--expect-incompatible-checkpoint', 'config'],
  /mutually exclusive/,
);
assertCliFailure(
  ['--max-cancel-ack-ms', '2000', '--max-cancel-terminal-ms', '1000'],
  /must be at least/,
);
assertCliFailure(['--cancel-stage', 'unknown'], /Unknown cancellation stage/);

process.stdout.write('PhotoLab E2E cancellation/recovery contract tests passed.\n');

function assertCliFailure(arguments_, pattern) {
  const result = spawnSync(process.execPath, [e2eCli, ...arguments_], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0, `CLI unexpectedly accepted ${arguments_.join(' ')}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}
