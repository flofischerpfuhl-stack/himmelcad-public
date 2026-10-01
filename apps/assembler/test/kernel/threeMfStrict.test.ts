/**
 * 3MF quality: multi-body, multi-colour packages written by
 * `kernel/threeMf.ts` pass the strict validator (`threeMfValidator.ts`):
 * required parts/relationships, units, base materials and colour groups,
 * named objects with per-object metadata, build items with transforms, and
 * a closed, consistently oriented mesh per object.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildThreeMf } from '../../renderer/src/foundation/geometry-kernel/threeMf.js';
import type { Feature } from '../../renderer/src/foundation/document/document.js';
import { boxFeatures, evaluate, mushroom, plateWithHoles } from '../print/fixtures.js';
import { validateThreeMf, type ParsedObject } from './threeMfValidator.js';

function colour(bodyId: string, color: string, id: string): Feature {
  return { id, name: id, suppressed: false, kind: 'setAppearance', bodyId, color };
}

void test('multi-body, multi-colour 3MF passes the strict validator', async () => {
  const features: Feature[] = [
    ...boxFeatures('a', 20, 10, 5),
    ...boxFeatures('b', 8, 8, 8, 40, 0),
    ...plateWithHoles(),
    ...mushroom(),
  ];
  features.push(colour('body:a-e', '#E4572E', 'c1'), colour('body:b-e', '#17BEBB', 'c2'));
  const result = await evaluate(features);
  assert.equal(result.bodies.length, 4);

  const bytes = buildThreeMf(result.bodies, { title: 'Strict test' });
  const { problems, model } = validateThreeMf(bytes);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(model);
  assert.equal(model.unit, 'millimeter');
  assert.equal(model.metadata.Title, 'Strict test');
  assert.equal(model.metadata.Application, 'HimmelCAD Assembler');
  assert.equal(model.objects.size, 4);
  assert.equal(model.items.length, 4);

  // One base material per body with its colour; objects reference their own.
  const [baseId, bases] = [...model.baseMaterials][0]!;
  assert.deepEqual(
    bases.map((b) => b.color),
    result.bodies.map((b) => `${b.color.toUpperCase()}FF`),
  );
  for (const [index, body] of result.bodies.entries()) {
    const object: ParsedObject = [...model.objects.values()].find((o) => o.partnumber === body.id)!;
    assert.ok(object, `object for ${body.id}`);
    assert.equal(object.name, body.name);
    assert.equal(object.metadata['hcasm:bodyId'], body.id);
    assert.equal(object.pid, baseId);
    assert.equal(object.pindex, index);
    // The item transform places the object back where it was modelled.
    const item = model.items.find((i) => i.objectId === object.id)!;
    const t = item.transform;
    const xs = object.vertices.map((v) => v[0]! + t[9]!);
    const ys = object.vertices.map((v) => v[1]! + t[10]!);
    const zs = object.vertices.map((v) => v[2]! + t[11]!);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    assert.ok(near(Math.min(...xs), body.min[0]) && near(Math.max(...xs), body.max[0]), 'x range');
    assert.ok(near(Math.min(...ys), body.min[1]) && near(Math.max(...ys), body.max[1]), 'y range');
    assert.ok(near(Math.min(...zs), body.min[2]) && near(Math.max(...zs), body.max[2]), 'z range');
    // Welded: fewer vertices than the render mesh, same triangle count.
    assert.ok(object.vertices.length < body.mesh.positions.length / 3);
    assert.equal(object.triangles.length, body.mesh.indices.length / 3);
  }
});

void test('per-face colours become a colour group referenced per triangle', async () => {
  const result = await evaluate(boxFeatures('f', 10, 10, 10));
  const body = result.bodies[0]!;
  const top = body.faces.find((f) => f.normal && f.normal[2] > 0.99)!;
  const side = body.faces.find((f) => f.normal && f.normal[0] > 0.99)!;
  const bytes = buildThreeMf([
    { ...body, faceColors: { [top.key]: '#FF0000', [side.key]: '#00FF00' } },
  ]);
  const { problems, model } = validateThreeMf(bytes);
  assert.deepEqual(problems, [], problems.join('\n'));
  const [groupId, colors] = [...model!.colorGroups][0]!;
  assert.deepEqual([...colors].sort(), ['#00FF00FF', '#FF0000FF']);
  const object = [...model!.objects.values()][0]!;
  const coloured = object.triangles.filter((t) => t.pid === groupId);
  assert.equal(coloured.length, top.triangleCount + side.triangleCount);
  // The other faces inherit the object's base material (no per-triangle property).
  assert.equal(
    object.triangles.filter((t) => t.pid === undefined).length,
    body.mesh.indices.length / 3 - coloured.length,
  );
});

void test('the validator rejects broken packages', async () => {
  const result = await evaluate(boxFeatures('x', 10, 10, 10));
  const good = buildThreeMf(result.bodies);
  // An open mesh (one triangle dropped) is reported.
  const open = buildThreeMf([
    {
      ...result.bodies[0]!,
      mesh: { ...result.bodies[0]!.mesh, indices: result.bodies[0]!.mesh.indices.slice(3) },
    },
  ]);
  assert.match(validateThreeMf(open).problems.join('\n'), /open edges/);
  // A corrupted byte fails the CRC check.
  const corrupt = good.slice();
  const at = new TextDecoder().decode(corrupt).indexOf('<vertex');
  corrupt[at + 1] = 'V'.charCodeAt(0);
  assert.match(validateThreeMf(corrupt).problems.join('\n'), /CRC mismatch/);
  // Names are XML-escaped.
  const named = buildThreeMf([{ ...result.bodies[0]!, name: 'A & <B> "quoted"' }]);
  const parsed = validateThreeMf(named);
  assert.deepEqual(parsed.problems, []);
  assert.equal([...parsed.model!.objects.values()][0]!.name, 'A & <B> "quoted"');
});
