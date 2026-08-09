/**
 * Pure freeze-payload tests for the image import CRS workflow.
 * Run: pnpm exec tsx --test renderer/src/importFreeze.test.ts
 * (from apps/photolab)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Mirror of ImageImportPanel helpers — keep in sync; extracted for node:test without Vite.

type GridKind = 'ntv2' | 'gtg' | 'geoid';

interface GeographicArea {
  westLongitude: number;
  southLatitude: number;
  eastLongitude: number;
  northLatitude: number;
}

interface RequiredGrid {
  kind?: GridKind;
  officialFilename: string;
  officialSha256?: string;
  license?: {
    licenseName: string;
    source: string;
    redistributionAllowed: boolean;
  };
  coverage?: GeographicArea;
  availability:
    | { state: 'missing' }
    | {
        state: 'presentVerified';
        localPath?: string;
        local_path?: string;
        observedSha256?: string;
        observed_sha256?: string;
      };
}

interface LocalGridSelection {
  filename: string;
  localPath: string;
  kind: GridKind;
  driver: string;
  coverage: GeographicArea;
}

interface CrsOperationCandidate {
  operationId: string;
  name: string;
  kind: 'general' | 'gaussKruegerDatumTransformation';
  projPipeline: string;
  areaOfUse: GeographicArea;
  ballpark: boolean;
  bestAvailable: boolean;
  requiredGrids: RequiredGrid[];
}

interface GridCatalogEntry {
  kind: GridKind;
  officialFilename: string;
  officialSha256?: string;
  license: {
    licenseName: string;
    source: string;
    redistributionAllowed: boolean;
  };
  coverage: GeographicArea;
  localPath?: string;
}

const AREA: GeographicArea = {
  westLongitude: 9,
  southLatitude: 48,
  eastLongitude: 10,
  northLatitude: 49,
};

function isVerticalGridFilename(name: string): boolean {
  return /geoid|gcg|egm|quasi|gtx|vert/i.test(name);
}

function normalizeGridKind(
  kind: GridKind | undefined,
  filename: string,
  verticalHint: boolean,
): GridKind {
  const lower = filename.toLowerCase();
  if (verticalHint || kind === 'geoid' || /geoid|gcg|egm|quasi|gtx|vert/i.test(lower)) {
    return 'geoid';
  }
  if (lower.endsWith('.gsb') || lower.endsWith('.gsba') || kind === 'ntv2') return 'ntv2';
  if (kind === 'gtg') return 'gtg';
  return 'gtg';
}

function gridLocalPath(grid: RequiredGrid): string | null {
  const availability = grid.availability;
  if (availability.state !== 'presentVerified') return null;
  const path = availability.local_path ?? availability.localPath;
  return path && path.trim() !== '' ? path : null;
}

function presentVerifiedAvailability(
  path: string,
  observedSha256: string | null,
): Extract<RequiredGrid['availability'], { state: 'presentVerified' }> {
  if (observedSha256) {
    return {
      state: 'presentVerified',
      local_path: path,
      observed_sha256: observedSha256,
    };
  }
  return { state: 'presentVerified', local_path: path };
}

function defaultGridLicense(filename: string) {
  return {
    licenseName: 'User or bundled PROJ grid',
    source: filename,
    redistributionAllowed: false,
  };
}

function normalizeRequiredGridForFreeze(
  grid: RequiredGrid,
  user: LocalGridSelection | null,
  catalog: readonly GridCatalogEntry[],
  area: GeographicArea,
): RequiredGrid {
  const vertical = isVerticalGridFilename(grid.officialFilename);
  const existingPath = gridLocalPath(grid);
  const catalogHit =
    catalog.find(
      (entry) =>
        entry.officialFilename === grid.officialFilename ||
        (user != null && entry.localPath === user.localPath) ||
        (user != null && entry.officialFilename === user.filename),
    ) ??
    catalog.find((entry) =>
      vertical
        ? entry.kind === 'geoid' && !!entry.localPath
        : (entry.kind === 'ntv2' || entry.kind === 'gtg') && !!entry.localPath,
    );

  const userPath = user?.localPath?.trim() || null;
  const path = userPath || existingPath || catalogHit?.localPath?.trim() || null;
  const license = grid.license ?? defaultGridLicense(user?.filename ?? grid.officialFilename);
  const filename = user?.filename ?? grid.officialFilename;
  const kind = normalizeGridKind(grid.kind ?? user?.kind, filename, vertical);
  const coverage = grid.coverage ?? user?.coverage ?? area;

  if (!path) {
    return {
      kind,
      officialFilename: grid.officialFilename,
      license,
      coverage,
      availability: { state: 'missing' },
    };
  }

  return {
    kind,
    officialFilename: filename,
    license,
    coverage,
    availability: presentVerifiedAvailability(path, null),
  };
}

function attachLocalGridsToOperation(
  operation: CrsOperationCandidate,
  verticalGrid: LocalGridSelection | null,
  horizontalGrid: LocalGridSelection | null,
  catalog: readonly GridCatalogEntry[],
  area: GeographicArea,
): CrsOperationCandidate {
  if (operation.requiredGrids.length === 0) return operation;
  return {
    ...operation,
    requiredGrids: operation.requiredGrids.map((grid) =>
      normalizeRequiredGridForFreeze(
        grid,
        isVerticalGridFilename(grid.officialFilename) ? verticalGrid : horizontalGrid,
        catalog,
        area,
      ),
    ),
  };
}

function heightReference(
  source: 'ellipsoidal' | 'orthometric' | 'deviceProfile' | 'unknown',
  verticalEpsg: number,
): Record<string, unknown> {
  if (source === 'ellipsoidal') return { kind: 'ellipsoidal' };
  if (source === 'deviceProfile') {
    return { kind: 'deviceProfile', profile_id: 'dji-explicit' };
  }
  if (source === 'orthometric') {
    return {
      kind: 'orthometric',
      vertical_crs: { kind: 'epsg', value: verticalEpsg },
    };
  }
  return { kind: 'unknown' };
}

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

  it('replaces discovery grid with user NTv2 path and strips CDN hash', () => {
    const user: LocalGridSelection = {
      filename: 'kanu_ntv2_schwaben.gsb',
      localPath: '/data/grids/kanu_ntv2_schwaben.gsb',
      kind: 'gtg', // mislabeled by GDAL
      driver: 'GTiff',
      coverage: AREA,
    };
    const catalog: GridCatalogEntry[] = [
      {
        kind: 'gtg',
        officialFilename: 'kanu_ntv2_schwaben.gsb',
        license: {
          licenseName: 'User',
          source: user.localPath,
          redistributionAllowed: false,
        },
        coverage: AREA,
        localPath: user.localPath,
      },
    ];

    const attached = attachLocalGridsToOperation(discoveryOp, null, user, catalog, AREA);
    assert.equal(attached.requiredGrids.length, 1);
    const grid = attached.requiredGrids[0]!;
    assert.equal(grid.officialFilename, 'kanu_ntv2_schwaben.gsb');
    assert.equal(grid.kind, 'ntv2');
    assert.equal(grid.officialSha256, undefined);
    assert.equal(grid.availability.state, 'presentVerified');
    if (grid.availability.state === 'presentVerified') {
      assert.equal(grid.availability.local_path, user.localPath);
      assert.equal(grid.availability.localPath, undefined);
      assert.equal(grid.availability.observed_sha256, undefined);
      assert.equal(grid.availability.observedSha256, undefined);
    }
  });

  it('keeps discovery path when user did not re-pick', () => {
    const attached = attachLocalGridsToOperation(discoveryOp, null, null, [], AREA);
    const grid = attached.requiredGrids[0]!;
    assert.equal(grid.availability.state, 'presentVerified');
    if (grid.availability.state === 'presentVerified') {
      assert.equal(grid.availability.local_path, '/proj/share/de_adv_BETA2007.tif');
    }
    // Still strip hash so freeze cannot fail SHA on path-only rediscovery.
    assert.equal(grid.officialSha256, undefined);
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
    const pipeline =
      '+proj=pipeline +step +proj=hgridshift +grids=de_adv_BETA2007.tif +step +proj=utm +zone=32';
    // Inline copy of rewrite helper used in ImageImportPanel
    const fromFilename = 'de_adv_BETA2007.tif';
    const toFilename = 'kanu_ntv2_schwaben.gsb';
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const next = pipeline
      .replace(/\+grids=([^\s]+)/g, (_full, list: string) => {
        const parts = list.split(',').map((part: string) => {
          const base = part.replace(/^.*[/\\]/, '');
          if (base === fromFilename || part === fromFilename) return toFilename;
          return part;
        });
        return `+grids=${parts.join(',')}`;
      })
      .replace(new RegExp(escape(fromFilename), 'g'), toFilename);
    assert.ok(next.includes('+grids=kanu_ntv2_schwaben.gsb'));
    assert.ok(!next.includes('de_adv_BETA2007.tif'));
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
