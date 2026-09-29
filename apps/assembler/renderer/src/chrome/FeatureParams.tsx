/**
 * History-card parameters of the modelling features (`model/features.ts`):
 * every numeric parameter is an `ExpressionField`, options are `Select`s;
 * each edit is one `editFeatureParams` call (one undo step).
 */
import { Select } from '@himmelcad/ui';

import type { ExtrudeOperation, Plane } from '../model/document.js';
import type { AxisRef, ModelingFeature } from '../model/features.js';
import type { AssemblerState, FeaturePatch } from '../model/store.js';
import { ExpressionField } from './ExpressionField.js';
import styles from './HistoryPanel.module.css';

const OPERATION_OPTIONS = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
];

function axisText(axis: AxisRef): string {
  if (axis.kind === 'world') return `${axis.axis} axis`;
  if (axis.kind === 'edge')
    return axis.edge.signature.curve === 'circle' ? 'circular edge axis' : 'edge';
  return 'sketch line';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ModelingFeatureParams({
  feature,
  state,
}: {
  feature: ModelingFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = (patch: Record<string, unknown>) =>
    state.editFeatureParams(feature.id, patch as FeaturePatch);
  const operation = (value: ExtrudeOperation) => (
    <div className={styles.paramsFull}>
      <span className={styles.paramLabel}>Operation</span>
      <Select
        aria-label={`${feature.name} operation`}
        value={value}
        options={OPERATION_OPTIONS}
        onChange={(event) => edit({ operation: event.currentTarget.value })}
      />
    </div>
  );
  const planeOffset = (
    plane: { kind: 'plane'; plane: Plane; offset: number } | { kind: 'face' },
  ) =>
    plane.kind === 'plane' ? (
      <ExpressionField
        label={`Plane ${plane.plane} offset`}
        value={plane.offset}
        unit="mm"
        onCommit={(v) => edit({ plane: { ...plane, offset: v } })}
      />
    ) : (
      <span className={styles.paramNote}>Plane: a planar face</span>
    );

  switch (feature.kind) {
    case 'revolve':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Angle"
            value={feature.angle}
            unit="°"
            onCommit={(v) => edit({ angle: v })}
          />
          <span className={styles.paramNote}>About the {axisText(feature.axis)}</span>
          {operation(feature.operation)}
        </div>
      );
    case 'sweep': {
      const path = feature.path;
      return (
        <div className={styles.params}>
          {path.kind === 'line' ? (
            <ExpressionField
              label="Path length"
              value={Math.hypot(
                path.end[0] - path.start[0],
                path.end[1] - path.start[1],
                path.end[2] - path.start[2],
              )}
              unit="mm"
              onCommit={(v) => {
                const len =
                  Math.hypot(
                    path.end[0] - path.start[0],
                    path.end[1] - path.start[1],
                    path.end[2] - path.start[2],
                  ) || 1;
                const k = v / len;
                edit({
                  path: {
                    ...path,
                    end: [0, 1, 2].map((i) => path.start[i]! + (path.end[i]! - path.start[i]!) * k),
                  },
                });
              }}
            />
          ) : (
            <span className={styles.paramNote}>
              Path: {path.kind === 'edges' ? plural(path.edges.length, 'edge') : 'sketch outline'}
            </span>
          )}
          {operation(feature.operation)}
        </div>
      );
    }
    case 'loft':
      return (
        <div className={styles.params}>
          <div>
            <span className={styles.paramLabel}>Sides</span>
            <Select
              aria-label={`${feature.name} sides`}
              value={feature.ruled ? 'ruled' : 'smooth'}
              options={[
                { value: 'smooth', label: 'Smooth' },
                { value: 'ruled', label: 'Straight' },
              ]}
              onChange={(event) => edit({ ruled: event.currentTarget.value === 'ruled' })}
            />
          </div>
          <span className={styles.paramNote}>{plural(feature.profiles.length, 'profile')}</span>
          {operation(feature.operation)}
        </div>
      );
    case 'mirror':
      return (
        <div className={styles.params}>
          {planeOffset(feature.plane)}
          <div>
            <span className={styles.paramLabel}>Original</span>
            <Select
              aria-label={`${feature.name} keep original`}
              value={feature.keepOriginal ? 'keep' : 'move'}
              options={[
                { value: 'keep', label: 'Keep' },
                { value: 'move', label: 'Mirror in place' },
              ]}
              onChange={(event) => edit({ keepOriginal: event.currentTarget.value === 'keep' })}
            />
          </div>
          <span className={styles.paramNote}>
            {plural(feature.bodyIds.length, 'body', 'bodies')}
          </span>
        </div>
      );
    case 'pattern': {
      const p = feature.pattern;
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Count"
            value={p.count}
            onCommit={(v) => edit({ pattern: { ...p, count: Math.round(v) } })}
          />
          {p.kind === 'linear' ? (
            <ExpressionField
              label="Spacing"
              value={p.spacing}
              unit="mm"
              onCommit={(v) => edit({ pattern: { ...p, spacing: v } })}
            />
          ) : (
            <ExpressionField
              label="Total angle"
              value={p.angle}
              unit="°"
              onCommit={(v) => edit({ pattern: { ...p, angle: v } })}
            />
          )}
          <span className={styles.paramNote}>
            {p.kind === 'linear'
              ? `Linear along the ${axisText(p.direction)}`
              : `Circular about the ${axisText(p.axis)}`}
          </span>
        </div>
      );
    }
    case 'split':
      return <div className={styles.params}>{planeOffset(feature.plane)}</div>;
    case 'transform':
      return (
        <div className={styles.params}>
          {(['dx', 'dy', 'dz'] as const).map((field) => (
            <ExpressionField
              key={field}
              label={`d${field.slice(1).toUpperCase()}`}
              value={feature[field]}
              unit="mm"
              onCommit={(v) => edit({ [field]: v })}
            />
          ))}
          {(['rx', 'ry', 'rz'] as const).map((field) => (
            <ExpressionField
              key={field}
              label={`Rotate ${field.slice(1).toUpperCase()}`}
              value={feature[field]}
              unit="°"
              onCommit={(v) => edit({ [field]: v })}
            />
          ))}
          {[0, 1, 2].map((i) => (
            <ExpressionField
              key={`pivot${i}`}
              label={`Pivot ${'XYZ'[i]}`}
              value={feature.pivot[i]!}
              unit="mm"
              onCommit={(v) => edit({ pivot: feature.pivot.map((p, j) => (j === i ? v : p)) })}
            />
          ))}
          <div>
            <span className={styles.paramLabel}>Result</span>
            <Select
              aria-label={`${feature.name} copy`}
              value={feature.copy ? 'copy' : 'move'}
              options={[
                { value: 'move', label: 'Move' },
                { value: 'copy', label: 'Copy' },
              ]}
              onChange={(event) => edit({ copy: event.currentTarget.value === 'copy' })}
            />
          </div>
        </div>
      );
    case 'align':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Gap"
            value={feature.offset}
            unit="mm"
            onCommit={(v) => edit({ offset: v })}
          />
          <div>
            <span className={styles.paramLabel}>Faces</span>
            <Select
              aria-label={`${feature.name} direction`}
              value={feature.flip ? 'flush' : 'opposed'}
              options={[
                { value: 'opposed', label: 'Face to face' },
                { value: 'flush', label: 'Same direction' },
              ]}
              onChange={(event) => edit({ flip: event.currentTarget.value === 'flush' })}
            />
          </div>
          <div>
            <span className={styles.paramLabel}>Position</span>
            <Select
              aria-label={`${feature.name} centre`}
              value={feature.center ? 'center' : 'keep'}
              options={[
                { value: 'center', label: 'Centred' },
                { value: 'keep', label: 'Keep position' },
              ]}
              onChange={(event) => edit({ center: event.currentTarget.value === 'center' })}
            />
          </div>
        </div>
      );
    case 'offsetFace':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Distance"
            value={feature.distance}
            unit="mm"
            onCommit={(v) => edit({ distance: v })}
          />
          <span className={styles.paramNote}>{plural(feature.faces.length, 'face')}</span>
        </div>
      );
    case 'deleteFace':
      return (
        <div className={styles.params}>
          <span className={styles.paramNote}>{plural(feature.faces.length, 'face')} removed</span>
        </div>
      );
  }
}
