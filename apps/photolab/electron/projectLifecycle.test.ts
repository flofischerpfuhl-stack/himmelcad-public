import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeDecisionFor,
  removeRecentProject,
  saveRouteFor,
  selectUntitledLitterCandidates,
  storedIndicatorState,
  UNTITLED_PROJECT_MAX_AGE_MS,
  updateRecentProjects,
  type RecentProject,
} from './projectLifecycle';

test('Save routes archive, untitled, and established folder sessions honestly', () => {
  assert.equal(saveRouteFor({ sourcePath: '/projects/site.hcadx' }), 'archiveSave');
  assert.equal(saveRouteFor({ sourcePath: 'C:\\Projects\\SITE.HCADX' }), 'archiveSave');
  assert.equal(
    saveRouteFor({ sourcePath: '/projects/Untitled-2026-09-02T12-00-00.hcad' }),
    'saveAs',
  );
  assert.equal(saveRouteFor({ sourcePath: '/projects/established.hcad' }), 'workingCopyOnly');
});

test('close proceeds only when every drain owner acknowledged completion', () => {
  assert.equal(closeDecisionFor({ timedOut: [] }), 'close');
  assert.equal(closeDecisionFor({ timedOut: ['job-1'] }), 'blocked');
  assert.equal(
    closeDecisionFor({ timedOutJobs: [], timedOutSideOperations: ['archive:save-1'] }),
    'blocked',
  );
});

test('MRU updates, deduplicates and retains the ten most recent projects', () => {
  const existing: RecentProject[] = Array.from({ length: 10 }, (_, index) => ({
    name: `Project ${String(index)}`,
    path: `/projects/${String(index)}.hcadx`,
    lastOpenedUnixMs: 100 - index,
  }));
  const reopened = updateRecentProjects(existing, {
    name: 'Renamed project',
    path: '/projects/4.hcadx',
    lastOpenedUnixMs: 200,
  });
  assert.equal(reopened.length, 10);
  assert.deepEqual(reopened[0], {
    name: 'Renamed project',
    path: '/projects/4.hcadx',
    lastOpenedUnixMs: 200,
  });
  assert.equal(reopened.filter(({ path }) => path === '/projects/4.hcadx').length, 1);
  assert.equal(removeRecentProject(reopened, '/projects/4.hcadx').length, 9);
});

test('litter selection requires an old Untitled project with zero images', () => {
  const now = 2_000_000_000;
  const old = now - UNTITLED_PROJECT_MAX_AGE_MS - 1;
  const candidates = selectUntitledLitterCandidates(
    [
      {
        path: '/projects/Untitled-old-empty.hcad',
        directoryName: 'Untitled-old-empty.hcad',
        modifiedUnixMs: old,
        imageCount: 0,
      },
      {
        path: '/projects/Untitled-old-used.hcad',
        directoryName: 'Untitled-old-used.hcad',
        modifiedUnixMs: old,
        imageCount: 2,
      },
      {
        path: '/projects/Untitled-new-empty.hcad',
        directoryName: 'Untitled-new-empty.hcad',
        modifiedUnixMs: now,
        imageCount: 0,
      },
      {
        path: '/projects/Named-old-empty.hcad',
        directoryName: 'Named-old-empty.hcad',
        modifiedUnixMs: old,
        imageCount: 0,
      },
    ],
    now,
  );
  assert.deepEqual(
    candidates.map(({ path }) => path),
    ['/projects/Untitled-old-empty.hcad'],
  );
});

test('stored indicator distinguishes durable, pending and failed working-copy flushes', () => {
  assert.deepEqual(
    storedIndicatorState({
      projectReady: true,
      durability: { kind: 'durable', storedAtUnixMs: 1_234 },
      autosaveGeneration: 7,
      lastSavedGeneration: 5,
      hasArchiveCopy: true,
    }),
    {
      kind: 'durable',
      storedAtUnixMs: 1_234,
      archiveChanges: 2,
      hasArchiveCopy: true,
    },
  );
  assert.deepEqual(
    storedIndicatorState({
      projectReady: true,
      durability: { kind: 'pending' },
      autosaveGeneration: 7,
      lastSavedGeneration: 5,
      hasArchiveCopy: true,
    }),
    { kind: 'pending', archiveChanges: 2, hasArchiveCopy: true },
  );
  assert.deepEqual(
    storedIndicatorState({
      projectReady: true,
      durability: { kind: 'failed', reason: 'disk full' },
      autosaveGeneration: 7,
      lastSavedGeneration: 5,
      hasArchiveCopy: false,
    }),
    {
      kind: 'failed',
      reason: 'disk full',
      archiveChanges: 2,
      hasArchiveCopy: false,
    },
  );
  assert.deepEqual(
    storedIndicatorState({
      projectReady: false,
      durability: { kind: 'pending' },
      autosaveGeneration: 0,
      lastSavedGeneration: 0,
      hasArchiveCopy: false,
    }),
    { kind: 'noProject' },
  );
});
