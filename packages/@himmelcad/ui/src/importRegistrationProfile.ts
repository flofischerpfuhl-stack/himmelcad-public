export type RegistrationMethodId =
  | 'sourceCoordinates'
  | 'originAndProjectNorth'
  | 'manualPlacement'
  | 'pointPairs'
  | 'icp';

export interface ImportRegistrationFormatContext {
  readonly formatId: string;
  readonly displayName: string;
  readonly confidence: number;
}

export type ImportRegistrationFamily =
  | 'pointCloud'
  | 'bim'
  | 'cad'
  | 'civil'
  | 'georeferencedRaster'
  | 'sceneLayer'
  | 'gaussianSplat'
  | 'generic3d';

export interface ImportRegistrationProfile {
  readonly family: ImportRegistrationFamily;
  readonly label: string;
  readonly summary: string;
  readonly methods: readonly RegistrationMethodId[];
  readonly recommendedMethod: RegistrationMethodId;
  readonly pointPicking: boolean;
  readonly specialCapabilities: readonly string[];
}

/** Maps canonical format IDs to product-neutral registration affordances. */
export function importRegistrationProfile(formatId: string): ImportRegistrationProfile {
  if (matches(formatId, ['las@', 'laz@', 'e57@'])) {
    return {
      family: 'pointCloud',
      label: 'Point cloud',
      summary:
        'Keep surveyed coordinates or georeference the cloud from fresh source/project point pairs.',
      methods: allMethods,
      recommendedMethod: 'pointPairs',
      pointPicking: true,
      specialCapabilities: [
        'Point picking in source and project views',
        'Bounded prepared source samples',
        'Optional ICP after a coarse placement',
      ],
    };
  }
  if (formatId.startsWith('hcad.format.ifc')) {
    return {
      family: 'bim',
      label: 'BIM model',
      summary:
        'Preserve IFC product placement, then place the model by coordinates, project north or geometry picks.',
      methods: [
        'sourceCoordinates',
        'originAndProjectNorth',
        'manualPlacement',
        'pointPairs',
        'icp',
      ],
      recommendedMethod: 'originAndProjectNorth',
      pointPicking: true,
      specialCapabilities: [
        'IFC placement stays immutable',
        'Project-north bearing',
        'Geometry point pairs',
      ],
    };
  }
  if (matches(formatId, ['dxf@', 'dwg@'])) {
    return {
      family: 'cad',
      label: 'CAD drawing',
      summary:
        'Use declared drawing coordinates or place local CAD geometry from an origin and bearing.',
      methods: ['sourceCoordinates', 'originAndProjectNorth', 'manualPlacement', 'pointPairs'],
      recommendedMethod: 'originAndProjectNorth',
      pointPicking: true,
      specialCapabilities: ['CAD vertex and edge picks', 'Explicit origin and project north'],
    };
  }
  if (formatId.startsWith('landxml@')) {
    return {
      family: 'civil',
      label: 'Civil model',
      summary:
        'Retain declared LandXML coordinates; no silent unit, scale or CRS correction is applied.',
      methods: ['sourceCoordinates', 'originAndProjectNorth', 'manualPlacement', 'pointPairs'],
      recommendedMethod: 'sourceCoordinates',
      pointPicking: true,
      specialCapabilities: ['Declared civil coordinates', 'Surface and alignment picks'],
    };
  }
  if (formatId.startsWith('geotiff@')) {
    return {
      family: 'georeferencedRaster',
      label: 'Georeferenced raster',
      summary:
        'Prefer embedded GeoTIFF mapping. HimmelCAD never reprojects or rescales it silently.',
      methods: ['sourceCoordinates', 'manualPlacement', 'pointPairs'],
      recommendedMethod: 'sourceCoordinates',
      pointPicking: true,
      specialCapabilities: ['Embedded raster mapping', 'Raster sample point pairs'],
    };
  }
  if (formatId.startsWith('slpk-')) {
    return {
      family: 'sceneLayer',
      label: 'Scene layer',
      summary: 'Keep the I3S placement or review a coarse manual/point-pair registration.',
      methods: ['sourceCoordinates', 'manualPlacement', 'pointPairs', 'icp'],
      recommendedMethod: 'sourceCoordinates',
      pointPicking: true,
      specialCapabilities: ['Streamed hierarchy', 'Prepared mesh picks', 'Optional surface ICP'],
    };
  }
  if (formatId.startsWith('gaussian-splat-ply@')) {
    return {
      family: 'gaussianSplat',
      label: 'Gaussian splat scene',
      summary: 'Review source placement before admitting the streamed splat hierarchy.',
      methods: ['sourceCoordinates', 'manualPlacement', 'pointPairs'],
      recommendedMethod: 'sourceCoordinates',
      pointPicking: true,
      specialCapabilities: [
        'Streamed splat preview',
        'Point-pair placement when picks are available',
      ],
    };
  }
  return {
    family: 'generic3d',
    label: '3D dataset',
    summary: 'Review the source placement and commit it as one canonical import transaction.',
    methods: ['sourceCoordinates', 'originAndProjectNorth', 'manualPlacement', 'pointPairs'],
    recommendedMethod: 'sourceCoordinates',
    pointPicking: true,
    specialCapabilities: ['Canonical preview', 'Manual or point-pair placement'],
  };
}

function matches(formatId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => formatId.startsWith(prefix));
}

const allMethods = [
  'sourceCoordinates',
  'originAndProjectNorth',
  'manualPlacement',
  'pointPairs',
  'icp',
] as const;
