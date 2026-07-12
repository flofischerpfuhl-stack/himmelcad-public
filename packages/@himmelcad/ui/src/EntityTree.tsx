import type { EntityId, EntityKind, EntitySnapshot, ProjectSnapshot } from '@himmelcad/data';
import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  Folder,
  Layers,
  Mountain,
  PanelLeftClose,
  Sparkles,
  Spline,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import styles from './EntityTree.module.css';
import { useLayoutStore } from './useLayoutStore.js';

export interface EntityTreeProps {
  project: ProjectSnapshot | null;
  selectedIds: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, mode: 'replace' | 'add' | 'toggle') => void;
  onRename?: (id: EntityId, name: string) => void;
  onMove?: (id: EntityId, newParentId: EntityId) => void;
  onVisibilityChange?: (id: EntityId, visible: boolean) => void;
  onContextAction?: (
    id: EntityId,
    action: 'showGcpImages' | 'open' | 'properties' | 'export',
  ) => void;
}

export function EntityTree({
  project,
  selectedIds,
  onSelect,
  onRename,
  onMove,
  onVisibilityChange,
  onContextAction,
}: EntityTreeProps): JSX.Element {
  const collapseLeft = useLayoutStore((s) => s.toggleLeftPanel);
  const [context, setContext] = useState<{ id: EntityId; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<EntityId | null>(null);
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

  if (!project) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Project</span>
          <span className={styles.headerName}>—</span>
          {headerCollapse}
        </div>
        <div className={styles.empty}>
          <Layers size={28} strokeWidth={1.4} color="var(--hc-fg-subtle)" />
          <div className={styles.emptyTitle}>No project open</div>
          <div className={styles.emptyHint}>
            Use Project → New, Project → Open, or drop a LAS file into the viewport.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Project</span>
        <span className={styles.headerName}>{project.name}</span>
        {headerCollapse}
      </div>
      <div className={styles.body} role="tree">
        <TreeNode
          id={project.rootEntity}
          entities={project.entities}
          depth={0}
          selectedIds={selectedIds}
          onSelect={onSelect}
          editingId={editingId}
          onEditingChange={setEditingId}
          onRename={onRename}
          onMove={onMove}
          onVisibilityChange={onVisibilityChange}
          onContextMenu={(id, x, y) =>
            setContext({
              id,
              x: Math.max(4, Math.min(x, window.innerWidth - 226)),
              y: Math.max(4, Math.min(y, window.innerHeight - 170)),
            })
          }
        />
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
          {isExportableProduct(project.entities[context.id]?.kind) && (
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
  onSelect: EntityTreeProps['onSelect'];
  editingId: EntityId | null;
  onEditingChange: (id: EntityId | null) => void;
  onRename: EntityTreeProps['onRename'];
  onMove: EntityTreeProps['onMove'];
  onVisibilityChange: EntityTreeProps['onVisibilityChange'];
  onContextMenu: (id: EntityId, x: number, y: number) => void;
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
}: NodeProps): ReactNode {
  const node: EntitySnapshot | undefined = entities[id];
  const [open, setOpen] = useState(true);
  if (!node) return null;
  const isSelected = selectedIds.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <div role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div
        className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={(e) => {
          const mode = e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
          onSelect(node.id, mode);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(node.id, 'replace');
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
            open ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
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
        node.children.map((cid) => (
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
          />
        ))}
    </div>
  );
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
