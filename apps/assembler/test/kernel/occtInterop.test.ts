/**
 * Exchange formats that only the HimmelCAD OCCT build (`vendor/occt-wasm`,
 * `HIMMELCAD_OCCT=himmelcad`) provides, on the real kernel:
 *
 * - STEP assemblies through `STEPCAFControl_Reader` (XCAF): same parts,
 *   names, colours, folders, placements and face order as the text-parser
 *   route (so a project replays to the same bodies on either module), and
 *   non-ASCII names;
 * - IGES export and import (surfaces sewn into solids), units converted.
 *
 * On the default replicad build these tests are skipped, and the ones at
 * the end check that IGES fails with "not in this build" instead.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as R from 'replicad';

import { selectedOcctModule } from '../../headless/occtModule.js';
import { readStepAssembly } from '../../renderer/src/kernel/stepImport.js';
import type { Body } from '../../renderer/src/kernel/types.js';
import type { Feature, ImportStepFeature } from '../../renderer/src/model/document.js';
import { circle, rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const himmelcad = selectedOcctModule() === 'himmelcad';
const skip = !himmelcad && 'needs the HimmelCAD OCCT build (HIMMELCAD_OCCT=himmelcad)';
const skipOnHimmelcad = himmelcad && 'the HimmelCAD OCCT build has IGES';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../../../../../test/fixtures/interop');
const robot = readFileSync(join(FIXTURES, 'robot-assembly.step'));

function importFeature(
  bytes: Uint8Array,
  fileName: string,
  id: string,
  format?: 'iges',
): ImportStepFeature {
  return {
    id,
    name: 'Import 1',
    suppressed: false,
    kind: 'importStep',
    data: Buffer.from(bytes).toString('base64'),
    fileName,
    ...(format ? { format } : { structure: 'assembly' as const }),
  };
}

function document(): Feature[] {
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
  ];
}

function summary(bodies: readonly Body[]): string[] {
  return bodies.map(
    (b) =>
      `${(b.itemPath ?? []).join('/')}/${b.name} ${b.color} faces=${b.faces.length} vol=${b.volume.toFixed(4)} ` +
      `${b.min.map((v) => v.toFixed(3)).join(',')}..${b.max.map((v) => v.toFixed(3)).join(',')}`,
  );
}

void test(
  'STEP via XCAF gives the same parts as the text route (names, colours, folders, placements, faces)',
  { skip },
  async () => {
    const { oc } = await loadNodeKernel();
    const xcaf = readStepAssembly(oc, robot, 'robot-assembly.step');
    const text = readStepAssembly(oc, robot, 'robot-assembly.step', undefined, { reader: 'text' });
    try {
      assert.equal(xcaf.reader, 'xcaf');
      assert.equal(text.reader, 'text');
      assert.deepEqual(xcaf.warnings, []);
      const describe = (parts: typeof xcaf.parts) =>
        parts.map((p) => {
          const box = p.shape.boundingBox;
          return [
            p.path.join('/'),
            p.name,
            p.color,
            p.shape.faces.length,
            R.measureVolume(p.shape).toFixed(4),
            box.bounds
              .flat()
              .map((v) => v.toFixed(3))
              .join(','),
          ].join(' ');
        });
      assert.deepEqual(describe(xcaf.parts), describe(text.parts));
      assert.deepEqual(
        xcaf.parts.map((p) => `${p.path.join('/')}/${p.name} ${p.color}`),
        [
          'Robot/Base plate #FF0000',
          'Robot/Arm/Link #0000FF',
          'Robot/Arm/Pin #33AA55',
          'Robot/Arm (2)/Link #0000FF',
          'Robot/Arm (2)/Pin #33AA55',
        ],
      );
    } finally {
      for (const p of [...xcaf.parts, ...text.parts]) p.shape.delete();
    }
  },
);

void test(
  'STEP via XCAF keeps non-ASCII names and exact colours (export → import)',
  { skip },
  async () => {
    const { evaluator, oc } = await loadNodeKernel();
    const doc: Feature[] = [
      ...document(),
      {
        id: 'c1',
        name: 'Colour',
        suppressed: false,
        kind: 'setAppearance',
        bodyId: 'body:e2',
        color: '#9AAE9B',
      },
    ];
    const bytes = await evaluator.exportStep(doc, undefined, {
      names: { 'body:e1': 'Grundplatte Größe 1', 'body:e2': 'Scheibe ø10' },
      assembly: {
        name: 'Baugruppe Ä',
        children: [
          { bodyId: 'body:e1' },
          { name: 'Runde Teile', children: [{ bodyId: 'body:e2' }] },
        ],
      },
    });
    const direct = readStepAssembly(oc, bytes, 'kit.step');
    try {
      assert.equal(direct.reader, 'xcaf');
    } finally {
      for (const p of direct.parts) p.shape.delete();
    }
    const result = await evaluator.evaluate([importFeature(bytes, 'kit.step', 'imp-u')]);
    assert.deepEqual(result.errors, {});
    assert.deepEqual(
      result.bodies.map((b) => [b.name, b.color, (b.itemPath ?? []).join('/')]),
      [
        ['Grundplatte Größe 1', '#B8BCC2', 'Baugruppe Ä'],
        ['Scheibe ø10', '#9AAE9B', 'Baugruppe Ä/Runde Teile'],
      ],
    );
    assert.ok(Math.abs(result.bodies[1]!.volume - Math.PI * 25 * 4) < 1e-4);
  },
);

void test(
  'IGES export → import (faces and MSBO solids, inches): same solids in millimetres',
  { skip },
  async () => {
    const { evaluator } = await loadNodeKernel();
    const doc = document();
    const source = (await evaluator.evaluate(doc)).bodies;
    for (const mode of ['faces', 'brep'] as const) {
      const bytes = await evaluator.exportIges!(doc, undefined, { mode, unit: 'in' });
      const text = new TextDecoder('latin1').decode(bytes);
      assert.match(text, /^ {72}S0000001$/m, `${mode}: IGES start section`);
      assert.match(text, /,1\.,1,4HINCH,/, `${mode}: unit flag 1 (inch) in the global section`);
      const back = await evaluator.evaluate([
        importFeature(bytes, 'kit.igs', `imp-${mode}`, 'iges'),
      ]);
      assert.deepEqual(back.errors, {}, mode);
      assert.deepEqual(back.warnings, {}, `${mode}: every shell closed into a solid`);
      assert.deepEqual(
        back.bodies.map((b) => b.name),
        ['kit 1', 'kit 2'],
      );
      assert.ok(
        back.bodies.every((b) => b.valid),
        `${mode}: valid`,
      );
      back.bodies.forEach((b, i) => {
        const want = source[i]!;
        assert.ok(
          Math.abs(b.volume - want.volume) < 1e-3 * want.volume,
          `${mode}: volume ${b.volume}`,
        );
        assert.ok(
          b.min.every((v, k) => Math.abs(v - want.min[k]!) < 1e-3) &&
            b.max.every((v, k) => Math.abs(v - want.max[k]!) < 1e-3),
          `${mode}: placement ${summary([b])[0]} vs ${summary([want])[0]}`,
        );
        assert.equal(b.faces.length, want.faces.length, `${mode}: faces`);
      });
    }
  },
);

void test(
  'a file that is not IGES fails the import step with a readable error',
  { skip },
  async () => {
    const { evaluator } = await loadNodeKernel();
    const result = await evaluator.evaluate([
      importFeature(new TextEncoder().encode('solid x\nendsolid x\n'), 'x.igs', 'imp-bad', 'iges'),
    ]);
    assert.match(
      result.errors['imp-bad'] ?? '',
      /IGES import failed: This is not a readable IGES file/,
    );
  },
);

void test(
  'replicad OCCT build (HIMMELCAD_OCCT=replicad): IGES import and export say "not in this build"',
  { skip: skipOnHimmelcad },
  async () => {
    const { evaluator } = await loadNodeKernel();
    const result = await evaluator.evaluate([
      importFeature(new TextEncoder().encode('x'), 'x.igs', 'imp-none', 'iges'),
    ]);
    assert.match(result.errors['imp-none'] ?? '', /IGES is not in this build/);
    await assert.rejects(evaluator.exportIges!(document()), /IGES is not in this build/);
    // The STEP import still reads the structure (text route).
    const { oc } = await loadNodeKernel();
    const read = readStepAssembly(oc, robot, 'robot-assembly.step');
    try {
      assert.equal(read.reader, 'text');
      assert.equal(read.parts.length, 5);
    } finally {
      for (const p of read.parts) p.shape.delete();
    }
  },
);
