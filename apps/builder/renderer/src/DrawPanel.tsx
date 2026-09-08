import type { ConstructionPoint, DrawRole, DrawToolSnapshot } from '@himmelcad/app';
import { Button, Select } from '@himmelcad/ui';
import {
  CircleDot,
  Cloud,
  CornerDownLeft,
  Crosshair,
  GitCommitHorizontal,
  Minus,
} from 'lucide-react';

import styles from './DrawPanel.module.css';

export type DrawSnapKind =
  | 'point'
  | 'cloudPoint'
  | 'end'
  | 'mid'
  | 'intersection'
  | 'perpendicular';

const SNAP_KINDS: readonly {
  readonly id: DrawSnapKind;
  readonly label: string;
  readonly icon: typeof CircleDot;
}[] = [
  { id: 'point', label: 'Point', icon: CircleDot },
  { id: 'cloudPoint', label: 'Cloud point', icon: Cloud },
  { id: 'end', label: 'Line end', icon: Minus },
  { id: 'mid', label: 'Line midpoint', icon: GitCommitHorizontal },
  { id: 'intersection', label: 'Intersection', icon: Crosshair },
  { id: 'perpendicular', label: 'Perpendicular foot', icon: CornerDownLeft },
];

export interface DrawPanelProps {
  readonly tool: DrawToolSnapshot;
  readonly snapKinds: Readonly<Record<DrawSnapKind, boolean>>;
  readonly constructionPreview: ConstructionPoint | null;
  readonly onRoleChange: (role: DrawRole) => void;
  readonly onSnapKindChange: (kind: DrawSnapKind, enabled: boolean) => void;
  readonly onFinish: () => void;
  readonly onClose: () => void;
  readonly onUndoVertex: () => void;
  readonly onCancel: () => void;
}

export function DrawPanel({
  tool,
  snapKinds,
  constructionPreview,
  onRoleChange,
  onSnapKindChange,
  onFinish,
  onClose,
  onUndoVertex,
  onCancel,
}: DrawPanelProps): JSX.Element {
  const polar = polarValues(tool, constructionPreview);
  return (
    <div className={styles.panel} aria-busy={tool.committing}>
      <label className={styles.role}>
        <span>Role</span>
        <Select
          aria-label="Draw role"
          value={tool.role}
          disabled={tool.kind === 'boundary' || tool.vertices.length > 0}
          options={
            tool.kind === 'boundary'
              ? [{ value: 'boundary', label: 'Boundary' }]
              : [
                  { value: 'plain', label: 'Plain' },
                  { value: 'breakline', label: 'Breakline' },
                ]
          }
          onChange={(event) => onRoleChange(event.currentTarget.value as DrawRole)}
        />
      </label>
      <section className={styles.section} aria-label="Snap kinds">
        <div className={styles.heading}>Snaps</div>
        <div className={styles.snapRow}>
          {SNAP_KINDS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={styles.snapButton}
              aria-label={label}
              aria-pressed={snapKinds[id]}
              title={label}
              onClick={() => onSnapKindChange(id, !snapKinds[id])}
            >
              <Icon size={14} aria-hidden />
            </button>
          ))}
        </div>
      </section>
      <section className={styles.section} aria-live="polite">
        <div className={styles.heading}>Live polar</div>
        <output className={styles.polar}>
          Dir {format(polar?.direction)}° · Dist {format(polar?.distance)} m · Δz{' '}
          {format(polar?.deltaZ)} m
        </output>
      </section>
      <section className={styles.section}>
        <div className={styles.listHeader}>
          <span>Vertices</span>
          <span>{tool.vertices.length}</span>
        </div>
        <ol className={styles.vertices} aria-label="Draw vertices">
          {tool.vertices.map((vertex, index) => (
            <li key={`${index}:${vertex.point.x}:${vertex.point.y}:${vertex.point.z}`}>
              <span>{index + 1}</span>
              <span>
                {format(vertex.point.x)} {format(vertex.point.y)} {format(vertex.point.z)}
              </span>
              <span title={vertex.kind}>{acquisitionGlyph(vertex.kind)}</span>
            </li>
          ))}
        </ol>
      </section>
      {tool.error ? (
        <div className={styles.error} role="alert">
          {tool.error}
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={tool.kind === 'boundary' || tool.vertices.length < 2}
          onClick={onFinish}
        >
          Finish
        </Button>
        <Button
          variant="secondary"
          disabled={tool.kind !== 'boundary' || tool.vertices.length < 3}
          onClick={onClose}
        >
          Close
        </Button>
        <Button variant="quiet" disabled={tool.vertices.length === 0} onClick={onUndoVertex}>
          Undo vertex
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function polarValues(
  tool: DrawToolSnapshot,
  constructionPreview: ConstructionPoint | null,
): { readonly direction: number; readonly distance: number; readonly deltaZ: number } | null {
  const from = tool.vertices.at(-1)?.point;
  const to = constructionPreview ?? tool.preview?.point;
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const direction = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
  return { direction, distance: Math.hypot(dx, dy), deltaZ: to.z - from.z };
}

function acquisitionGlyph(kind: 'pick' | 'typed' | 'constrained'): string {
  return kind === 'pick' ? '⌖' : kind === 'typed' ? '⌨' : '∟';
}

function format(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(3);
}
