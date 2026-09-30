/**
 * 3MF and OBJ import (reference meshes): objects, names, colours, units,
 * component/item transforms and `p:path` parts; plus a 3MF export → import
 * round trip through the app's own writer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildThreeMf } from '../../renderer/src/foundation/geometry-kernel/threeMf.js';
import { importFormatOf, parseMeshFile } from '../../renderer/src/modules/interop/importParsers.js';
import { referenceMeshesFromImport } from '../../renderer/src/modules/interop/importActions.js';
import {
  signedVolume,
  weldMesh,
} from '../../renderer/src/foundation/geometry-kernel/meshSolidPayload.js';
import type { ParsedStl } from '../../renderer/src/modules/interop/stlImport.js';
import { interopFixture } from './fixtures.js';

function volumeOf(mesh: ParsedStl): number {
  return signedVolume(weldMesh(mesh.positions));
}

function near(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) <= tol;
}

void test('import formats by extension', () => {
  assert.equal(importFormatOf('Part.STEP'), 'step');
  assert.equal(importFormatOf('a.stp'), 'step');
  assert.equal(importFormatOf('a.igs'), 'iges');
  assert.equal(importFormatOf('scan.stl'), 'stl');
  assert.equal(importFormatOf('plate.3MF'), '3mf');
  assert.equal(importFormatOf('m.obj'), 'obj');
  assert.equal(importFormatOf('outline.dxf'), 'dxf');
  assert.equal(importFormatOf('project.hcasm'), 'hcasm');
  assert.equal(importFormatOf('photo.png'), null);
});

void test('3MF: items, units (cm → mm), transforms, p:path parts, colours, mirrored item', async () => {
  const result = await parseMeshFile(interopFixture('parts.3mf'), 'parts.3mf');
  assert.equal(result.format, '3mf');
  assert.equal(result.declaredUnit, 'centimeter');
  assert.equal(result.unitScale, 10);
  assert.deepEqual(
    result.objects.map((o) => [o.name, o.color, o.folder.join('/'), o.mesh.triangleCount]),
    [
      ['Cube', '#FF0000', 'parts', 12],
      ['Pair', '#FF0000', 'parts', 24],
      ['Wedge', '#33AA55', 'parts', 4],
    ],
  );
  const [cube, pair, wedge] = result.objects;
  // Cube: 1 cm, lifted 1 cm → 10 mm cube at z 10..20.
  assert.deepEqual(cube!.mesh.min, [0, 0, 10]);
  assert.deepEqual(cube!.mesh.max, [10, 10, 20]);
  assert.ok(near(volumeOf(cube!.mesh), 1000, 1e-3));
  // Pair: cube moved 2 cm in X (20..30 mm) + remote 0.5 cm cube at the origin (0..5 mm).
  assert.deepEqual(pair!.mesh.min, [0, 0, 0]);
  assert.deepEqual(pair!.mesh.max, [30, 10, 10]);
  assert.ok(near(volumeOf(pair!.mesh), 1000 + 125, 1e-3));
  // Wedge: mirrored in X, moved 5 cm: x 40..50 mm; winding fixed so the volume stays positive.
  assert.deepEqual(wedge!.mesh.min, [40, 0, 0]);
  assert.deepEqual(wedge!.mesh.max, [50, 10, 10]);
  assert.ok(near(volumeOf(wedge!.mesh), 1000 / 6, 1e-3), `wedge volume ${volumeOf(wedge!.mesh)}`);
  assert.ok(result.warnings.some((w) => /centimeter to millimetres/.test(w)));

  const meshes = referenceMeshesFromImport(
    result,
    'parts.3mf',
    (() => {
      let n = 0;
      return () => `m${(n += 1)}`;
    })(),
  );
  assert.deepEqual(
    meshes.map((m) => [m.mesh.id, m.mesh.name, m.mesh.color, m.folder]),
    [
      ['m1', 'Cube', '#FF0000', ['parts']],
      ['m2', 'Pair', '#FF0000', ['parts']],
      ['m3', 'Wedge', '#33AA55', ['parts']],
    ],
  );
});

void test('3MF round trip: the app export reads back with names, colours and placements', async () => {
  const cube = await parseMeshFile(interopFixture('l-bracket.stl'), 'l-bracket.stl');
  const mesh = cube.objects[0]!.mesh;
  const bytes = buildThreeMf(
    [
      { id: 'body:a', name: 'Bracket A', color: '#9AAE9B', mesh },
      {
        id: 'body:b',
        name: 'Bracket <B>',
        color: '#C7AE8E',
        mesh: { ...mesh, positions: mesh.positions.map((v, i) => (i % 3 === 0 ? v + 50 : v)) },
      },
    ],
    { title: 'Round trip' },
  );
  const back = await parseMeshFile(bytes, 'round-trip.3mf');
  assert.deepEqual(
    back.objects.map((o) => [o.name, o.color]),
    [
      ['Bracket A', '#9AAE9B'],
      ['Bracket <B>', '#C7AE8E'],
    ],
  );
  assert.deepEqual(back.objects[0]!.mesh.min, [0, 0, 0]);
  assert.deepEqual(back.objects[1]!.mesh.min, [50, 0, 0]);
  const expected = 40 * 10 * 10 + 10 * 20 * 10;
  for (const o of back.objects) assert.ok(near(volumeOf(o.mesh), expected, 1e-2));
});

void test('3MF errors are readable', async () => {
  await assert.rejects(
    parseMeshFile(new TextEncoder().encode('not a zip'), 'x.3mf'),
    /not a readable 3MF package/,
  );
});

void test('OBJ: groups become meshes in a folder, quads and negative indices, vertex colours', async () => {
  const result = await parseMeshFile(interopFixture('bracket-groups.obj'), 'bracket-groups.obj');
  assert.equal(result.format, 'obj');
  assert.equal(result.declaredUnit, null);
  assert.deepEqual(
    result.objects.map((o) => [o.name, o.color, o.folder.join('/'), o.mesh.triangleCount]),
    [
      ['base', null, 'bracket-groups/Bracket', 12],
      ['pin', '#336699', 'bracket-groups/Bracket', 8],
    ],
  );
  assert.ok(near(volumeOf(result.objects[0]!.mesh), 20 * 10 * 2, 1e-3));
  assert.ok(near(volumeOf(result.objects[1]!.mesh), 2 * 6, 1e-3));
});

void test('OBJ errors name the line', async () => {
  await assert.rejects(
    parseMeshFile(new TextEncoder().encode('v 0 0 0\nv 1 0 0\nf 1 2 7\n'), 'bad.obj'),
    /Line 3: Face index 7 refers to a missing vertex/,
  );
});
