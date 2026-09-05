import assert from 'node:assert/strict';
import test from 'node:test';

import type { PhotolabJob, PhotolabJobState } from '@himmelcad/data';
import type { JobSurfaceItem } from '@himmelcad/ui';

import { jobSurfaceItems } from './jobSurfaceItems.js';

function job(
  state: PhotolabJobState,
  options: {
    kind?: PhotolabJob['kind'];
    origin?: PhotolabJob['origin'];
    completedUnits?: number;
    totalUnits?: number;
  } = {},
): PhotolabJob {
  return {
    schemaVersion: 1,
    id: `${options.kind ?? 'alignPhotos'}-${state.kind}`,
    kind: options.kind ?? 'alignPhotos',
    origin: options.origin ?? 'job',
    configHash: '0'.repeat(64) as PhotolabJob['configHash'],
    inputHash: '1'.repeat(64) as PhotolabJob['inputHash'],
    state,
    progress: {
      stage: { kind: 'featureExtraction', index: 1, stageCount: 4, label: 'Extract features' },
      metrics: {
        completedUnits: options.completedUnits ?? 0,
        ...(options.totalUnits == null ? {} : { totalUnits: options.totalUnits }),
        completedBytes: 0,
      },
    },
    createdAtUnixMs: 1_000,
    startedAtUnixMs: 2_000,
    ...(state.kind === 'completed' || state.kind === 'failed' || state.kind === 'cancelled'
      ? { finishedAtUnixMs: 3_000 }
      : {}),
  };
}

test('maps every PhotoLab job state to the shared surface state and phase', () => {
  const cases: ReadonlyArray<
    readonly [
      PhotolabJobState,
      JobSurfaceItem['state'],
      expectedPhase: string,
      expectedCancellable: boolean,
    ]
  > = [
    [{ kind: 'queued' }, 'pending-registration', 'Extract features', true],
    [{ kind: 'running' }, 'running', 'Extract features', true],
    [{ kind: 'pauseRequested' }, 'running', 'Pausing…', false],
    [{ kind: 'paused' }, 'running', 'Paused', true],
    [{ kind: 'cancelRequested' }, 'cancelling', 'Extract features', false],
    [{ kind: 'completed' }, 'completed', 'Extract features', false],
    [
      { kind: 'failed', code: 'test', message: 'Test failure' },
      'failed',
      'Extract features',
      false,
    ],
    [{ kind: 'cancelled' }, 'cancelled', 'Extract features', false],
  ];

  for (const [state, expectedState, expectedPhase, expectedCancellable] of cases) {
    const [item] = jobSurfaceItems([job(state)]);
    assert.equal(item?.state, expectedState, state.kind);
    assert.equal(item?.phase, expectedPhase, state.kind);
    assert.equal(item?.cancellation.cancellable, expectedCancellable, state.kind);
  }
});

test('maps overall progress and reports unknown units as indeterminate', () => {
  const [known, unknown] = jobSurfaceItems([
    job({ kind: 'running' }, { completedUnits: 50, totalUnits: 100 }),
    job({ kind: 'running' }),
  ]);

  assert.equal(known?.fraction, 0.375);
  assert.equal(unknown?.fraction, null);
});

test('marks side-operation cancellation at the next safe boundary', () => {
  const [item] = jobSurfaceItems([job({ kind: 'running' }, { origin: 'sideOperation' })]);

  assert.deepEqual(item?.cancellation, {
    cancellable: true,
    atNextSafeBoundary: true,
  });
});

test('keeps sentence-case labels for all five side-operation kinds', () => {
  const kinds: readonly PhotolabJob['kind'][] = [
    'archiveSave',
    'imageInspection',
    'imageCommit',
    'imageMask',
    'gcpOperation',
  ];

  assert.deepEqual(
    jobSurfaceItems(
      kinds.map((kind) => job({ kind: 'running' }, { kind, origin: 'sideOperation' })),
    ).map((item) => item.label),
    ['Save archive', 'Inspect images', 'Commit images', 'Apply image masks', 'GCP operation'],
  );
});
