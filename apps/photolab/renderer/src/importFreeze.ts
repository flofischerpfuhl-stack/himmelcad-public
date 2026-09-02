/**
 * Pure freeze helpers for the CRS import wizards.
 *
 * These helpers turn a PROJ discovery result plus the user's local grid picks
 * into the exact payload the sidecar freezes. They are deliberately free of
 * React, CSS modules and DOM access so the `node --experimental-strip-types
 * --test` runner can load them directly (see `importFreeze.test.ts`).
 */

export type GridKind = 'ntv2' | 'gtg' | 'geoid';
export type HeightSource = 'unknown' | 'ellipsoidal' | 'orthometric' | 'deviceProfile';

export interface GeographicArea {
  westLongitude: number;
  southLatitude: number;
  eastLongitude: number;
  northLatitude: number;
}

export interface RequiredGrid {
  kind?: GridKind;
  officialFilename: string;
  officialSha256?: string;
  license?: {
    licenseName: string;
    spdxExpression?: string;
    source: string;
    redistributionAllowed: boolean;
  };
  coverage?: GeographicArea;
  availability:
    | { state: 'missing' }
    | {
        state: 'presentVerified';
        /** Prefer camelCase; always also set local_path for older sidecars. */
        localPath?: string;
        local_path?: string;
        observedSha256?: string;
        observed_sha256?: string;
      };
}

export interface CrsOperationCandidate {
  operationId: string;
  name: string;
  kind: 'general' | 'gaussKruegerDatumTransformation';
  projPipeline: string;
  areaOfUse: GeographicArea;
  expectedAccuracyMm?: number;
  ballpark: boolean;
  bestAvailable: boolean;
  requiredGrids: RequiredGrid[];
}

export interface GridCatalogEntry {
  kind: GridKind;
  officialFilename: string;
  officialSha256?: string;
  license: {
    licenseName: string;
    spdxExpression?: string;
    source: string;
    redistributionAllowed: boolean;
  };
  coverage: GeographicArea;
  localPath?: string;
}

export interface LocalGridSelection {
  filename: string;
  localPath: string;
  kind: GridKind;
  driver: string;
  coverage: GeographicArea;
  /** Preferred when resolving saved workflows. */
  absolutePath?: string;
  /** Fallback relative to project / last cwd. */
  relativePath?: string;
}

export function isVerticalGridFilename(name: string): boolean {
  return /geoid|gcg|egm|quasi|gtx|vert/i.test(name);
}

/**
 * Ensure every required grid has a concrete local path for freeze.
 *
 * Paths (priority): user pick (also if set earlier, not re-picked) → discovery → catalog.
 * Always emit snake_case `local_path` — old sidecars ignore camelCase on tagged enums.
 */
export function attachLocalGridsToOperation(
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

/** Replace +grids= old name (basename) with the user file basename. */
export function rewritePipelineGridToken(
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

export function normalizeRequiredGridForFreeze(
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

/** GDAL often reports .gsb as a generic raster → UI stores "gtg"; PROJ wants ntv2. */
export function normalizeGridKind(
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

/**
 * Tagged-enum fields must use a single name. Dual keys (localPath + local_path)
 * make serde alias builds fail with "duplicate field".
 * snake_case matches the Rust field name (works without rename; with alias too).
 */
export function presentVerifiedAvailability(
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

export function gridLocalPath(grid: RequiredGrid): string | null {
  const availability = grid.availability;
  if (availability.state !== 'presentVerified') return null;
  const path = availability.local_path ?? availability.localPath;
  return path && path.trim() !== '' ? path : null;
}

export function defaultGridLicense(filename: string): {
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

export function heightReference(
  source: HeightSource,
  verticalEpsg: number,
): Record<string, unknown> {
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
