import type {
  AlignmentMergeConnection,
  EntityId,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';

export function compatibleGcpOptimizations(
  alignmentEntityId: EntityId,
  entries: readonly PublishedGcpOptimizationEntry[],
): readonly PublishedGcpOptimizationEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.optimization.sourceAlignmentEntityId === alignmentEntityId &&
        entry.optimization.artifact.result.converged,
    )
    .sort(
      (left, right) =>
        left.optimization.publicationSequence - right.optimization.publicationSequence ||
        left.entityId.localeCompare(right.entityId),
    );
}

export function commonControlPointIds(
  entries: readonly PublishedGcpOptimizationEntry[],
): readonly string[] {
  const controls = entries.map(
    (entry) =>
      new Set(
        entry.optimization.artifact.result.residuals
          .filter((residual) => residual.role.startsWith('control'))
          .map((residual) => residual.pointId),
      ),
  );
  const first = controls[0];
  if (!first || entries.length === 0) return [];
  return [...first].filter((id) => controls.every((set) => set.has(id))).sort();
}

export function completeAlignmentConnections(
  alignmentIds: readonly EntityId[],
  mode: 'overlap' | 'sharedControls',
  controlPointIds: readonly string[],
): AlignmentMergeConnection[] {
  return alignmentIds.flatMap((alignmentA, left) =>
    alignmentIds.slice(left + 1).map((alignmentB) =>
      mode === 'overlap'
        ? {
            kind: 'overlap' as const,
            alignmentA,
            alignmentB,
            verifiedCrossRunTrackCount: 0,
          }
        : {
            kind: 'sharedControls' as const,
            alignmentA,
            alignmentB,
            controlPointIds: [...controlPointIds],
          },
    ),
  );
}
