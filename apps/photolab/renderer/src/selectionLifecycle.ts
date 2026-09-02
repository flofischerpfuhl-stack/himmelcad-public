import type { EntityId, ProjectSnapshot } from '@himmelcad/data';

/** Keeps explicit user intent while pruning ids absent from the accepted snapshot. */
export function revalidateSelection(
  selection: ReadonlySet<EntityId>,
  snapshot: Pick<ProjectSnapshot, 'entities'>,
): ReadonlySet<EntityId> {
  let next: Set<EntityId> | null = null;
  for (const id of selection) {
    if (snapshot.entities[id]) continue;
    next ??= new Set(selection);
    next.delete(id);
  }
  return next ?? selection;
}
