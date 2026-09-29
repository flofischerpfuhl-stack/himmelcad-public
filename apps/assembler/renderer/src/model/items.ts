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

import type { Body } from '../kernel/types.js';

export interface ItemFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface ItemsMeta {
  /** Body id → display name chosen by the user. */
  names: Record<string, string>;
  folders: ItemFolder[];
  /** Row key (`body:<bodyId>`, `sketch:<featureId>`, `folder:<id>`) → containing folder id. */
  parent: Record<string, string>;
}

export const EMPTY_ITEMS_META: ItemsMeta = { names: {}, folders: [], parent: {} };

export function bodyRowKey(bodyId: string): string {
  return `body:${bodyId}`;
}
export function sketchRowKey(featureId: string): string {
  return `sketch:${featureId}`;
}
export function folderRowKey(folderId: string): string {
  return `folder:${folderId}`;
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
  kind: 'body' | 'sketch';
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

/**
 * Nested tree of folders and rows. Rows keep their given order; a row whose
 * folder no longer exists is shown at the top level. Folders come first
 * within each level, in creation order.
 */
export function buildItemTree(rows: readonly LeafRow[], meta: ItemsMeta): ItemNode[] {
  const folderIds = new Set(meta.folders.map((f) => f.id));
  const parentOf = (key: string): string | null => {
    const p = meta.parent[key];
    return p && folderIds.has(p) ? p : null;
  };
  const build = (parent: string | null): ItemNode[] => {
    const folders: ItemNode[] = meta.folders
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
  /** Creates a folder (optionally inside `parentId`, holding `keys`); returns its id. */
  createFolder: (options?: { name?: string; keys?: string[]; parentId?: string | null }) => string;
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

export function isEmptyItemsMeta(meta: ItemsMeta): boolean {
  return (
    Object.keys(meta.names).length === 0 &&
    meta.folders.length === 0 &&
    Object.keys(meta.parent).length === 0
  );
}
