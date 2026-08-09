import type {
  ImportRegistrationState,
  RegistrationPoint,
  RegistrationPointPair,
  RegistrationRecipe,
  RegistrationSimilarity3d,
  RegistrationTargetSample,
} from '@himmelcad/app';
import type { EntityId, SnapResult } from '@himmelcad/data';
import { ImportRegistrationWizard } from '@himmelcad/ui';
import type { CanonicalRepresentationAdmission } from '@himmelcad/viewer/kernel';
import { useEffect, useRef, useState } from 'react';

import styles from './PhotolabExternalImportDialog.module.css';
import {
  PhotolabKernelViewport,
  type PhotolabKernelViewportHandle,
} from './PhotolabKernelViewport.js';
import type { PhotolabExternalImportSession } from './externalImportSession.js';

type Placement = NonNullable<CanonicalRepresentationAdmission['entity']['placement']>;

export interface PhotolabRegistrationPointCloudLayer {
  readonly entityId: EntityId;
  readonly name: string;
  readonly metadataUrl: string;
  readonly pointCount: number;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
}

export function PhotolabExternalImportDialog({
  sourcePath,
  projectLabel,
  session,
  currentPointClouds,
  onCommitted,
  onClose,
}: {
  readonly sourcePath: string;
  readonly projectLabel: string;
  readonly session: PhotolabExternalImportSession;
  readonly currentPointClouds: readonly PhotolabRegistrationPointCloudLayer[];
  readonly onCommitted: () => void | Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<ImportRegistrationState | null>(null);
  const [pairs, setPairs] = useState<RegistrationPointPair[]>([]);
  const [sourceSnap, setSourceSnap] = useState<SnapResult | null>(null);
  const [targetSnap, setTargetSnap] = useState<SnapResult | null>(null);
  const [pendingSource, setPendingSource] = useState<RegistrationPoint | null>(null);
  const [preparedSourceSamples, setPreparedSourceSamples] = useState<readonly RegistrationPoint[]>(
    [],
  );
  const [currentAdmissions, setCurrentAdmissions] = useState<
    readonly CanonicalRepresentationAdmission[]
  >([]);
  const [busy, setBusy] = useState(false);
  const sourceViewport = useRef<PhotolabKernelViewportHandle | null>(null);
  const projectViewport = useRef<PhotolabKernelViewportHandle | null>(null);
  const stagedSession = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      for (const layer of currentPointClouds) {
        await projectViewport.current?.loadPotreePointCloud(layer.metadataUrl, {
          entityId: layer.entityId,
          sourceName: layer.name,
          bounds: layer.bounds,
          pointCount: layer.pointCount,
        });
      }
      const residency = await window.himmelcad?.externalImport.residency<{
        readonly entries: readonly {
          readonly admission: unknown;
          readonly dataset: {
            readonly datasetId: string;
            readonly formatId: string;
            readonly entityId: string;
            readonly representationSlot: string;
            readonly metadataUrl: string;
          } | null;
        }[];
      }>();
      const canonicalAdmissions: CanonicalRepresentationAdmission[] = [];
      for (const entry of residency?.entries ?? []) {
        const admissions = previewAdmissions({ admissions: [entry.admission] }, undefined);
        const admission = admissions[0];
        if (!admission) continue;
        canonicalAdmissions.push(admission);
        if (
          entry.dataset?.formatId === 'potree@2' &&
          admission.resolvedGeometry.kind === 'pointCloud'
        ) {
          await projectViewport.current?.loadPotreePointCloud(entry.dataset.metadataUrl, {
            entityId: admission.entity.id as EntityId,
            sourceName: admission.entity.name,
            bounds: await readPotreeBounds(entry.dataset.metadataUrl),
            pointCount: admission.resolvedGeometry.dataset.elementCount ?? 0,
            canonicalAdmission: admission,
          });
        } else if (entry.dataset === null) {
          await projectViewport.current?.loadCanonicalPackage([admission]);
        }
      }
      setCurrentAdmissions(canonicalAdmissions);
      projectViewport.current?.frameAll();
    })();
  }, [currentPointClouds]);

  useEffect(() => {
    if (!state) return;
    let active = true;
    void (async () => {
      const admissions = previewAdmissions(state.sourcePreview, state.preview?.transform);
      await sourceViewport.current?.loadCanonicalPackage(admissions);
      const materialized = await window.himmelcad?.externalImport.materialize(state.sessionId);
      if (!materialized || !active) return;
      stagedSession.current = state.sessionId;
      try {
        setPreparedSourceSamples((await session.sourceSamples(state.sessionId)).points);
      } catch {
        setPreparedSourceSamples([]);
      }
      for (const dataset of materialized.datasets) {
        if (dataset.formatId !== 'potree@2') continue;
        const admission = admissions.find(
          (candidate) =>
            candidate.entity.id === dataset.entityId &&
            candidate.representationSlot === dataset.representationSlot,
        );
        if (admission?.resolvedGeometry.kind !== 'pointCloud') continue;
        const bounds = await readPotreeBounds(dataset.metadataUrl);
        await sourceViewport.current?.loadPotreePointCloud(dataset.metadataUrl, {
          entityId: admission.entity.id as EntityId,
          sourceName: admission.entity.name,
          bounds,
          pointCount: admission.resolvedGeometry.dataset.elementCount ?? 0,
          canonicalAdmission: admission,
        });
      }
      sourceViewport.current?.frameAll();
    })();
    return () => {
      active = false;
    };
  }, [session, state]);

  useEffect(
    () => () => {
      if (stagedSession.current) {
        void window.himmelcad?.externalImport.revoke(stagedSession.current);
      }
    },
    [],
  );

  const stage = async (recipe: RegistrationRecipe): Promise<void> => {
    setBusy(true);
    try {
      setState(await session.stage(sourcePath, recipe));
      setPairs([]);
      setPendingSource(null);
      setPreparedSourceSamples([]);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (): Promise<void> => {
    if (state) {
      await window.himmelcad?.externalImport.revoke(state.sessionId);
      await session.cancel(state.sessionId);
    }
    onClose();
  };
  const requestPick = (side: 'source' | 'target'): void => {
    if (side === 'source') {
      if (sourceSnap) setPendingSource(toPoint(sourceSnap));
      return;
    }
    if (!pendingSource || !targetSnap) return;
    setPairs((current) => [
      ...current,
      { pairId: `pair-${current.length + 1}`, source: pendingSource, target: toPoint(targetSnap) },
    ]);
    setPendingSource(null);
  };
  const previewPairs = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    try {
      setState(await session.previewPointPairs(state.sessionId, pairs));
    } finally {
      setBusy(false);
    }
  };
  const commit = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    try {
      await session.commit(state.sessionId);
      await window.himmelcad?.externalImport.revoke(state.sessionId);
      await onCommitted();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const previewIcp = async (): Promise<void> => {
    if (!state) return;
    const source =
      preparedSourceSamples.length >= 3
        ? preparedSourceSamples
        : collectInlineSource(previewAdmissions(state.sourcePreview, undefined));
    const target = collectInlineTargets(currentAdmissions);
    if (source.length < 3 || target.length < 3) return;
    const mode = target.every((sample) => sample.normal) ? 'pointToPlane' : 'pointToPoint';
    setBusy(true);
    try {
      setState(
        await session.previewIcp({
          sessionId: state.sessionId,
          source,
          target,
          initial: state.preview?.transform ?? identitySimilarity,
          mode,
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
      {...((preparedSourceSamples.length >= 3 ||
        collectInlineSource(state ? previewAdmissions(state.sourcePreview, undefined) : [], 3)
          .length >= 3) &&
      collectInlineTargets(currentAdmissions, 3).length >= 3
        ? { onPreviewIcp: () => void previewIcp() }
        : {})}
      onCommit={() => void commit()}
      onCancel={() => void cancel()}
      sourceView={
        <div className={styles.viewport}>
          <PhotolabKernelViewport
            ref={sourceViewport}
            onCursorSnap={setSourceSnap}
            onLog={() => undefined}
          />
        </div>
      }
      projectView={
        <div className={styles.viewport}>
          <PhotolabKernelViewport
            ref={projectViewport}
            onCursorSnap={setTargetSnap}
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

function toPoint(snap: SnapResult): RegistrationPoint {
  return { x: snap.position.x, y: snap.position.y, z: snap.position.z ?? 0 };
}

function collectInlineSource(
  admissions: readonly CanonicalRepresentationAdmission[],
  maximum = 2_048,
): RegistrationPoint[] {
  const points: RegistrationPoint[] = [];
  for (const admission of admissions) {
    const mesh = inlineMesh(admission);
    if (!mesh) continue;
    for (const position of mesh.positions)
      points.push(applyPlacement(position, admission.entity.placement));
  }
  return deterministicSubset(points, maximum);
}

function collectInlineTargets(
  admissions: readonly CanonicalRepresentationAdmission[],
  maximum = 2_048,
): RegistrationTargetSample[] {
  const samples: RegistrationTargetSample[] = [];
  for (const admission of admissions) {
    const mesh = inlineMesh(admission);
    if (!mesh) continue;
    for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
      const a = mesh.positions[mesh.indices[index] ?? -1];
      const b = mesh.positions[mesh.indices[index + 1] ?? -1];
      const c = mesh.positions[mesh.indices[index + 2] ?? -1];
      if (!a || !b || !c) continue;
      const world = [a, b, c].map((point) => applyPlacement(point, admission.entity.placement));
      const normal = normalOf(world[0]!, world[1]!, world[2]!);
      for (const position of world) samples.push({ position, normal });
    }
  }
  return deterministicSubset(samples, maximum);
}

function inlineMesh(admission: CanonicalRepresentationAdmission): {
  readonly positions: readonly RegistrationPoint[];
  readonly indices: readonly number[];
} | null {
  const geometry = admission.resolvedGeometry;
  const mesh =
    geometry.kind === 'surface3d'
      ? geometry.mesh
      : geometry.kind === 'solid' && geometry.solid.kind === 'closedMesh'
        ? geometry.solid.mesh
        : null;
  return mesh?.storage.kind === 'inline' ? mesh.storage : null;
}

function deterministicSubset<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values];
  return Array.from(
    { length: maximum },
    (_, index) => values[Math.floor((index * values.length) / maximum)]!,
  );
}

function applyPlacement(
  point: RegistrationPoint,
  matrix: CanonicalRepresentationAdmission['entity']['placement'],
): RegistrationPoint {
  if (!matrix) return point;
  return {
    x: matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12],
    y: matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13],
    z: matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14],
  };
}

function normalOf(
  a: RegistrationPoint,
  b: RegistrationPoint,
  c: RegistrationPoint,
): RegistrationPoint {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const normal = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

function previewAdmissions(
  value: unknown,
  preview: RegistrationSimilarity3d | undefined,
): readonly CanonicalRepresentationAdmission[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.admissions) ||
    !value.admissions.every(isAdmission)
  ) {
    throw new Error('registration source preview is invalid');
  }
  if (!preview) return value.admissions;
  const outer = similarityMatrix(preview);
  return value.admissions.map((admission) => ({
    ...admission,
    entity: {
      ...admission.entity,
      placement: compose(outer, admission.entity.placement ?? identityMatrix),
    },
  }));
}

function isAdmission(value: unknown): value is CanonicalRepresentationAdmission {
  return (
    isRecord(value) &&
    isRecord(value.entity) &&
    typeof value.entity.id === 'string' &&
    typeof value.representationSlot === 'string' &&
    isRecord(value.resolvedGeometry)
  );
}

const identityMatrix: Placement = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function similarityMatrix(value: RegistrationSimilarity3d): Placement {
  const [cx, sx] = [Math.cos(value.rxRadians), Math.sin(value.rxRadians)];
  const [cy, sy] = [Math.cos(value.ryRadians), Math.sin(value.ryRadians)];
  const [cz, sz] = [Math.cos(value.rzRadians), Math.sin(value.rzRadians)];
  const s = value.scale;
  return [
    s * cy * cz,
    s * cy * sz,
    s * -sy,
    0,
    s * (sx * sy * cz - cx * sz),
    s * (sx * sy * sz + cx * cz),
    s * sx * cy,
    0,
    s * (cx * sy * cz + sx * sz),
    s * (cx * sy * sz - sx * cz),
    s * cx * cy,
    0,
    value.tx,
    value.ty,
    value.tz,
    1,
  ];
}

function compose(outer: Placement, inner: Placement): Placement {
  const at = (column: number, row: number): number =>
    [0, 1, 2, 3].reduce(
      (sum, index) => sum + outer[index * 4 + row]! * inner[column * 4 + index]!,
      0,
    );
  return [
    at(0, 0),
    at(0, 1),
    at(0, 2),
    at(0, 3),
    at(1, 0),
    at(1, 1),
    at(1, 2),
    at(1, 3),
    at(2, 0),
    at(2, 1),
    at(2, 2),
    at(2, 3),
    at(3, 0),
    at(3, 1),
    at(3, 2),
    at(3, 3),
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
    throw new Error('staged Potree metadata has no bounds');
  }
  return { min: tuple(metadata.boundingBox.min), max: tuple(metadata.boundingBox.max) };
}

function tuple(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => typeof item !== 'number')
  ) {
    throw new Error('staged Potree bound is invalid');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
