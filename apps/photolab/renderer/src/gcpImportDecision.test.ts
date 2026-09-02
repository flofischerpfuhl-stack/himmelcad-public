import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CrsOperationCandidate,
  CrsOperationDiscovery,
  LocalGridSelection,
} from './ImageImportPanel.js';
import {
  buildGcpImportDecision,
  buildGcpOperationQuery,
  isGcpOperationReady,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './gcpImportDecision.ts';

const area = {
  westLongitude: 11.49,
  southLatitude: 47.99,
  eastLongitude: 11.51,
  northLatitude: 48.01,
};

function candidate(state: 'missing' | 'presentVerified'): CrsOperationCandidate {
  return {
    operationId: 'proj:frozen-height',
    name: 'DHHN2016 to ellipsoidal height',
    kind: 'general',
    projPipeline:
      '+proj=pipeline +step +inv +proj=utm +zone=32 +ellps=GRS80 +step +proj=vgridshift +grids=GCG2016_SU.tif +multiplier=1 +step +proj=utm +zone=32 +ellps=GRS80',
    areaOfUse: area,
    ballpark: false,
    bestAvailable: true,
    requiredGrids: [
      {
        kind: 'geoid',
        officialFilename: 'GCG2016_SU.tif',
        license: {
          licenseName: 'Fixture',
          source: 'fixture',
          redistributionAllowed: false,
        },
        coverage: area,
        availability:
          state === 'missing'
            ? { state: 'missing' }
            : { state: 'presentVerified', localPath: '/fixtures/GCG2016_SU.tif' },
      },
    ],
  };
}

const discovery: CrsOperationDiscovery = {
  candidates: [],
  audit: { versions: { projVersion: '9.4.0', epsgDatabaseVersion: 'v11.004' } },
  warnings: [],
};

describe('GCP height decisions', () => {
  it('builds a compound DHHN2016-to-ellipsoidal query and transform decision', () => {
    const verticalGrid: LocalGridSelection = {
      filename: 'GCG2016_SU.tif',
      localPath: '/fixtures/GCG2016_SU.tif',
      kind: 'geoid',
      driver: 'GTiff',
      coverage: area,
    };
    const query = buildGcpOperationQuery({
      sourceHorizontalEpsg: 25832,
      targetHorizontalEpsg: 25832,
      sourceVerticalEpsg: 7837,
      targetVerticalEpsg: 4979,
      transformHorizontal: false,
      transformHeight: true,
      areaOfInterest: area,
      verticalGrid,
      horizontalGrid: null,
    });
    assert.deepEqual(query.source.crs, {
      kind: 'authority',
      value: 'EPSG:25832+7837',
    });
    assert.deepEqual(query.target.crs, { kind: 'epsg', value: 25832 });
    assert.equal(query.gridCatalog[0]?.kind, 'geoid');
    const decision = buildGcpImportDecision(
      query,
      candidate('presentVerified'),
      discovery,
      7837,
      4979,
      true,
    );
    assert.equal(decision.vertical.mode, 'transform');
    assert.deepEqual(decision.vertical.source, {
      kind: 'normalHeight',
      vertical_crs: { kind: 'epsg', value: 7837 },
    });
    assert.deepEqual(decision.vertical.target, { kind: 'ellipsoidal' });
  });

  it('preserves values while retaining the declared vertical CRS', () => {
    const query = buildGcpOperationQuery({
      sourceHorizontalEpsg: 25832,
      targetHorizontalEpsg: 25832,
      sourceVerticalEpsg: 7837,
      targetVerticalEpsg: 4979,
      transformHorizontal: false,
      transformHeight: false,
      areaOfInterest: area,
      verticalGrid: null,
      horizontalGrid: null,
    });
    const decision = buildGcpImportDecision(
      query,
      candidate('presentVerified'),
      discovery,
      7837,
      4979,
      false,
    );
    assert.equal(decision.vertical.mode, 'preserveValues');
    assert.deepEqual(decision.vertical.target, decision.vertical.source);
    assert.deepEqual(decision.vertical.source, {
      kind: 'normalHeight',
      vertical_crs: { kind: 'epsg', value: 7837 },
    });
  });

  it('blocks an operation whose required geoid is missing', () => {
    assert.equal(isGcpOperationReady(false, true, true, candidate('missing'), area), false);
    assert.equal(isGcpOperationReady(false, true, true, candidate('presentVerified'), area), true);
    assert.equal(
      isGcpOperationReady(false, true, true, candidate('presentVerified'), {
        ...area,
        eastLongitude: 12,
      }),
      false,
    );
    assert.equal(
      isGcpOperationReady(
        false,
        true,
        true,
        { ...candidate('presentVerified'), projPipeline: '+proj=noop' },
        area,
      ),
      false,
    );
  });
});
