import assert from 'node:assert/strict';
import test from 'node:test';

import { selectKeyStep } from '../src/Select.js';

const options = [{}, { disabled: true }, {}, {}];

void test('select keyboard steps skip disabled options and stop at the ends', () => {
  assert.equal(selectKeyStep('ArrowDown', 0, options), 2);
  assert.equal(selectKeyStep('ArrowDown', 3, options), 3);
  assert.equal(selectKeyStep('ArrowUp', 2, options), 0);
  assert.equal(selectKeyStep('ArrowUp', 0, options), 0);
  assert.equal(selectKeyStep('Home', 3, options), 0);
  assert.equal(selectKeyStep('End', 0, options), 3);
  assert.equal(selectKeyStep('Enter', 2, options), 'pick');
  assert.equal(selectKeyStep(' ', 2, options), 'pick');
  assert.equal(selectKeyStep('a', 2, options), null);
  assert.equal(selectKeyStep('ArrowDown', 0, [{ disabled: true }]), null);
});
