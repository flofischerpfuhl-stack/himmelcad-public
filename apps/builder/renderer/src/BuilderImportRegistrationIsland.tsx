import type {
  ImportRegistrationState,
  JsonValue,
  RegistrationPoint,
  RegistrationPointPair,
  RegistrationRecipe,
  RegistrationSimilarity3d,
  RegistrationTargetSample,
} from '@himmelcad/app';
import { logEvent } from '@himmelcad/console';
import type { SnapResult } from '@himmelcad/data';
import { ImportRegistrationWizard, type ImportRegistrationFormatContext } from '@himmelcad/ui';
import type { CanonicalRepresentationAdmission } from '@himmelcad/viewer/kernel';
import { useEffect, useRef, useState } from 'react';

import styles from './BuilderImportRegistrationIsland.module.css';
import {
  BuilderKernelViewport,
  type BuilderCanonicalImportPackage,
  type BuilderKernelViewportHandle,
} from './BuilderKernelViewport.js';
import type { BuilderCanonicalProjectSession } from './project.js';
import { importStageNeedsFurtherInput } from './importDialogPolicy.js';

interface StagedResidency {
  readonly sessionId: string;
  readonly datasets: readonly {
    readonly datasetId: string;
    readonly formatId: string;
    readonly entityId: string;
    readonly representationSlot: string;
    readonly metadataUrl: string;
  }[];
}

type Placement = NonNullable<CanonicalRepresentationAdmission['entity']['placement']>;

export function BuilderImportRegistrationIsland({
  jobId,
  sourcePath,
  projectLabel,
  session,
  onBackgroundStateChange,
  onCommitted,
  onClose,
}: {
  readonly jobId: string;
  readonly sourcePath: string;
  readonly projectLabel: string;
  readonly session: BuilderCanonicalProjectSession;
  readonly onBackgroundStateChange: (backgrounded: boolean) => void;
  readonly onCommitted: () => void | Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<ImportRegistrationState | null>(null);
  const [pairs, setPairs] = useState<RegistrationPointPair[]>([]);
  const [sourceSnap, setSourceSnap] = useState<SnapResult | null>(null);
  const [targetSnap, setTargetSnap] = useState<SnapResult | null>(null);
  const [pendingSource, setPendingSource] = useState<RegistrationPoint | null>(null);
  const [format, setFormat] = useState<ImportRegistrationFormatContext | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [semanticLosses, setSemanticLosses] = useState<readonly string[]>([]);
  const [pendingRecipe, setPendingRecipe] = useState<RegistrationRecipe | null>(null);
  const [pendingProviderOptions, setPendingProviderOptions] = useState<JsonValue>({});
  const [currentAdmissions, setCurrentAdmissions] = useState<
    readonly CanonicalRepresentationAdmission[]
  >([]);
  const [preparedSourceSamples, setPreparedSourceSamples] = useState<readonly RegistrationPoint[]>(
    [],
  );
  const [preparedTargetSamples, setPreparedTargetSamples] = useState<
    readonly RegistrationTargetSample[]
  >([]);
  const [busy, setBusy] = useState(false);
  const sourceViewport = useRef<BuilderKernelViewportHandle | null>(null);
  const projectViewport = useRef<BuilderKernelViewportHandle | null>(null);
  const stagedResidency = useRef<StagedResidency | null>(null);

  useEffect(() => {
    let active = true;
    void window.himmelcad?.sidecar
      .call<ImportRegistrationState>('registration.session.state', { sessionId: jobId })
      .then((restored) => {
        if (active) setState(restored);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [jobId]);

  useEffect(() => {
    let active = true;
    void Promise.all([session.probeImport(sourcePath), session.listIoFormats()]).then(
      ([selection, formats]) => {
        if (!active) return;
        const descriptor = formats.find(
          (candidate) =>
            candidate.providerId === selection.providerId &&
            candidate.formatIds.includes(selection.formatId),
        );
        setFormat({
          formatId: selection.formatId,
          displayName: descriptor?.displayName ?? selection.providerId,
          confidence: selection.confidence,
        });
        setProbeError(null);
      },
      (error: unknown) => {
        if (active) setProbeError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [session, sourcePath]);

  useEffect(() => {
    if (!state || pendingRecipe?.method.kind === 'sourceCoordinates') return;
    let active = true;
    const package_ = applyPreviewToPackage(
      parsePreviewPackage(state.sourcePreview),
      state.preview?.transform,
    );
    void (async () => {
      await sourceViewport.current?.loadCanonicalPackage(package_);
      const api = window.himmelcad;
      if (!api || !active) return;
      if (stagedResidency.current?.sessionId !== state.sessionId) {
        stagedResidency.current = await api.stagedRegistration.materialize(state.sessionId);
        try {
          const samples = await session.registrationSourceSamples(state.sessionId);
          if (active) setPreparedSourceSamples(samples.points);
        } catch {
          if (active) setPreparedSourceSamples([]);
        }
      }
      for (const dataset of stagedResidency.current.datasets) {
        if (dataset.formatId !== 'potree@2') continue;
        const admission = package_.admissions.find(
          (candidate) =>
            candidate.entity.id === dataset.entityId &&
            candidate.representationSlot === dataset.representationSlot,
        );
        if (admission?.resolvedGeometry.kind !== 'pointCloud') continue;
        await sourceViewport.current?.loadPotreePointCloud(dataset.metadataUrl, {
          datasetId: dataset.datasetId,
          admission,
          bounds: await readPotreeBounds(dataset.metadataUrl),
        });
      }
      sourceViewport.current?.frameAll();
    })().catch((error: unknown) => {
      if (active) setOperationError(errorMessage(error));
    });
    void window.himmelcad?.canonicalProject
      .residencyBootstrap()
      .then(async (bootstrap) => {
        if (!active) return;
        const admissions = bootstrap.entries
          .map((entry) => entry.admission)
          .filter(isAdmissionLike);
        setCurrentAdmissions(admissions);
        const inlineAdmissions: CanonicalRepresentationAdmission[] = [];
        const pointCloudTargets: RegistrationTargetSample[] = [];
        for (const entry of bootstrap.entries) {
          if (!isAdmissionLike(entry.admission)) continue;
          if (
            entry.dataset?.formatId === 'potree@2' &&
            entry.admission.resolvedGeometry.kind === 'pointCloud'
          ) {
            await projectViewport.current?.loadPotreePointCloud(entry.dataset.metadataUrl, {
              datasetId: entry.dataset.datasetId,
              admission: entry.admission,
              bounds: await readPotreeBounds(entry.dataset.metadataUrl),
            });
            try {
              const samples = await session.registrationProjectPointCloudSamples(
                entry.dataset.datasetId,
              );
              for (const position of samples.points) pointCloudTargets.push({ position });
            } catch {
              // Picking remains available when a legacy dataset cannot expose root samples.
            }
          } else if (entry.dataset === null) {
            inlineAdmissions.push(entry.admission);
          }
        }
        setPreparedTargetSamples(deterministicSubset(pointCloudTargets, 2_048));
        if (inlineAdmissions.length > 0) {
          await projectViewport.current?.loadCanonicalPackage({
            providerId: 'hcad.registration-current-preview@1',
            providerVersion: '1',
            admissions: inlineAdmissions,
          });
        }
        projectViewport.current?.frameAll();
      })
      .catch((error: unknown) => {
        if (active) setOperationError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [pendingRecipe?.method.kind, session, state]);

  useEffect(
    () => () => {
      const sessionId = stagedResidency.current?.sessionId;
      if (sessionId) void window.himmelcad?.stagedRegistration.revoke(sessionId);
    },
    [],
  );

  const stage = async (
    recipe: RegistrationRecipe,
    providerOptions: JsonValue = {},
    acceptedLossCodes: readonly string[] = [],
  ): Promise<void> => {
    const backgroundOperation = !importStageNeedsFurtherInput(recipe.method.kind);
    setBusy(true);
    setOperationError(null);
    setSemanticLosses([]);
    setPendingRecipe(recipe);
    setPendingProviderOptions(providerOptions);
    if ((await window.himmelcad?.jobs.get(jobId))?.state === 'needs-input') {
      await window.himmelcad?.jobs.respond(jobId);
    }
    await window.himmelcad?.jobs.update(jobId, {
      phase: 'Preparing import',
      progressKey: jobId,
      cancellation: { cancellable: true },
    });
    if (backgroundOperation) {
      logEvent('info', 'renderer', `Import running in background: ${fileLabel(sourcePath)}`);
      onBackgroundStateChange(true);
    }
    try {
      const stagedState = await session.stageRegisteredImport(
        sourcePath,
        recipe,
        withAcceptedLossCodes(providerOptions, acceptedLossCodes),
        jobId,
      );
      setState(stagedState);
      setPairs([]);
      setPendingSource(null);
      setPreparedSourceSamples([]);
      onBackgroundStateChange(false);
      await window.himmelcad?.jobs.needsInput(jobId, 'Review placement');
    } catch (error: unknown) {
      const message = errorMessage(error);
      const losses = explicitSemanticLosses(message);
      if (losses.length > 0) {
        setSemanticLosses(losses);
        await window.himmelcad?.jobs.needsInput(jobId, 'Waiting for semantic-loss confirmation');
        if (backgroundOperation) {
          logEvent(
            'warn',
            'renderer',
            `Import needs confirmation before it can continue: ${fileLabel(sourcePath)}`,
          );
        }
      } else {
        setOperationError(message);
        const job = await window.himmelcad?.jobs.get(jobId);
        if (job?.state === 'cancelling') await window.himmelcad?.jobs.cancelled(jobId);
        else await window.himmelcad?.jobs.fail(jobId, message);
        if (backgroundOperation) {
          logEvent(
            'error',
            'renderer',
            `Background import failed for ${fileLabel(sourcePath)}: ${message}`,
          );
        }
      }
      if (backgroundOperation) onBackgroundStateChange(false);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (): Promise<void> => {
    await window.himmelcad?.jobs.cancel(jobId);
    if (state) await window.himmelcad?.stagedRegistration.revoke(state.sessionId);
    onClose();
  };
  const changePlacement = async (): Promise<void> => {
    if (!state) return;
    await window.himmelcad?.stagedRegistration.revoke(state.sessionId);
    await session.cancelRegisteredImport(state.sessionId);
    setState(null);
    setPendingRecipe(null);
    setPairs([]);
    onBackgroundStateChange(false);
    await window.himmelcad?.jobs.needsInput(jobId, 'Choose placement');
  };
  const requestPick = (side: 'source' | 'target'): void => {
    if (side === 'source') {
      if (sourceSnap) setPendingSource(point(sourceSnap));
      return;
    }
    if (!pendingSource || !targetSnap) return;
    setPairs((current) => [
      ...current,
      {
        pairId: `pair-${current.length + 1}`,
        source: pendingSource,
        target: point(targetSnap),
      },
    ]);
    setPendingSource(null);
  };
  const previewPairs = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    setOperationError(null);
    try {
      setState(await session.previewRegistrationPointPairs(state.sessionId, pairs));
    } catch (error: unknown) {
      setOperationError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const previewIcp = async (): Promise<void> => {
    if (!state) return;
    const inlineSource = collectInlineMeshSamples(
      parsePreviewPackage(state.sourcePreview).admissions,
    );
    const source = preparedSourceSamples.length >= 3 ? preparedSourceSamples : inlineSource;
    const target = deterministicSubset(
      [...preparedTargetSamples, ...collectInlineMeshTargetSamples(currentAdmissions)],
      2_048,
    );
    if (source.length < 3 || target.length < 3) return;
    const pointToPlane = target.every((sample) => sample.normal !== undefined);
    setBusy(true);
    setOperationError(null);
    try {
      setState(
        await session.previewRegistrationIcp({
          sessionId: state.sessionId,
          source,
          target,
          initial: state.preview?.transform ?? identitySimilarity,
          mode: pointToPlane ? 'pointToPlane' : 'pointToPoint',
          options: {
            maximumIterations: 40,
            maximumCorrespondenceDistance: 10,
            convergenceTranslationMeters: 0.0001,
            convergenceRotationRadians: 0.00001,
            minimumOverlapRatio: 0.25,
            huberDeltaMeters: 0.1,
          },
        }),
      );
    } catch (error: unknown) {
      setOperationError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const commit = async (): Promise<void> => {
    if (!state) return;
    const startedAt = performance.now();
    setBusy(true);
    setOperationError(null);
    logEvent('info', 'renderer', `Import commit running in background: ${fileLabel(sourcePath)}`);
    await window.himmelcad?.jobs.update(jobId, {
      phase: 'Registering dataset',
      cancellation: { cancellable: true },
    });
    onBackgroundStateChange(true);
    try {
      await session.commitRegisteredImport(state.sessionId);
      await window.himmelcad?.stagedRegistration.revoke(state.sessionId);
      await onCommitted();
      await window.himmelcad?.jobs.complete(jobId, `Import committed: ${fileLabel(sourcePath)}`);
      logEvent(
        'info',
        'renderer',
        `Import completed: ${fileLabel(sourcePath)} · ${state.sourceEntityCount} entity · ${((performance.now() - startedAt) / 1_000).toFixed(1)} s commit`,
      );
      onClose();
    } catch (error: unknown) {
      const message = errorMessage(error);
      setOperationError(message);
      const job = await window.himmelcad?.jobs.get(jobId);
      if (job?.state === 'cancelling') await window.himmelcad?.jobs.cancelled(jobId);
      else await window.himmelcad?.jobs.fail(jobId, message);
      logEvent(
        'error',
        'renderer',
        `Background import commit failed for ${fileLabel(sourcePath)}: ${message}`,
      );
      onBackgroundStateChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ImportRegistrationWizard
      sourceLabel={sourcePath.split(/[\\/]/).at(-1) ?? sourcePath}
      projectLabel={projectLabel}
      format={format}
      probeError={probeError}
      operationError={operationError}
      semanticLosses={semanticLosses}
      state={state}
      placementSummary={state ? placementSummary(state) : null}
      onChangePlacement={() => void changePlacement()}
      pointPairs={pairs}
      nextPickSide={pendingSource ? 'target' : 'source'}
      sourcePickReady={sourceSnap !== null}
      targetPickReady={targetSnap !== null}
      busy={busy}
      onStage={(recipe, providerOptions) => void stage(recipe, providerOptions)}
      onAcceptSemanticLosses={() => {
        if (pendingRecipe) void stage(pendingRecipe, pendingProviderOptions, semanticLosses);
      }}
      onLoadTransform={async () => {
        const path = await window.himmelcad?.dialog.openTransform();
        if (!path) return null;
        const inspected = await session.inspectRegistrationTransform(path);
        return {
          label: fileLabel(path),
          sourceSha256: inspected.sourceSha256,
          transform: inspected.transform,
          warnings: inspected.warnings,
        };
      }}
      onSaveTransform={async (transform) =>
        (await window.himmelcad?.dialog.saveTransform(transform)) ?? null
      }
      onRequestPick={requestPick}
      onPreviewPointPairs={() => void previewPairs()}
      {...(hasIcpSamples(state, currentAdmissions, preparedSourceSamples, preparedTargetSamples)
        ? { onPreviewIcp: () => void previewIcp() }
        : {})}
      onCommit={() => void commit()}
      onCancel={() => void cancel()}
      sourceView={
        <div className={styles.viewport}>
          <BuilderKernelViewport
            ref={sourceViewport}
            pointSize={1}
            onCursorSnap={setSourceSnap}
            onDropFiles={() => undefined}
            onLog={() => undefined}
          />
        </div>
      }
      projectView={
        <div className={styles.viewport}>
          <BuilderKernelViewport
            ref={projectViewport}
            pointSize={1}
            onCursorSnap={setTargetSnap}
            onDropFiles={() => undefined}
            onLog={() => undefined}
          />
        </div>
      }
    />
  );
}

const identitySimilarity = {
  tx: 0,
  ty: 0,
  tz: 0,
  rxRadians: 0,
  ryRadians: 0,
  rzRadians: 0,
  scale: 1,
} as const;

function hasIcpSamples(
  state: ImportRegistrationState | null,
  current: readonly CanonicalRepresentationAdmission[],
  preparedSource: readonly RegistrationPoint[],
  preparedTarget: readonly RegistrationTargetSample[],
): boolean {
  if (!state) return false;
  return (
    (preparedSource.length >= 3 ||
      collectInlineMeshSamples(parsePreviewPackage(state.sourcePreview).admissions, 3).length >=
        3) &&
    (preparedTarget.length >= 3 || collectInlineMeshTargetSamples(current, 3).length >= 3)
  );
}

function deterministicSubset<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values];
  return Array.from(
    { length: maximum },
    (_, index) => values[Math.floor((index * values.length) / maximum)]!,
  );
}

function collectInlineMeshSamples(
  admissions: readonly CanonicalRepresentationAdmission[],
  maximum = 2_048,
): RegistrationPoint[] {
  const result: RegistrationPoint[] = [];
  for (const admission of admissions) {
    const geometry = admission.resolvedGeometry;
    const mesh =
      geometry.kind === 'surface3d'
        ? geometry.mesh
        : geometry.kind === 'solid' && geometry.solid.kind === 'closedMesh'
          ? geometry.solid.mesh
          : null;
    if (mesh?.storage.kind !== 'inline') continue;
    for (const position of mesh.storage.positions) {
      result.push(applyPlacement(position, admission.entity.placement));
    }
  }
  if (result.length <= maximum) return result;
  const sampled: RegistrationPoint[] = [];
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(result[Math.floor((index * result.length) / maximum)]!);
  }
  return sampled;
}

function collectInlineMeshTargetSamples(
  admissions: readonly CanonicalRepresentationAdmission[],
  maximum = 2_048,
): RegistrationTargetSample[] {
  const samples: RegistrationTargetSample[] = [];
  for (const admission of admissions) {
    const geometry = admission.resolvedGeometry;
    const mesh =
      geometry.kind === 'surface3d'
        ? geometry.mesh
        : geometry.kind === 'solid' && geometry.solid.kind === 'closedMesh'
          ? geometry.solid.mesh
          : null;
    if (mesh?.storage.kind !== 'inline') continue;
    const positions = mesh.storage.positions;
    for (let index = 0; index + 2 < mesh.storage.indices.length; index += 3) {
      const a = positions[mesh.storage.indices[index] ?? -1];
      const b = positions[mesh.storage.indices[index + 1] ?? -1];
      const c = positions[mesh.storage.indices[index + 2] ?? -1];
      if (!a || !b || !c) continue;
      const normal = triangleNormal(a, b, c, admission.entity.placement);
      for (const vertex of [a, b, c]) {
        samples.push({ position: applyPlacement(vertex, admission.entity.placement), normal });
      }
    }
  }
  if (samples.length <= maximum) return samples;
  return Array.from(
    { length: maximum },
    (_, index) => samples[Math.floor((index * samples.length) / maximum)]!,
  );
}

function triangleNormal(
  a: RegistrationPoint,
  b: RegistrationPoint,
  c: RegistrationPoint,
  placement: CanonicalRepresentationAdmission['entity']['placement'],
): RegistrationPoint {
  const worldA = applyPlacement(a, placement);
  const worldB = applyPlacement(b, placement);
  const worldC = applyPlacement(c, placement);
  const ab = { x: worldB.x - worldA.x, y: worldB.y - worldA.y, z: worldB.z - worldA.z };
  const ac = { x: worldC.x - worldA.x, y: worldC.y - worldA.y, z: worldC.z - worldA.z };
  const world = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const length = Math.hypot(world.x, world.y, world.z) || 1;
  return { x: world.x / length, y: world.y / length, z: world.z / length };
}

function applyPlacement(
  point_: RegistrationPoint,
  matrix: CanonicalRepresentationAdmission['entity']['placement'],
): RegistrationPoint {
  if (!matrix) return point_;
  return {
    x: matrix[0] * point_.x + matrix[4] * point_.y + matrix[8] * point_.z + matrix[12],
    y: matrix[1] * point_.x + matrix[5] * point_.y + matrix[9] * point_.z + matrix[13],
    z: matrix[2] * point_.x + matrix[6] * point_.y + matrix[10] * point_.z + matrix[14],
  };
}

function applyPreviewToPackage(
  package_: BuilderCanonicalImportPackage,
  preview: RegistrationSimilarity3d | undefined,
): BuilderCanonicalImportPackage {
  if (!preview) return package_;
  const outer = similarityMatrix(preview);
  return {
    ...package_,
    admissions: package_.admissions.map((admission) => ({
      ...admission,
      entity: {
        ...admission.entity,
        placement: composeMatrices(outer, admission.entity.placement ?? identityMatrix),
      },
    })),
  };
}

const identityMatrix: Placement = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function similarityMatrix(value: RegistrationSimilarity3d): Placement {
  const [cx, sx] = [Math.cos(value.rxRadians), Math.sin(value.rxRadians)];
  const [cy, sy] = [Math.cos(value.ryRadians), Math.sin(value.ryRadians)];
  const [cz, sz] = [Math.cos(value.rzRadians), Math.sin(value.rzRadians)];
  const scale = value.scale;
  return [
    scale * cy * cz,
    scale * cy * sz,
    scale * -sy,
    0,
    scale * (sx * sy * cz - cx * sz),
    scale * (sx * sy * sz + cx * cz),
    scale * sx * cy,
    0,
    scale * (cx * sy * cz + sx * sz),
    scale * (cx * sy * sz - sx * cz),
    scale * cx * cy,
    0,
    value.tx,
    value.ty,
    value.tz,
    1,
  ];
}

function composeMatrices(outer: Placement, inner: Placement): Placement {
  const value = (column: number, row: number): number =>
    [0, 1, 2, 3].reduce(
      (sum, index) => sum + outer[index * 4 + row]! * inner[column * 4 + index]!,
      0,
    );
  return [
    value(0, 0),
    value(0, 1),
    value(0, 2),
    value(0, 3),
    value(1, 0),
    value(1, 1),
    value(1, 2),
    value(1, 3),
    value(2, 0),
    value(2, 1),
    value(2, 2),
    value(2, 3),
    value(3, 0),
    value(3, 1),
    value(3, 2),
    value(3, 3),
  ];
}

async function readPotreeBounds(metadataUrl: string): Promise<{
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}> {
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`staged Potree metadata failed (${response.status})`);
  const metadata: unknown = await response.json();
  if (!isRecord(metadata) || !isRecord(metadata.boundingBox)) {
    throw new Error('staged Potree metadata has no bounding box');
  }
  return {
    min: coordinateTuple(metadata.boundingBox.min),
    max: coordinateTuple(metadata.boundingBox.max),
  };
}

function coordinateTuple(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new Error('staged Potree bound is invalid');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileLabel(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function placementSummary(state: ImportRegistrationState): string {
  const package_ = isRecord(state.sourcePreview) ? state.sourcePreview : {};
  const objects = Array.isArray(package_.objects) ? package_.objects : [];
  const source = objects
    .filter(isRecord)
    .map((object) => (isRecord(object.value) ? object.value['hcad.point-cloud-import@1'] : null))
    .filter(isRecord)
    .map((attributes) => attributes.source)
    .find(isRecord);
  const crs = typeof source?.declaredCrs === 'string' ? source.declaredCrs : 'Not declared';
  const units = typeof source?.declaredUnits === 'string' ? source.declaredUnits : 'Not declared';
  const transform = state.preview?.transform;
  const offset = transform ? [transform.tx, transform.ty, transform.tz] : [0, 0, 0];
  return `CRS: ${crs} · offset ${offset.map(formatOffset).join(' ')} · source units ${units}`;
}

function formatOffset(value: number): string {
  return Number.isInteger(value)
    ? value.toFixed(0)
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function explicitSemanticLosses(message: string): readonly string[] {
  if (!/explicit(?:ly)? accept|explicit acceptance/i.test(message)) return [];
  return [...new Set(message.match(/hcad\.loss\.[A-Za-z0-9_.:@-]+/g) ?? [])];
}

function withAcceptedLossCodes(
  options: JsonValue,
  acceptedLossCodes: readonly string[],
): JsonValue {
  if (acceptedLossCodes.length === 0) return options;
  if (!isRecord(options)) throw new Error('provider import options must be an object');
  return { ...options, acceptedLossCodes: [...acceptedLossCodes] };
}

function point(snap: SnapResult): RegistrationPoint {
  return { x: snap.position.x, y: snap.position.y, z: snap.position.z ?? 0 };
}

function parsePreviewPackage(value: unknown): BuilderCanonicalImportPackage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('providerId' in value) ||
    typeof value.providerId !== 'string' ||
    !('providerVersion' in value) ||
    typeof value.providerVersion !== 'string' ||
    !('admissions' in value) ||
    !Array.isArray(value.admissions) ||
    !value.admissions.every(isAdmissionLike)
  ) {
    throw new Error('registration source preview is invalid');
  }
  return {
    providerId: value.providerId,
    providerVersion: value.providerVersion,
    admissions: value.admissions,
  };
}

function isAdmissionLike(
  value: unknown,
): value is BuilderCanonicalImportPackage['admissions'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entity' in value &&
    typeof value.entity === 'object' &&
    value.entity !== null &&
    'resolvedGeometry' in value
  );
}
