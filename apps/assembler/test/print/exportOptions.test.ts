/**
 * STL export options: resolution presets re-tessellate a copy (coarse <
 * standard < fine triangles on curved bodies, the display mesh untouched),
 * ASCII STL round-trips through the STL reader, binary and ASCII agree.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MESH_RESOLUTIONS } from '../../renderer/src/foundation/geometry-kernel/meshExport.js';
import { parseStl } from '../../renderer/src/kernel/stlImport.js';
import { stlBytes } from '../../renderer/src/foundation/geometry-kernel/stlExport.js';
import { circle, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from '../kernel/nodeKernel.js';
import { evaluate, extrude } from './fixtures.js';

function cylinder() {
  const s = sketchFeature('cy-s', [circle(0, 0, 20)]);
  return [s.feature, extrude('cy-e', 'cy-s', [s.regionKeys[0]!], 30, { name: 'Cylinder' })];
}

void test('resolution presets: coarse < standard < fine; the display mesh is unchanged', async () => {
  const { evaluator } = await loadNodeKernel();
  const features = cylinder();
  const before = await evaluate(features);
  const displayTriangles = before.bodies[0]!.mesh.indices.length / 3;
  const counts: Record<string, number> = {};
  for (const preset of ['coarse', 'standard', 'fine'] as const) {
    const [body] = await evaluator.exportMesh!(features, MESH_RESOLUTIONS[preset]);
    assert.ok(body, preset);
    counts[preset] = body.mesh.indices.length / 3;
    assert.equal(body.id, 'body:cy-e');
    assert.equal(body.mesh.triangleFaces.length, counts[preset]);
  }
  assert.ok(counts.coarse! < counts.standard!, JSON.stringify(counts));
  assert.ok(counts.standard! < counts.fine!, JSON.stringify(counts));
  // Meshing a copy never changes what the viewport shows.
  const after = await evaluate(features);
  assert.equal(after.bodies[0]!.mesh.indices.length / 3, displayTriangles);
  // A coarse export after a fine one is still coarse (no leftover finer triangulation).
  const [again] = await evaluator.exportMesh!(features, MESH_RESOLUTIONS.coarse);
  assert.equal(again!.mesh.indices.length / 3, counts.coarse);
});

void test('ASCII and binary STL describe the same triangles', async () => {
  const result = await evaluate(cylinder());
  const body = result.bodies[0]!;
  const meshes = [{ name: 'Cylinder Ø40', mesh: body.mesh }];
  const ascii = stlBytes(meshes, 'ascii');
  const binary = stlBytes(meshes, 'binary');
  const text = new TextDecoder().decode(ascii);
  assert.match(text, /^solid Cylinder_40\n/);
  assert.match(text, /endsolid Cylinder_40\n$/);
  const fromAscii = parseStl(ascii);
  const fromBinary = parseStl(binary);
  assert.equal(fromAscii.triangleCount, body.mesh.indices.length / 3);
  assert.equal(fromBinary.triangleCount, fromAscii.triangleCount);
  for (let i = 0; i < 300; i += 1) {
    assert.ok(Math.abs(fromAscii.positions[i]! - fromBinary.positions[i]!) < 1e-5);
  }
});
