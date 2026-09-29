import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDocument, type Feature } from '../../renderer/src/model/document.js';
import { buildThreeMf } from '../../renderer/src/kernel/threeMf.js';
import { loadNodeKernel } from './nodeKernel.js';

/**
 * Minimal store-only ZIP reader, test-only: finds the end-of-central-directory
 * record, walks the central directory and returns each entry's bytes
 * (assumes method 0 / store, as `zipWriter.ts` always writes). Verifies the
 * package this app writes can be parsed back — not a general unzip.
 */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'end-of-central-directory record found');
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'central directory signature');
    const compressionMethod = view.getUint16(offset + 10, true);
    assert.equal(compressionMethod, 0, 'store method (uncompressed)');
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const dataStart = localHeaderOffset + 30 + localNameLength;
    entries.set(name, bytes.subarray(dataStart, dataStart + compressedSize));

    offset += 46 + nameLength;
  }
  return entries;
}

void test('3MF package: content types, root relationship, model XML unit and object count', async () => {
  const { evaluator } = await loadNodeKernel();
  const box: Feature[] = [
    {
      id: 's1',
      name: 'Sketch 1',
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [
        { kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
        { kind: 'circle', cx: 40, cy: 10, radius: 5 },
      ],
    },
    {
      id: 'e1',
      name: 'Cube',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's1', profileIndex: 0 },
      distance: 10,
      symmetric: false,
      operation: 'new',
      resultBodyName: 'Cube',
    },
    {
      id: 'e2',
      name: 'Cylinder',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's1', profileIndex: 1 },
      distance: 10,
      symmetric: false,
      operation: 'new',
      resultBodyName: 'Cylinder',
    },
  ];
  const result = await evaluator.evaluate(box);
  assert.equal(result.bodies.length, 2);

  const zipBytes = buildThreeMf(result.bodies);
  const entries = readZip(zipBytes);

  assert.ok(entries.has('[Content_Types].xml'));
  const contentTypes = new TextDecoder().decode(entries.get('[Content_Types].xml')!);
  assert.match(contentTypes, /3dmanufacturing-3dmodel\+xml/);

  assert.ok(entries.has('_rels/.rels'));
  const rels = new TextDecoder().decode(entries.get('_rels/.rels')!);
  assert.match(rels, /Target="\/3D\/3dmodel\.model"/);

  assert.ok(entries.has('3D/3dmodel.model'));
  const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
  assert.match(model, /unit="millimeter"/);
  const objectCount = (model.match(/<object /g) ?? []).length;
  assert.equal(objectCount, 2);
  const itemCount = (model.match(/<item /g) ?? []).length;
  assert.equal(itemCount, 2);
  // Base materials carry the body colours (displaycolor), referenced by pid/pindex.
  assert.match(model, /<m:basematerials id="1">/);
  const materialCount = (model.match(/<m:base /g) ?? []).length;
  assert.equal(materialCount, 2);
  assert.match(model, /pid="1" pindex="0"/);
  assert.match(model, /pid="1" pindex="1"/);

  // Every triangle vertex index is in range for its object's own vertex list.
  const vertexCounts = [...model.matchAll(/<object[^>]*>[\s\S]*?<\/mesh>/g)].map((objectMatch) => {
    const vertices = (objectMatch[0].match(/<vertex /g) ?? []).length;
    const maxIndex = Math.max(
      ...[...objectMatch[0].matchAll(/v[123]="(\d+)"/g)].map((m) => Number(m[1])),
    );
    return { vertices, maxIndex };
  });
  for (const { vertices, maxIndex } of vertexCounts) {
    assert.ok(maxIndex < vertices, `triangle index ${maxIndex} in range for ${vertices} vertices`);
  }
});

void test('3MF export of the demo bracket produces one object and a parseable package', async () => {
  const { evaluator } = await loadNodeKernel();
  const result = await evaluator.evaluate(createDemoDocument());
  const zipBytes = buildThreeMf(result.bodies);
  const entries = readZip(zipBytes);
  const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
  assert.equal((model.match(/<object /g) ?? []).length, 1);
  assert.match(model, /name="Bracket"/);
});

void test('buildThreeMf throws for an empty body list', () => {
  assert.throws(() => buildThreeMf([]), /Nothing to export/);
});
