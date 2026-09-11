import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exportDisclosureRows,
  landXmlProjectUnitDefault,
} from '../renderer/src/exportDisclosure.js';

test('DXF plan-loss disclosure accounts for measurement and cloud omissions exactly', () => {
  const losses = [
    'hcad.loss.dxf.canonical-identity@1',
    'hcad.loss.dxf.entity-omitted@1',
    'hcad.loss.dxf.mesh-entity-partition@1',
  ] as const;
  const rows = exportDisclosureRows(
    [{ kind: 'Surface' }, { kind: 'Object', label: 'Measurement' }, { kind: 'PointCloud' }],
    'dxf',
    losses,
  );

  assert.deepEqual(
    rows.map((row) => [row.entityKind, row.writtenAs]),
    [
      ['Surface', '3DFACE + breaklines'],
      ['Measurement', 'not written'],
      ['Point Cloud', 'not written'],
    ],
  );
  assert.deepEqual(
    new Set(rows.flatMap((row) => row.lossCodes ?? [])),
    new Set(losses),
    'the UI must disclose every provider plan loss and no invented code',
  );
});

test('LandXML unit defaults use declared project truth and refuse ambiguity', () => {
  assert.equal(landXmlProjectUnitDefault([{ sourceCrs: 'EPSG:25832', sourceUnits: 'm' }]), 'meter');
  assert.equal(
    landXmlProjectUnitDefault([
      {
        sourceCrs: 'PROJCRS["State Plane",LENGTHUNIT["US survey foot",0.304800609601219]]',
        sourceUnits: 'US survey ft',
      },
    ]),
    'USSurveyFoot',
  );
  assert.equal(landXmlProjectUnitDefault([{ sourceCrs: null, sourceUnits: 'ft' }]), 'foot');
  assert.equal(
    landXmlProjectUnitDefault([
      { sourceCrs: 'EPSG:25832', sourceUnits: 'm' },
      { sourceCrs: null, sourceUnits: 'ft' },
    ]),
    null,
  );
  assert.equal(landXmlProjectUnitDefault([{ sourceCrs: null, sourceUnits: null }]), null);
});
