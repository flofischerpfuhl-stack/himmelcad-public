import type { JournalMirror } from '@himmelcad/app';
import type {
  EntityId,
  EntityKind,
  EntitySnapshot,
  ObjectHash,
  ProjectSnapshot,
} from '@himmelcad/data';

export function projectSnapshotFromJournalMirror(mirror: JournalMirror): ProjectSnapshot {
  const canonicalEntities = Object.values(mirror.entities);
  const root =
    canonicalEntities.find((entity) => entity.id === 'project-root') ??
    canonicalEntities.find((entity) => entity.owner === null && entity.typeId === 'hcad.group@1') ??
    canonicalEntities[0];
  if (root === undefined) throw new Error('canonical project snapshot has no live root entity');

  const liveIds = new Set(canonicalEntities.map((entity) => entity.id));
  const childrenByParent = new Map<string, EntityId[]>();
  const parentByEntity = new Map<string, EntityId | null>();
  for (const entity of canonicalEntities) {
    if (entity.id === root.id) {
      parentByEntity.set(entity.id, null);
      continue;
    }
    // Providers may stage a top-level entity before a registration workflow
    // assigns an explicit owner. The UI projects it below the one canonical
    // project root without rewriting the canonical envelope.
    const parent =
      entity.owner !== null && entity.owner !== entity.id && liveIds.has(entity.owner)
        ? (entity.owner as EntityId)
        : (root.id as EntityId);
    parentByEntity.set(entity.id, parent);
    const children = childrenByParent.get(parent) ?? [];
    children.push(entity.id as EntityId);
    childrenByParent.set(parent, children);
  }

  const entities: Record<string, EntitySnapshot> = {};
  for (const entity of canonicalEntities) {
    entities[entity.id] = {
      id: entity.id as EntityId,
      kind: entityKind(entity.typeId, entity.id === root.id),
      name: entity.name,
      parent: parentByEntity.get(entity.id) ?? null,
      children: childrenByParent.get(entity.id) ?? [],
      visibility: { visible: true, locked: false },
      versionHash: entity.versionHash as ObjectHash,
      // Bounds belong to resolved representations, not the canonical entity
      // envelope. The tree must not invent them from importer summaries.
      bounds: null,
    };
  }

  return {
    formatVersion: 1,
    projectId: root.id,
    name: root.name,
    rootEntity: root.id as EntityId,
    entities,
    renderOffset: { x: 0, y: 0, z: 0 },
  };
}

function entityKind(typeId: string, isRoot: boolean): EntityKind {
  if (isRoot) return 'ProjectRoot';
  switch (typeId) {
    case 'hcad.group@1':
      return 'Group';
    case 'hcad.layer@1':
      return 'Layer';
    case 'hcad.point@1':
      return 'SinglePoint';
    case 'hcad.curve@1':
      return 'Polyline3D';
    case 'hcad.elevation-surface@1':
      return 'Surface';
    case 'hcad.surface-3d@1':
      return 'Mesh';
    case 'hcad.raster-image@1':
      return 'Orthomosaic';
    case 'hcad.point-cloud@1':
      return 'PointCloud';
    case 'hcad.gaussian-splat-cloud@1':
      return 'GaussianSplatCloud';
    case 'hcad.bim-object@1':
      return 'IfcElement';
    case 'hcad.text@1':
    case 'hcad.label@1':
      return 'Text';
    default:
      return 'Object';
  }
}
