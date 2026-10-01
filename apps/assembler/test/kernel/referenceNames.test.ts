/**
 * Readable "Missing reference" messages (`kernel/referenceNames.ts`): ids of
 * steps and bodies become the History names.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nameMissingReference,
  nameMissingReferences,
} from '../../renderer/src/foundation/geometry-kernel/referenceNames.js';

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
    // Naming keys become the step that made the geometry and its role (block 8).
    ['Missing reference: face "gone:face" on "Body 1"', 'Missing reference: a face of "Body 1"'],
    [
      'Missing reference: face "feature-extrude-2:end:0" on "Body 1"',
      'Missing reference: the end face of "Body 1" created by "Extrude 2"',
    ],
    [
      'Missing reference: face "feature-extrude-2:side:0:l3#2" on "Body 1"',
      'Missing reference: a side face of "Body 1" created by "Extrude 2"',
    ],
    [
      'Missing reference: face "feature-extrude-9:start:0" on "Body 1"',
      'Missing reference: the start face of "Body 1" created by a deleted step',
    ],
    ['Missing reference: face "r:start:0"', 'Missing reference: a face'],
    [
      'Missing reference: edge "feature-extrude-2:end:0|feature-extrude-2:side:0:l2" on "Body 1"',
      'Missing reference: an edge of "Body 1" created by "Extrude 2"',
    ],
    [
      'Missing reference: edge "feature-extrude-2:end:0|feature-pattern-5:new~1" on "Body 1"',
      'Missing reference: an edge of "Body 1" between faces created by "Extrude 2" and "Pattern 1"',
    ],
    [
      'Missing reference: profile "c1+l2@L" of "Sketch 1"',
      'Missing reference: a profile of "Sketch 1"',
    ],
    ['Missing reference: line "l99" of "Sketch 1"', 'Missing reference: a line of "Sketch 1"'],
    ['Missing reference: point "p7" of "Sketch 1"', 'Missing reference: a point of "Sketch 1"'],
    // Other messages pass through.
    ['Radius too large', 'Radius too large'],
  ];
  for (const [message, expected] of cases)
    assert.equal(nameMissingReference(message, names), expected);
  const errors = { a: 'Missing reference: sketch "feature-sketch-1"', b: 'Radius too large' };
  const out = nameMissingReferences(errors, [{ id: 'feature-sketch-1', name: 'Base' }]);
  assert.deepEqual(out, { a: 'Missing reference: sketch "Base"', b: 'Radius too large' });
  assert.equal(errors.a, 'Missing reference: sketch "feature-sketch-1"', 'input unchanged');
});
