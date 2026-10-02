/**
 * Items organisation: body display names and folders (interaction research
 * §3 — the Items Manager is the scene-item tree, separate from the feature
 * History). Decision (recorded in `assembler/SELECTION-NAVIGATION.md`):
 *
 * - **Names and folders are item properties**, stored in the project file's
 *   `items` section, not History steps: renaming or filing a body does not
 *   change geometry, so it must not appear as a parametric step, and it
 *   survives edits of earlier steps because bodies are keyed by their stable
 *   id (`body:<creating feature id>`). Not in the undo history (like
 *   visibility).
 * - **Colour is a document feature** (`setAppearance`, already evaluated by
 *   the kernel): it is undoable, travels with the body through booleans and
 *   copies, and reaches STEP/3MF export through `Body.color`.
 */
import { create } from 'zustand';

import type { Body } from '../geometry-kernel/types.js';

export interface ItemFolder {
  id: string;
  name: string;
  collapsed: boolean;
  /**
   * The History step whose bodies this folder was made for (Pattern 3D
   * copies, `stepFolders.ts`). While that step is not in the document
   * (undone, deleted) the folder is not shown and its rows sit one level up;
   * a redo shows it again. Absent: a folder the user made.
   */
  featureId?: string;
}

export interface ItemsMeta {
  /** Body id → display name chosen by the user. */
  names: Record<string, string>;
  folders: ItemFolder[];
  /** Row key (`body:<bodyId>`, `sketch:<featureId>`, `mesh:<referenceMeshId>`, `folder:<id>`) → containing folder id. */
  parent: Record<string, string>;
}

export const EMPTY_ITEMS_META: ItemsMeta = { names: {}, folders: [], parent: {} };

export function bodyRowKey(bodyId: string): string {
  return `body:${bodyId}`;
}
export function sketchRowKey(featureId: string): string {
  return `sketch:${featureId}`;
}
/** An imported STL reference mesh (`model/referenceMesh.ts`; its name lives on the mesh itself). */
export function meshRowKey(meshId: string): string {
  return `mesh:${meshId}`;
}
export function folderRowKey(folderId: string): string {
  return `folder:${folderId}`;
}
/** A construction plane or axis (`model/construction.ts`; its name is the History step's). */
export function datumRowKey(featureId: string): string {
  return `datum:${featureId}`;
}
/** A reference image (canvas module; its name is the History step's). */
export function imageRowKey(featureId: string): string {
  return `image:${featureId}`;
}

export function displayBodyName(body: Pick<Body, 'id' | 'name'>, meta: ItemsMeta): string {
  return meta.names[body.id] ?? body.name;
}

/** Bodies with their user-given names (exports, API read-outs). */
export function withDisplayNames<T extends Pick<Body, 'id' | 'name'>>(
  bodies: readonly T[],
  meta: ItemsMeta,
): T[] {
  return bodies.map((b) => (meta.names[b.id] ? { ...b, name: meta.names[b.id]! } : b));
}

// ---- tree ------------------------------------------------------------------------------------

export interface LeafRow {
  key: string;
  kind: 'body' | 'sketch' | 'mesh' | 'plane' | 'axis' | 'image';
}

export type ItemNode =
  | { type: 'folder'; folder: ItemFolder; key: string; children: ItemNode[] }
  | { type: 'leaf'; row: LeafRow; key: string };

/** `true` if `folderId` is `ancestorId` or lies inside it. */
export function isInsideFolder(meta: ItemsMeta, folderId: string, ancestorId: string): boolean {
  let current: string | undefined = folderId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = meta.parent[folderRowKey(current)];
  }
  return false;
}

/** Folders made for a step that is not in the document (`ItemFolder.featureId`). */
export function absentStepFolderIds(
  meta: Pick<ItemsMeta, 'folders'>,
  liveFeatureIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    meta.folders
      .filter((f) => f.featureId !== undefined && !liveFeatureIds.has(f.featureId))
      .map((f) => f.id),
  );
}

/**
 * Nested tree of folders and rows. Rows keep their given order; a row whose
 * folder no longer exists is shown at the top level. Folders come first
 * within each level, in creation order. With `liveFeatureIds`, a folder made
 * for a step that is not in the document is left out and its contents move
 * one level up (`ItemFolder.featureId`).
 */
export function buildItemTree(
  rows: readonly LeafRow[],
  meta: ItemsMeta,
  liveFeatureIds?: ReadonlySet<string>,
): ItemNode[] {
  const absent = liveFeatureIds ? absentStepFolderIds(meta, liveFeatureIds) : new Set<string>();
  const folderIds = new Set(meta.folders.filter((f) => !absent.has(f.id)).map((f) => f.id));
  const parentOf = (key: string): string | null => {
    let p: string | undefined = meta.parent[key];
    const seen = new Set<string>();
    // An absent step folder passes its rows to its own parent.
    while (p && absent.has(p) && !seen.has(p)) {
      seen.add(p);
      p = meta.parent[folderRowKey(p)];
    }
    return p && folderIds.has(p) ? p : null;
  };
  const build = (parent: string | null): ItemNode[] => {
    const folders: ItemNode[] = meta.folders
      .filter((f) => !absent.has(f.id))
      .filter((f) => parentOf(folderRowKey(f.id)) === parent && f.id !== parent)
      .map((folder) => ({
        type: 'folder' as const,
        folder,
        key: folderRowKey(folder.id),
        children: build(folder.id),
      }));
    const leaves: ItemNode[] = rows
      .filter((row) => parentOf(row.key) === parent)
      .map((row) => ({ type: 'leaf' as const, row, key: row.key }));
    return [...folders, ...leaves];
  };
  return build(null);
}

/** Every leaf row key inside a folder node (recursively). */
export function leafKeys(node: ItemNode): string[] {
  if (node.type === 'leaf') return [node.row.key];
  return node.children.flatMap(leafKeys);
}

/** Leaves in display order, skipping the contents of collapsed folders (range selection, keyboard). */
export function visibleLeafOrder(nodes: readonly ItemNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === 'leaf'
      ? [node.row.key]
      : node.folder.collapsed
        ? []
        : visibleLeafOrder(node.children),
  );
}

// ---- store -----------------------------------------------------------------------------------

let folderCounter = 0;

function newFolderId(existing: readonly ItemFolder[]): string {
  const taken = new Set(existing.map((f) => f.id));
  let id: string;
  do {
    folderCounter += 1;
    id = `folder-${folderCounter}`;
  } while (taken.has(id));
  return id;
}

export function nextFolderName(folders: readonly ItemFolder[]): string {
  let n = folders.length + 1;
  while (folders.some((f) => f.name === `Folder ${n}`)) n += 1;
  return `Folder ${n}`;
}

export interface ItemsState extends ItemsMeta {
  renameBody: (bodyId: string, name: string | null) => void;
  /** Creates a folder (optionally inside `parentId`, holding `keys`, made for step `featureId`); returns its id. */
  createFolder: (options?: {
    name?: string;
    keys?: string[];
    parentId?: string | null;
    featureId?: string;
  }) => string;
  renameFolder: (folderId: string, name: string) => void;
  /** Deletes a folder; its contents move to the folder's parent. */
  deleteFolder: (folderId: string) => void;
  toggleCollapsed: (folderId: string, collapsed?: boolean) => void;
  /** Moves rows/folders into `folderId` (`null` = top level). Refuses to nest a folder in itself. */
  moveToFolder: (keys: string[], folderId: string | null) => boolean;
  /** Replaces everything (project load/new). */
  setItemsMeta: (meta: ItemsMeta) => void;
}

export const useItemsStore = create<ItemsState>((set, get) => ({
  ...EMPTY_ITEMS_META,
  renameBody: (bodyId, name) =>
    set((s) => {
      const names = { ...s.names };
      const trimmed = name?.trim();
      if (trimmed) names[bodyId] = trimmed;
      else delete names[bodyId];
      return { names };
    }),
  createFolder: (options) => {
    const state = get();
    const id = newFolderId(state.folders);
    const folder: ItemFolder = {
      id,
      name: options?.name?.trim() || nextFolderName(state.folders),
      collapsed: false,
      ...(options?.featureId ? { featureId: options.featureId } : {}),
    };
    const parent = { ...state.parent };
    if (options?.parentId) parent[folderRowKey(id)] = options.parentId;
    for (const key of options?.keys ?? []) parent[key] = id;
    set({ folders: [...state.folders, folder], parent });
    return id;
  },
  renameFolder: (folderId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({
      folders: s.folders.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)),
    }));
  },
  deleteFolder: (folderId) =>
    set((s) => {
      const up = s.parent[folderRowKey(folderId)];
      const parent: Record<string, string> = {};
      for (const [key, value] of Object.entries(s.parent)) {
        if (key === folderRowKey(folderId)) continue;
        if (value === folderId) {
          if (up) parent[key] = up;
        } else parent[key] = value;
      }
      return { folders: s.folders.filter((f) => f.id !== folderId), parent };
    }),
  toggleCollapsed: (folderId, collapsed) =>
    set((s) => ({
      folders: s.folders.map((f) =>
        f.id === folderId ? { ...f, collapsed: collapsed ?? !f.collapsed } : f,
      ),
    })),
  moveToFolder: (keys, folderId) => {
    const state = get();
    if (folderId && !state.folders.some((f) => f.id === folderId)) return false;
    for (const key of keys) {
      if (!key.startsWith('folder:') || !folderId) continue;
      if (isInsideFolder(state, folderId, key.slice('folder:'.length))) return false;
    }
    const parent = { ...state.parent };
    for (const key of keys) {
      if (folderId) parent[key] = folderId;
      else delete parent[key];
    }
    set({ parent });
    return true;
  },
  setItemsMeta: (meta) =>
    set({
      names: { ...meta.names },
      folders: meta.folders.map((f) => ({ ...f })),
      parent: { ...meta.parent },
    }),
}));

export function itemsMetaSnapshot(state: ItemsMeta): ItemsMeta {
  return { names: state.names, folders: state.folders, parent: state.parent };
}

/**
 * `meta` without the folders made for steps that are no longer in the
 * document (their rows move up to the folder's parent): what Save writes, as
 * no undo can bring those steps back after the project is reopened.
 */
export function withoutAbsentStepFolders(
  meta: ItemsMeta,
  liveFeatureIds: ReadonlySet<string>,
): ItemsMeta {
  const absent = absentStepFolderIds(meta, liveFeatureIds);
  if (absent.size === 0) return meta;
  const up = (folderId: string): string | undefined => {
    let p: string | undefined = folderId;
    const seen = new Set<string>();
    while (p && absent.has(p) && !seen.has(p)) {
      seen.add(p);
      p = meta.parent[folderRowKey(p)];
    }
    return p;
  };
  const parent: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta.parent)) {
    if (key.startsWith('folder:') && absent.has(key.slice('folder:'.length))) continue;
    const target = up(value);
    if (target) parent[key] = target;
  }
  return { names: meta.names, folders: meta.folders.filter((f) => !absent.has(f.id)), parent };
}

export function isEmptyItemsMeta(meta: ItemsMeta): boolean {
  return (
    Object.keys(meta.names).length === 0 &&
    meta.folders.length === 0 &&
    Object.keys(meta.parent).length === 0
  );
}
