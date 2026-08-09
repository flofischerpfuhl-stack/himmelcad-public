import type {
  ImportRegistrationState,
  RegistrationPoint,
  RegistrationPointPair,
  RegistrationRecipe,
  RegistrationSimilarity3d,
  RegistrationTargetSample,
} from '@himmelcad/app';
import type { SnapResult } from '@himmelcad/data';
import { ImportRegistrationWizard } from '@himmelcad/ui';
import type { CanonicalRepresentationAdmission } from '@himmelcad/viewer/kernel';
import { useEffect, useRef, useState } from 'react';

import styles from './BuilderImportRegistrationIsland.module.css';
import {
  BuilderKernelViewport,
  type BuilderCanonicalImportPackage,
  type BuilderKernelViewportHandle,
} from './BuilderKernelViewport.js';
import type { BuilderCanonicalProjectSession } from './project.js';

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
  sourcePath,
  projectLabel,
  session,
  onCommitted,
  onClose,
}: {
  readonly sourcePath: string;
  readonly projectLabel: string;
  readonly session: BuilderCanonicalProjectSession;
  readonly onCommitted: () => void | Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<ImportRegistrationState | null>(null);
  const [pairs, setPairs] = useState<RegistrationPointPair[]>([]);
  const [sourceSnap, setSourceSnap] = useState<SnapResult | null>(null);
  const [targetSnap, setTargetSnap] = useState<SnapResult | null>(null);
  const [pendingSource, setPendingSource] = useState<RegistrationPoint | null>(null);
  const [currentAdmissions, setCurrentAdmissions] = useState<
    readonly CanonicalRepresentationAdmission[]
  >([]);
  const [preparedSourceSamples, setPreparedSourceSamples] = useState<readonly RegistrationPoint[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const sourceViewport = useRef<BuilderKernelViewportHandle | null>(null);
  const projectViewport = useRef<BuilderKernelViewportHandle | null>(null);
  const stagedResidency = useRef<StagedResidency | null>(null);

  useEffect(() => {
    if (!state) return;
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
    })();
    void window.himmelcad?.canonicalProject.residencyBootstrap().then(async (bootstrap) => {
      if (!active) return;
      const admissions = bootstrap.entries
        .filter((entry) => entry.dataset === null)
        .map((entry) => entry.admission)
        .filter(isAdmissionLike);
      setCurrentAdmissions(admissions);
      if (admissions.length > 0) {
        await projectViewport.current?.loadCanonicalPackage({
          providerId: 'hcad.registration-current-preview@1',
          providerVersion: '1',
          admissions,
        });
        projectViewport.current?.frameAll();
      }
    });
    return () => {
      active = false;
    };
  }, [session, state]);

  useEffect(
    () => () => {
      const sessionId = stagedResidency.current?.sessionId;
      if (sessionId) void window.himmelcad?.stagedRegistration.revoke(sessionId);
    },
    [],
  );

  const stage = async (recipe: RegistrationRecipe): Promise<void> => {
    setBusy(true);
    try {
      setState(await session.stageRegisteredImport(sourcePath, recipe));
      setPairs([]);
      setPendingSource(null);
      setPreparedSourceSamples([]);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (): Promise<void> => {
    if (state) {
      await window.himmelcad?.stagedRegistration.revoke(state.sessionId);
      await session.cancelRegisteredImport(state.sessionId);
    }
    onClose();
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
    try {
      setState(await session.previewRegistrationPointPairs(state.sessionId, pairs));
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
    const target = collectInlineMeshTargetSamples(currentAdmissions);
    if (source.length < 3 || target.length < 3) return;
    const pointToPlane = target.every((sample) => sample.normal !== undefined);
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };
  const commit = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    try {
      await session.commitRegisteredImport(state.sessionId);
      await window.himmelcad?.stagedRegistration.revoke(state.sessionId);
      await onCommitted();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ImportRegistrationWizard
      sourceLabel={sourcePath.split(/[\\/]/).at(-1) ?? sourcePath}
      projectLabel={projectLabel}
      state={state}
      pointPairs={pairs}
      busy={busy}
      onStage={(recipe) => void stage(recipe)}
      onRequestPick={requestPick}
      onPreviewPointPairs={() => void previewPairs()}
      {...(hasIcpSamples(state, currentAdmissions, preparedSourceSamples)
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
): boolean {
  if (!state) return false;
  return (
    (preparedSource.length >= 3 ||
      collectInlineMeshSamples(parsePreviewPackage(state.sourcePreview).admissions, 3).length >=
        3) &&
    collectInlineMeshTargetSamples(current, 3).length >= 3
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
