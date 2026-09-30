/**
 * Imported structure → Items folders (Shapr3D: "STEP assemblies are
 * imported into nested Items folders"). Folders are Items properties
 * (`model/items.ts`), not History steps, so they are created next to the
 * import step:
 *
 * - reference meshes (3MF objects, OBJ groups) are filed right when they
 *   are added (`fileRowsIntoFolders`);
 * - STEP assembly parts exist only after the kernel evaluated the import
 *   step, so the import registers its feature id
 *   (`notifyAssemblyImported`) and `installAssemblyFolderSync` files that
 *   feature's bodies (`Body.itemPath`) once, when they first appear. A
 *   body is never filed again afterwards: moving it elsewhere, undo/redo or
 *   reopening the project keep the user's arrangement.
 */
import type { Body } from '../foundation/geometry-kernel/types.js';
import { bodyRowKey, useItemsStore } from '../interface/shell-ui/items.js';

export interface FolderRow {
  /** Items row key (`body:<id>`, `mesh:<id>`). */
  key: string;
  /** Folder names from the top level down; empty = stay at the top level. */
  path: readonly string[];
}

/**
 * Creates the folders of `rows` (a new set per call, so a second import of
 * the same file gets its own folders) and moves each row into its folder.
 * Returns the created folder ids by path (`a/b`).
 */
export function fileRowsIntoFolders(rows: readonly FolderRow[]): Map<string, string> {
  const created = new Map<string, string>();
  const items = useItemsStore.getState();
  for (const row of rows) {
    if (row.path.length === 0) continue;
    let parent: string | null = null;
    for (let depth = 1; depth <= row.path.length; depth += 1) {
      const key = row.path.slice(0, depth).join('/');
      let id = created.get(key);
      if (!id) {
        id = items.createFolder({ name: row.path[depth - 1]!, parentId: parent });
        created.set(key, id);
      }
      parent = id;
    }
    items.moveToFolder([row.key], parent);
  }
  return created;
}

const pending = new Set<string>();

/** An import step with assembly structure was created: file its bodies when they appear. */
export function notifyAssemblyImported(featureId: string): void {
  pending.add(featureId);
}

/** `true` if the import step's bodies still wait to be filed (tests). */
export function assemblyFilingPending(featureId: string): boolean {
  return pending.has(featureId);
}

/**
 * Files the bodies of pending import steps found in `bodies` (called with
 * every new evaluation). Returns the feature ids filed now.
 */
export function fileImportedAssemblies(bodies: readonly Body[]): string[] {
  if (pending.size === 0) return [];
  const filed: string[] = [];
  for (const featureId of [...pending]) {
    const parts = bodies.filter((b) => b.createdBy === featureId);
    if (parts.length === 0) continue;
    pending.delete(featureId);
    filed.push(featureId);
    const rows = parts
      .filter((b) => b.itemPath && b.itemPath.length > 0)
      .map((b) => ({ key: bodyRowKey(b.id), path: b.itemPath! }));
    if (rows.length > 0) fileRowsIntoFolders(rows);
  }
  return filed;
}

/** Subscribes `fileImportedAssemblies` to a store's evaluation (the app's assembler store). */
export function installAssemblyFolderSync(store: {
  subscribe(
    listener: (
      state: { evaluation: { bodies: Body[] } },
      prev: { evaluation: { bodies: Body[] } },
    ) => void,
  ): () => void;
}): () => void {
  return store.subscribe((state, prev) => {
    if (state.evaluation !== prev.evaluation) fileImportedAssemblies(state.evaluation.bodies);
  });
}
