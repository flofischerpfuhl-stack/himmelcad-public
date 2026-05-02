import { useState } from 'react';

import type { EntityId, EntitySnapshot, ProjectSnapshot } from '@himmelcad/data';

import styles from './EntityTree.module.css';

export interface EntityTreeProps {
  project: ProjectSnapshot | null;
  selectedIds: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, mode: 'replace' | 'add' | 'toggle') => void;
}

export function EntityTree({ project, selectedIds, onSelect }: EntityTreeProps): JSX.Element {
  if (!project) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No project open</div>
        <div className={styles.emptyHint}>Use Project → New or Project → Open</div>
      </div>
    );
  }

  return (
    <div className={styles.root} role="tree">
      <TreeNode
        id={project.rootEntity}
        entities={project.entities}
        depth={0}
        selectedIds={selectedIds}
        onSelect={onSelect}
      />
    </div>
  );
}

interface NodeProps {
  id: EntityId;
  entities: ProjectSnapshot['entities'];
  depth: number;
  selectedIds: ReadonlySet<EntityId>;
  onSelect: EntityTreeProps['onSelect'];
}

function TreeNode({ id, entities, depth, selectedIds, onSelect }: NodeProps): JSX.Element | null {
  const node: EntitySnapshot | undefined = entities[id];
  const [open, setOpen] = useState(true);
  if (!node) return null;
  const isSelected = selectedIds.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <div role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div
        className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={(e) => {
          const mode = e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
          onSelect(node.id, mode);
        }}
      >
        <button
          className={styles.twisty}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
          tabIndex={-1}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>
        <span className={styles.kind} title={node.kind}>
          {kindGlyph(node.kind)}
        </span>
        <span className={styles.label}>{node.name || node.id}</span>
        {!node.visibility.visible && <span className={styles.hidden}>hidden</span>}
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
          />
        ))}
    </div>
  );
}

function kindGlyph(kind: EntitySnapshot['kind']): string {
  switch (kind) {
    case 'ProjectRoot':
      return '◇';
    case 'Group':
      return '▢';
    case 'PointCloud':
      return '∴';
    case 'PointCloudSegment':
      return '∵';
    default:
      return '◦';
  }
}
