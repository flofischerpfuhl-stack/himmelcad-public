import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  KernelRuntimeQualityAdjustment,
  KernelRuntimeQualityState,
} from '../src/kernel/KernelRuntimeQualityGovernor.js';

void test('runtime-quality compatibility exports remain data-only Rust boundary types', () => {
  const state: KernelRuntimeQualityState = { renderScale: 0.9, detailScale: 0.75 };
  const adjustment: KernelRuntimeQualityAdjustment = 'reduced';
  assert.deepEqual(state, { renderScale: 0.9, detailScale: 0.75 });
  assert.equal(adjustment, 'reduced');
});
