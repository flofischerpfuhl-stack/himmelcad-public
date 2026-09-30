/**
 * STEP assemblies: import keeps the product structure (names, colours,
 * nested placements → `Body.itemPath`), export writes Items folders as
 * sub-assemblies with names and colours, AP214/AP242 and the length unit.
 * Fixture: `test/fixtures/interop/robot-assembly.step` (see its generator).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Feature, ImportStepFeature } from '../../renderer/src/model/document.js';
import { parseStepStructure } from '../../renderer/src/interop/step/stepStructure.js';
import { decodeStepString, scanStep } from '../../renderer/src/interop/step/p21.js';
import type { Body } from '../../renderer/src/kernel/types.js';
import { circle, rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const here = dirname(fileURLToPath(import.meta.url));
// Compiled to apps/assembler/.build/tests/apps/assembler/test/kernel: six levels up is apps/assembler.
const FIXTURES = join(here, '../../../../../../test/fixtures/interop');
const robot = readFileSync(join(FIXTURES, 'robot-assembly.step'));

function importFeature(
  bytes: Uint8Array,
  fileName: string,
  id = 'feature-import-1',
): ImportStepFeature {
  return {
    id,
    name: 'Import 1',
    suppressed: false,
    kind: 'importStep',
    data: Buffer.from(bytes).toString('base64'),
    fileName,
    structure: 'assembly',
  };
}

function near(actual: number, expected: number, tol = 1e-4): boolean {
  return Math.abs(actual - expected) <= tol;
}

function assertBox(body: Body, min: number[], max: number[], label: string): void {
  const ok =
    body.min.every((v, i) => near(v, min[i]!, 1e-3)) &&
    body.max.every((v, i) => near(v, max[i]!, 1e-3));
  assert.ok(
    ok,
    `${label}: box ${JSON.stringify([body.min, body.max])}, expected ${JSON.stringify([min, max])}`,
  );
}

void test('p21 scanner: strings, complex records, positions', () => {
  assert.equal(decodeStepString("it''s"), "it's");
  assert.equal(decodeStepString('\\X2\\00FC\\X0\\ber'), 'über');
  assert.equal(decodeStepString('\\X\\E4'), 'ä');
  const text = `ISO-10303-21;
HEADER; FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }')); ENDSEC;
DATA;
#10 = PRODUCT('P;1','Name with ''quote''','',(#2));
/* comment #11 = PRODUCT('x','y','',()); */
#11 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#12 = CARTESIAN_POINT('',(1.,2.,3.E+00));
ENDSEC;
END-ISO-10303-21;`;
  const scan = scanStep(text, { wanted: new Set(['PRODUCT', 'LENGTH_UNIT']) });
  assert.equal(scan.recordCount, 3);
  assert.deepEqual(scan.schemas, ['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']);
  assert.equal(scan.positions.get(12), 3);
  assert.deepEqual(scan.entities.get(10)!.parts[0]!.slice(0, 2), ['P;1', "Name with 'quote'"]);
  assert.deepEqual(scan.entities.get(11)!.types, ['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
  assert.equal(scan.entities.has(12), false, 'unwanted records are counted, not parsed');
});

void test('STEP structure of the fixture: tree, names, colours, unit, protocol', () => {
  const s = parseStepStructure(robot.toString('latin1'));
  assert.equal(s.protocol, 'AP214');
  assert.equal(s.lengthUnit, 'mm');
  assert.equal(s.roots.length, 1);
  const root = s.roots[0]!;
  assert.equal(root.name, 'Robot');
  assert.deepEqual(
    root.children.map((c) => [c.instanceName, c.node.name]),
    [
      ['Base plate:1', 'Base plate'],
      ['Arm:1', 'Arm'],
      ['Arm:2', 'Arm'],
    ],
  );
  const arm = root.children[1]!.node;
  assert.deepEqual(
    arm.children.map((c) => [c.node.name, c.node.color]),
    [
      ['Link', '#0000FF'],
      ['Pin', '#33AA55'],
    ],
  );
  assert.equal(root.children[0]!.node.color, '#FF0000');
  assert.equal(s.partCount, 3);
  assert.equal(s.instanceCount, 5);
});

void test('STEP assembly import: one body per placed part, names, colours, folders, placements', async () => {
  const { evaluator } = await loadNodeKernel();
  const result = await evaluator.evaluate([importFeature(robot, 'robot-assembly.step')]);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.warnings, {});
  const summary = result.bodies.map((b) => [b.id, b.name, b.color, (b.itemPath ?? []).join('/')]);
  assert.deepEqual(summary, [
    ['body:feature-import-1', 'Base plate', '#FF0000', 'Robot'],
    ['body:feature-import-1:1', 'Link', '#0000FF', 'Robot/Arm'],
    ['body:feature-import-1:2', 'Pin', '#33AA55', 'Robot/Arm'],
    ['body:feature-import-1:3', 'Link', '#0000FF', 'Robot/Arm (2)'],
    ['body:feature-import-1:4', 'Pin', '#33AA55', 'Robot/Arm (2)'],
  ]);
  const [plate, link1, pin1, link2, pin2] = result.bodies as [Body, Body, Body, Body, Body];
  assertBox(plate, [0, 0, 0], [40, 30, 5], 'Base plate');
  assertBox(link1, [10, 5, 5], [14, 9, 25], 'Link in Arm:1 (translated)');
  assertBox(link2, [26, 5, 5], [30, 9, 25], 'Link in Arm:2 (rotated 90° about Z, translated)');
  assertBox(pin1, [11, 6, 25], [13, 8, 31], 'Pin in Arm:1 (nested placement)');
  assertBox(pin2, [27, 6, 25], [29, 8, 31], 'Pin in Arm:2 (nested placement)');
  assert.ok(near(plate.volume, 40 * 30 * 5, 1e-6 * 6000));
  assert.ok(near(pin1.volume, Math.PI * 6, 1e-3));
  assert.ok(result.bodies.every((b) => b.valid));
  // Face keys: the first body keeps the classic keys, later ones are prefixed by their index.
  assert.ok(plate.faces.every((f) => /^feature-import-1:face:\d+$/.test(f.key)));
  assert.ok(pin2.faces.every((f) => /^feature-import-1:4:face:\d+$/.test(f.key)));
});

void test('legacy STEP import feature (no structure) still yields one body', async () => {
  const { evaluator } = await loadNodeKernel();
  const legacy: ImportStepFeature = { ...importFeature(robot, 'robot.step') };
  delete legacy.structure;
  const result = await evaluator.evaluate([legacy]);
  assert.deepEqual(result.errors, {});
  assert.equal(result.bodies.length, 1);
  assert.equal(result.bodies[0]!.itemPath, undefined);
});

void test('a non-STEP file fails the import step with a readable error', async () => {
  const { evaluator } = await loadNodeKernel();
  const result = await evaluator.evaluate([
    importFeature(new TextEncoder().encode('solid cube\nendsolid cube\n'), 'cube.step'),
  ]);
  assert.match(
    result.errors['feature-import-1'] ?? '',
    /STEP import failed: This is not a readable STEP file/,
  );
  assert.equal(result.bodies.length, 0);
});

function twoBodyDocument(): Feature[] {
  const s1 = sketchFeature('s1', [rect(0, 0, 10, 10), circle(40, 10, 5)]);
  return [
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
      resultBodyName: 'Cube',
    },
    {
      id: 'e2',
      name: 'Extrude 2',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's1', regions: [s1.regionKeys[1]!] },
      distance: 4,
      symmetric: false,
      operation: 'new',
      resultBodyName: 'Disc',
    },
    {
      id: 'c1',
      name: 'Colour',
      suppressed: false,
      kind: 'setAppearance',
      bodyId: 'body:e2',
      color: '#9AAE9B',
    },
  ];
}

void test('STEP export as an assembly: folders become sub-assemblies with names and exact colours', async () => {
  const { evaluator } = await loadNodeKernel();
  const bytes = await evaluator.exportStep(twoBodyDocument(), undefined, {
    schema: 'AP242',
    names: { 'body:e1': 'Cube renamed' },
    assembly: {
      name: 'Kit',
      children: [{ bodyId: 'body:e1' }, { name: 'Round parts', children: [{ bodyId: 'body:e2' }] }],
    },
  });
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /FILE_SCHEMA\s*\(\s*\(\s*'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/);
  assert.equal(parseStepStructure(text).protocol, 'AP242');
  // #9AAE9B written as sRGB (not brightened by OCCT's linear colour space).
  assert.match(text, /COLOUR_RGB\('',0\.6039\d*,0\.6823\d*,0\.6078\d*\)/);
  const structure = parseStepStructure(text);
  assert.equal(structure.roots.length, 1);
  assert.equal(structure.roots[0]!.name, 'Kit');
  assert.deepEqual(
    structure.roots[0]!.children.map((c) => c.node.name),
    ['Cube renamed', 'Round parts'],
  );
  const reimported = await evaluator.evaluate([
    importFeature(bytes, 'kit.step', 'feature-import-9'),
  ]);
  assert.deepEqual(reimported.errors, {});
  assert.deepEqual(
    reimported.bodies.map((b) => [b.name, b.color, (b.itemPath ?? []).join('/')]),
    [
      ['Cube renamed', '#B8BCC2', 'Kit'],
      ['Disc', '#9AAE9B', 'Kit/Round parts'],
    ],
  );
  assert.ok(near(reimported.bodies[0]!.volume, 1000, 1e-6));
  assert.ok(near(reimported.bodies[1]!.volume, Math.PI * 25 * 4, 1e-4));
});

void test('imported (located) parts re-export flat and as an assembly without extra levels', async () => {
  const { evaluator } = await loadNodeKernel();
  const source = [importFeature(robot, 'robot-assembly.step')];
  const imported = await evaluator.evaluate(source);
  const ids = imported.bodies.map((b) => b.id);
  const boxes = (bodies: readonly Body[]) =>
    bodies.map(
      (b) =>
        `${b.name} ${b.min.map((v) => v.toFixed(3)).join(',')}..${b.max.map((v) => v.toFixed(3)).join(',')}`,
    );

  const flat = await evaluator.exportStep(source, ids, { schema: 'AP214' });
  const flatStructure = parseStepStructure(new TextDecoder().decode(flat));
  assert.deepEqual(
    flatStructure.roots.map((r) => [r.name, r.children.length]),
    [
      ['Base plate', 0],
      ['Link', 0],
      ['Pin', 0],
      ['Link', 0],
      ['Pin', 0],
    ],
    'flat: every body is a top-level part (no wrapper assemblies)',
  );
  const flatBack = await evaluator.evaluate([importFeature(flat, 'flat.step', 'feature-import-7')]);
  // Same geometry and placements; equal names in one folder get "(2)" (Items names are unique per folder).
  assert.deepEqual(
    flatBack.bodies.map((b) => b.name),
    ['Base plate', 'Link', 'Pin', 'Link (2)', 'Pin (2)'],
  );
  const geometry = (bodies: readonly Body[]) =>
    boxes(bodies).map((s) => s.replace(/^.* (?=[-\d])/, ''));
  assert.deepEqual(geometry(flatBack.bodies), geometry(imported.bodies));
  assert.ok(flatBack.bodies.every((b) => b.itemPath === undefined));

  const tree = {
    name: 'Robot',
    children: [
      { bodyId: ids[0]! },
      { name: 'Arm', children: [{ bodyId: ids[1]! }, { bodyId: ids[2]! }] },
      { name: 'Arm (2)', children: [{ bodyId: ids[3]! }, { bodyId: ids[4]! }] },
    ],
  };
  const nested = await evaluator.exportStep(source, ids, { assembly: tree });
  const back = await evaluator.evaluate([importFeature(nested, 'nested.step', 'feature-import-8')]);
  assert.deepEqual(boxes(back.bodies), boxes(imported.bodies));
  assert.deepEqual(
    back.bodies.map((b) => `${(b.itemPath ?? []).join('/')}/${b.name} ${b.color}`),
    imported.bodies.map((b) => `${(b.itemPath ?? []).join('/')}/${b.name} ${b.color}`),
  );
});

void test('STEP export options: AP214 and inch units round-trip to the same millimetre geometry', async () => {
  const { evaluator } = await loadNodeKernel();
  const bytes = await evaluator.exportStep(twoBodyDocument(), ['body:e1'], {
    schema: 'AP214',
    unit: 'in',
  });
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /AUTOMOTIVE_DESIGN/);
  assert.match(text, /CONVERSION_BASED_UNIT\('INCH'/);
  assert.equal(parseStepStructure(text).lengthUnit, 'in');
  const reimported = await evaluator.evaluate([importFeature(bytes, 'cube-in.step')]);
  assert.deepEqual(reimported.errors, {});
  assert.equal(reimported.bodies.length, 1);
  assert.ok(
    near(reimported.bodies[0]!.volume, 1000, 1e-3),
    `volume ${reimported.bodies[0]!.volume}`,
  );
  assertBox(reimported.bodies[0]!, [0, 0, 0], [10, 10, 10], 'inch round trip');
});
