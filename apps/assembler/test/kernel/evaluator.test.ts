import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ExtrudeFeature,
  type Feature,
} from '../../renderer/src/foundation/document/document.js';
import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type {
  Body,
  EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  edgeSignatureOf,
  faceSignatureOf,
} from '../../renderer/src/foundation/geometry-kernel/naming.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import { circle, rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const PLATE = 'body:feature-extrude-1';

/** Hand calculation, see `createDemoDocument`. */
function bracketVolume(plateWidth: number): number {
  const plate = plateWidth * 50 * 6;
  const upright = 80 * 8 * 40;
  const fillet = (4 * 4 - (Math.PI * 4 * 4) / 4) * 80;
  const hole = Math.PI * 3 * 3 * 6;
  return plate + upright + fillet - hole;
}

/** The plate sketch with another width (same entity ids, as the solver would leave it). */
function withSketch1Width(features: Feature[], width: number): Feature[] {
  return features.map((f) =>
    f.id === 'feature-sketch-1' && f.kind === 'sketch'
      ? ({
          ...f,
          ...addRectangle(EMPTY_SKETCH, [0, 0], [width, 50], { position: true, size: true }).sketch,
        } as SketchFeature)
      : f,
  );
}

function body(result: EvaluationResult, id = PLATE): Body {
  const found = result.bodies.find((b) => b.id === id);
  assert.ok(found, `body ${id} exists`);
  return found;
}

function roundFaceEdgesTouch(result: EvaluationResult): { key: string; area: number } | null {
  const b = body(result);
  const round = b.faces.find((f) => f.key === 'feature-fillet-3:round:0');
  return round ? { key: round.key, area: round.area } : null;
}

void test('demo bracket evaluates to one valid B-rep body matching the hand calculation', async (t) => {
  const { evaluator, loadMs } = await loadNodeKernel();
  const start = performance.now();
  const result = await evaluator.evaluate(createDemoDocument());
  const totalMs = performance.now() - start;
  t.diagnostic(
    `wasm load ${loadMs.toFixed(0)} ms; demo evaluation ${totalMs.toFixed(0)} ms ` +
      `(model ${result.stats.modelMs.toFixed(0)} ms, tessellation ${result.stats.tessellateMs.toFixed(0)} ms), ` +
      `${result.stats.triangles} triangles`,
  );
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.warnings, {});
  assert.equal(result.bodies.length, 1);
  const bracket = body(result);
  assert.equal(bracket.name, 'Bracket');
  assert.equal(bracket.valid, true);
  assert.ok(Math.abs(bracket.volume - bracketVolume(80)) < 0.01, `volume ${bracket.volume}`);
  const bboxTol = 1e-6;
  bracket.min.forEach((v, i) =>
    assert.ok(Math.abs(v - [0, 0, 0][i]!) < bboxTol, `min ${bracket.min}`),
  );
  bracket.max.forEach((v, i) =>
    assert.ok(Math.abs(v - [80, 50, 46][i]!) < bboxTol, `max ${bracket.max}`),
  );
  // Fillet face and the hole's cylinder are real curved B-rep faces.
  const round = bracket.faces.find((f) => f.key === 'feature-fillet-3:round:0');
  assert.equal(round?.surface, 'cylinder');
  assert.ok(Math.abs(round.area - (Math.PI * 4 * 80) / 2) < 1e-3, `fillet area ${round.area}`);
  const hole = bracket.faces.find((f) => f.key === 'feature-extrude-5:side:0:c1');
  assert.equal(hole?.surface, 'cylinder');
  assert.ok(Math.abs(hole.area - 2 * Math.PI * 3 * 6) < 1e-3, `hole area ${hole.area}`);
  // Keys are unique within the body.
  assert.equal(new Set(bracket.faces.map((f) => f.key)).size, bracket.faces.length);
  assert.equal(new Set(bracket.edges.map((e) => e.key)).size, bracket.edges.length);
});

void test('tessellation: every triangle carries a face id, planes are flat-shaded, cylinders smooth', async () => {
  const { evaluator } = await loadNodeKernel();
  const bracket = body(await evaluator.evaluate(createDemoDocument()));
  const { mesh } = bracket;
  const triangles = mesh.indices.length / 3;
  assert.equal(mesh.triangleFaces.length, triangles);
  let covered = 0;
  bracket.faces.forEach((face, faceIndex) => {
    assert.ok(face.triangleCount > 0, `face ${face.key} has triangles`);
    covered += face.triangleCount;
    for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t += 1) {
      assert.equal(mesh.triangleFaces[t], faceIndex);
    }
    if (face.surface === 'plane' && face.normal) {
      for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t += 1) {
        for (let k = 0; k < 3; k += 1) {
          const v = mesh.indices[t * 3 + k]!;
          const n = [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!];
          const d = n[0]! * face.normal[0] + n[1]! * face.normal[1] + n[2]! * face.normal[2];
          assert.ok(d > 0.999, `planar face ${face.key} vertex normal matches the outward normal`);
        }
      }
    }
  });
  assert.equal(covered, triangles);
  const round = bracket.faces.find((f) => f.key === 'feature-fillet-3:round:0')!;
  const distinct = new Set<string>();
  for (let t = round.triangleStart; t < round.triangleStart + round.triangleCount; t += 1) {
    const v = mesh.indices[t * 3]!;
    distinct.add([0, 1, 2].map((k) => mesh.normals[v * 3 + k]!.toFixed(3)).join(','));
  }
  assert.ok(distinct.size > 4, 'fillet vertex normals vary smoothly across the face');
  for (const edge of bracket.edges) {
    assert.ok(edge.segments.length >= 6, `edge ${edge.key} has a polyline`);
    assert.ok(edge.faceIndices.length >= 1);
  }
});

void test('stable references: editing the base-plate sketch width keeps the fillet on the inner edge', async (t) => {
  const { evaluator } = await loadNodeKernel();
  const before = await evaluator.evaluate(createDemoDocument());
  const start = performance.now();
  const after = await evaluator.evaluate(withSketch1Width(createDemoDocument(), 100));
  t.diagnostic(`parameter-edit re-evaluation ${(performance.now() - start).toFixed(0)} ms`);
  assert.deepEqual(after.errors, {});
  assert.deepEqual(after.warnings, {}, 'resolved by naming key, not by the geometric fallback');
  const bracket = body(after);
  assert.equal(bracket.valid, true);
  assert.ok(Math.abs(bracket.volume - bracketVolume(100)) < 0.01, `volume ${bracket.volume}`);
  assert.ok(Math.abs(bracket.max[0] - 100) < 1e-6);
  // The fillet is still on the plate-top/upright-front edge: a quarter cylinder along X at y=38..42, z=6..10.
  const round = bracket.faces.find((f) => f.key === 'feature-fillet-3:round:0');
  assert.ok(round, 'fillet face still present');
  assert.equal(round.surface, 'cylinder');
  assert.ok(Math.abs(round.centroid[0] - 40) < 1e-6, `fillet centroid x ${round.centroid}`);
  assert.ok(
    round.centroid[1] > 38 && round.centroid[1] < 42,
    `fillet centroid y ${round.centroid}`,
  );
  assert.ok(round.centroid[2] > 6 && round.centroid[2] < 10, `fillet centroid z ${round.centroid}`);
  assert.deepEqual(roundFaceEdgesTouch(before)?.key, roundFaceEdgesTouch(after)?.key);
  // The hole sketched on the plate's top face followed the face through the edit.
  assert.ok(bracket.faces.some((f) => f.key === 'feature-extrude-5:side:0:c1'));
});

void test('stable references: removing the referenced face yields a Missing reference error, not a re-bind', async () => {
  const { evaluator } = await loadNodeKernel();
  const suppressed = createDemoDocument().map((f) =>
    f.id === 'feature-extrude-2' ? { ...f, suppressed: true } : f,
  );
  const result = await evaluator.evaluate(suppressed);
  assert.match(result.errors['feature-fillet-3'] ?? '', /^Missing reference: edge /);
  assert.equal(result.warnings['feature-fillet-3'], undefined);
  // The rest of the history still evaluates: plate with the hole, no fillet.
  const plate = body(result);
  assert.ok(Math.abs(plate.volume - (80 * 50 * 6 - Math.PI * 9 * 6)) < 0.01);
  assert.ok(!plate.faces.some((f) => f.key.startsWith('feature-fillet-3')));

  const separate = createDemoDocument().map((f) =>
    f.id === 'feature-extrude-2' ? ({ ...f, operation: 'new' } as ExtrudeFeature) : f,
  );
  const split = await evaluator.evaluate(separate);
  assert.equal(split.bodies.length, 2);
  assert.match(split.errors['feature-fillet-3'] ?? '', /^Missing reference: edge /);
});

void test('face push/pull keeps the face identity; chamfer, shell, move and booleans evaluate', async () => {
  const { evaluator } = await loadNodeKernel();
  const demo = await evaluator.evaluate(createDemoDocument());
  const bracket = body(demo);
  const top = bracket.faces.find((f) => f.normal && f.normal[2] > 0.999 && f.centroid[2] > 45)!;
  const pushPull: ExtrudeFeature = {
    id: 'feature-extrude-10',
    name: 'Extrude 4',
    suppressed: false,
    kind: 'extrude',
    profile: {
      kind: 'face',
      face: { bodyId: PLATE, key: top.key, signature: faceSignatureOf(top) },
    },
    distance: 5,
    symmetric: false,
    operation: 'join',
  };
  const outerEdge = bracket.edges.find(
    (e) =>
      e.curve === 'line' &&
      Math.abs(e.midpoint[2] - 46) < 1e-6 &&
      Math.abs(e.midpoint[1] - 50) < 1e-6,
  )!;
  const features: Feature[] = [
    ...createDemoDocument(),
    pushPull,
    {
      id: 'feature-chamfer-11',
      name: 'Chamfer 1',
      suppressed: false,
      kind: 'chamfer',
      distance: 1,
      edges: [{ bodyId: PLATE, key: outerEdge.key, signature: edgeSignatureOf(outerEdge) }],
    },
  ];
  const result = await evaluator.evaluate(features);
  assert.deepEqual(result.errors, {});
  const grown = body(result);
  assert.ok(Math.abs(grown.max[2] - 51) < 1e-6, `pushed top to z=51, got ${grown.max}`);
  assert.ok(
    grown.faces.some((f) => f.key === top.key),
    'moved face keeps its key',
  );
  assert.ok(grown.faces.some((f) => f.key === 'feature-chamfer-11:chamfer:0'));
  assert.equal(grown.valid, true);

  const boxSketch = sketchFeature('feature-sketch-1', [rect(0, 0, 20, 20), circle(40, 10, 5)]);
  const box: Feature[] = [
    boxSketch.feature,
    {
      id: 'feature-extrude-2',
      name: 'Extrude 1',
      suppressed: false,
      kind: 'extrude',
      profile: {
        kind: 'sketch',
        featureId: 'feature-sketch-1',
        regions: [boxSketch.regionKeys[0]!],
      },
      distance: 20,
      symmetric: false,
      operation: 'new',
    },
    {
      id: 'feature-extrude-3',
      name: 'Extrude 2',
      suppressed: false,
      kind: 'extrude',
      profile: {
        kind: 'sketch',
        featureId: 'feature-sketch-1',
        regions: [boxSketch.regionKeys[1]!],
      },
      distance: 10,
      symmetric: true,
      operation: 'new',
    },
  ];
  const boxes = await evaluator.evaluate(box);
  assert.equal(boxes.bodies.length, 2);
  const cube = body(boxes, 'body:feature-extrude-2');
  const cubeTop = cube.faces.find((f) => f.key === 'feature-extrude-2:end:0')!;
  const shelled = await evaluator.evaluate([
    ...box,
    {
      id: 'feature-shell-4',
      name: 'Shell 1',
      suppressed: false,
      kind: 'shell',
      bodyId: cube.id,
      thickness: 2,
      faces: [{ bodyId: cube.id, key: cubeTop.key, signature: faceSignatureOf(cubeTop) }],
    },
    {
      id: 'feature-move-5',
      name: 'Move 1',
      suppressed: false,
      kind: 'move',
      bodyId: 'body:feature-extrude-3',
      dx: -30,
      dy: 0,
      dz: 10,
    },
    {
      id: 'feature-boolean-6',
      name: 'Union 1',
      suppressed: false,
      kind: 'boolean',
      operation: 'union',
      targetBodyId: cube.id,
      toolBodyIds: ['body:feature-extrude-3'],
    },
  ]);
  assert.deepEqual(shelled.errors, {});
  assert.equal(shelled.bodies.length, 1);
  const hollow = body(shelled, cube.id);
  // Shell (8000 - 16*16*18) plus the cylinder moved into the cavity (r=5, z 0..20, centre (10,10)),
  // minus the part already occupied by the walls/floor.
  const shellVolume = 8000 - 16 * 16 * 18;
  assert.ok(hollow.volume > shellVolume, `union added material: ${hollow.volume}`);
  assert.ok(hollow.faces.some((f) => f.key.startsWith('feature-shell-4:inner:')));
  assert.equal(hollow.valid, true);
});
