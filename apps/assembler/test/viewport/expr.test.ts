import assert from 'node:assert/strict';
import test from 'node:test';

import { parseExpression } from '../../renderer/src/platform/viewport/expr.js';

void test('parseExpression evaluates plain numbers', () => {
  assert.equal(parseExpression('40'), 40);
  assert.equal(parseExpression('  12.5 '), 12.5);
});

void test('parseExpression evaluates +, -, *, / with standard precedence', () => {
  assert.equal(parseExpression('2 + 3 * 4'), 14);
  assert.equal(parseExpression('(2 + 3) * 4'), 20);
  assert.equal(parseExpression('40 / 2'), 20);
  assert.equal(parseExpression('10 - 2 - 3'), 5);
});

void test('parseExpression handles unary minus', () => {
  assert.equal(parseExpression('-5 + 2'), -3);
  assert.equal(parseExpression('3 * -2'), -6);
});

void test('parseExpression returns null for division by zero', () => {
  assert.equal(parseExpression('1 / 0'), null);
});

void test('parseExpression returns null for unparsable or trailing-garbage input', () => {
  assert.equal(parseExpression(''), null);
  assert.equal(parseExpression('abc'), null);
  assert.equal(parseExpression('12 + '), null);
  assert.equal(parseExpression('12 34'), null);
  assert.equal(parseExpression('(12'), null);
});
