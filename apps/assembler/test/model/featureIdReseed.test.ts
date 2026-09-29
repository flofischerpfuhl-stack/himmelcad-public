import assert from 'node:assert/strict';
import test from 'node:test';

import type { ImportStepFeature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';

// Regression coverage for the module-level `featureIdCounter`: it must be
// reseeded from the highest feature id in whatever document `loadDocument`
// loads, not left at wherever a previous document (e.g. the demo document,
// or a file opened earlier in the same session) left it — otherwise a newly
// allocated id can collide with one already present in a just-opened file.

function importFeature(id: string): ImportStepFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'importStep',
    data: 'AA==',
    fileName: 'x.step',
  };
}

void test('the feature id counter is reseeded from a newly loaded document, not accumulated across loads', () => {
  const store = useAssemblerStore;

  store.getState().loadDocument([importFeature('feature-import-5')]);
  const firstNewId = store.getState().allocateFeatureId('sketch');
  // Seeded from 5 (the loaded document's highest suffix), so the next id is 6.
  assert.equal(firstNewId, 'feature-sketch-6');

  // Load a *different* document whose highest id is much higher than
  // anything minted in this process so far: the counter must jump to match
  // it, not continue from 6/7/8... (which would collide with real ids in
  // the file just opened).
  store.getState().loadDocument([importFeature('feature-import-500')]);
  const secondNewId = store.getState().allocateFeatureId('sketch');
  assert.equal(secondNewId, 'feature-sketch-501');

  // And loading a document with no features at all resets it back down —
  // it is re-derived from the loaded document each time, not monotonic.
  store.getState().loadDocument([]);
  const thirdNewId = store.getState().allocateFeatureId('sketch');
  assert.equal(thirdNewId, 'feature-sketch-1');
});

void test('a newly allocated id never collides with an id already present in the just-loaded document', () => {
  const store = useAssemblerStore;
  store.getState().loadDocument([importFeature('feature-sketch-3')]);
  const id = store.getState().allocateFeatureId('sketch');
  assert.notEqual(id, 'feature-sketch-3');
  assert.equal(id, 'feature-sketch-4');
});
