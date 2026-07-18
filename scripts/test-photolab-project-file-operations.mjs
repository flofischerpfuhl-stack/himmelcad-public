import assert from 'node:assert/strict';
import { stdout } from 'node:process';

import {
  applyProjectProgress,
  createProjectFileOperation,
  requestProjectCancellation,
} from '../apps/photolab/renderer/src/projectFileOperation.ts';

const initial = createProjectFileOperation('open', 'fixture');
assert.deepEqual(
  { archiveOperationId: initial.archiveOperationId, progressKey: initial.progressKey },
  {
    archiveOperationId: 'archive-open-fixture',
    progressKey: 'project-open:fixture',
  },
);

const validating = applyProjectProgress(initial, {
  progressKey: initial.progressKey,
  operationId: initial.archiveOperationId,
  fraction: 0.12,
  message: 'Validating project archive',
  archive: {
    phase: 'validating',
    filesCompleted: 4,
    filesTotal: 4,
    bytesCompleted: 2048,
    bytesTotal: 2048,
  },
});
const extracting = applyProjectProgress(validating, {
  progressKey: initial.progressKey,
  operationId: initial.archiveOperationId,
  fraction: 0.6,
  message: 'Extracting project archive',
  archive: {
    phase: 'extracting',
    filesCompleted: 2,
    filesTotal: 4,
    bytesCompleted: 1024,
    bytesTotal: 2048,
    currentPath: 'objects/example.bin',
  },
});
const stale = applyProjectProgress(extracting, {
  progressKey: initial.progressKey,
  operationId: initial.archiveOperationId,
  fraction: 0.4,
  message: 'Stale transport event',
});
assert.equal(stale.fraction, 0.6, 'out-of-order progress must never move backwards');
assert.equal(stale.archive.currentPath, 'objects/example.bin');

const unrelated = applyProjectProgress(stale, {
  progressKey: 'project-open:another',
  fraction: 1,
  message: 'Unrelated operation',
});
assert.equal(unrelated, stale, 'an unrelated project operation must not mutate the dialog');

const cancelling = requestProjectCancellation(stale);
assert.equal(cancelling.cancelRequested, true);
assert.equal(cancelling.message, 'Cancellation requested…');

stdout.write('PhotoLab project file operation contract tests passed.\n');
