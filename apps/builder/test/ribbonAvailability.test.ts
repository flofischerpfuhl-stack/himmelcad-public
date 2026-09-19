import assert from 'node:assert/strict';
import test from 'node:test';

import { createRibbonTabs, UNSHIPPED_RIBBON_ACTIONS } from '../renderer/src/ribbon.js';

void test('genuinely unshipped ribbon commands are disabled with a reason', () => {
  const noop = (): void => undefined;
  const tabs = createRibbonTabs({
    recent: [],
    snapshots: [],
    onNew: noop,
    onOpen: noop,
    onOpenArchive: noop,
    onOpenRecent: noop,
    onSave: noop,
    onSaveAs: noop,
    onUndo: noop,
    onRedo: noop,
    onRestoreSnapshot: noop,
    onClose: noop,
    onExport: noop,
    onImport: noop,
    onPhotoLabProductImport: noop,
    onTryHardwareRenderingAgain: noop,
  });
  const actions = tabs.flatMap((tab) => tab.groups.flatMap((group) => group.actions));

  assert.deepEqual(Object.keys(UNSHIPPED_RIBBON_ACTIONS).sort(), ['select.box', 'select.lasso']);
  for (const [id, reason] of Object.entries(UNSHIPPED_RIBBON_ACTIONS)) {
    const action = actions.find((candidate) => candidate.id === id);
    assert.equal(action?.disabled, true, id);
    assert.equal(action?.title, reason, id);
  }
  assert.equal(actions.find((action) => action.id === 'file.import')?.disabled, undefined);
});
