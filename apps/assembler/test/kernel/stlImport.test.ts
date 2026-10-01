import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStl, suggestStlUnitHint } from '../../renderer/src/modules/interop/stlImport.js';

/** Writes one binary STL with `triangles` (each `[ax,ay,az,bx,by,bz,cx,cy,cz]`), little-endian, no stored normals (all zero) so a parser reading the stored normal instead of recomputing it would fail these tests. */
function buildBinaryStl(triangles: readonly (readonly number[])[]): ArrayBuffer {
  const byteLength = 80 + 4 + triangles.length * 50;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  let offset = 84;
  for (const t of triangles) {
    // normal (zeros — deliberately garbage/absent)
    view.setFloat32(offset, 0, true);
    view.setFloat32(offset + 4, 0, true);
    view.setFloat32(offset + 8, 0, true);
    for (let v = 0; v < 3; v += 1) {
      view.setFloat32(offset + 12 + v * 12, t[v * 3]!, true);
      view.setFloat32(offset + 12 + v * 12 + 4, t[v * 3 + 1]!, true);
      view.setFloat32(offset + 12 + v * 12 + 8, t[v * 3 + 2]!, true);
    }
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return buffer;
}

const UNIT_TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

void test('parses a binary STL and recomputes the facet normal from the vertices', () => {
  const buffer = buildBinaryStl([UNIT_TRIANGLE]);
  const parsed = parseStl(buffer);
  assert.equal(parsed.triangleCount, 1);
  assert.equal(parsed.degenerateCount, 0);
  assert.equal(parsed.positions.length, 9);
  // +Z, since the stored (garbage) normal was zero and must not be trusted.
  assert.ok(Math.abs(parsed.normals[2]! - 1) < 1e-5);
  assert.deepEqual(parsed.min, [0, 0, 0]);
  assert.deepEqual(parsed.max, [1, 1, 0]);
});

void test('parses multiple binary triangles and computes a combined bounding box', () => {
  const buffer = buildBinaryStl([UNIT_TRIANGLE, [5, 5, 5, 6, 5, 5, 5, 6, 5]]);
  const parsed = parseStl(buffer);
  assert.equal(parsed.triangleCount, 2);
  assert.deepEqual(parsed.min, [0, 0, 0]);
  assert.deepEqual(parsed.max, [6, 6, 5]);
});

void test('drops a zero-area (degenerate) binary triangle instead of crashing', () => {
  const buffer = buildBinaryStl([
    UNIT_TRIANGLE,
    [0, 0, 0, 0, 0, 0, 0, 0, 0], // all three vertices coincide
    [1, 1, 1, 2, 2, 2, 3, 3, 3], // collinear: zero area
  ]);
  const parsed = parseStl(buffer);
  assert.equal(parsed.triangleCount, 1);
  assert.equal(parsed.degenerateCount, 2);
  // No NaN leaked into the surviving geometry.
  assert.ok(parsed.normals.every((n) => Number.isFinite(n)));
});

void test('parses an ASCII STL', () => {
  const text = [
    'solid cube',
    'facet normal 0 0 0',
    '  outer loop',
    '    vertex 0 0 0',
    '    vertex 1 0 0',
    '    vertex 0 1 0',
    '  endloop',
    'endfacet',
    'facet normal 0 0 0',
    '  outer loop',
    '    vertex 2 2 2',
    '    vertex 3 2 2',
    '    vertex 2 3 2',
    '  endloop',
    'endfacet',
    'endsolid cube',
  ].join('\n');
  const parsed = parseStl(new TextEncoder().encode(text));
  assert.equal(parsed.triangleCount, 2);
  assert.equal(parsed.degenerateCount, 0);
  assert.deepEqual(parsed.min, [0, 0, 0]);
  assert.deepEqual(parsed.max, [3, 3, 2]);
});

void test('drops a degenerate triangle in an ASCII STL', () => {
  const text = [
    'solid degenerate',
    'facet normal 0 0 0',
    '  outer loop',
    '    vertex 0 0 0',
    '    vertex 0 0 0',
    '    vertex 0 0 0',
    '  endloop',
    'endfacet',
    'endsolid degenerate',
  ].join('\n');
  const parsed = parseStl(new TextEncoder().encode(text));
  assert.equal(parsed.triangleCount, 0);
  assert.equal(parsed.degenerateCount, 1);
});

void test('an ASCII STL with scientific-notation coordinates parses correctly', () => {
  const text = [
    'solid s',
    'facet normal 0 0 0',
    '  outer loop',
    '    vertex 0e0 0e0 0e0',
    '    vertex 1.5e1 0e0 0e0',
    '    vertex 0e0 1.5e1 0e0',
    '  endloop',
    'endfacet',
    'endsolid s',
  ].join('\n');
  const parsed = parseStl(new TextEncoder().encode(text));
  assert.equal(parsed.triangleCount, 1);
  assert.deepEqual(parsed.max, [15, 15, 0]);
});

void test('rejects input too small to be any STL file', () => {
  assert.throws(() => parseStl(new Uint8Array([1, 2])));
});

void test('unit heuristic: a bounding box under 1 unit across suggests metres', () => {
  const hint = suggestStlUnitHint([0, 0, 0], [0.08, 0.05, 0.03]);
  assert.deepEqual(hint, { hint: 'm', scaleToMm: 1000 });
});

void test('unit heuristic: a bounding box of a few units across suggests inches', () => {
  const hint = suggestStlUnitHint([0, 0, 0], [4, 2, 1]);
  assert.deepEqual(hint, { hint: 'in', scaleToMm: 25.4 });
});

void test('unit heuristic: a normal millimetre-scale bounding box suggests nothing', () => {
  assert.equal(suggestStlUnitHint([0, 0, 0], [80, 50, 6]), null);
});
