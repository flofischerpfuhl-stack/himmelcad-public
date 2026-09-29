import assert from 'node:assert/strict';
import test from 'node:test';

import { useProjectStore } from '../../../renderer/src/model/project/projectStore.js';
import { useAssemblerStore } from '../../../renderer/src/model/store.js';

// Regression coverage: the dirty-flag subscription used to be established
// lazily, only inside `newProject`/`openProject`/`save`/`saveAs` — so a
// freshly started app whose *first* user action was editing the document
// directly (not File > New/Open/Save first) never had `dirty` set to
// `true`. `projectStore.ts` now subscribes at module load instead. This
// file imports `projectStore.ts` for the first time in its own process (the
// test runner isolates test files into separate processes), so it observes
// exactly the state a freshly started app would be in — no `newProject()`/
// `openProject()`/`save()` call precedes the assertions below.

void test('a freshly loaded document is not dirty', () => {
  assert.equal(useProjectStore.getState().dirty, false);
});

void test('the very first document edit after startup — before any File action — marks the project dirty', () => {
  assert.equal(useProjectStore.getState().dirty, false);
  useAssemblerStore.getState().loadDocument(
    [
      {
        id: 'f1',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
      },
    ],
    { projectName: 'Edited before touching the File menu' },
  );
  assert.equal(useProjectStore.getState().dirty, true);
});
