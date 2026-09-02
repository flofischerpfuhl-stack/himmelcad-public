import type {
  AlignmentMergeCandidateRecord,
  EntityId,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';

export interface LineageLabel {
  text: string;
  title: string;
}

export function hash8(value: string): string {
  return value.slice(0, 8);
}

export function shortOperationId(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function entitySuffix8(value: string): string {
  return (value.split(':').at(-1) ?? value).slice(0, 8);
}

export function formatAlignmentLineageLabel(
  entityId: EntityId,
  candidates: readonly AlignmentMergeCandidateRecord[],
): LineageLabel {
  const candidate = candidates.find((item) => item.entityId === entityId);
  return {
    text: candidate
      ? `${candidate.name} · ${hash8(candidate.versionSha256)}`
      : `Alignment · ${entitySuffix8(entityId)}`,
    title: entityId,
  };
}

export function formatGcpRevisionLineageLabel(
  entityId: EntityId,
  optimizations: readonly PublishedGcpOptimizationEntry[],
): LineageLabel {
  const entry = optimizations.find((item) => item.entityId === entityId);
  return {
    text: entry
      ? `${shortOperationId(entry.optimization.operationId)} · ${hash8(entry.optimization.snapshotSha256)}`
      : `GCP revision · ${entitySuffix8(entityId)}`,
    title: entityId,
  };
}
