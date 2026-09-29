import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePickId,
  encodePickId,
  NO_PICK_ID,
  PickTable,
} from '../../renderer/src/viewport/picking.js';

void test('encodePickId/decodePickId round-trip small and large ids', () => {
  for (const id of [1, 2, 255, 256, 65535, 1_000_000]) {
    const [r, g, b, a] = encodePickId(id);
    const bytes = [
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255),
      Math.round(a * 255),
    ];
    const decoded = decodePickId(
      bytes as unknown as { 0: number; 1: number; 2: number; 3: number },
    );
    assert.equal(decoded, id);
  }
});

void test('NO_PICK_ID decodes from all-zero bytes', () => {
  assert.equal(
    decodePickId([0, 0, 0, 0] as unknown as { 0: number; 1: number; 2: number; 3: number }),
    NO_PICK_ID,
  );
});

void test('PickTable assigns sequential 1-based ids and resolves them back', () => {
  const table = new PickTable();
  const idA = table.add({ kind: 'body', bodyId: 'body-1' });
  const idB = table.add({ kind: 'face', bodyId: 'body-1', side: '+X' });
  assert.equal(idA, 1);
  assert.equal(idB, 2);
  assert.deepEqual(table.resolve(idA), { kind: 'body', bodyId: 'body-1' });
  assert.deepEqual(table.resolve(idB), { kind: 'face', bodyId: 'body-1', side: '+X' });
});

void test('PickTable.resolve returns null for id 0 and out-of-range ids', () => {
  const table = new PickTable();
  table.add({ kind: 'body', bodyId: 'x' });
  assert.equal(table.resolve(0), null);
  assert.equal(table.resolve(99), null);
  assert.equal(table.resolve(-1), null);
});

void test('PickTable.clear empties the table', () => {
  const table = new PickTable();
  const id = table.add({ kind: 'body', bodyId: 'x' });
  table.clear();
  assert.equal(table.resolve(id), null);
});
