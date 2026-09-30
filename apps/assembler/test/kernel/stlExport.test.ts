import assert from 'node:assert/strict';
import test from 'node:test';

import { type Feature } from '../../renderer/src/foundation/document/document.js';
import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import { exportAllBodiesStl, exportBodyStl } from '../../renderer/src/kernel/stlExport.js';
import { circle, rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

function readStlHeader(buffer: ArrayBuffer): { triangleCount: number; byteLength: number } {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  return { triangleCount, byteLength: buffer.byteLength };
}

/** Every edge of a closed (watertight) mesh is shared by exactly two triangles. */
function isWatertight(positions: Float32Array, indices: Uint32Array): boolean {
  const key = (a: number, b: number) => {
    const ax = positions[a * 3]!.toFixed(4);
    const ay = positions[a * 3 + 1]!.toFixed(4);
    const az = positions[a * 3 + 2]!.toFixed(4);
    const bx = positions[b * 3]!.toFixed(4);
    const by = positions[b * 3 + 1]!.toFixed(4);
    const bz = positions[b * 3 + 2]!.toFixed(4);
    return `${ax},${ay},${az}|${bx},${by},${bz}`;
  };
  const edgeCount = new Map<string, number>();
  for (let t = 0; t < indices.length / 3; t += 1) {
    const [a, b, c] = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = key(p!, q!);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  // Each directed edge should appear exactly once, and be matched by its
  // reverse (the neighbouring triangle's opposite winding) exactly once.
  for (const [k, count] of edgeCount) {
    if (count !== 1) return false;
    const [p, q] = k.split('|');
    if ((edgeCount.get(`${q}|${p}`) ?? 0) !== 1) return false;
  }
  return true;
}

void test('binary STL: header, triangle count and watertight demo body', async () => {
  const { evaluator } = await loadNodeKernel();
  const result = await evaluator.evaluate(createDemoDocument());
  assert.equal(result.bodies.length, 1);
  const body = result.bodies[0]!;

  const buffer = exportBodyStl(result.bodies, body.id)!;
  const { triangleCount, byteLength } = readStlHeader(buffer);
  const expectedTriangles = body.mesh.indices.length / 3;
  assert.equal(triangleCount, expectedTriangles);
  assert.equal(byteLength, 80 + 4 + expectedTriangles * 50);
  assert.ok(
    isWatertight(body.mesh.positions, body.mesh.indices),
    'demo body STL mesh is watertight',
  );
});

void test('binary STL: "all bodies" export merges every body into one triangle soup', async () => {
  const { evaluator } = await loadNodeKernel();
  const s1 = sketchFeature('s1', [rect(0, 0, 10, 10), circle(40, 10, 5)]);
  const box: Feature[] = [
    s1.feature,
    {
      id: 'e1',
      name: 'Extrude 1',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's1', regions: [s1.regionKeys[0]!] },
      distance: 10,
      symmetric: false,
      operation: 'new',
    },
    {
      id: 'e2',
      name: 'Extrude 2',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's1', regions: [s1.regionKeys[1]!] },
      distance: 10,
      symmetric: false,
      operation: 'new',
    },
  ];
  const result = await evaluator.evaluate(box);
  assert.equal(result.bodies.length, 2);
  const totalTriangles = result.bodies.reduce((sum, b) => sum + b.mesh.indices.length / 3, 0);
  const buffer = exportAllBodiesStl(result.bodies);
  const { triangleCount } = readStlHeader(buffer);
  assert.equal(triangleCount, totalTriangles);
});

void test('exportBodyStl returns null for an unknown body id', async () => {
  const { evaluator } = await loadNodeKernel();
  const result = await evaluator.evaluate(createDemoDocument());
  assert.equal(exportBodyStl(result.bodies, 'body:does-not-exist'), null);
});
