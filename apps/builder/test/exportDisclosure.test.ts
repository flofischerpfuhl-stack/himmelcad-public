import assert from 'node:assert/strict';
import test from 'node:test';

import { exportDisclosureRows } from '../renderer/src/exportDisclosure.js';

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
