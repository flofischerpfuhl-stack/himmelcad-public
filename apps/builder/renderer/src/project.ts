import type {
  EntityId,
  EntityKind,
  EntitySnapshot,
  ObjectHash,
  ProjectSnapshot,
} from '@himmelcad/data';

const ROOT_ID = 'root' as EntityId;

const FAKE_HASH = '0000000000000000' as ObjectHash;

export interface ImportSummary {
  entityId: EntityId;
  kind: EntityKind;
  name: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  pointCount: number;
}

/**
 * Builds the in-renderer ProjectSnapshot. The Rust core will own this once the
 * authoritative project store lands (Workstream 4); for now the renderer
 * mutates a local snapshot so the EntityTree has something to display after
 * a LAS import.
 */
export function createEmptyProject(): ProjectSnapshot {
  const root: EntitySnapshot = {
    id: ROOT_ID,
    kind: 'ProjectRoot',
    name: 'Untitled',
    parent: null,
    children: [],
    visibility: { visible: true, locked: false },
    versionHash: FAKE_HASH,
    bounds: null,
  };
  return {
    formatVersion: 1,
    projectId: 'local-' + Math.random().toString(36).slice(2, 10),
    name: 'Untitled',
    rootEntity: ROOT_ID,
    entities: { [ROOT_ID]: root },
    renderOffset: { x: 0, y: 0, z: 0 },
  };
}

export function applyImportToProject(
  prev: ProjectSnapshot,
  summary: ImportSummary,
): ProjectSnapshot {
  const child: EntitySnapshot = {
    id: summary.entityId,
    kind: summary.kind,
    name: summary.name,
    parent: ROOT_ID,
    children: [],
    visibility: { visible: true, locked: false },
    versionHash: FAKE_HASH,
    bounds: {
      min: { x: summary.bounds.min[0], y: summary.bounds.min[1], z: summary.bounds.min[2] },
      max: { x: summary.bounds.max[0], y: summary.bounds.max[1], z: summary.bounds.max[2] },
    },
  };
  const root = prev.entities[ROOT_ID];
  if (!root) return prev;
  const newRoot: EntitySnapshot = {
    ...root,
    children: [...root.children, summary.entityId],
  };
  return {
    ...prev,
    entities: {
      ...prev.entities,
      [ROOT_ID]: newRoot,
      [summary.entityId]: child,
    },
  };
}
