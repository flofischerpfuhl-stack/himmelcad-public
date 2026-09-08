import assert from 'node:assert/strict';
import test from 'node:test';

import { ViewDisplayStore, type ViewHistoryPersistence } from '../src/index.js';

const persistence: ViewHistoryPersistence = {
  async load() {
    return null;
  },
  async store() {},
};

void test('view display snapshots stay referentially stable between notifications', async () => {
  const store = new ViewDisplayStore(persistence);
  const initial = store.getSnapshot();
  assert.strictEqual(store.getSnapshot(), initial);

  await store.openProject('project-a');
  const opened = store.getSnapshot();
  assert.notStrictEqual(opened, initial);
  assert.strictEqual(store.getSnapshot(), opened);

  assert.equal(store.setLabels(false), true);
  const changed = store.getSnapshot();
  assert.notStrictEqual(changed, opened);
  assert.strictEqual(store.getSnapshot(), changed);
  assert.equal(changed.state.labels, false);
});
