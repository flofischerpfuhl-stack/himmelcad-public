import assert from 'node:assert/strict';
import test from 'node:test';

import { useProjectStore } from '../../../renderer/src/interface/shell-ui/project/projectStore.js';
import { useAssemblerStore } from '../../../renderer/src/foundation/commands/store.js';
import { addRectangle } from '../../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../../renderer/src/foundation/sketch-solver/types.js';

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
        ...addRectangle(EMPTY_SKETCH, [0, 0], [10, 10], { position: true, size: true }).sketch,
      },
    ],
    { projectName: 'Edited before touching the File menu' },
  );
  assert.equal(useProjectStore.getState().dirty, true);
});

void test('importing, hiding or renaming a reference mesh marks the project dirty', () => {
  useProjectStore.setState({ dirty: false });
  useAssemblerStore.getState().importReferenceMesh({
    id: 'm1',
    name: 'Scan',
    fileName: 'scan.stl',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    min: [0, 0, 0],
    max: [1, 1, 0],
    transform: { dx: 0, dy: 0, dz: 0 },
    hidden: false,
  });
  assert.equal(useProjectStore.getState().dirty, true);
  useProjectStore.setState({ dirty: false });
  useAssemblerStore.getState().setReferenceMeshHidden('m1', true);
  assert.equal(useProjectStore.getState().dirty, true);
  useProjectStore.setState({ dirty: false });
  useAssemblerStore.getState().renameReferenceMesh('m1', 'Scan 2');
  assert.equal(useProjectStore.getState().dirty, true);
});
