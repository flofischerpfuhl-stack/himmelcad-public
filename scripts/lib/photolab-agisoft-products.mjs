/**
 * Frozen PhotoLab parameters corresponding to Metashape High depth maps.
 *
 * Metashape records `BuildDepthMaps/downscale=2`, mild filtering and at most
 * 16 neighbours in the Sulzberg dense-cloud metadata. Dense fusion consumes
 * those same maps; it must not rerun a lower-resolution or stricter depth job
 * merely to approach the reference point count.
 */
export const AGISOFT_HIGH_DEPTH_CONTRACT = Object.freeze({
  imageDownscale: 2,
  filter: 'mild',
  maximumNeighbors: 16,
  minimumViews: 2,
  effectiveMaximumImageDimension: 2_640,
  minimumConfidence: 0.2,
  geometricRelativeTolerance: 0.025,
});

/** Returns the frozen comparable depth or dense configuration. */
export function agisoftGoldenMvsConfiguration(kind) {
  if (kind === 'depth') {
    return {
      kind: 'depth',
      imageDownscale: AGISOFT_HIGH_DEPTH_CONTRACT.imageDownscale,
      filter: AGISOFT_HIGH_DEPTH_CONTRACT.filter,
      maximumNeighbors: AGISOFT_HIGH_DEPTH_CONTRACT.maximumNeighbors,
      reuseCompatibleMaps: true,
    };
  }
  if (kind === 'dense') {
    return {
      kind: 'dense',
      imageDownscale: AGISOFT_HIGH_DEPTH_CONTRACT.imageDownscale,
      filter: AGISOFT_HIGH_DEPTH_CONTRACT.filter,
      maximumNeighbors: AGISOFT_HIGH_DEPTH_CONTRACT.maximumNeighbors,
      minimumViews: AGISOFT_HIGH_DEPTH_CONTRACT.minimumViews,
      retainConfidence: true,
      calculateColors: true,
    };
  }
  throw new Error(`Agisoft golden MVS configuration does not support ${kind}`);
}
