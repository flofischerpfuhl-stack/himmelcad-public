import assert from 'node:assert/strict';
import test from 'node:test';

import type { PhotolabJob, PhotolabJobState } from '@himmelcad/data';

import { JOBS_CHIP_LINGER_MS, jobsChipState } from './jobsChip.js';

const NOW = 10_000;

function job(
  id: string,
  state: PhotolabJobState,
  options: { completed?: number; total?: number; finishedAt?: number } = {},
): PhotolabJob {
  return {
    schemaVersion: 1,
    id,
    kind: 'alignPhotos',
    origin: 'job',
    configHash: '0'.repeat(64) as PhotolabJob['configHash'],
    inputHash: '1'.repeat(64) as PhotolabJob['inputHash'],
    state,
    progress: {
      stage: { kind: 'featureExtraction', index: 0, stageCount: 1, label: 'Extract features' },
      metrics: {
        completedUnits: options.completed ?? 0,
        ...(options.total == null ? {} : { totalUnits: options.total }),
        completedBytes: 0,
      },
    },
    createdAtUnixMs: 1_000,
    startedAtUnixMs: 2_000,
    ...(options.finishedAt == null ? {} : { finishedAtUnixMs: options.finishedAt }),
  };
}

test('hides when no job is active or lingering', () => {
  assert.equal(jobsChipState([], NOW).tone, 'hidden');
  assert.equal(
    jobsChipState([job('old', { kind: 'completed' }, { finishedAt: 1_000 })], NOW).tone,
    'hidden',
  );
});

test('describes one running job with honest progress', () => {
  assert.deepEqual(
    jobsChipState([job('one', { kind: 'running' }, { completed: 42, total: 100 })], NOW),
    { label: '1 job running · Align photos 42%', tone: 'progress', count: 1 },
  );
});

test('counts several running jobs', () => {
  assert.deepEqual(
    jobsChipState(
      [
        job('one', { kind: 'running' }),
        job('two', { kind: 'queued' }),
        job('three', { kind: 'paused' }),
      ],
      NOW,
    ),
    { label: '3 jobs running', tone: 'progress', count: 3 },
  );
});

test('prioritizes a pending cancellation', () => {
  assert.deepEqual(jobsChipState([job('one', { kind: 'cancelRequested' })], NOW), {
    label: 'Cancelling…',
    tone: 'warning',
    count: 1,
  });
});

test('shows the most recent failure until the caller acknowledges it', () => {
  const state = jobsChipState(
    [
      job('older', { kind: 'failed', code: 'old', message: 'Old failure' }, { finishedAt: 8_000 }),
      job('newer', { kind: 'failed', code: 'new', message: 'New failure' }, { finishedAt: 9_000 }),
    ],
    NOW,
  );
  assert.equal(state.label, 'Job failed — Align photos');
  assert.equal(state.tone, 'danger');
});

test('lingers through the threshold and expires afterwards', () => {
  const completed = job('done', { kind: 'completed' }, { finishedAt: NOW - JOBS_CHIP_LINGER_MS });
  assert.equal(jobsChipState([completed], NOW).label, 'Job completed — Align photos');
  assert.equal(jobsChipState([completed], NOW + 1).tone, 'hidden');
});
