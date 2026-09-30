import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findParameterUsages,
  isValidParameterName,
  renameInExpression,
  resolveFeatureExpression,
  resolveParameterValues,
  type Parameter,
} from '../../renderer/src/foundation/document/parameters.js';

void test('isValidParameterName accepts identifiers, rejects the rest', () => {
  assert.ok(isValidParameterName('wall'));
  assert.ok(isValidParameterName('hole_d'));
  assert.ok(isValidParameterName('_x2'));
  assert.ok(!isValidParameterName('2bad'));
  assert.ok(!isValidParameterName('has space'));
  assert.ok(!isValidParameterName(''));
  assert.ok(!isValidParameterName('d-1'));
});

void test('resolveParameterValues: a plain parameter keeps its stored value', () => {
  const params: Parameter[] = [{ id: 'p1', name: 'wall', unit: 'mm', value: 2 }];
  const result = resolveParameterValues(params);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.values.get('wall'), 2);
});

void test('resolveParameterValues: an expression reads another parameter, in any declaration order', () => {
  const params: Parameter[] = [
    { id: 'p2', name: 'hole_d', unit: 'mm', value: 0, expression: 'wall * 2' },
    { id: 'p1', name: 'wall', unit: 'mm', value: 2 },
  ];
  const result = resolveParameterValues(params);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.values.get('wall'), 2);
  assert.equal(result.values.get('hole_d'), 4);
});

void test('resolveParameterValues: detects a direct cycle', () => {
  const params: Parameter[] = [
    { id: 'p1', name: 'a', unit: 'mm', value: 0, expression: 'b + 1' },
    { id: 'p2', name: 'b', unit: 'mm', value: 0, expression: 'a + 1' },
  ];
  const result = resolveParameterValues(params);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /Circular reference/);
});

void test('resolveParameterValues: an unknown name is rejected', () => {
  const params: Parameter[] = [
    { id: 'p1', name: 'a', unit: 'mm', value: 0, expression: 'nope * 2' },
  ];
  const result = resolveParameterValues(params);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /unknown name "nope"/);
});

void test('resolveParameterValues: an invalid expression syntax is rejected', () => {
  const params: Parameter[] = [{ id: 'p1', name: 'a', unit: 'mm', value: 0, expression: '2 +' }];
  const result = resolveParameterValues(params);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /invalid expression/);
});

void test('resolveFeatureExpression: resolves a plain number and a formula against parameter values', () => {
  const values = new Map([['wall', 2]]);
  assert.deepEqual(resolveFeatureExpression('4', values), { ok: true, value: 4 });
  assert.deepEqual(resolveFeatureExpression('wall * 2', values), { ok: true, value: 4 });
});

void test('resolveFeatureExpression: rejects an unknown name and a non-positive result', () => {
  const values = new Map([['wall', 2]]);
  const unknown = resolveFeatureExpression('missing', values);
  assert.equal(unknown.ok, false);
  const negative = resolveFeatureExpression('wall - 4', values);
  assert.equal(negative.ok, false);
});

void test('findParameterUsages finds a referencing sketch dimension and a referencing feature field', () => {
  const features = [
    {
      id: 'feature-sketch-1',
      name: 'Sketch 1',
      kind: 'sketch',
      dimensions: [
        { id: 'd1', name: 'd1', expression: 'wall + 1' },
        { id: 'd2', name: 'd2', value: 5 },
      ],
    },
    {
      id: 'feature-extrude-1',
      name: 'Extrude 1',
      kind: 'extrude',
      distanceExpression: 'wall * 3',
    },
    {
      id: 'feature-extrude-2',
      name: 'Extrude 2',
      kind: 'extrude',
      distance: 5,
    },
  ];
  const usages = findParameterUsages(features, 'wall');
  assert.equal(usages.length, 2);
  assert.deepEqual(usages.map((u) => u.featureId).sort(), [
    'feature-extrude-1',
    'feature-sketch-1',
  ]);
  assert.equal(findParameterUsages(features, 'unused').length, 0);
});

void test('renameInExpression replaces whole-word occurrences only', () => {
  assert.equal(renameInExpression('wall * 2', 'wall', 'thickness'), 'thickness * 2');
  assert.equal(renameInExpression('wall2 + wall', 'wall', 'w'), 'wall2 + w');
});
