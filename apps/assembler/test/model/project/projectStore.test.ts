import assert from 'node:assert/strict';
import test from 'node:test';

import { useProjectStore } from '../../../renderer/src/model/project/projectStore.js';
import { useAssemblerStore } from '../../../renderer/src/foundation/commands/store.js';
import { sketchFromLegacyProfiles } from '../../../renderer/src/foundation/sketch-solver/builders.js';

// These tests exercise the dirty-flag state machine only (New/confirm/cancel
// transitions and the features-change subscription); Open/Save/Export go
// through `persistence.ts`'s browser file-input/download/Electron IPC paths,
// which need a DOM or `window.assembler` and are exercised by hand
// (`apps/assembler/README.md` verification) and by the Electron production
// smoke test, not here.

void test('the project starts clean', () => {
  useProjectStore.getState().newProject(); // establish a clean baseline for this test file's run
  assert.equal(useProjectStore.getState().dirty, false);
  assert.equal(useProjectStore.getState().pendingAction, null);
});

void test('a feature-history change marks the project dirty', () => {
  useProjectStore.getState().newProject();
  assert.equal(useProjectStore.getState().dirty, false);

  useAssemblerStore.getState().loadDocument(
    [
      {
        id: 'f1',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        ...sketchFromLegacyProfiles([{ kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }])
          .sketch,
      },
    ],
    { projectName: 'Edited' },
  );

  assert.equal(useProjectStore.getState().dirty, true);
});

void test('requestNew proceeds immediately when clean, but asks for confirmation when dirty', () => {
  useProjectStore.getState().newProject();
  assert.equal(useProjectStore.getState().dirty, false);
  useProjectStore.getState().requestNew();
  // Clean -> New proceeds without asking.
  assert.equal(useProjectStore.getState().pendingAction, null);

  useAssemblerStore.getState().loadDocument(
    [
      {
        id: 'f2',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        ...sketchFromLegacyProfiles([{ kind: 'circle', cx: 0, cy: 0, radius: 5 }]).sketch,
      },
    ],
    { projectName: 'Edited again' },
  );
  assert.equal(useProjectStore.getState().dirty, true);

  useProjectStore.getState().requestNew();
  assert.equal(useProjectStore.getState().pendingAction, 'new');
  // The document is untouched while the confirmation is pending.
  assert.equal(useAssemblerStore.getState().features.length, 1);
});

void test('cancelPending leaves the document and dirty flag untouched', () => {
  useProjectStore.getState().newProject();
  useAssemblerStore.getState().loadDocument(
    [
      {
        id: 'f3',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        ...sketchFromLegacyProfiles([{ kind: 'rectangle', x: 0, y: 0, width: 5, height: 5 }])
          .sketch,
      },
    ],
    { projectName: 'Kept' },
  );
  useProjectStore.getState().requestOpen();
  assert.equal(useProjectStore.getState().pendingAction, 'open');

  useProjectStore.getState().cancelPending();
  assert.equal(useProjectStore.getState().pendingAction, null);
  assert.equal(useProjectStore.getState().dirty, true);
  assert.equal(useAssemblerStore.getState().projectName, 'Kept');
});

void test('confirmDiscard proceeds with the pending action and clears dirty', () => {
  useProjectStore.getState().newProject();
  useAssemblerStore.getState().loadDocument(
    [
      {
        id: 'f4',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        ...sketchFromLegacyProfiles([{ kind: 'rectangle', x: 0, y: 0, width: 5, height: 5 }])
          .sketch,
      },
    ],
    { projectName: 'ToDiscard' },
  );
  assert.equal(useProjectStore.getState().dirty, true);

  useProjectStore.getState().requestNew();
  assert.equal(useProjectStore.getState().pendingAction, 'new');

  useProjectStore.getState().confirmDiscard();
  assert.equal(useProjectStore.getState().pendingAction, null);
  assert.equal(useProjectStore.getState().dirty, false);
  assert.equal(useAssemblerStore.getState().features.length, 0);
  assert.equal(useAssemblerStore.getState().projectName, 'Untitled');
});
