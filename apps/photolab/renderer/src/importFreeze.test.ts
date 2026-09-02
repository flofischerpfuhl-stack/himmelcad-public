/**
 * Freeze-payload tests for the image import CRS workflow.
 * Run: pnpm --filter @himmelcad/photolab test
 *
 * The helpers under test live in `importFreeze.ts` — a plain module without JSX
 * or CSS-module imports — so the `node --experimental-strip-types --test`
 * runner loads the production code directly. `ImageImportPanel.tsx` imports the
 * very same functions, so there is nothing left that could drift.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachLocalGridsToOperation,
  defaultGridLicense,
  gridLocalPath,
  heightReference,
  isVerticalGridFilename,
  normalizeGridKind,
  presentVerifiedAvailability,
  rewritePipelineGridToken,
  type CrsOperationCandidate,
  type GeographicArea,
  type GridCatalogEntry,
  type LocalGridSelection,
  type RequiredGrid,
} from './importFreeze.js';

const AREA: GeographicArea = {
  westLongitude: 9,
  southLatitude: 48,
  eastLongitude: 10,
  northLatitude: 49,
};

function assertSingleKey(obj: Record<string, unknown>, a: string, b: string, label: string): void {
  const hasA = Object.prototype.hasOwnProperty.call(obj, a);
  const hasB = Object.prototype.hasOwnProperty.call(obj, b);
  assert.ok(!(hasA && hasB), `${label} must not dual-key ${a}+${b}`);
}

describe('normalizeGridKind', () => {
  it('maps classic NTv2 extension to ntv2 even when UI said gtg', () => {
    assert.equal(normalizeGridKind('gtg', 'kanu_ntv2_schwaben.gsb', false), 'ntv2');
    assert.equal(normalizeGridKind(undefined, 'foo.gsba', false), 'ntv2');
  });

  it('keeps geoid for vertical names', () => {
    assert.equal(normalizeGridKind('gtg', 'de_bkg_gcg2016.tif', true), 'geoid');
  });
});

describe('attachLocalGridsToOperation (freeze payload)', () => {
  const betaHash = '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2';

  const discoveryOp: CrsOperationCandidate = {
    operationId: 'proj:test',
    name: 'DHDN to ETRS',
    kind: 'gaussKruegerDatumTransformation',
    projPipeline: '+proj=pipeline +step +proj=hgridshift +grids=de_adv_BETA2007.tif',
    areaOfUse: AREA,
    ballpark: false,
    bestAvailable: true,
    requiredGrids: [
      {
        kind: 'gtg',
        officialFilename: 'de_adv_BETA2007.tif',
        officialSha256: betaHash,
        license: {
          licenseName: 'AdV',
          source: 'cdn.proj.org',
          redistributionAllowed: true,
        },
        coverage: AREA,
        availability: {
          state: 'presentVerified',
          local_path: '/proj/share/de_adv_BETA2007.tif',
          observed_sha256: betaHash,
        },
      },
    ],
  };

  const userGrid: LocalGridSelection = {
    filename: 'kanu_ntv2_schwaben.gsb',
    localPath: '/data/grids/kanu_ntv2_schwaben.gsb',
    kind: 'gtg', // mislabeled by GDAL
    driver: 'GTiff',
    coverage: AREA,
  };

  const userCatalog: GridCatalogEntry[] = [
    {
      kind: 'gtg',
      officialFilename: userGrid.filename,
      license: {
        licenseName: 'User',
        source: userGrid.localPath,
        redistributionAllowed: false,
      },
      coverage: AREA,
      localPath: userGrid.localPath,
    },
  ];

  it('replaces discovery grid with user NTv2 path and strips CDN hash', () => {
    const attached = attachLocalGridsToOperation(discoveryOp, null, userGrid, userCatalog, AREA);
    assert.equal(attached.requiredGrids.length, 1);
    const grid = attached.requiredGrids[0]!;
    assert.equal(grid.officialFilename, 'kanu_ntv2_schwaben.gsb');
    assert.equal(grid.kind, 'ntv2');
    assert.equal(grid.officialSha256, undefined);
    assert.equal(grid.availability.state, 'presentVerified');
    if (grid.availability.state === 'presentVerified') {
      assert.equal(grid.availability.local_path, userGrid.localPath);
      assert.equal(grid.availability.localPath, undefined);
      assert.equal(grid.availability.observed_sha256, undefined);
      assert.equal(grid.availability.observedSha256, undefined);
    }
  });

  it('rewrites the PROJ pipeline token when the user rebinds a different file', () => {
    const attached = attachLocalGridsToOperation(discoveryOp, null, userGrid, userCatalog, AREA);
    // Without this the frozen operation would still reference the discovery grid
    // and sidecar rediscovery could not match +grids=<old> to the user file.
    assert.equal(
      attached.projPipeline,
      '+proj=pipeline +step +proj=hgridshift +grids=kanu_ntv2_schwaben.gsb',
    );
  });

  it('keeps discovery path and pipeline when user did not re-pick', () => {
    const attached = attachLocalGridsToOperation(discoveryOp, null, null, [], AREA);
    const grid = attached.requiredGrids[0]!;
    assert.equal(grid.availability.state, 'presentVerified');
    if (grid.availability.state === 'presentVerified') {
      assert.equal(grid.availability.local_path, '/proj/share/de_adv_BETA2007.tif');
    }
    // Still strip hash so freeze cannot fail SHA on path-only rediscovery.
    assert.equal(grid.officialSha256, undefined);
    assert.equal(attached.projPipeline, discoveryOp.projPipeline);
  });

  it('routes vertical grids to the vertical selection only', () => {
    const geoidOp: CrsOperationCandidate = {
      ...discoveryOp,
      projPipeline: '+proj=pipeline +step +proj=vgridshift +grids=de_bkg_gcg2016.tif',
      requiredGrids: [
        {
          kind: 'gtg',
          officialFilename: 'de_bkg_gcg2016.tif',
          availability: { state: 'missing' },
        },
      ],
    };
    const vertical: LocalGridSelection = {
      filename: 'gcg2016_local.tif',
      localPath: '/data/grids/gcg2016_local.tif',
      kind: 'gtg',
      driver: 'GTiff',
      coverage: AREA,
    };
    const attached = attachLocalGridsToOperation(geoidOp, vertical, userGrid, [], AREA);
    const grid = attached.requiredGrids[0]!;
    assert.equal(grid.kind, 'geoid');
    assert.equal(grid.officialFilename, 'gcg2016_local.tif');
    assert.equal(attached.projPipeline.includes('+grids=gcg2016_local.tif'), true);
  });

  it('marks missing when no path can be resolved', () => {
    const op: CrsOperationCandidate = {
      ...discoveryOp,
      requiredGrids: [
        {
          kind: 'ntv2',
          officialFilename: 'missing.gsb',
          availability: { state: 'missing' },
        },
      ],
    };
    const attached = attachLocalGridsToOperation(op, null, null, [], AREA);
    assert.equal(attached.requiredGrids[0]!.availability.state, 'missing');
    assert.equal(attached.projPipeline, op.projPipeline);
  });
});

describe('heightReference freeze keys', () => {
  it('uses only snake_case field names (no dual keys)', () => {
    const orth = heightReference('orthometric', 7837);
    assertSingleKey(orth, 'verticalCrs', 'vertical_crs', 'orthometric');
    assert.ok(orth.vertical_crs);

    const device = heightReference('deviceProfile', 0);
    assertSingleKey(device, 'profileId', 'profile_id', 'deviceProfile');
    assert.ok(device.profile_id);
  });
});

describe('rewritePipelineGridToken', () => {
  it('swaps +grids= basename for any user file', () => {
    const next = rewritePipelineGridToken(
      '+proj=pipeline +step +proj=hgridshift +grids=de_adv_BETA2007.tif +step +proj=utm +zone=32',
      'de_adv_BETA2007.tif',
      'kanu_ntv2_schwaben.gsb',
    );
    assert.ok(next.includes('+grids=kanu_ntv2_schwaben.gsb'));
    assert.ok(!next.includes('de_adv_BETA2007.tif'));
  });

  it('swaps only the matching entry of a comma-separated grid list', () => {
    const next = rewritePipelineGridToken(
      '+proj=pipeline +step +proj=hgridshift +grids=/share/de_adv_BETA2007.tif,other.gsb',
      'de_adv_BETA2007.tif',
      'kanu_ntv2_schwaben.gsb',
    );
    assert.equal(next.includes('kanu_ntv2_schwaben.gsb,other.gsb'), true);
  });

  it('is a no-op for an unchanged or empty rebinding', () => {
    const pipeline = '+proj=pipeline +step +proj=hgridshift +grids=a.gsb';
    assert.equal(rewritePipelineGridToken(pipeline, 'a.gsb', 'a.gsb'), pipeline);
    assert.equal(rewritePipelineGridToken(pipeline, '', 'b.gsb'), pipeline);
  });
});

describe('workflow JSON round-trip shape', () => {
  it('stores operation grids without officialSha256', () => {
    const userPath = '/data/grids/kanu_ntv2_schwaben.gsb';
    const requiredGrids = [
      {
        kind: 'ntv2' as const,
        officialFilename: 'kanu_ntv2_schwaben.gsb',
        license: defaultGridLicense('kanu_ntv2_schwaben.gsb'),
        coverage: AREA,
        availability: { state: 'presentVerified' as const, local_path: userPath },
      },
    ];
    const json = JSON.stringify({
      schemaVersion: 1,
      kind: 'image',
      name: 'Schwaben',
      operation: { requiredGrids },
    });
    const parsed = JSON.parse(json) as {
      operation: { requiredGrids: RequiredGrid[] };
    };
    assert.equal(parsed.operation.requiredGrids[0]!.officialSha256, undefined);
    assert.equal(gridLocalPath(parsed.operation.requiredGrids[0]!), userPath);
  });
});

describe('grid availability helpers', () => {
  it('classifies vertical filenames and emits snake_case availability only', () => {
    assert.equal(isVerticalGridFilename('de_bkg_gcg2016.tif'), true);
    assert.equal(isVerticalGridFilename('kanu_ntv2_schwaben.gsb'), false);

    const pathOnly = presentVerifiedAvailability('/data/grids/a.gsb', null);
    assertSingleKey(pathOnly, 'localPath', 'local_path', 'presentVerified');
    assert.equal(pathOnly.local_path, '/data/grids/a.gsb');
    assert.equal(pathOnly.observed_sha256, undefined);

    const hashed = presentVerifiedAvailability('/data/grids/a.gsb', 'abc');
    assertSingleKey(hashed, 'observedSha256', 'observed_sha256', 'presentVerified');
    assert.equal(hashed.observed_sha256, 'abc');

    assert.deepEqual(defaultGridLicense('a.gsb'), {
      licenseName: 'User or bundled PROJ grid',
      source: 'a.gsb',
      redistributionAllowed: false,
    });
  });
});
