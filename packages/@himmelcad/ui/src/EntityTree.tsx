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
import { EntityCommandMenu, type EntityCommandTarget } from './CommandSurfaces.js';
import {
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from './escapeLadder.js';
import { ExpandChevron } from './ExpandChevron.js';
import { IslandTabs } from './IslandTabs.js';
import { useLayoutStore } from './useLayoutStore.js';

export type LeftNavTabId = 'tree' | 'layers' | 'imported';

export interface EntityTreeProps {
  project: ProjectSnapshot | null;
  /** Product id used to admit product-owned generated command rows. Defaults to Builder. */
  productId?: string;
  selectedIds: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, mode: 'replace' | 'add' | 'toggle') => void;
  onSelectMany?: (ids: readonly EntityId[]) => void;
  onRename?: (id: EntityId, name: string) => void;
  onMove?: (id: EntityId, newParentId: EntityId) => void;
  onVisibilityChange?: (id: EntityId, visible: boolean) => void;
  canExport?: (entity: EntitySnapshot) => boolean;
  onContextAction?: EntityTreeContextAction | LegacyEntityTreeContextAction;
  /** Left island navigation tab (Tree / Layers / Imported from). */
  leftNavTab?: LeftNavTabId;
  onLeftNavTabChange?: (tab: LeftNavTabId) => void;
  /** Optional product-owned sibling ordering. The canonical project order is unchanged. */
  sortChildren?: (left: EntitySnapshot, right: EntitySnapshot) => number;
  /** Compact metadata rendered at the trailing edge of each tree row. */
  secondaryLabel?: (entity: EntitySnapshot) => ReactNode;
}

export type EntityTreeContextAction = (commandId: string, entityIds: readonly EntityId[]) => void;

type LegacyEntityTreeContextAction = (
  id: EntityId,
  action: 'showGcpImages' | 'open' | 'properties' | 'export' | 'remove',
) => void;

export function EntityTree({
  project,
  productId,
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
  secondaryLabel,
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

  const contextEntity = context ? project?.entities[context.id] : undefined;
  const contextEntityIds = contextEntity
    ? selectedIds.has(contextEntity.id)
      ? [...selectedIds].filter((id) => project?.entities[id])
      : [contextEntity.id]
    : [];

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
            secondaryLabel={secondaryLabel}
          />
        </div>
      </div>
      {context && contextEntity ? (
        <EntityCommandMenu
          x={context.x}
          y={context.y}
          context={treeCommandContext(
            project,
            new Set(contextEntityIds),
            canExport,
            productId ?? 'builder',
            contextEntity.kind,
          )}
          target={{ entityIds: contextEntityIds, kind: contextEntity.kind }}
          onClose={() => setContext(null)}
          onExecute={(commandId, target) =>
            dispatchEntityTreeCommand(commandId, target, context.id, {
              onRename: setEditingId,
              ...(productId !== undefined ? { productId } : {}),
              ...(onVisibilityChange ? { onVisibilityChange } : {}),
              ...(onContextAction ? { onContextAction } : {}),
            })
          }
        />
      ) : null}
    </div>
  );
}

function treeCommandContext(
  project: ProjectSnapshot,
  selectedIds: ReadonlySet<EntityId>,
  canExport: EntityTreeProps['canExport'],
  productId: string,
  entityKind: EntityKind,
) {
  const entities = [...selectedIds].flatMap((id) => {
    const entity = project.entities[id];
    return entity ? [entity] : [];
  });
  return {
    hasProject: true,
    productId,
    selectedEntityIds: entities.map((entity) => entity.id),
    selectedCanonicalEntityKinds: entities.map((entity) => entity.kind),
    entityKind,
    selectedEntityKinds: entities.map((entity) => {
      if (entity.kind === 'SinglePoint' || entity.kind === 'GroundControlPoint')
        return 'point' as const;
      if (entity.kind === 'Polyline3D') return 'polyline' as const;
      if (entity.kind === 'Mesh' || entity.kind === 'TexturedMesh' || entity.kind === 'Surface')
        return 'mesh' as const;
      if (entity.kind === 'PointCloud' || entity.kind === 'GaussianSplatCloud')
        return 'cloud' as const;
      return 'other' as const;
    }),
    selectionVisibility: entities.every((entity) => entity.visibility.visible)
      ? ('visible' as const)
      : entities.every((entity) => !entity.visibility.visible)
        ? ('hidden' as const)
        : ('mixed' as const),
    selectionEditable: entities.every((entity) => !entity.visibility.locked),
    selectionExportable:
      entities.length > 0 &&
      entities.every((entity) => canExport?.(entity) ?? isExportableProduct(entity.kind)),
  };
}

export function dispatchEntityTreeCommand(
  commandId: string,
  target: EntityCommandTarget,
  contextId: EntityId,
  handlers: Pick<EntityTreeProps, 'productId' | 'onVisibilityChange' | 'onContextAction'> & {
    readonly onRename: (id: EntityId) => void;
  },
): void {
  if (commandId === 'entity.rename') {
    handlers.onRename(contextId);
    return;
  }
  if (commandId === 'entity.hide' || commandId === 'entity.show') {
    for (const id of target.entityIds) {
      handlers.onVisibilityChange?.(id as EntityId, commandId === 'entity.show');
    }
    return;
  }
  if (!handlers.onContextAction) return;
  const legacyAction =
    commandId === 'entity.export'
      ? 'export'
      : commandId === 'entity.properties'
        ? 'properties'
        : commandId === 'entity.zoom_to'
          ? 'open'
          : null;
  if (legacyAction) {
    (handlers.onContextAction as LegacyEntityTreeContextAction)(contextId, legacyAction);
    return;
  }
  if (handlers.productId !== undefined) {
    (handlers.onContextAction as EntityTreeContextAction)(
      commandId,
      target.entityIds as readonly EntityId[],
    );
  }
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
  secondaryLabel?: EntityTreeProps['secondaryLabel'];
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
  secondaryLabel,
}: NodeProps): ReactNode {
  const node: EntitySnapshot | undefined = entities[id];
  const [open, setOpen] = useState(true);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!node || editingId !== node.id) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = renameInputRef.current;
      if (!input || input.ownerDocument.activeElement !== input) return false;
      revertEscapeField(input, node.name);
      onEditingChange(null);
      return true;
    });
  }, [editingId, node, onEditingChange]);
  if (!node) return null;
  const isSelected = selectedIds.has(node.id);
  const children = orderedChildren(node.children, entities, sortChildren);
  const hasChildren = children.length > 0;

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? open : undefined}
      aria-selected={isSelected}
    >
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
            ref={renameInputRef}
            className={styles.renameInput}
            defaultValue={node.name}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (consumeEscapeBlurCommitSuppression(event.currentTarget)) {
                onEditingChange(null);
                return;
              }
              const value = event.currentTarget.value.trim();
              if (value && value !== node.name) onRename?.(node.id, value);
              onEditingChange(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        ) : (
          <span className={styles.label}>{node.name || node.id}</span>
        )}
        {editingId !== node.id && secondaryLabel ? (
          <span className={styles.secondaryLabel}>{secondaryLabel(node)}</span>
        ) : null}
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
      {open && hasChildren ? (
        <div role="group">
          {children.map((cid) => (
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
              secondaryLabel={secondaryLabel}
            />
          ))}
        </div>
      ) : null}
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
