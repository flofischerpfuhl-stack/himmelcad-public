import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDemoDocument,
  type Feature,
  type ImportStepFeature,
} from '../../renderer/src/foundation/document/document.js';
import { circle, rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

void test('STEP export -> STEP import round trip: same body count, volume within 1e-6 relative', async () => {
  const { evaluator } = await loadNodeKernel();
  const original = await evaluator.evaluate(createDemoDocument());
  assert.deepEqual(original.errors, {});
  assert.equal(original.bodies.length, 1);
  const originalVolume = original.bodies[0]!.volume;

  const stepBytes = await evaluator.exportStep(createDemoDocument());
  assert.ok(stepBytes.byteLength > 0);
  // ISO-10303-21 STEP files are ASCII text starting with this header.
  const header = new TextDecoder().decode(stepBytes.subarray(0, 20));
  assert.match(header, /^ISO-10303-21;/);

  const importFeature: ImportStepFeature = {
    id: 'feature-import-1',
    name: 'Import 1',
    suppressed: false,
    kind: 'importStep',
    data: toBase64(stepBytes),
    fileName: 'bracket.step',
  };
  const reimported = await evaluator.evaluate([importFeature]);
  assert.deepEqual(reimported.errors, {});
  assert.equal(reimported.bodies.length, 1);
  const importedVolume = reimported.bodies[0]!.volume;
  const relativeError = Math.abs(importedVolume - originalVolume) / originalVolume;
  assert.ok(
    relativeError < 1e-6,
    `volume round trip: original ${originalVolume}, imported ${importedVolume}, relative error ${relativeError}`,
  );
  assert.equal(reimported.bodies[0]!.valid, true);
});

void test('STEP export can select a subset of bodies by id', async () => {
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
  const evaluated = await evaluator.evaluate(box);
  assert.equal(evaluated.bodies.length, 2);
  const oneBody = await evaluator.exportStep(box, ['body:e1']);
  const importFeature: ImportStepFeature = {
    id: 'feature-import-2',
    name: 'Import 1',
    suppressed: false,
    kind: 'importStep',
    data: toBase64(oneBody),
    fileName: 'cube.step',
  };
  const reimported = await evaluator.evaluate([importFeature]);
  assert.equal(reimported.bodies.length, 1);
});

void test('exportStep rejects when the document has an evaluation error', async () => {
  const { evaluator } = await loadNodeKernel();
  const broken: Feature[] = [
    {
      id: 'f1',
      name: 'Fillet 1',
      suppressed: false,
      kind: 'fillet',
      radius: 1,
      edges: [
        {
          bodyId: 'body:does-not-exist',
          key: 'x',
          signature: { curve: 'line', midpoint: [0, 0, 0], length: 1, direction: [1, 0, 0] },
        },
      ],
    },
  ];
  await assert.rejects(() => evaluator.exportStep(broken), /Cannot export/);
});
