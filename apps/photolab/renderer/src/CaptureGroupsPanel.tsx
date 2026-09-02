import type {
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  CameraCalibrationSeed,
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
import {
  EMPTY_LAB_CALIBRATION,
  type ImagePixelDimensions,
  type LabCalibrationFormValues,
  type LabCalibrationParameter,
  validateLabCalibration,
} from './labCalibration.js';

const HELP_SESSION_KEY = 'photolab.capture-groups.help-open';

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
  onSetInitialCalibration,
  onDuplicateAsDraft,
  onMergeProposals,
}: {
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
  projectCameras: readonly {
    entityId: EntityId;
    name: string;
    dimensions?: ImagePixelDimensions | undefined;
  }[];
  selectedCameras: readonly {
    entityId: EntityId;
    name: string;
    dimensions?: ImagePixelDimensions | undefined;
  }[];
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
  onSetInitialCalibration: (
    calibrationGroupId: EntityId,
    initialCalibration: CameraCalibrationSeed,
    policy: GcpIntrinsicsPolicy,
  ) => void;
  onDuplicateAsDraft: (captureGroupId: EntityId) => void;
  onMergeProposals: (firstCaptureGroupId: EntityId, secondCaptureGroupId: EntityId) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [calibrationNames, setCalibrationNames] = useState<readonly string[]>([
    'Calibration group 1',
  ]);
  const [assignments, setAssignments] = useState<Readonly<Record<EntityId, number>>>({});
  const [labForms, setLabForms] = useState<Readonly<Record<number, LabCalibrationFormValues>>>({});
  const [helpOpen, setHelpOpen] = useState(() => {
    try {
      return sessionStorage.getItem(HELP_SESSION_KEY) === 'true';
    } catch {
      return false;
    }
  });
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
  const cameraById = useMemo(
    () => new Map(projectCameras.map((camera) => [camera.entityId, camera])),
    [projectCameras],
  );
  const cameraNameById = useMemo(
    () => new Map(projectCameras.map((camera) => [camera.entityId, camera.name])),
    [projectCameras],
  );
  const partitionComplete =
    calibrationDrafts.length > 0 &&
    calibrationDrafts.every((group) => group.cameraEntityIds.length);
  const draftLabResults = calibrationDrafts.map((draft, index) => {
    const form = labForms[index];
    return form && labFormHasValues(form)
      ? validateLabCalibration(form, sharedDimensions(draft.cameraEntityIds, cameraById))
      : undefined;
  });
  const labFormsValid = draftLabResults.every(
    (result) => !result || Object.keys(result.errors).length === 0,
  );
  const frozenDrafts = calibrationDrafts.map((draft, index) => {
    const result = draftLabResults[index];
    return result?.initialCalibration && result.intrinsicsPolicy
      ? {
          ...draft,
          initialCalibration: result.initialCalibration,
          intrinsicsPolicy: result.intrinsicsPolicy,
        }
      : draft;
  });
  const groupedCameraIds = new Set(calibrationGroups.flatMap((group) => group.cameraEntityIds));
  const ungroupedCameras = projectCameras.filter(
    (camera) => !groupedCameraIds.has(camera.entityId),
  );
  return (
    <div className={styles.root}>
      <details
        className={styles.help}
        open={helpOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setHelpOpen(open);
          try {
            sessionStorage.setItem(HELP_SESSION_KEY, String(open));
          } catch {
            // Session storage can be unavailable in isolated renderer tests.
          }
        }}
      >
        <summary>About capture and calibration groups</summary>
        <p>A capture group is one photo session used as a processing scope.</p>
        <p>A calibration group contains cameras that may share one set of intrinsics.</p>
        <p>
          Split for a different camera, lens, zoom, or autofocus session; do not split continuous
          images from the same unchanged setup.
        </p>
      </details>
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
            <div className={styles.draftCalibration} key={`calibration-${index}`}>
              <div className={styles.calibrationName}>
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
                      setCalibrationNames((current) =>
                        current.filter((_, value) => value !== index),
                      );
                      setAssignments((current) =>
                        Object.fromEntries(
                          Object.entries(current).map(([entityId, value]) => [
                            entityId,
                            value === index ? 0 : value > index ? value - 1 : value,
                          ]),
                        ),
                      );
                      setLabForms((current) => removeIndexedForm(current, index));
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <LabCalibrationEditor
                values={labForms[index] ?? EMPTY_LAB_CALIBRATION}
                dimensions={sharedDimensions(
                  calibrationDrafts[index]?.cameraEntityIds ?? [],
                  cameraById,
                )}
                busy={busy}
                optional
                onChange={(values) => setLabForms((current) => ({ ...current, [index]: values }))}
              />
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
          disabled={busy || selectedCameras.length < 2 || !partitionComplete || !labFormsValid}
          onClick={() => {
            onCreate(
              name.trim() || `Mission ${captureGroups.length + 1}`,
              selectedCameras.map((camera) => camera.entityId),
              frozenDrafts,
            );
            setName('');
            setLabForms({});
          }}
        >
          {busy ? 'Creating…' : 'Create from selection'}
        </button>
      </section>
      <section className={styles.ungrouped}>
        <div className={styles.sectionTitle}>Ungrouped cameras</div>
        {ungroupedCameras.length === 0 ? (
          <p>All cameras belong to an active calibration group.</p>
        ) : (
          <>
            <div className={styles.ungroupedList}>
              {ungroupedCameras.map((camera) => (
                <div key={camera.entityId}>
                  <span title={camera.entityId}>{camera.name}</span>
                  <mark>Intrinsics pinned — add to a group to refine</mark>
                </div>
              ))}
            </div>
            {ungroupedCameras.length === 1 && (
              <small>
                Automatic grouping skipped this single-image session because proposals require at
                least 2 images.
              </small>
            )}
            <button
              type="button"
              disabled={busy || ungroupedCameras.length < 2}
              onClick={() =>
                onCreate(
                  `Ungrouped cameras ${captureGroups.length + 1}`,
                  ungroupedCameras.map((camera) => camera.entityId),
                  [
                    {
                      name: 'Calibration group 1',
                      cameraEntityIds: ungroupedCameras.map((camera) => camera.entityId),
                      groupingBasis: 'manual',
                    },
                  ],
                )
              }
            >
              Create group from ungrouped
            </button>
          </>
        )}
      </section>
      <section className={styles.groups}>
        <div className={styles.sectionTitle}>Intrinsics sharing plan</div>
        {captureGroups.length === 0 ? (
          <p>No groups are available yet. Imported images remain independent until grouped.</p>
        ) : (
          captureGroups.map((capture, captureIndex) => (
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
                  {capture.automatic ? 'Automatically detected' : 'Manual grouping'} ·{' '}
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
                  {capture.reviewStatus === 'confirmed' && (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        captureGroups.some(
                          (candidate) =>
                            candidate.supersedesCaptureGroupId === capture.entityId &&
                            candidate.reviewStatus === 'needsReview',
                        )
                      }
                      onClick={() => onDuplicateAsDraft(capture.entityId)}
                    >
                      Duplicate as draft
                    </button>
                  )}
                  {capture.automatic &&
                    capture.reviewStatus === 'needsReview' &&
                    captureGroups[captureIndex + 1]?.automatic &&
                    captureGroups[captureIndex + 1]?.reviewStatus === 'needsReview' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          onMergeProposals(
                            capture.entityId,
                            captureGroups[captureIndex + 1]!.entityId,
                          )
                        }
                      >
                        Merge these proposals
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
                    {calibration.reviewStatus === 'needsReview' && (
                      <LabCalibrationEditor
                        values={labFormFromSeed(
                          calibration.initialCalibration,
                          calibration.intrinsicsPolicy,
                        )}
                        dimensions={sharedDimensions(calibration.cameraEntityIds, cameraById)}
                        busy={busy}
                        optional={false}
                        onSave={(initialCalibration, policy) =>
                          onSetInitialCalibration(calibration.entityId, initialCalibration, policy)
                        }
                      />
                    )}
                    {calibration.reviewStatus !== 'needsReview' && (
                      <details className={styles.labCalibration}>
                        <summary>Enter lab calibration…</summary>
                        <small>
                          Duplicate this capture group as a draft to change its frozen calibration.
                        </small>
                      </details>
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

function LabCalibrationEditor({
  values,
  dimensions,
  busy,
  optional,
  onChange,
  onSave,
}: {
  values: LabCalibrationFormValues;
  dimensions: ImagePixelDimensions | undefined;
  busy: boolean;
  optional: boolean;
  onChange?: (values: LabCalibrationFormValues) => void;
  onSave?: (initialCalibration: CameraCalibrationSeed, policy: GcpIntrinsicsPolicy) => void;
}): JSX.Element {
  const [current, setCurrent] = useState(values);
  const active = !optional || labFormHasValues(current);
  const result = active ? validateLabCalibration(current, dimensions) : { errors: {} };
  const update = (next: LabCalibrationFormValues) => {
    setCurrent(next);
    onChange?.(next);
  };
  return (
    <details className={styles.labCalibration}>
      <summary>Enter lab calibration…</summary>
      <small>Use absolute cx and cy pixels from the top-left image origin.</small>
      {dimensions ? (
        <small>
          Image size {dimensions.widthPixels} × {dimensions.heightPixels} px
        </small>
      ) : (
        <span className={styles.fieldError}>Images must have one known pixel size.</span>
      )}
      <div className={styles.labFields}>
        {(
          Object.keys(EMPTY_LAB_CALIBRATION).filter(
            (key) => key !== 'policy',
          ) as LabCalibrationParameter[]
        ).map((parameter) => (
          <label key={parameter}>
            <span>{labParameterLabel(parameter)}</span>
            <input
              inputMode="decimal"
              value={current[parameter]}
              disabled={busy}
              aria-invalid={Boolean(result.errors[parameter])}
              onChange={(event) => update({ ...current, [parameter]: event.currentTarget.value })}
            />
            {result.errors[parameter] && (
              <span className={styles.fieldError}>{result.errors[parameter]}</span>
            )}
          </label>
        ))}
      </div>
      <label className={styles.policyChoice}>
        <span>Policy</span>
        <Select
          value={current.policy}
          disabled={busy}
          onChange={(event) =>
            update({
              ...current,
              policy: event.currentTarget.value as LabCalibrationFormValues['policy'],
            })
          }
        >
          <option value="fixed">Fixed · trust calibration</option>
          <option value="prior">Prior · refine from calibration</option>
        </Select>
      </label>
      {onSave && (
        <button
          type="button"
          disabled={
            busy ||
            Object.keys(result.errors).length > 0 ||
            !result.initialCalibration ||
            !result.intrinsicsPolicy
          }
          onClick={() => {
            if (result.initialCalibration && result.intrinsicsPolicy) {
              onSave(result.initialCalibration, result.intrinsicsPolicy);
            }
          }}
        >
          Save lab calibration
        </button>
      )}
    </details>
  );
}

function labParameterLabel(parameter: LabCalibrationParameter): string {
  return parameter === 'f' || parameter === 'cx' || parameter === 'cy'
    ? `${parameter} (px)`
    : parameter;
}

function labFormHasValues(values: LabCalibrationFormValues): boolean {
  return (Object.keys(values) as (keyof LabCalibrationFormValues)[]).some(
    (key) => key !== 'policy' && values[key].trim() !== '',
  );
}

function labFormFromSeed(
  seed: CameraCalibrationSeed | undefined,
  policy: GcpIntrinsicsPolicy | undefined,
): LabCalibrationFormValues {
  if (!seed) return EMPTY_LAB_CALIBRATION;
  const full = seed.fullBrownCalibration;
  return {
    f: String(seed.focalPixels ?? ''),
    cx: String(seed.principalXPixels ?? ''),
    cy: String(seed.principalYPixels ?? ''),
    k1: String(full?.radialDistortion[0] ?? 0),
    k2: String(full?.radialDistortion[1] ?? 0),
    k3: String(full?.radialDistortion[2] ?? 0),
    p1: String(full?.tangentialDistortion[0] ?? 0),
    p2: String(full?.tangentialDistortion[1] ?? 0),
    policy: policy?.kind === 'prior' ? 'prior' : 'fixed',
  };
}

function sharedDimensions(
  cameraIds: readonly EntityId[],
  cameraById: ReadonlyMap<
    EntityId,
    { entityId: EntityId; name: string; dimensions?: ImagePixelDimensions | undefined }
  >,
): ImagePixelDimensions | undefined {
  const dimensions = cameraIds.map((id) => cameraById.get(id)?.dimensions);
  const first = dimensions[0];
  return first &&
    dimensions.every(
      (value) =>
        value?.widthPixels === first.widthPixels && value.heightPixels === first.heightPixels,
    )
    ? first
    : undefined;
}

function removeIndexedForm(
  forms: Readonly<Record<number, LabCalibrationFormValues>>,
  removedIndex: number,
): Readonly<Record<number, LabCalibrationFormValues>> {
  return Object.fromEntries(
    Object.entries(forms)
      .filter(([index]) => Number(index) !== removedIndex)
      .map(([index, form]) => [Number(index) > removedIndex ? Number(index) - 1 : index, form]),
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
  if (value === 'missionAutofocus') return 'Mission / autofocus grouping';
  if (value === 'embeddedCalibration') return 'Embedded calibration grouping';
  return 'Manual grouping';
}
