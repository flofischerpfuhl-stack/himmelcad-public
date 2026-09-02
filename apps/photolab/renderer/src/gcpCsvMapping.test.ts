import assert from 'node:assert/strict';
import test from 'node:test';

import { detectGcpColumns, uncertaintyOriginLabel } from './gcpCsvMapping.js';

test('detects common, axis-specific and description headers case-insensitively', () => {
  assert.deepEqual(
    detectGcpColumns(['Point-ID', 'EASTING', 'Northing', 'Elevation', 'dE', 'D_N', 'dH', 'Desc']),
    {
      name: 'Point-ID',
      east: 'EASTING',
      north: 'Northing',
      height: 'Elevation',
      eastStddev: 'dE',
      northStddev: 'D_N',
      heightStddev: 'dH',
      code: 'Desc',
    },
  );
});

test('detects shared horizontal and vertical sigma headers with either separator style', () => {
  assert.deepEqual(detectGcpColumns(['Name', 'X', 'Y', 'Z', 'σ-H', 's_v', 'CODE']), {
    name: 'Name',
    east: 'X',
    north: 'Y',
    height: 'Z',
    horizontalStddev: 'σ-H',
    heightStddev: 's_v',
    code: 'CODE',
  });
  assert.equal(detectGcpColumns(['name', 'x', 'y', 'z', 'STD']).horizontalStddev, 'STD');
  assert.equal(detectGcpColumns(['name', 'x', 'y', 'z', 'sigma']).horizontalStddev, 'sigma');
});

test('prefers an east/north pair over an additional shared horizontal column', () => {
  assert.deepEqual(detectGcpColumns(['name', 'e', 'n', 'h', 'sigma', 'sE', 'sN']), {
    name: 'name',
    east: 'e',
    north: 'n',
    height: 'h',
    eastStddev: 'sE',
    northStddev: 'sN',
  });
});

test('labels parsed, fallback and partially populated uncertainty rows', () => {
  assert.equal(
    uncertaintyOriginLabel({
      eastUsedDefault: false,
      northUsedDefault: false,
      heightUsedDefault: false,
    }),
    'parsed σ',
  );
  assert.equal(
    uncertaintyOriginLabel({
      eastUsedDefault: true,
      northUsedDefault: true,
      heightUsedDefault: true,
    }),
    'default σ',
  );
  assert.equal(
    uncertaintyOriginLabel({
      eastUsedDefault: false,
      northUsedDefault: true,
      heightUsedDefault: false,
    }),
    'mixed σ',
  );
});
