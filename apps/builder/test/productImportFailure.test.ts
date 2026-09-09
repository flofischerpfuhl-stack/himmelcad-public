import assert from 'node:assert/strict';
import test from 'node:test';

import { productImportFailure } from '../renderer/src/productImportFailure.js';

void test('typed product refusal survives the Electron error wrapper', () => {
  const envelope = encodeURIComponent(
    JSON.stringify({
      reasonCode: 'invalid_package',
      message: 'The import package is invalid. Republish or recompute this product in PhotoLab.',
    }),
  );
  const failure = productImportFailure(
    new Error(
      `Error invoking remote method 'sidecar:call': Error: HCAD_PRODUCT_IMPORT_ERROR:${envelope}`,
    ),
  );
  assert.deepEqual(failure, {
    reasonCode: 'invalid_package',
    message: 'The import package is invalid. Republish or recompute this product in PhotoLab.',
  });
});

void test('raw RPC and internal diagnostics are never surfaced by the product island', () => {
  const failure = productImportFailure(
    new Error(
      "Error invoking remote method 'sidecar:call': SidecarRpcError: prepared dataset binding differs from canonical geometry",
    ),
  );
  assert.equal(failure.reasonCode, 'failed_no_commit');
  assert.doesNotMatch(failure.message, /remote method|SidecarRpcError|dataset binding/i);
  assert.match(failure.message, /without changing the project/i);
});
