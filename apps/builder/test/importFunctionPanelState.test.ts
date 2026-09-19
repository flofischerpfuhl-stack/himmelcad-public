import assert from 'node:assert/strict';
import test from 'node:test';

import { IMPORT_FUNCTION_PANEL } from '../renderer/src/importFunctionPanelState.js';

void test('shipped Import exposes its real picker state and shared 28 px secondary action', () => {
  assert.deepEqual(IMPORT_FUNCTION_PANEL, {
    title: 'Import',
    body: 'Choose files to import…',
    action: 'Choose files…',
    actionVariant: 'secondary',
    actionSize: 'medium',
  });
  assert.doesNotMatch(JSON.stringify(IMPORT_FUNCTION_PANEL), /once the function ships/u);
});
