import type { CameraCalibrationGroupingBasis, EntityId } from '@himmelcad/data';

export interface CaptureCalibrationDraft {
  name: string;
  cameraEntityIds: readonly EntityId[];
  groupingBasis: CameraCalibrationGroupingBasis;
}

/** Freezes the visible assignment table into an ordered, exact calibration partition. */
export function buildCaptureCalibrationDrafts(
  cameras: readonly { entityId: EntityId }[],
  names: readonly string[],
  assignments: Readonly<Record<EntityId, number>>,
): readonly CaptureCalibrationDraft[] {
  return names.map((name, index) => ({
    name: name.trim() || `Autofocus ${index + 1}`,
    cameraEntityIds: cameras
      .filter((camera) => (assignments[camera.entityId] ?? 0) === index)
      .map((camera) => camera.entityId),
    groupingBasis: 'missionAutofocus',
  }));
}
