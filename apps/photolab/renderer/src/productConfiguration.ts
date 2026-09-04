import type { EntityId, ObjectHash } from '@himmelcad/data';

export interface DemGroundParameters {
  cellSizeM: number;
  slope: number;
  maxWindowM: number;
  initialDistanceM: number;
}

export const DEFAULT_DEM_GROUND_PARAMETERS: Readonly<DemGroundParameters> = {
  // About 2–5 times typical UAV GSD balances samples per cell and structure detail.
  cellSizeM: 1.0,
  // A 15% terrain tolerance retains common surveyed ramps and embankments.
  slope: 0.15,
  // Eighteen metres removes typical buildings without a city-scale kernel.
  maxWindowM: 18.0,
  // Half a metre tolerates dense-cloud noise and low vegetation near terrain.
  initialDistanceM: 0.5,
};

export function validDemGroundParameters(parameters: DemGroundParameters): boolean {
  return (
    Number.isFinite(parameters.cellSizeM) &&
    parameters.cellSizeM > 0 &&
    Number.isFinite(parameters.slope) &&
    parameters.slope > 0 &&
    parameters.slope <= 1 &&
    Number.isFinite(parameters.maxWindowM) &&
    parameters.maxWindowM >= parameters.cellSizeM &&
    Number.isFinite(parameters.initialDistanceM) &&
    parameters.initialDistanceM >= 0
  );
}

export type ProductOperation = 'depth' | 'dense' | 'dem' | 'ortho' | 'mesh' | 'splat';

export type ProductRunConfiguration =
  | {
      kind: 'depth';
      imageDownscale: 1 | 2 | 4 | 8;
      filter: 'mild' | 'moderate' | 'aggressive';
      reuseCompatibleMaps: boolean;
    }
  | {
      kind: 'dense';
      imageDownscale: 1 | 2 | 4 | 8;
      minimumViews: number;
      retainConfidence: boolean;
      calculateColors: boolean;
    }
  | {
      kind: 'dem';
      surface: 'dsm' | 'dtm';
      resolutionMetersPerPixel: number;
      interpolateNodata: boolean;
      tileSizePixels: 512;
      cellSizeM: number;
      slope: number;
      maxWindowM: number;
      initialDistanceM: number;
    }
  | {
      kind: 'ortho';
      resolutionMetersPerPixel: number;
      blendMode: 'mosaic' | 'average' | 'disabled';
      colorCorrection: boolean;
      fillHoles: boolean;
      tileSizePixels: 512;
      sourceDemEntityId?: EntityId;
      sourceDemVersionSha256?: ObjectHash;
    }
  | {
      kind: 'mesh';
      meshSource: 'dem' | 'dense';
      targetFaceCount: number;
      interpolateHoles: boolean;
      buildTexture: boolean;
      textureSize: 2048 | 4096 | 8192 | 16384;
      sourceDemEntityId?: EntityId;
    }
  | {
      kind: 'splat';
      initialization: 'sparseTiePoints';
      iterations: number;
      sphericalHarmonicsDegree: 0 | 1 | 2 | 3;
      maximumSplats: number;
      maximumResolution: number;
      retainTrainingCheckpoints: boolean;
    };

export function defaultProductConfiguration(operation: ProductOperation): ProductRunConfiguration {
  if (operation === 'depth') {
    return { kind: 'depth', imageDownscale: 2, filter: 'moderate', reuseCompatibleMaps: true };
  }
  if (operation === 'dense') {
    return {
      kind: 'dense',
      imageDownscale: 2,
      minimumViews: 3,
      retainConfidence: true,
      calculateColors: true,
    };
  }
  if (operation === 'dem') {
    return {
      kind: 'dem',
      surface: 'dsm',
      resolutionMetersPerPixel: 0.05,
      interpolateNodata: false,
      tileSizePixels: 512,
      ...DEFAULT_DEM_GROUND_PARAMETERS,
    };
  }
  if (operation === 'ortho') {
    return {
      kind: 'ortho',
      resolutionMetersPerPixel: 0.03,
      blendMode: 'mosaic',
      colorCorrection: true,
      fillHoles: false,
      tileSizePixels: 512,
    };
  }
  if (operation === 'mesh') {
    return {
      kind: 'mesh',
      meshSource: 'dem',
      targetFaceCount: 5_000_000,
      interpolateHoles: false,
      buildTexture: true,
      textureSize: 8192,
    };
  }
  return {
    kind: 'splat',
    initialization: 'sparseTiePoints',
    iterations: 30_000,
    sphericalHarmonicsDegree: 3,
    maximumSplats: 10_000_000,
    maximumResolution: 1_920,
    retainTrainingCheckpoints: true,
  };
}

export function validProductConfiguration(configuration: ProductRunConfiguration): boolean {
  if (configuration.kind === 'dem') {
    return (
      Number.isFinite(configuration.resolutionMetersPerPixel) &&
      configuration.resolutionMetersPerPixel > 0 &&
      (configuration.surface === 'dsm' || validDemGroundParameters(configuration))
    );
  }
  if (configuration.kind === 'ortho') {
    return (
      Number.isFinite(configuration.resolutionMetersPerPixel) &&
      configuration.resolutionMetersPerPixel > 0
    );
  }
  if (configuration.kind === 'dense') return configuration.minimumViews >= 2;
  if (configuration.kind === 'mesh') {
    return (
      (configuration.meshSource === 'dem' || configuration.meshSource === 'dense') &&
      configuration.targetFaceCount >= 10_000
    );
  }
  if (configuration.kind === 'splat') {
    return (
      configuration.iterations >= 1_000 &&
      configuration.maximumSplats >= 100_000 &&
      configuration.maximumResolution >= 256
    );
  }
  return true;
}
