/**
 * Items panel (left): the scene-item tree (interaction research §3) —
 * bodies, STL reference meshes and sketches, organised in folders. Rows show
 * a type icon (bodies: their colour), the name (double-click or F2 renames a
 * body, reference mesh or folder),
 * isolate and visibility. Folders collapse, their eye toggles every child,
 * rows are dragged onto a folder (or the panel background for the top
 * level). Click selects (Ctrl/Cmd adds, Shift range), hover highlights the
 * geometry, right-click opens the shared context menu. Header: type filter,
 * new folder, and the options menu (show hidden items, invert visibility).
 * "Reveal in Items" (viewport context menu) scrolls to and flashes a row.
 */
import {
  Axis3d,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  PenSquare,
  SquareDashed,
  Target,
  ZoomIn,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Menu,
  MenuItem,
  MenuSeparator,
  Tooltip,
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { findCommand } from '../../foundation/commands/registry.js';
import {
  bodyRowKey,
  buildItemTree,
  displayBodyName,
  folderRowKey,
  leafKeys,
  datumRowKey,
  meshRowKey,
  sketchRowKey,
  useItemsStore,
  visibleLeafOrder,
  type ItemNode,
  type LeafRow,
} from './items.js';
import { consumedSketchIds, isSketchVisible } from '../../model/modeling.js';
import type { AssemblerState, SelectionItem } from '../../foundation/commands/store.js';
import { useWorkspaceStore } from './workspace.js';
import { useSketchStore } from '../../sketch/session.js';
import { anchoredMenuStyle } from '../../platform/widgets/anchoredMenu.js';
import panelStyles from '../../platform/widgets/Panel.module.css';
import styles from './ItemsPanel.module.css';

type TypeFilter = 'all' | 'bodies' | 'sketches' | 'meshes' | 'construction';

/** Whether a row passes the Items type filter ("Bodies" lists solids and reference meshes). */
function passesFilter(filter: TypeFilter, kind: RowInfo['kind']): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'bodies':
      return kind === 'body' || kind === 'mesh';
    case 'sketches':
      return kind === 'sketch';
    case 'meshes':
      return kind === 'mesh';
    case 'construction':
      return kind === 'plane' || kind === 'axis';
  }
}

const FILTER_LABEL: Record<TypeFilter, string> = {
  all: 'All',
  bodies: 'Bodies',
  sketches: 'Sketches',
  meshes: 'Meshes',
  // Short enough for the segmented filter row (planes and axes).
  construction: 'Datums',
};

const DRAG_MIME = 'application/x-hcasm-items';

interface RowInfo {
  key: string;
  kind: 'body' | 'sketch' | 'mesh' | 'plane' | 'axis';
  item: SelectionItem;
  name: string;
  color?: string;
}

export interface ItemsPanelProps {
  state: AssemblerState;
  onContextMenu: (x: number, y: number) => void;
}

function selectionEquals(a: SelectionItem, b: SelectionItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'body' && b.kind === 'body') return a.bodyId === b.bodyId;
  if (a.kind === 'sketchProfile' && b.kind === 'sketchProfile') return a.featureId === b.featureId;
  if (a.kind === 'mesh' && b.kind === 'mesh') return a.meshId === b.meshId;
  if (a.kind === 'datum' && b.kind === 'datum') return a.featureId === b.featureId;
  return false;
}

export function ItemsPanel({ state, onContextMenu }: ItemsPanelProps): JSX.Element {
  const meta = useItemsStore();
  const revealRequest = useWorkspaceStore((s) => s.revealRequest);
  const renameRequest = useWorkspaceStore((s) => s.renameRequest);
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const consumed = consumedSketchIds(state.features);
  const rows = useMemo(() => {
    const map = new Map<string, RowInfo>();
    for (const body of state.evaluation.bodies) {
      map.set(bodyRowKey(body.id), {
        key: bodyRowKey(body.id),
        kind: 'body',
        item: { kind: 'body', bodyId: body.id },
        name: displayBodyName(body, meta),
        color: body.color,
      });
    }
    // Imported STL reference meshes: shown, hidden, renamed and filed like bodies,
    // never kernel inputs (`model/referenceMesh.ts`).
    for (const mesh of state.referenceMeshes) {
      map.set(meshRowKey(mesh.id), {
        key: meshRowKey(mesh.id),
        kind: 'mesh',
        item: { kind: 'mesh', meshId: mesh.id },
        name: mesh.name,
      });
    }
    for (const sketch of state.evaluation.sketches) {
      const feature = state.features.find((f) => f.id === sketch.featureId);
      map.set(sketchRowKey(sketch.featureId), {
        key: sketchRowKey(sketch.featureId),
        kind: 'sketch',
        item: { kind: 'sketchProfile', featureId: sketch.featureId },
        name: feature?.name ?? sketch.featureId,
      });
    }
    // Construction planes and axes (Shapr3D Items lists planes and axes with their own icons).
    for (const datum of state.evaluation.datums ?? []) {
      const feature = state.features.find((f) => f.id === datum.featureId);
      map.set(datumRowKey(datum.featureId), {
        key: datumRowKey(datum.featureId),
        kind: datum.kind,
        item: { kind: 'datum', featureId: datum.featureId },
        name: feature?.name ?? datum.featureId,
      });
    }
    return map;
  }, [state.evaluation, state.features, state.referenceMeshes, meta]);

  // "Bodies" lists solids and reference meshes; "Sketches" only sketches; "Meshes" only meshes.
  const leaves: LeafRow[] = [...rows.values()]
    .filter((r) => passesFilter(filter, r.kind))
    .map((r) => ({ key: r.key, kind: r.kind }));
  let tree = buildItemTree(leaves, meta);
  if (filter !== 'all') tree = pruneEmptyFolders(tree);
  const order = visibleLeafOrder(tree);
  const bodyCount = [...rows.values()].filter((r) => r.kind === 'body').length;
  const meshCount = [...rows.values()].filter((r) => r.kind === 'mesh').length;
  const datumCount = [...rows.values()].filter(
    (r) => r.kind === 'plane' || r.kind === 'axis',
  ).length;
  const sketchCount = rows.size - bodyCount - meshCount - datumCount;

  const isSelected = (item: SelectionItem): boolean =>
    state.selection.some((existing) => selectionEquals(existing, item));

  // "Reveal in Items": open the folders above the row, scroll to it and flash it.
  useEffect(() => {
    if (!revealRequest) return;
    const key = revealRequest.key;
    let parent = useItemsStore.getState().parent[key];
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      useItemsStore.getState().toggleCollapsed(parent, false);
      parent = useItemsStore.getState().parent[folderRowKey(parent)];
    }
    setFilter('all');
    setFlashKey(key);
    const timer = setTimeout(() => setFlashKey(null), 1600);
    requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => clearTimeout(timer);
  }, [revealRequest]);

  useEffect(() => {
    if (renameRequest) setRenamingKey(renameRequest.key);
  }, [renameRequest]);

  const selectRow = (
    key: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ): void => {
    const row = rows.get(key);
    if (!row) return;
    if (event.shiftKey && anchorKey !== null && order.includes(anchorKey)) {
      const a = order.indexOf(anchorKey);
      const b = order.indexOf(key);
      const [start, end] = a < b ? [a, b] : [b, a];
      const items = order
        .slice(start, end + 1)
        .map((k) => rows.get(k)?.item)
        .filter((i): i is SelectionItem => i !== undefined);
      state.setSelection(items);
      return;
    }
    setAnchorKey(key);
    if (event.ctrlKey || event.metaKey) state.toggle(row.item);
    else state.select(row.item);
  };

  /** Keys dragged: the selection when the dragged row is part of it, else the row. */
  const dragKeys = (key: string): string[] => {
    const row = rows.get(key);
    if (row && isSelected(row.item)) {
      return [...rows.values()].filter((r) => isSelected(r.item)).map((r) => r.key);
    }
    return [key];
  };

  const onDrop = (event: React.DragEvent, folderId: string | null) => {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    setDropTarget(null);
    if (!raw) return;
    event.preventDefault();
    event.stopPropagation();
    const keys = JSON.parse(raw) as string[];
    if (!useItemsStore.getState().moveToFolder(keys, folderId)) {
      useWorkspaceStore.getState().notify('A folder cannot be moved into itself.', 'warning');
    }
  };

  const visibilityOf = (keys: string[]): { anyVisible: boolean } => {
    let anyVisible = false;
    for (const key of keys) {
      const row = rows.get(key);
      if (!row) continue;
      if (row.item.kind === 'body' && !state.hiddenBodyIds.includes(row.item.bodyId)) {
        anyVisible = true;
      }
      if (
        row.item.kind === 'sketchProfile' &&
        isSketchVisible(row.item.featureId, consumed, state.sketchVisibility)
      ) {
        anyVisible = true;
      }
      if (row.item.kind === 'datum' && state.sketchVisibility[row.item.featureId] !== false) {
        anyVisible = true;
      }
      const meshId = row.item.kind === 'mesh' ? row.item.meshId : null;
      if (meshId && state.referenceMeshes.some((m) => m.id === meshId && !m.hidden)) {
        anyVisible = true;
      }
    }
    return { anyVisible };
  };

  const setVisible = (keys: string[], visible: boolean) => {
    const bodies: string[] = [];
    for (const key of keys) {
      const row = rows.get(key);
      if (row?.item.kind === 'body') bodies.push(row.item.bodyId);
      if (row?.item.kind === 'sketchProfile') state.setSketchVisible(row.item.featureId, visible);
      if (row?.item.kind === 'mesh') state.setReferenceMeshHidden(row.item.meshId, !visible);
      if (row?.item.kind === 'datum') state.setSketchVisible(row.item.featureId, visible);
    }
    if (visible) state.showBodies(bodies);
    else state.hideBodies(bodies);
  };

  const showAll = findCommand('edit.showAll')!;
  const invert = findCommand('edit.invertVisibility')!;
  const newFolder = () => {
    const keys = [...rows.values()].filter((r) => isSelected(r.item)).map((r) => r.key);
    const id = useItemsStore.getState().createFolder({ keys });
    setRenamingKey(folderRowKey(id));
  };

  const renderNode = (node: ItemNode, depth: number): JSX.Element | null => {
    if (node.type === 'folder') {
      const keys = leafKeys(node);
      const { anyVisible } = visibilityOf(keys);
      const folder = node.folder;
      return (
        <div key={node.key} role="group">
          <div
            className={`${styles.row} ${styles.folderRow} ${dropTarget === node.key ? styles.rowDrop : ''} ${keys.length > 0 && !anyVisible ? styles.rowHidden : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            role="treeitem"
            aria-expanded={!folder.collapsed}
            aria-level={depth + 1}
            tabIndex={0}
            data-row-key={node.key}
            draggable={renamingKey !== node.key}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_MIME, JSON.stringify([node.key]));
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(node.key);
            }}
            onDragLeave={() => setDropTarget((t) => (t === node.key ? null : t))}
            onDrop={(event) => onDrop(event, folder.id)}
            onClick={() => useItemsStore.getState().toggleCollapsed(folder.id)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setRenamingKey(node.key);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'F2') setRenamingKey(node.key);
              else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                useItemsStore.getState().toggleCollapsed(folder.id);
              } else if (event.key === 'ArrowRight') {
                useItemsStore.getState().toggleCollapsed(folder.id, false);
              } else if (event.key === 'ArrowLeft') {
                useItemsStore.getState().toggleCollapsed(folder.id, true);
              }
            }}
          >
            <span className={styles.chevron}>
              {folder.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </span>
            <span className={styles.icon}>
              {folder.collapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
            </span>
            <NameField
              name={folder.name}
              editing={renamingKey === node.key}
              onDone={(value) => {
                setRenamingKey(null);
                if (value !== null) useItemsStore.getState().renameFolder(folder.id, value);
              }}
            />
            <span className={styles.childCount}>{keys.length}</span>
            <FolderMenu
              folderId={folder.id}
              onRename={() => setRenamingKey(node.key)}
              onSelectContents={() =>
                state.setSelection(
                  keys.map((k) => rows.get(k)?.item).filter((i): i is SelectionItem => !!i),
                )
              }
            />
            <button
              type="button"
              className={styles.rowButton}
              aria-label={anyVisible ? `Hide ${folder.name}` : `Show ${folder.name}`}
              title={anyVisible ? 'Hide contents' : 'Show contents'}
              disabled={keys.length === 0}
              onClick={(event) => {
                event.stopPropagation();
                setVisible(keys, !anyVisible);
              }}
            >
              {anyVisible || keys.length === 0 ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          </div>
          {folder.collapsed ? null : node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }
    const row = rows.get(node.key);
    if (!row) return null;
    return (
      <LeafRowView
        key={node.key}
        row={row}
        depth={depth}
        state={state}
        selected={isSelected(row.item)}
        flashing={flashKey === row.key}
        renaming={renamingKey === row.key}
        onRenameDone={(value) => {
          setRenamingKey(null);
          if (value !== null && row.item.kind === 'body') {
            useItemsStore.getState().renameBody(row.item.bodyId, value);
          }
          if (value !== null && row.item.kind === 'mesh') {
            state.renameReferenceMesh(row.item.meshId, value);
          }
        }}
        onStartRename={() => {
          if (row.kind === 'body' || row.kind === 'mesh') setRenamingKey(row.key);
        }}
        onSelect={(event) => selectRow(row.key, event)}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragKeys(row.key)));
          event.dataTransfer.effectAllowed = 'move';
        }}
        onContextMenu={(x, y) => {
          if (!isSelected(row.item)) state.select(row.item);
          onContextMenu(x, y);
        }}
      />
    );
  };

  return (
    <div className={`${panelStyles.root} ${panelStyles.itemsPlacement}`} aria-label="Items panel">
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>Items</span>
        <span className={panelStyles.count}>
          {bodyCount} {bodyCount === 1 ? 'body' : 'bodies'}
          {meshCount > 0 ? ` · ${meshCount} ${meshCount === 1 ? 'mesh' : 'meshes'}` : ''} ·{' '}
          {sketchCount} {sketchCount === 1 ? 'sketch' : 'sketches'}
        </span>
        <span className={panelStyles.headerSpacer} />
        <Tooltip content="New folder (holds the selected items)">
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="New folder"
            onClick={newFolder}
          >
            <FolderPlus size={14} />
          </button>
        </Tooltip>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="Items panel options"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
          >
            <MoreHorizontal size={14} />
          </button>
          {overflowOpen ? (
            <Menu
              ariaLabel="Items panel options"
              onClose={() => setOverflowOpen(false)}
              style={{ position: 'absolute', top: '100%', right: 0 }}
            >
              <MenuItem
                disabled={!showAll.availability(state).enabled}
                onSelect={() => showAll.run(state)}
              >
                Show hidden items
              </MenuItem>
              <MenuItem
                disabled={!invert.availability(state).enabled}
                onSelect={() => invert.run(state)}
              >
                Invert visibility
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={newFolder}>New folder</MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
      <div className={styles.filters} role="radiogroup" aria-label="Show item types">
        {(['all', 'bodies', 'sketches', 'meshes', 'construction'] as const)
          // "Meshes" / "Planes & axes" only once the project has one (or it is the active filter).
          .filter((f) => f !== 'meshes' || meshCount > 0 || filter === 'meshes')
          .filter((f) => f !== 'construction' || datumCount > 0 || filter === 'construction')
          .map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={`${styles.filter} ${filter === f ? styles.filterActive : ''}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
      </div>
      <div
        ref={bodyRef}
        className={`${panelStyles.body} ${dropTarget === 'root' ? styles.bodyDrop : ''}`}
        role="tree"
        aria-label="Items"
        aria-multiselectable
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
          event.preventDefault();
          setDropTarget('root');
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropTarget(null);
        }}
        onDrop={(event) => onDrop(event, null)}
      >
        {rows.size === 0 ? <div className={panelStyles.empty}>No items yet</div> : null}
        {rows.size > 0 && tree.length === 0 ? (
          <div className={panelStyles.empty}>No {filter} in this project</div>
        ) : null}
        {tree.map((node) => renderNode(node, 0))}
      </div>
    </div>
  );
}

function pruneEmptyFolders(nodes: readonly ItemNode[]): ItemNode[] {
  return nodes.flatMap((node): ItemNode[] => {
    if (node.type === 'leaf') return [node];
    const children = pruneEmptyFolders(node.children);
    return children.length > 0 ? [{ ...node, children }] : [];
  });
}

/** Inline name editor: Enter/blur commits, Escape reverts (shared escape ladder). */
function NameField({
  name,
  editing,
  onDone,
}: {
  name: string;
  editing: boolean;
  onDone: (value: string | null) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!editing) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) return false;
      revertEscapeField(input, name);
      onDone(null);
      return true;
    });
  }, [editing, name, onDone]);
  if (!editing) return <span className={styles.name}>{name}</span>;
  return (
    <input
      ref={inputRef}
      className={styles.nameInput}
      aria-label="Name"
      defaultValue={name}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      onBlur={(event) => {
        if (consumeEscapeBlurCommitSuppression(event.currentTarget)) {
          onDone(null);
          return;
        }
        const value = event.currentTarget.value.trim();
        onDone(value && value !== name ? value : null);
      }}
    />
  );
}

function FolderMenu({
  folderId,
  onRename,
  onSelectContents,
}: {
  folderId: string;
  onRename: () => void;
  onSelectContents: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className={styles.rowButton}
        aria-label="Folder options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (!open) setMenuStyle(anchoredMenuStyle(event.currentTarget, 150));
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={13} />
      </button>
      {open ? (
        <Menu ariaLabel="Folder options" onClose={() => setOpen(false)} style={menuStyle}>
          <MenuItem onSelect={onSelectContents}>Select contents</MenuItem>
          <MenuItem onSelect={onRename}>Rename</MenuItem>
          <MenuItem
            onSelect={() => {
              useItemsStore.getState().createFolder({ parentId: folderId });
              useItemsStore.getState().toggleCollapsed(folderId, false);
            }}
          >
            New folder inside
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => useItemsStore.getState().deleteFolder(folderId)}>
            Delete folder (keep items)
          </MenuItem>
        </Menu>
      ) : null}
    </div>
  );
}

interface LeafRowProps {
  row: RowInfo;
  depth: number;
  state: AssemblerState;
  selected: boolean;
  flashing: boolean;
  renaming: boolean;
  onRenameDone: (value: string | null) => void;
  onStartRename: () => void;
  onSelect: (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  onDragStart: (event: React.DragEvent) => void;
  onContextMenu: (x: number, y: number) => void;
}

function LeafRowView(props: LeafRowProps): JSX.Element {
  const { row, state } = props;
  const consumed = consumedSketchIds(state.features);
  let visible: boolean;
  let hint = '';
  if (row.item.kind === 'body') {
    visible = !state.hiddenBodyIds.includes(row.item.bodyId);
  } else if (row.item.kind === 'sketchProfile') {
    visible = isSketchVisible(row.item.featureId, consumed, state.sketchVisibility);
    hint = consumed.has(row.item.featureId) ? ' (used by an extrude)' : '';
  } else if (row.item.kind === 'mesh') {
    const meshId = row.item.meshId;
    visible = !state.referenceMeshes.some((m) => m.id === meshId && m.hidden);
  } else if (row.item.kind === 'datum') {
    visible = state.sketchVisibility[row.item.featureId] !== false;
  } else {
    visible = true;
  }
  const bodyId = row.item.kind === 'body' ? row.item.bodyId : null;
  const isolated =
    bodyId !== null && state.isolatedBodyIds?.length === 1 && state.isolatedBodyIds[0] === bodyId;
  const toggleVisible = () => {
    if (row.item.kind === 'body') {
      if (visible) state.hideBodies([row.item.bodyId]);
      else state.showBodies([row.item.bodyId]);
    } else if (row.item.kind === 'sketchProfile') {
      state.setSketchVisible(row.item.featureId, !visible);
    } else if (row.item.kind === 'mesh') {
      state.setReferenceMeshHidden(row.item.meshId, visible);
    } else if (row.item.kind === 'datum') {
      state.setSketchVisible(row.item.featureId, !visible);
    }
  };
  return (
    <div
      className={`${styles.row} ${props.selected ? styles.rowSelected : ''} ${visible ? '' : styles.rowHidden} ${props.flashing ? styles.rowFlash : ''}`}
      style={{ paddingLeft: 8 + props.depth * 14 + 16 }}
      role="treeitem"
      aria-selected={props.selected}
      aria-level={props.depth + 1}
      tabIndex={0}
      data-row-key={row.key}
      draggable={!props.renaming}
      onDragStart={props.onDragStart}
      onClick={(event) => props.onSelect(event)}
      onDoubleClick={() => {
        if (row.item.kind === 'sketchProfile') {
          useSketchStore.getState().begin({ featureId: row.item.featureId });
        } else props.onStartRename();
      }}
      onMouseEnter={() => state.setHover(row.item)}
      onMouseLeave={() => state.setHover(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(event.clientX, event.clientY);
      }}
      title={
        row.kind === 'mesh'
          ? 'Reference mesh (imported STL): not a solid, never used by modelling operations'
          : undefined
      }
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter') props.onSelect(event);
        else if (event.key === 'F2') props.onStartRename();
      }}
    >
      {row.kind === 'body' ? (
        <button
          type="button"
          className={styles.swatch}
          style={{ background: row.color }}
          aria-label={`Colour of ${row.name}`}
          title="Colour…"
          onClick={(event) => {
            event.stopPropagation();
            if (bodyId) useWorkspaceStore.getState().setColourDialog([bodyId]);
          }}
        />
      ) : (
        <span className={styles.icon}>
          {row.kind === 'sketch' ? (
            <PenSquare size={13} />
          ) : row.kind === 'mesh' ? (
            <Boxes size={13} />
          ) : row.kind === 'plane' ? (
            <SquareDashed size={13} />
          ) : row.kind === 'axis' ? (
            <Axis3d size={13} />
          ) : (
            <Box size={13} />
          )}
        </span>
      )}
      <NameField name={row.name} editing={props.renaming} onDone={props.onRenameDone} />
      {row.kind !== 'mesh' ? (
        <button
          type="button"
          className={styles.rowButton}
          aria-label={`Zoom to ${row.name}`}
          title="Zoom to"
          onClick={(event) => {
            event.stopPropagation();
            // Shapr3D Items "zoom to": frames the item without changing the selection.
            useWorkspaceStore.getState().sendCamera({ kind: 'fitItems', items: [row.item] });
          }}
        >
          <ZoomIn size={12} />
        </button>
      ) : null}
      {bodyId ? (
        <button
          type="button"
          className={`${styles.rowButton} ${isolated ? styles.rowButtonActive : ''}`}
          aria-label={isolated ? 'Stop isolating' : 'Isolate'}
          title={isolated ? 'Stop isolating' : 'Isolate'}
          onClick={(event) => {
            event.stopPropagation();
            state.setIsolatedBodyIds(isolated ? null : [bodyId]);
          }}
        >
          <Target size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className={styles.rowButton}
        aria-label={visible ? `Hide ${row.name}` : `Show ${row.name}`}
        title={visible ? `Hide${hint}` : `Show${hint}`}
        onClick={(event) => {
          event.stopPropagation();
          toggleVisible();
        }}
      >
        {visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </div>
  );
}
