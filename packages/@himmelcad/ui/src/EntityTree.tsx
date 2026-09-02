import type { EntityId, EntityKind, EntitySnapshot, ProjectSnapshot } from '@himmelcad/data';
import {
  Box,
  CircleDot,
  ArrowUpToLine,
  Eye,
  EyeOff,
  Folder,
  Layers,
  Mountain,
  PanelLeftClose,
  Sparkles,
  Spline,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import styles from './EntityTree.module.css';
import { ExpandChevron } from './ExpandChevron.js';
import { IslandTabs } from './IslandTabs.js';
import { useLayoutStore } from './useLayoutStore.js';

export type LeftNavTabId = 'tree' | 'layers' | 'imported';

export interface EntityTreeProps {
  project: ProjectSnapshot | null;
  selectedIds: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, mode: 'replace' | 'add' | 'toggle') => void;
  onSelectMany?: (ids: readonly EntityId[]) => void;
  onRename?: (id: EntityId, name: string) => void;
  onMove?: (id: EntityId, newParentId: EntityId) => void;
  onVisibilityChange?: (id: EntityId, visible: boolean) => void;
  canExport?: (entity: EntitySnapshot) => boolean;
  onContextAction?: (
    id: EntityId,
    action: 'showGcpImages' | 'open' | 'properties' | 'export' | 'remove',
  ) => void;
  /** Left island navigation tab (Tree / Layers / Imported from). */
  leftNavTab?: LeftNavTabId;
  onLeftNavTabChange?: (tab: LeftNavTabId) => void;
  /** Optional product-owned sibling ordering. The canonical project order is unchanged. */
  sortChildren?: (left: EntitySnapshot, right: EntitySnapshot) => number;
}

export function EntityTree({
  project,
  selectedIds,
  onSelect,
  onSelectMany,
  onRename,
  onMove,
  onVisibilityChange,
  canExport,
  onContextAction,
  leftNavTab = 'tree',
  onLeftNavTabChange,
  sortChildren,
}: EntityTreeProps): JSX.Element {
  const collapseLeft = useLayoutStore((s) => s.toggleLeftPanel);
  const [context, setContext] = useState<{ id: EntityId; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<EntityId | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<EntityId | null>(null);
  const [activeParentId, setActiveParentId] = useState<EntityId | null>(null);
  const [localNavTab, setLocalNavTab] = useState<LeftNavTabId>(leftNavTab);
  const treeBodyRef = useRef<HTMLDivElement>(null);
  const navTab = onLeftNavTabChange ? leftNavTab : localNavTab;
  const setNavTab = (tab: LeftNavTabId): void => {
    if (onLeftNavTabChange) onLeftNavTabChange(tab);
    else setLocalNavTab(tab);
  };
  useEffect(() => {
    if (!context) return;
    const close = (): void => setContext(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [context]);
  const headerCollapse = (
    <button
      type="button"
      className={styles.headerCollapse}
      onClick={collapseLeft}
      title="Collapse panel"
      aria-label="Collapse left panel"
    >
      <PanelLeftClose size={14} />
    </button>
  );

  const nav = (
    <div className={styles.navRow}>
      <IslandTabs
        ariaLabel="Left navigation"
        value={navTab}
        onChange={(id) => setNavTab(id as LeftNavTabId)}
        items={[
          { id: 'tree', label: 'Tree' },
          { id: 'layers', label: 'Layers' },
          { id: 'imported', label: 'Imported from' },
        ]}
      />
      {headerCollapse}
    </div>
  );

  if (!project) {
    return (
      <div className={styles.root}>
        {nav}
        <div className={styles.islandBody}>
          <div className={styles.header}>
            <span className={styles.headerLabel}>Project</span>
            <span className={styles.headerName}>—</span>
          </div>
          <div className={styles.empty}>
            <Layers size={28} strokeWidth={1.4} color="var(--hc-fg-subtle)" />
            <div className={styles.emptyTitle}>No project open</div>
            <div className={styles.emptyHint}>
              Use Project → New, Project → Open, or drop a LAS file into the viewport.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (navTab !== 'tree') {
    return (
      <div className={styles.root}>
        {nav}
        <div className={styles.islandBody}>
          <div className={styles.header}>
            <span className={styles.headerLabel}>
              {navTab === 'layers' ? 'Layers' : 'Imported from'}
            </span>
            <span className={styles.headerName}>{project.name}</span>
          </div>
          <div className={styles.placeholderPane}>
            <div className={styles.emptyTitle}>
              {navTab === 'layers' ? 'Layers view' : 'Import provenance'}
            </div>
            <div className={styles.emptyHint}>
              {navTab === 'layers'
                ? 'Layer-ordered navigation will live here. Tree remains the hierarchical project model.'
                : 'Group entities by source import, capture, or external file. Coming next.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {nav}
      <div className={styles.islandBody}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Project</span>
          <span className={styles.headerName}>{project.name}</span>
          <button
            type="button"
            className={styles.scrollTop}
            onClick={() => treeBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            title="Scroll tree to top"
            aria-label="Scroll entity tree to top"
          >
            <ArrowUpToLine size={13} />
          </button>
        </div>
        <div
          ref={treeBodyRef}
          className={styles.body}
          role="tree"
          tabIndex={0}
          onKeyDown={(event) => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
            const parent = activeParentId ? project.entities[activeParentId] : undefined;
            if (!parent) return;
            event.preventDefault();
            const ids = parent.children.filter((id) => project.entities[id]);
            if (onSelectMany) onSelectMany(ids);
            else ids.forEach((id) => onSelect(id, 'add'));
          }}
        >
          <TreeNode
            id={project.rootEntity}
            entities={project.entities}
            depth={0}
            selectedIds={selectedIds}
            onSelect={(id, event) => {
              const node = project.entities[id];
              const parentId = node?.parent ?? null;
              const siblings = parentId
                ? orderedChildren(
                    project.entities[parentId]?.children ?? [],
                    project.entities,
                    sortChildren,
                  )
                : [id];
              if (event.shiftKey && selectionAnchor && parentId === activeParentId) {
                const anchorIndex = siblings.indexOf(selectionAnchor);
                const currentIndex = siblings.indexOf(id);
                if (anchorIndex >= 0 && currentIndex >= 0) {
                  const range = siblings.slice(
                    Math.min(anchorIndex, currentIndex),
                    Math.max(anchorIndex, currentIndex) + 1,
                  );
                  if (onSelectMany) onSelectMany(range);
                  else range.forEach((rangeId) => onSelect(rangeId, 'add'));
                  return;
                }
              }
              onSelect(id, event.metaKey || event.ctrlKey ? 'toggle' : 'replace');
              setSelectionAnchor(id);
              setActiveParentId(parentId);
            }}
            editingId={editingId}
            onEditingChange={setEditingId}
            onRename={onRename}
            onMove={onMove}
            onVisibilityChange={onVisibilityChange}
            onContextMenu={(id, x, y) => {
              if (!selectedIds.has(id)) onSelect(id, 'replace');
              setSelectionAnchor(id);
              setActiveParentId(project.entities[id]?.parent ?? null);
              setContext({
                id,
                x: Math.max(4, Math.min(x, window.innerWidth - 226)),
                y: Math.max(4, Math.min(y, window.innerHeight - 170)),
              });
            }}
            sortChildren={sortChildren}
          />
        </div>
      </div>
      {context && project.entities[context.id] && (
        <div
          className={styles.contextMenu}
          style={{ left: context.x, top: context.y }}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onContextAction?.(context.id, 'open');
              setContext(null);
            }}
          >
            Open / View
          </button>
          {project.entities[context.id]?.kind === 'GroundControlPoint' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onContextAction?.(context.id, 'showGcpImages');
                setContext(null);
              }}
            >
              Images containing this GCP
            </button>
          )}
          {project.entities[context.id] &&
            (canExport?.(project.entities[context.id]!) ??
              isExportableProduct(project.entities[context.id]?.kind)) && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onContextAction?.(context.id, 'export');
                  setContext(null);
                }}
              >
                Export…
              </button>
            )}
          {project.entities[context.id]?.kind === 'CameraImage' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onContextAction?.(context.id, 'remove');
                setContext(null);
              }}
            >
              Remove from project…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEditingId(context.id);
              setContext(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const entity = project.entities[context.id];
              if (entity) onVisibilityChange?.(context.id, !entity.visibility.visible);
              setContext(null);
            }}
          >
            {project.entities[context.id]?.visibility.visible ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onContextAction?.(context.id, 'properties');
              setContext(null);
            }}
          >
            Properties
          </button>
        </div>
      )}
    </div>
  );
}

function isExportableProduct(kind: EntityKind | undefined): boolean {
  return (
    kind === 'DepthMap' ||
    kind === 'PointCloud' ||
    kind === 'DigitalElevationModel' ||
    kind === 'Orthomosaic' ||
    kind === 'Mesh' ||
    kind === 'TexturedMesh' ||
    kind === 'GaussianSplatCloud'
  );
}

interface NodeProps {
  id: EntityId;
  entities: ProjectSnapshot['entities'];
  depth: number;
  selectedIds: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, event: ReactMouseEvent<HTMLDivElement>) => void;
  editingId: EntityId | null;
  onEditingChange: (id: EntityId | null) => void;
  onRename: EntityTreeProps['onRename'];
  onMove: EntityTreeProps['onMove'];
  onVisibilityChange: EntityTreeProps['onVisibilityChange'];
  onContextMenu: (id: EntityId, x: number, y: number) => void;
  sortChildren?: EntityTreeProps['sortChildren'];
}

function TreeNode({
  id,
  entities,
  depth,
  selectedIds,
  onSelect,
  editingId,
  onEditingChange,
  onRename,
  onMove,
  onVisibilityChange,
  onContextMenu,
  sortChildren,
}: NodeProps): ReactNode {
  const node: EntitySnapshot | undefined = entities[id];
  const [open, setOpen] = useState(true);
  if (!node) return null;
  const isSelected = selectedIds.has(node.id);
  const children = orderedChildren(node.children, entities, sortChildren);
  const hasChildren = children.length > 0;

  return (
    <div role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div
        className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={(e) => {
          onSelect(node.id, e);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(node.id, event.clientX, event.clientY);
        }}
        draggable={node.kind !== 'ProjectRoot'}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-himmelcad-entity', node.id);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-himmelcad-entity')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const source = event.dataTransfer.getData('application/x-himmelcad-entity') as EntityId;
          if (source && source !== node.id) onMove?.(source, node.id);
        }}
      >
        <button
          type="button"
          className={styles.twisty}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
          tabIndex={-1}
        >
          {hasChildren ? (
            <ExpandChevron expanded={open} size={12} />
          ) : (
            <span className={styles.twistyEmpty} />
          )}
        </button>
        <span className={styles.kind} title={node.kind}>
          {kindIcon(node.kind)}
        </span>
        {editingId === node.id ? (
          <input
            className={styles.renameInput}
            defaultValue={node.name}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              const value = event.currentTarget.value.trim();
              if (value && value !== node.name) onRename?.(node.id, value);
              onEditingChange(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') onEditingChange(null);
            }}
          />
        ) : (
          <span className={styles.label}>{node.name || node.id}</span>
        )}
        <button
          type="button"
          className={`${styles.eye} ${node.visibility.visible ? '' : styles.eyeHidden}`}
          aria-label={node.visibility.visible ? 'Visible' : 'Hidden'}
          title={node.visibility.visible ? 'Visible' : 'Hidden'}
          onClick={(event) => {
            event.stopPropagation();
            onVisibilityChange?.(node.id, !node.visibility.visible);
          }}
        >
          {node.visibility.visible ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
      </div>
      {open &&
        children.map((cid) => (
          <TreeNode
            key={cid}
            id={cid}
            entities={entities}
            depth={depth + 1}
            selectedIds={selectedIds}
            onSelect={onSelect}
            editingId={editingId}
            onEditingChange={onEditingChange}
            onRename={onRename}
            onMove={onMove}
            onVisibilityChange={onVisibilityChange}
            onContextMenu={onContextMenu}
            sortChildren={sortChildren}
          />
        ))}
    </div>
  );
}

function orderedChildren(
  children: readonly EntityId[],
  entities: ProjectSnapshot['entities'],
  sortChildren: EntityTreeProps['sortChildren'],
): readonly EntityId[] {
  if (!sortChildren) return children;
  return [...children].sort((leftId, rightId) => {
    const left = entities[leftId];
    const right = entities[rightId];
    return left && right ? sortChildren(left, right) : 0;
  });
}

function kindIcon(kind: EntityKind): ReactNode {
  const size = 13;
  switch (kind) {
    case 'ProjectRoot':
      return <Folder size={size} />;
    case 'Group':
    case 'Layer':
      return <Layers size={size} />;
    case 'PointCloud':
      return <Sparkles size={size} />;
    case 'PointCloudSegment':
      return <CircleDot size={size} />;
    case 'Mesh':
    case 'TexturedMesh':
      return <Mountain size={size} />;
    case 'Polyline3D':
    case 'AlignmentElement':
    case 'Axis':
      return <Spline size={size} />;
    default:
      return <Box size={size} />;
  }
}
