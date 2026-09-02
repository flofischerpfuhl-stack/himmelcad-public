import type {
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  EntityId,
  MergedAlignmentRunRecord,
  ProcessingSetRecord,
  ProjectCameraImageRecord,
  ProjectSnapshot,
} from '@himmelcad/data';

import styles from './ImagePropertiesPanel.module.css';
import { humanizeEnum } from './photolabFormatting.js';

export function SelectionPropertiesPanel({
  project,
  selectedIds,
  images,
  processingSets,
  captureGroups,
  calibrationGroups,
  alignmentMerges,
}: {
  project: ProjectSnapshot;
  selectedIds: readonly EntityId[];
  images: readonly ProjectCameraImageRecord[];
  processingSets: readonly ProcessingSetRecord[];
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
  alignmentMerges: readonly MergedAlignmentRunRecord[];
}): JSX.Element {
  const entities = selectedIds.flatMap((id) =>
    project.entities[id] ? [project.entities[id]] : [],
  );
  const selectedSet = new Set(selectedIds);
  const selectedImages = images.filter((image) => selectedSet.has(image.entityId));
  const sharedTags =
    selectedImages.length > 0
      ? selectedImages[0]!.metadata.statusTags.filter((tag) =>
          selectedImages.every((image) => image.metadata.statusTags.includes(tag)),
        )
      : [];
  const camera = commonValue(
    selectedImages.map((image) => {
      const exif = image.metadata.inspectedPhoto.metadata.exif;
      return [exif.make, exif.model].filter(Boolean).join(' ') || '—';
    }),
  );
  const dimensions = commonValue(
    selectedImages.map((image) => {
      const value = image.metadata.inspectedPhoto.metadata.exif.dimensions;
      return value ? `${value.widthPixels} × ${value.heightPixels} px` : '—';
    }),
  );
  const singleId = selectedIds.length === 1 ? selectedIds[0] : undefined;
  const processingSet = processingSets.find((record) => record.entityId === singleId);
  const captureGroup = captureGroups.find((record) => record.entityId === singleId);
  const calibrationGroup = calibrationGroups.find((record) => record.entityId === singleId);
  const alignmentMerge = alignmentMerges.find((record) => record.entityId === singleId);

  return (
    <div className={styles.root}>
      <section>
        <h3>Selection</h3>
        <Row label="Count" value={String(entities.length)} />
        <Row
          label="Type"
          value={commonValue(entities.map((entity) => humanizeEnum(entity.kind)))}
        />
        <Row
          label="Parent"
          value={commonValue(
            entities.map((entity) =>
              entity.parent ? (project.entities[entity.parent]?.name ?? entity.parent) : '—',
            ),
          )}
        />
        <Row
          label="Visibility"
          value={commonValue(
            entities.map((entity) => (entity.visibility.visible ? 'Visible' : 'Hidden')),
          )}
        />
        <Row
          label="Locked"
          value={commonValue(
            entities.map((entity) => (entity.visibility.locked ? 'Locked' : 'Unlocked')),
          )}
        />
      </section>
      {selectedImages.length > 0 && (
        <section>
          <h3>Shared image attributes</h3>
          <Row label="Images" value={`${selectedImages.length} of ${entities.length}`} />
          <Row label="Camera" value={camera} />
          <Row label="Dimensions" value={dimensions} />
          <div className={styles.tags}>
            {sharedTags.length > 0 ? (
              sharedTags.map((tag) => <span key={tag}>{humanizeEnum(tag)}</span>)
            ) : (
              <span>No shared tags</span>
            )}
          </div>
        </section>
      )}
      {processingSet && (
        <section>
          <h3>Processing scope</h3>
          <Row label="Images" value={String(processingSet.cameraEntityIds.length)} />
          <Row label="Image IDs" value={processingSet.cameraEntityIds.join(', ')} />
          <Row label="Capture groups" value={String(processingSet.captureGroupIds?.length ?? 0)} />
          <Row
            label="Calibration groups"
            value={String(processingSet.calibrationGroupIds?.length ?? 0)}
          />
          <Row label="Membership" value={processingSet.membershipSha256} />
        </section>
      )}
      {captureGroup && (
        <section>
          <h3>Capture lineage</h3>
          <Row label="Images" value={String(captureGroup.cameraEntityIds.length)} />
          <Row
            label="Grouping"
            value={captureGroup.automatic ? 'Automatically detected' : 'User defined'}
          />
          <Row label="Review" value={humanizeEnum(captureGroup.reviewStatus ?? 'confirmed')} />
          <Row label="Image IDs" value={captureGroup.cameraEntityIds.join(', ')} />
          <Row label="Calibration groups" value={String(captureGroup.calibrationGroupIds.length)} />
          <Row label="Membership" value={captureGroup.membershipSha256} />
        </section>
      )}
      {calibrationGroup && (
        <section>
          <h3>Calibration lineage</h3>
          <Row
            label="Capture group"
            value={
              captureGroups.find((record) => record.entityId === calibrationGroup.captureGroupId)
                ?.name ?? calibrationGroup.captureGroupId
            }
          />
          <Row label="Images" value={String(calibrationGroup.cameraEntityIds.length)} />
          <Row label="Image IDs" value={calibrationGroup.cameraEntityIds.join(', ')} />
          <Row label="Grouping" value={humanizeEnum(calibrationGroup.groupingBasis)} />
          <Row label="Review" value={humanizeEnum(calibrationGroup.reviewStatus ?? 'confirmed')} />
          <Row label="Membership" value={calibrationGroup.membershipSha256} />
        </section>
      )}
      {alignmentMerge && (
        <section>
          <h3>Merged alignment lineage</h3>
          <Row label="State" value={humanizeEnum(alignmentMerge.state)} />
          <Row label="Input alignments" value={alignmentMerge.inputAlignmentEntityIds.join(', ')} />
          <Row
            label="GCP optimizations"
            value={alignmentMerge.inputGcpOptimizationEntityIds.join(', ') || 'None'}
          />
          <Row label="Connections" value={String(alignmentMerge.connections.length)} />
          <Row label="Images" value={String(alignmentMerge.cameraEntityIds.length)} />
          <Row label="Image IDs" value={alignmentMerge.cameraEntityIds.join(', ')} />
          <Row label="Lineage" value={alignmentMerge.lineageSha256} />
          <Row label="Dataset" value={alignmentMerge.datasetRelativePath ?? 'Not published'} />
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function commonValue(values: readonly string[]): string {
  if (values.length === 0) return '—';
  return values.every((value) => value === values[0]) ? values[0]! : 'Mixed';
}
