import type {
  CrsOperationCandidate,
  CrsOperationDiscovery,
  CrsOperationQuery,
  GridCatalogEntry,
  ImageImportDecision,
  LocalGridSelection,
} from './ImageImportPanel.js';

const BETA2007: GridCatalogEntry = {
  kind: 'gtg',
  officialFilename: 'de_adv_BETA2007.tif',
  officialSha256: '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2',
  license: {
    licenseName: 'AdV free redistribution notice',
    source: 'https://cdn.proj.org/de_adv_README.txt',
    redistributionAllowed: true,
  },
  coverage: {
    westLongitude: 5.416666666666667,
    southLatitude: 46.95,
    eastLongitude: 15.75,
    northLatitude: 55.35,
  },
};

const GCG2016: GridCatalogEntry = {
  kind: 'geoid',
  officialFilename: 'de_bkg_gcg2016.tif',
  officialSha256: '598f18324dea7f8e72421d18add7ac6228259adf91eeb335cc9c27d98484f7ac',
  license: {
    licenseName: 'Creative Commons Attribution 4.0',
    spdxExpression: 'CC-BY-4.0',
    source: 'https://cdn.proj.org/de_bkg_README.txt',
    redistributionAllowed: true,
  },
  coverage: {
    westLongitude: 3.25625,
    southLatitude: 47.2208333,
    eastLongitude: 15.11875,
    northLatitude: 55.9791667,
  },
};

export interface GcpDecisionInput {
  sourceHorizontalEpsg: number;
  targetHorizontalEpsg: number;
  sourceVerticalEpsg: number;
  targetVerticalEpsg: number;
  transformHorizontal: boolean;
  transformHeight: boolean;
  areaOfInterest: CrsOperationQuery['areaOfInterest'];
  verticalGrid: LocalGridSelection | null;
  horizontalGrid: LocalGridSelection | null;
}

export function buildGcpOperationQuery(input: GcpDecisionInput): CrsOperationQuery {
  const sourceHorizontal = input.transformHorizontal
    ? input.sourceHorizontalEpsg
    : input.targetHorizontalEpsg;
  const source = input.transformHeight
    ? compoundHeightCrs(sourceHorizontal, input.sourceVerticalEpsg)
    : { kind: 'epsg' as const, value: sourceHorizontal };
  const target = input.transformHeight
    ? compoundHeightCrs(input.targetHorizontalEpsg, input.targetVerticalEpsg)
    : { kind: 'epsg' as const, value: input.targetHorizontalEpsg };
  const gridCatalog: GridCatalogEntry[] = [];
  if (input.horizontalGrid) gridCatalog.push(userGrid(input.horizontalGrid));
  else if (isGaussKrueger(input.sourceHorizontalEpsg) || isGaussKrueger(input.targetHorizontalEpsg))
    gridCatalog.push(BETA2007);
  if (input.transformHeight) {
    if (input.verticalGrid) gridCatalog.push(userGrid(input.verticalGrid));
    else if (input.sourceVerticalEpsg === 7837 || input.targetVerticalEpsg === 7837)
      gridCatalog.push(GCG2016);
  }
  return {
    source: { crs: source },
    target: { crs: target },
    areaOfInterest: input.areaOfInterest,
    selectionPolicy: { allowBallpark: false, onlyBest: false },
    gridCatalog: [...new Map(gridCatalog.map((grid) => [grid.officialFilename, grid])).values()],
  };
}

export function buildGcpImportDecision(
  query: CrsOperationQuery,
  operation: CrsOperationCandidate,
  discovery: CrsOperationDiscovery,
  sourceVerticalEpsg: number,
  targetVerticalEpsg: number,
  transformHeight: boolean,
): ImageImportDecision {
  const sourceHeight = gcpHeightReference(sourceVerticalEpsg);
  return {
    schemaVersion: 1,
    containsGpsData: false,
    horizontal: { source: query.source, target: query.target },
    vertical: transformHeight
      ? {
          source: sourceHeight,
          target: gcpHeightReference(targetVerticalEpsg),
          mode: 'transform',
        }
      : { source: sourceHeight, target: sourceHeight, mode: 'preserveValues' },
    areaOfInterest: query.areaOfInterest,
    operation: { ...operation, bestAvailable: true },
    selectionPolicy: { allowBallpark: false, onlyBest: false },
    databaseVersions: discovery.audit.versions,
  };
}

export function isGcpOperationReady(
  identityImport: boolean,
  transformHeight: boolean,
  discoveryMatchesQuery: boolean,
  operation: CrsOperationCandidate | null,
  areaOfInterest: CrsOperationQuery['areaOfInterest'],
): boolean {
  return (
    identityImport ||
    (discoveryMatchesQuery &&
      operation != null &&
      !operation.ballpark &&
      (!transformHeight || operation.projPipeline.includes('+proj=vgridshift')) &&
      containsArea(operation.areaOfUse, areaOfInterest) &&
      operation.requiredGrids.every(
        (grid) =>
          grid.availability.state === 'presentVerified' &&
          grid.coverage != null &&
          containsArea(grid.coverage, areaOfInterest),
      ))
  );
}

export function gcpHeightReference(epsg: number): Record<string, unknown> {
  if (epsg === 4979) return { kind: 'ellipsoidal' };
  if (epsg === 99999) {
    return { kind: 'deviceProfile', profile_id: 'Local / relative height' };
  }
  return {
    kind: 'normalHeight',
    vertical_crs: { kind: 'epsg', value: epsg },
  };
}

function compoundHeightCrs(horizontalEpsg: number, verticalEpsg: number) {
  return verticalEpsg === 4979
    ? ({ kind: 'epsg', value: horizontalEpsg } as const)
    : ({ kind: 'authority', value: `EPSG:${horizontalEpsg}+${verticalEpsg}` } as const);
}

function userGrid(selection: LocalGridSelection): GridCatalogEntry {
  return {
    kind: selection.kind,
    officialFilename: selection.filename,
    license: {
      licenseName: 'User-supplied local grid',
      source: selection.localPath,
      redistributionAllowed: false,
    },
    coverage: selection.coverage,
    localPath: selection.localPath,
  };
}

function isGaussKrueger(epsg: number): boolean {
  return epsg >= 31466 && epsg <= 31469;
}

function containsArea(
  coverage: CrsOperationQuery['areaOfInterest'],
  area: CrsOperationQuery['areaOfInterest'],
): boolean {
  return (
    coverage.westLongitude <= area.westLongitude &&
    coverage.southLatitude <= area.southLatitude &&
    coverage.eastLongitude >= area.eastLongitude &&
    coverage.northLatitude >= area.northLatitude
  );
}
