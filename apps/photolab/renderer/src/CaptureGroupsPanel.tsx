import type {
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  EntityId,
  GcpIntrinsicParameterMask,
  GcpIntrinsicsGroupDiagnostics,
  GcpIntrinsicsPolicy,
} from '@himmelcad/data';
import { Select } from '@himmelcad/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import styles from './CaptureGroupsPanel.module.css';
import {
  buildCaptureCalibrationDrafts,
  type CaptureCalibrationDraft,
} from './captureGroupDraft.js';

export function CaptureGroupsPanel({
  captureGroups,
  calibrationGroups,
  projectCameras,
  selectedCameras,
  busy,
  onCreate,
  onConfirm,
  onUseAsAlignmentScope,
  intrinsicsDiagnostics,
  onUpdateIntrinsics,
}: {
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
  projectCameras: readonly { entityId: EntityId; name: string }[];
  selectedCameras: readonly { entityId: EntityId; name: string }[];
  busy: boolean;
  onCreate: (
    name: string,
    cameraIds: readonly EntityId[],
    calibrationGroups: readonly CaptureCalibrationDraft[],
  ) => void;
  onConfirm: (captureGroupId: EntityId) => void;
  onUseAsAlignmentScope: (captureGroup: CaptureGroupRecord) => void;
  intrinsicsDiagnostics: readonly GcpIntrinsicsGroupDiagnostics[];
  onUpdateIntrinsics: (calibrationGroupId: EntityId, policy: GcpIntrinsicsPolicy) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [calibrationNames, setCalibrationNames] = useState<readonly string[]>([
    'Calibration group 1',
  ]);
  const [assignments, setAssignments] = useState<Readonly<Record<EntityId, number>>>({});
  const selectionKey = selectedCameras.map((camera) => camera.entityId).join('\u0000');
  useEffect(() => {
    const selectedIds = selectionKey.split('\u0000').filter(Boolean) as EntityId[];
    setAssignments(
      (current) =>
        Object.fromEntries(
          selectedIds.map((entityId) => [entityId, current[entityId] ?? 0]),
        ) as Readonly<Record<EntityId, number>>,
    );
  }, [selectionKey]);
  const calibrationDrafts = useMemo(
    () => buildCaptureCalibrationDrafts(selectedCameras, calibrationNames, assignments),
    [assignments, calibrationNames, selectedCameras],
  );
  const cameraNameById = useMemo(
    () => new Map(projectCameras.map((camera) => [camera.entityId, camera.name])),
    [projectCameras],
  );
  const partitionComplete =
    calibrationDrafts.length > 0 &&
    calibrationDrafts.every((group) => group.cameraEntityIds.length);
  return (
    <div className={styles.root}>
      <section className={styles.create}>
        <div className={styles.sectionTitle}>New capture group</div>
        <label>
          <span>Name</span>
          <input
            value={name}
            placeholder={`Mission ${captureGroups.length + 1}`}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <div className={styles.selection}>{selectedCameras.length} selected images</div>
        <div className={styles.calibrationEditor}>
          <div className={styles.editorHeader}>
            <span>Calibration groups</span>
            <button
              type="button"
              className={styles.iconButton}
              title="Add another autofocus or lens session"
              onClick={() =>
                setCalibrationNames((current) => [
                  ...current,
                  `Calibration group ${current.length + 1}`,
                ])
              }
            >
              <Plus size={13} /> Add split
            </button>
          </div>
          {calibrationNames.map((calibrationName, index) => (
            <div className={styles.calibrationName} key={`calibration-${index}`}>
              <input
                aria-label={`Calibration group ${index + 1} name`}
                value={calibrationName}
                onChange={(event) =>
                  setCalibrationNames((current) =>
                    current.map((value, currentIndex) =>
                      currentIndex === index ? event.currentTarget.value : value,
                    ),
                  )
                }
              />
              <span>{calibrationDrafts[index]?.cameraEntityIds.length ?? 0} images</span>
              {calibrationNames.length > 1 && (
                <button
                  type="button"
                  className={styles.removeButton}
                  title="Remove calibration group"
                  onClick={() => {
                    setCalibrationNames((current) => current.filter((_, value) => value !== index));
                    setAssignments((current) =>
                      Object.fromEntries(
                        Object.entries(current).map(([entityId, value]) => [
                          entityId,
                          value === index ? 0 : value > index ? value - 1 : value,
                        ]),
                      ),
                    );
                  }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
          {calibrationNames.length > 1 && (
            <div className={styles.cameraAssignments}>
              {selectedCameras.map((camera) => (
                <label key={camera.entityId}>
                  <span title={camera.name}>{camera.name}</span>
                  <Select
                    value={assignments[camera.entityId] ?? 0}
                    onChange={(event) =>
                      setAssignments((current) => ({
                        ...current,
                        [camera.entityId]: Number(event.currentTarget.value),
                      }))
                    }
                  >
                    {calibrationNames.map((calibrationName, index) => (
                      <option key={`assignment-${index}`} value={index}>
                        {calibrationName || `Calibration group ${index + 1}`}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={busy || selectedCameras.length < 2 || !partitionComplete}
          onClick={() => {
            onCreate(
              name.trim() || `Mission ${captureGroups.length + 1}`,
              selectedCameras.map((camera) => camera.entityId),
              calibrationDrafts,
            );
            setName('');
          }}
        >
          {busy ? 'Creating…' : 'Create from selection'}
        </button>
      </section>
      <section className={styles.groups}>
        <div className={styles.sectionTitle}>Intrinsics sharing plan</div>
        {captureGroups.length === 0 ? (
          <p>No groups are available yet. Imported images remain independent until grouped.</p>
        ) : (
          captureGroups.map((capture) => (
            <article key={capture.entityId}>
              <div className={styles.groupHeading}>
                <strong>{capture.name}</strong>
                <span>{capture.cameraEntityIds.length} images</span>
              </div>
              <div className={styles.reviewRow}>
                <span
                  className={
                    capture.reviewStatus === 'needsReview' ? styles.needsReview : undefined
                  }
                >
                  {capture.automatic ? 'Automatically detected' : 'User defined'} ·{' '}
                  {capture.reviewStatus === 'needsReview' ? 'review required' : 'confirmed'}
                </span>
                <div className={styles.groupActions}>
                  <button
                    type="button"
                    disabled={busy || capture.reviewStatus === 'needsReview'}
                    title={
                      capture.reviewStatus === 'needsReview'
                        ? 'Confirm or replace the detected intrinsics partition first'
                        : 'Create or reuse an immutable processing set for this mission'
                    }
                    onClick={() => onUseAsAlignmentScope(capture)}
                  >
                    Use mission as processing set
                  </button>
                  {capture.reviewStatus === 'needsReview' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onConfirm(capture.entityId)}
                    >
                      Confirm grouping
                    </button>
                  )}
                </div>
              </div>
              {capture.evidence?.map((item) => (
                <small key={item}>{item}</small>
              ))}
              {calibrationGroups
                .filter((calibration) => calibration.captureGroupId === capture.entityId)
                .map((calibration) => (
                  <div className={styles.calibration} key={calibration.entityId}>
                    <span>{calibration.name}</span>
                    <small>
                      {calibration.cameraEntityIds.length} images ·{' '}
                      {groupingLabel(calibration.groupingBasis)}
                    </small>
                    {calibration.initialCalibration?.focalPixels !== undefined && (
                      <small>
                        Seed {calibration.initialCalibration.focalPixels.toFixed(2)} px ·{' '}
                        {calibration.initialCalibration.widthPixels} ×{' '}
                        {calibration.initialCalibration.heightPixels}
                      </small>
                    )}
                    <IntrinsicsPolicyEditor
                      group={calibration}
                      busy={busy}
                      diagnostics={intrinsicsDiagnostics.find(
                        (item) => item.calibrationGroupId === calibration.entityId,
                      )}
                      onChange={(policy) => onUpdateIntrinsics(calibration.entityId, policy)}
                    />
                    <details>
                      <summary>Show assigned images</summary>
                      <div className={styles.assignedImages}>
                        {calibration.cameraEntityIds.map((entityId) => (
                          <span key={entityId} title={entityId}>
                            {cameraNameById.get(entityId) ?? entityId}
                          </span>
                        ))}
                      </div>
                    </details>
                  </div>
                ))}
              <code title={capture.membershipSha256}>{capture.membershipSha256.slice(0, 12)}</code>
            </article>
          ))
        )}
      </section>
    </div>
  );
}

const ALL_INTRINSICS: GcpIntrinsicParameterMask = {
  f: true,
  cx: true,
  cy: true,
  k1: true,
  k2: true,
  k3: true,
  p1: true,
  p2: true,
};

function IntrinsicsPolicyEditor({
  group,
  busy,
  diagnostics,
  onChange,
}: {
  group: CameraCalibrationGroupRecord;
  busy: boolean;
  diagnostics: GcpIntrinsicsGroupDiagnostics | undefined;
  onChange: (policy: GcpIntrinsicsPolicy) => void;
}): JSX.Element {
  const policy = group.intrinsicsPolicy ?? { kind: 'auto' };
  const mask = 'parameters' in policy ? policy.parameters : ALL_INTRINSICS;
  return (
    <div>
      <label>
        <span>Intrinsics policy</span>
        <Select
          value={policy.kind}
          disabled={busy}
          onChange={(event) => {
            const kind = event.currentTarget.value as GcpIntrinsicsPolicy['kind'];
            if (kind === 'auto' || kind === 'fixed') return onChange({ kind });
            if (kind === 'custom') return onChange({ kind, parameters: mask });
            onChange({
              kind,
              parameters: mask,
              stddev: {
                focalLogScale: 0.25,
                principalXPixels: 200,
                principalYPixels: 200,
                k1: 0.25,
                k2: 0.25,
                k3: 0.25,
                p1: 0.1,
                p2: 0.1,
              },
            });
          }}
        >
          <option value="auto">Auto · staged and observable</option>
          <option value="fixed">Fixed · trust embedded calibration</option>
          <option value="prior">Prior · refine selected with regularization</option>
          <option value="custom">Custom · refine selected</option>
        </Select>
      </label>
      {(policy.kind === 'prior' || policy.kind === 'custom') && (
        <div aria-label="Enabled intrinsic parameters">
          {(Object.keys(ALL_INTRINSICS) as (keyof GcpIntrinsicParameterMask)[]).map((parameter) => (
            <label key={parameter}>
              <input
                type="checkbox"
                checked={mask[parameter]}
                disabled={busy}
                onChange={(event) => {
                  const parameters = { ...mask, [parameter]: event.currentTarget.checked };
                  onChange(
                    policy.kind === 'custom'
                      ? { kind: 'custom', parameters }
                      : { ...policy, parameters },
                  );
                }}
              />
              <span>{parameter}</span>
            </label>
          ))}
        </div>
      )}
      {diagnostics && (
        <small>
          Effective {enabledParameters(diagnostics.effectiveParameters)} ·{' '}
          {diagnostics.observationCount} observations · radial{' '}
          {(diagnostics.radialCoverage * 100).toFixed(0)}% · {diagnostics.occupiedQuadrants}/4
          quadrants
          {diagnostics.stages.at(-1)?.rejection
            ? ` · fallback: ${diagnostics.stages.at(-1)?.rejection}`
            : ''}
        </small>
      )}
    </div>
  );
}

function enabledParameters(mask: GcpIntrinsicParameterMask): string {
  const values = (Object.keys(mask) as (keyof GcpIntrinsicParameterMask)[]).filter(
    (parameter) => mask[parameter],
  );
  return values.length ? values.join(', ') : 'fixed';
}

function groupingLabel(value: CameraCalibrationGroupRecord['groupingBasis']): string {
  if (value === 'missionAutofocus') return 'mission / autofocus';
  if (value === 'embeddedCalibration') return 'embedded calibration';
  return 'manual calibration';
}
