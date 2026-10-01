/**
 * Mesh → solid: the checks (closed, manifold, orientation, limits), the
 * OCCT build with coplanar merging, and that the result is a real kernel
 * body — it fillets like any other.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  meshSolidFeature,
  referenceMeshWorldPositions,
  referenceMeshesFromImport,
} from '../../renderer/src/modules/interop/importActions.js';
import { parseMeshFile } from '../../renderer/src/modules/interop/importParsers.js';
import {
  MeshSolidError,
  decodeMeshSolidPayload,
  encodeMeshSolidPayload,
  planarRegions,
  prepareSolidMesh,
  weldMesh,
} from '../../renderer/src/foundation/geometry-kernel/meshSolidPayload.js';
import type { Feature, FilletFeature } from '../../renderer/src/foundation/document/document.js';
import { interopFixture } from '../interop/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

async function stlPositions(name: string): Promise<Float32Array> {
  const result = await parseMeshFile(interopFixture(name), name);
  return referenceMeshWorldPositions(referenceMeshesFromImport(result, name)[0]!.mesh);
}

/** Icosphere (subdivided icosahedron) of radius r: no two triangles coplanar. */
function icosphere(r: number, subdivisions: number): Float32Array {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  let faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const norm = (v: number[]) => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return v.map((c) => (c / l) * r);
  };
  verts = verts.map(norm);
  for (let s = 0; s < subdivisions; s += 1) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = cache.get(key);
      if (i === undefined) {
        i = verts.length;
        verts.push(norm(verts[a]!.map((c, k) => (c + verts[b]![k]!) / 2)));
        cache.set(key, i);
      }
      return i;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a!, b!);
      const bc = mid(b!, c!);
      const ca = mid(c!, a!);
      return [
        [a!, ab, ca],
        [b!, bc, ab],
        [c!, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  return new Float32Array(faces.flatMap((f) => f.flatMap((i) => verts[i]!)));
}

void test('checks: closed L-bracket passes with coplanar regions; an open box is refused with the reason', async () => {
  const { mesh, check } = prepareSolidMesh(weldMesh(await stlPositions('l-bracket.stl')));
  assert.equal(check.triangles, 20);
  assert.equal(check.faces, 8, 'two L caps + six sides');
  assert.equal(check.components, 1);
  assert.ok(Math.abs(check.volume - 6000) < 1e-6);
  const regions = planarRegions(mesh);
  const cap = regions.find((r) => r.triangles.length === 4)!;
  assert.equal(cap.loops?.length, 1);
  assert.equal(cap.loops?.[0]?.length, 6, 'the cap boundary is the L outline');

  assert.throws(() => prepareSolidMesh(weldMesh(new Float32Array(0))), /fewer than 4 triangles/);
  const open = await stlPositions('open-box.stl');
  assert.throws(
    () => prepareSolidMesh(weldMesh(open)),
    /not a closed, manifold surface: 4 open edges/,
  );
});

void test('checks: inside-out and partly flipped meshes are re-oriented; limits are enforced', () => {
  const sphere = icosphere(10, 1);
  // Reverse every triangle: inside out.
  const inverted = new Float32Array(sphere.length);
  for (let t = 0; t < sphere.length; t += 9) {
    inverted.set(sphere.subarray(t, t + 3), t);
    inverted.set(sphere.subarray(t + 6, t + 9), t + 3);
    inverted.set(sphere.subarray(t + 3, t + 6), t + 6);
  }
  const fixed = prepareSolidMesh(weldMesh(inverted));
  assert.equal(fixed.check.inverted, true);
  assert.ok(fixed.check.volume > 0);
  // Flip one triangle only.
  const one = sphere.slice();
  one.set(sphere.subarray(6, 9), 3);
  one.set(sphere.subarray(3, 6), 6);
  const repaired = prepareSolidMesh(weldMesh(one));
  assert.equal(
    repaired.check.flipped + (repaired.check.inverted ? repaired.check.triangles : 0) > 0,
    true,
  );
  assert.throws(
    () => prepareSolidMesh(weldMesh(sphere), { triangles: 10, faces: 10 }),
    /supports up to 10/,
  );
});

void test('payload round trip', () => {
  const { mesh } = prepareSolidMesh(weldMesh(icosphere(5, 1)));
  const back = decodeMeshSolidPayload(encodeMeshSolidPayload(mesh));
  assert.deepEqual([...back.indices], [...mesh.indices]);
  assert.deepEqual([...back.positions], [...mesh.positions]);
  assert.throws(() => decodeMeshSolidPayload(new Uint8Array(20)), MeshSolidError);
});

void test('kernel: L-bracket mesh becomes an 8-face valid solid and can be filleted', async () => {
  const { evaluator } = await loadNodeKernel();
  const { mesh } = prepareSolidMesh(weldMesh(await stlPositions('l-bracket.stl')));
  const solid = meshSolidFeature({
    id: 'feature-meshSolid-1',
    name: 'Mesh to Solid 1',
    sourceName: 'l-bracket',
    mesh,
  });
  const result = await evaluator.evaluate([solid]);
  assert.deepEqual(result.errors, {});
  assert.equal(result.bodies.length, 1);
  const body = result.bodies[0]!;
  assert.equal(body.name, 'l-bracket');
  assert.equal(body.faces.length, 8);
  assert.equal(body.valid, true);
  assert.ok(Math.abs(body.volume - 6000) < 1e-6, `volume ${body.volume}`);
  assert.ok(body.faces.every((f) => f.surface === 'plane'));
  // Fillet the long outer vertical edge at x = 40, y = 0.
  const edge = body.edges.find(
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[0] - 40) < 1e-6 && Math.abs(e.midpoint[1]) < 1e-6,
  )!;
  assert.ok(edge, 'vertical edge at (40, 0)');
  const fillet: FilletFeature = {
    id: 'feature-fillet-2',
    name: 'Fillet 1',
    suppressed: false,
    kind: 'fillet',
    radius: 3,
    edges: [
      {
        bodyId: body.id,
        key: edge.key,
        signature: {
          curve: 'line',
          midpoint: edge.midpoint,
          length: edge.length,
          direction: edge.direction,
        },
      },
    ],
  };
  const filleted = await evaluator.evaluate([solid, fillet] as Feature[]);
  assert.deepEqual(filleted.errors, {});
  const expected = 6000 - (9 - (Math.PI * 9) / 4) * 10;
  assert.ok(
    Math.abs(filleted.bodies[0]!.volume - expected) < 1e-3,
    `filleted volume ${filleted.bodies[0]!.volume}`,
  );
  assert.ok(filleted.bodies[0]!.faces.some((f) => f.surface === 'cylinder'));
});

void test('kernel: a faceted sphere (no coplanar triangles) converts face per triangle', async () => {
  const { evaluator } = await loadNodeKernel();
  const { mesh, check } = prepareSolidMesh(weldMesh(icosphere(10, 2)));
  assert.equal(check.faces, 320);
  const result = await evaluator.evaluate([
    meshSolidFeature({
      id: 'feature-meshSolid-3',
      name: 'Mesh to Solid 1',
      sourceName: 'ball',
      mesh,
    }),
  ]);
  assert.deepEqual(result.errors, {});
  assert.equal(result.bodies[0]!.faces.length, 320);
  assert.equal(result.bodies[0]!.valid, true);
  assert.ok(Math.abs(result.bodies[0]!.volume - check.volume) < 1e-3);
});
