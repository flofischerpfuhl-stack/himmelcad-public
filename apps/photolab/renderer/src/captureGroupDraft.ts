import type {
  CameraCalibrationGroupingBasis,
  CameraCalibrationSeed,
  EntityId,
  GcpIntrinsicsPolicy,
} from '@himmelcad/data';

export interface CaptureCalibrationDraft {
  name: string;
  cameraEntityIds: readonly EntityId[];
  groupingBasis: CameraCalibrationGroupingBasis;
  initialCalibration?: CameraCalibrationSeed;
  intrinsicsPolicy?: GcpIntrinsicsPolicy;
}

/** Freezes the visible assignment table into an ordered, exact calibration partition. */
export function buildCaptureCalibrationDrafts(
  cameras: readonly { entityId: EntityId }[],
  names: readonly string[],
  assignments: Readonly<Record<EntityId, number>>,
): readonly CaptureCalibrationDraft[] {
  return names.map((name, index) => ({
    name: name.trim() || `Calibration group ${index + 1}`,
    cameraEntityIds: cameras
      .filter((camera) => (assignments[camera.entityId] ?? 0) === index)
      .map((camera) => camera.entityId),
    groupingBasis: 'manual',
  }));
}
