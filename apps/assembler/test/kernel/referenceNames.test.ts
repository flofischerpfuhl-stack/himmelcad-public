/**
 * Readable "Missing reference" messages (`kernel/referenceNames.ts`): ids of
 * steps and bodies become the History names.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nameMissingReference,
  nameMissingReferences,
} from '../../renderer/src/kernel/referenceNames.js';

const names = new Map([
  ['feature-constructionPlane-4', 'Plane 2'],
  ['feature-extrude-2', 'Extrude 2'],
  ['feature-sketch-1', 'Sketch 1'],
  ['feature-mirror-3', 'Mirror 1'],
  ['feature-pattern-5', 'Pattern 1'],
]);

void test('ids of steps and bodies become History names; deleted steps are said so', () => {
  const cases: [string, string][] = [
    [
      'Missing reference: construction plane "feature-constructionPlane-4"',
      'Missing reference: construction plane "Plane 2"',
    ],
    [
      'Missing reference: construction axis "feature-constructionAxis-9"',
      'Missing reference: construction axis of a deleted step',
    ],
    ['Missing reference: sketch "feature-sketch-1"', 'Missing reference: sketch "Sketch 1"'],
    [
      'Missing reference: sketch "feature-mirror-3:sketch:1"',
      'Missing reference: mirrored sketch 2 of "Mirror 1"',
    ],
    ['Missing reference: body "body:feature-extrude-2"', 'Missing reference: body of "Extrude 2"'],
    [
      'Missing reference: body "body:feature-pattern-5:2"',
      'Missing reference: body of "Pattern 1"',
    ],
    [
      'Missing reference: body "body:feature-extrude-7"',
      'Missing reference: body of a deleted step',
    ],
    // Messages that already name things, or keys without a better name, pass through.
    [
      'Missing reference: profile "c1" of "Sketch 1"',
      'Missing reference: profile "c1" of "Sketch 1"',
    ],
    ['Missing reference: face "r:start:0"', 'Missing reference: face "r:start:0"'],
  ];
  for (const [message, expected] of cases)
    assert.equal(nameMissingReference(message, names), expected);
  const errors = { a: 'Missing reference: sketch "feature-sketch-1"', b: 'Radius too large' };
  const out = nameMissingReferences(errors, [{ id: 'feature-sketch-1', name: 'Base' }]);
  assert.deepEqual(out, { a: 'Missing reference: sketch "Base"', b: 'Radius too large' });
  assert.equal(errors.a, 'Missing reference: sketch "feature-sketch-1"', 'input unchanged');
});
