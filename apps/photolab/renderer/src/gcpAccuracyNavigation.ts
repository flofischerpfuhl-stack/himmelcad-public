export interface GcpObservationResidual {
  pointId: string;
  imageId: number;
  residualPixels: number | null | undefined;
}

/** Selects the first maximum residual, or the first observed image when samples are unavailable. */
export function selectWorstResidualImageForPoint(
  pointId: string,
  residuals: readonly GcpObservationResidual[],
  observedImageIds: readonly number[],
): number | null {
  let selectedImageId: number | null = null;
  let selectedResidual = Number.NEGATIVE_INFINITY;

  for (const residual of residuals) {
    if (
      residual.pointId !== pointId ||
      residual.residualPixels == null ||
      !Number.isFinite(residual.residualPixels) ||
      residual.residualPixels < 0
    ) {
      continue;
    }
    if (residual.residualPixels > selectedResidual) {
      selectedImageId = residual.imageId;
      selectedResidual = residual.residualPixels;
    }
  }

  return selectedImageId ?? observedImageIds[0] ?? null;
}
