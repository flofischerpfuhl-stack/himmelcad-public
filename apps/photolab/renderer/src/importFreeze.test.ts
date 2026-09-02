/**
 * Pure freeze-payload tests for the image import CRS workflow.
 * Run: pnpm --filter @himmelcad/photolab test
 *
 * `ImageImportPanel.tsx` is a React module (JSX plus CSS-module imports), so the
 * `node --experimental-strip-types --test` runner cannot load it. The freeze
 * helpers below are therefore a verbatim mirror of that file. The drift guard at
 * the end of this file compares the mirror against the panel source, so the
 * mirror can never silently diverge from the behaviour it claims to test.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

type GridKind = 'ntv2' | 'gtg' | 'geoid';
type HeightSource = 'unknown' | 'ellipsoidal' | 'orthometric' | 'deviceProfile';

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

// mirror-begin ImageImportPanel.tsx
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
  return {
    state: 'presentVerified',
    local_path: path,
  };
}

function defaultGridLicense(filename: string): {
  licenseName: string;
  source: string;
  redistributionAllowed: boolean;
} {
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

  // Path-only binding for freeze. Official CDN/catalog SHA pins must not ride along
  // when the user supplies a local NTv2/geoid (e.g. kanu_ntv2_schwaben.gsb) — the
  // sidecar re-hashes the file against that pin and rejects the import.
  const next: RequiredGrid = {
    kind,
    officialFilename: filename,
    license,
    coverage,
    availability: presentVerifiedAvailability(path, null),
  };
  return next;
}

function rewritePipelineGridToken(
  pipeline: string,
  fromFilename: string,
  toFilename: string,
): string {
  if (!fromFilename || !toFilename || fromFilename === toFilename) return pipeline;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match +grids=... tokens; swap exact basename occurrences.
  return pipeline
    .replace(/\+grids=([^\s]+)/g, (_full, list: string) => {
      const parts = list.split(',').map((part) => {
        const base = part.replace(/^.*[/\\]/, '');
        if (base === fromFilename || part === fromFilename) return toFilename;
        return part;
      });
      if (parts.join(',') === list && list.includes(fromFilename)) {
        return `+grids=${list.split(fromFilename).join(toFilename)}`;
      }
      return `+grids=${parts.join(',')}`;
    })
    .replace(new RegExp(escape(fromFilename), 'g'), toFilename);
}

function attachLocalGridsToOperation(
  operation: CrsOperationCandidate,
  verticalGrid: LocalGridSelection | null,
  horizontalGrid: LocalGridSelection | null,
  catalog: readonly GridCatalogEntry[],
  area: GeographicArea,
): CrsOperationCandidate {
  if (operation.requiredGrids.length === 0) return operation;
  let projPipeline = operation.projPipeline;
  const requiredGrids = operation.requiredGrids.map((grid) => {
    const vertical = isVerticalGridFilename(grid.officialFilename);
    const user = vertical ? verticalGrid : horizontalGrid;
    const next = normalizeRequiredGridForFreeze(grid, user, catalog, area);
    // Keep PROJ pipeline in sync when the user rebinds a different local file.
    // Otherwise freeze rediscovery cannot match +grids=<old> to +grids=<user>.
    if (
      user &&
      next.officialFilename &&
      grid.officialFilename &&
      next.officialFilename !== grid.officialFilename
    ) {
      projPipeline = rewritePipelineGridToken(
        projPipeline,
        grid.officialFilename,
        next.officialFilename,
      );
    }
    return next;
  });
  return {
    ...operation,
    projPipeline,
    requiredGrids,
  };
}

function heightReference(source: HeightSource, verticalEpsg: number): Record<string, unknown> {
  if (source === 'ellipsoidal') return { kind: 'ellipsoidal' };
  if (source === 'deviceProfile') {
    // Single key only (no profileId + profile_id dual).
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
// mirror-end ImageImportPanel.tsx

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

describe('mirror drift guard', () => {
  /** Comments and formatting are noise; only the executable text must agree. */
  const normalize = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1')
      .replace(/\bexport\s+function\b/g, 'function')
      .replace(/\s+/g, '');

  it('mirrors every freeze helper verbatim from ImageImportPanel.tsx', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const begin = self.indexOf('// mirror-begin ImageImportPanel.tsx');
    const end = self.indexOf('// mirror-end ImageImportPanel.tsx');
    assert.ok(begin > 0 && end > begin, 'the mirror markers must delimit the copied helpers');

    const mirrored = self
      .slice(begin, end)
      .split(/\n(?=function )/)
      .slice(1)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    assert.equal(mirrored.length, 9, 'expected nine mirrored freeze helpers');

    const panel = normalize(
      readFileSync(new URL('./ImageImportPanel.tsx', import.meta.url), 'utf8'),
    );
    for (const chunk of mirrored) {
      const name = /^function\s+([A-Za-z0-9_]+)/.exec(chunk)?.[1] ?? '(unnamed)';
      assert.ok(
        panel.includes(normalize(chunk)),
        `${name} drifted from ImageImportPanel.tsx — re-copy the helper into the mirror block`,
      );
    }
  });
});
