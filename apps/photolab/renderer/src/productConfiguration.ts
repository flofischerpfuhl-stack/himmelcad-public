import type { EntityId, ObjectHash } from '@himmelcad/data';

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
