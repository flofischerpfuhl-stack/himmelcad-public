/**
 * History-card parameters of the modelling features (`features.ts`):
 * every numeric parameter is an `ExpressionField`, options are `Select`s;
 * each edit is one `editFeatureParams` call (one undo step).
 */
import { Select } from '@himmelcad/ui';

import type { ExtrudeOperation, Plane, AxisRef } from '../../../foundation/document/document.js';
import {
  PRIMITIVE_LABEL,
  PRIMITIVE_SIZE_FIELDS,
  type ModelingFeature,
  type PrimitiveShape,
  type RevolveHelix,
} from '../features.js';
import type { AssemblerState, FeaturePatch } from '../../../foundation/commands/store.js';
import { ExpressionField } from '../../../platform/widgets/ExpressionField.js';
import { PrintFeatureParams } from './PrintFeatureParams.js';
import styles from '../../../platform/widgets/HistoryCard.module.css';

const OPERATION_OPTIONS = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
];

function axisText(axis: AxisRef): string {
  if (axis.kind === 'world') return `${axis.axis} axis`;
  if (axis.kind === 'edge')
    return axis.edge.signature.curve === 'circle' ? 'circular edge axis' : 'edge';
  if (axis.kind === 'construction') return 'construction axis';
  return 'sketch line';
}

/** A helix switched on from the History card: 5 mm pitch, 3 turns. */
const DEFAULT_HELIX: RevolveHelix = { pitch: 5, turns: 3 };

/** History-card labels of the primitive sizes. */
export const PRIMITIVE_FIELD_LABEL: Record<PrimitiveShape, Partial<Record<string, string>>> = {
  box: { width: 'Width', depth: 'Depth', height: 'Height' },
  cylinder: { radius: 'Radius', height: 'Height' },
  sphere: { radius: 'Radius' },
  cone: { radius: 'Base radius', radius2: 'Top radius', height: 'Height' },
  torus: { radius: 'Ring radius', radius2: 'Tube radius' },
};

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
    plane:
      | { kind: 'plane'; plane: Plane; offset: number }
      | { kind: 'face' }
      | { kind: 'construction'; featureId: string },
  ) =>
    plane.kind === 'plane' ? (
      <ExpressionField
        label={`Plane ${plane.plane} offset`}
        value={plane.offset}
        unit="mm"
        onCommit={(v) => edit({ plane: { ...plane, offset: v } })}
      />
    ) : plane.kind === 'construction' ? (
      <span className={styles.paramNote}>
        Plane: {state.features.find((f) => f.id === plane.featureId)?.name ?? 'construction plane'}
      </span>
    ) : (
      <span className={styles.paramNote}>Plane: a planar face</span>
    );

  switch (feature.kind) {
    case 'revolve': {
      const helix = feature.helix;
      return (
        <div className={styles.params}>
          <div>
            <span className={styles.paramLabel}>Path</span>
            <Select
              aria-label={`${feature.name} path`}
              value={helix ? 'helix' : 'plain'}
              options={[
                { value: 'plain', label: 'Revolve' },
                { value: 'helix', label: 'Helix' },
              ]}
              onChange={(event) =>
                edit({
                  helix: event.currentTarget.value === 'helix' ? DEFAULT_HELIX : undefined,
                })
              }
            />
          </div>
          {helix ? (
            <>
              <ExpressionField
                label="Pitch"
                value={helix.pitch}
                unit="mm"
                onCommit={(v) => edit({ helix: { ...helix, pitch: v } })}
              />
              <ExpressionField
                label="Turns"
                value={helix.turns}
                onCommit={(v) => edit({ helix: { ...helix, turns: v } })}
              />
              <ExpressionField
                label="Height"
                value={Math.abs(helix.pitch) * helix.turns}
                unit="mm"
                onCommit={(v) =>
                  edit({
                    helix: {
                      ...helix,
                      turns: Math.abs(helix.pitch) > 0 ? v / Math.abs(helix.pitch) : helix.turns,
                    },
                  })
                }
              />
              <div>
                <span className={styles.paramLabel}>Hand</span>
                <Select
                  aria-label={`${feature.name} handedness`}
                  value={helix.leftHanded ? 'left' : 'right'}
                  options={[
                    { value: 'right', label: 'Right-handed' },
                    { value: 'left', label: 'Left-handed' },
                  ]}
                  onChange={(event) => {
                    const { leftHanded: _drop, ...rest } = helix;
                    edit({
                      helix:
                        event.currentTarget.value === 'left' ? { ...rest, leftHanded: true } : rest,
                    });
                  }}
                />
              </div>
            </>
          ) : (
            <ExpressionField
              label="Angle"
              value={feature.angle}
              unit="°"
              onCommit={(v) => edit({ angle: v })}
            />
          )}
          <span className={styles.paramNote}>About the {axisText(feature.axis)}</span>
          {operation(feature.operation)}
        </div>
      );
    }
    case 'scale': {
      const factors = feature.factors;
      return (
        <div className={styles.params}>
          {factors ? (
            (['X', 'Y', 'Z'] as const).map((axis, i) => (
              <ExpressionField
                key={axis}
                label={`Factor ${axis}`}
                value={factors[i]!}
                onCommit={(v) => edit({ factors: factors.map((f, j) => (j === i ? v : f)) })}
              />
            ))
          ) : (
            <ExpressionField
              label="Factor"
              value={feature.factor}
              onCommit={(v) => edit({ factor: v, factorExpression: undefined })}
            />
          )}
          <div>
            <span className={styles.paramLabel}>Scaling</span>
            <Select
              aria-label={`${feature.name} uniform`}
              value={factors ? 'axes' : 'uniform'}
              options={[
                { value: 'uniform', label: 'Uniform' },
                { value: 'axes', label: 'Per axis' },
              ]}
              onChange={(event) =>
                edit(
                  event.currentTarget.value === 'axes'
                    ? { factors: [feature.factor, feature.factor, feature.factor] }
                    : { factors: undefined, factor: factors?.[0] ?? feature.factor },
                )
              }
            />
          </div>
          {[0, 1, 2].map((i) => (
            <ExpressionField
              key={`center${i}`}
              label={`Centre ${'XYZ'[i]}`}
              value={feature.center[i]!}
              unit="mm"
              onCommit={(v) => edit({ center: feature.center.map((p, j) => (j === i ? v : p)) })}
            />
          ))}
          <div>
            <span className={styles.paramLabel}>Result</span>
            <Select
              aria-label={`${feature.name} copy`}
              value={feature.copy ? 'copy' : 'move'}
              options={[
                { value: 'move', label: 'Scale' },
                { value: 'copy', label: 'Copy' },
              ]}
              onChange={(event) => edit({ copy: event.currentTarget.value === 'copy' })}
            />
          </div>
          <span className={styles.paramNote}>
            {plural(feature.bodyIds.length, 'body', 'bodies')}
          </span>
        </div>
      );
    }
    case 'translate': {
      const delta = feature.to.map((t, i) => t - feature.from[i]!);
      return (
        <div className={styles.params}>
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <ExpressionField
              key={axis}
              label={`Move ${axis}`}
              value={delta[i]!}
              unit="mm"
              onCommit={(v) =>
                edit({ to: feature.to.map((t, j) => (j === i ? feature.from[j]! + v : t)) })
              }
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
          <span className={styles.paramNote}>
            {plural(feature.bodyIds.length, 'body', 'bodies')}, point to point
          </span>
        </div>
      );
    }
    case 'primitive':
      return (
        <div className={styles.params}>
          {PRIMITIVE_SIZE_FIELDS[feature.shape].map((field) => (
            <ExpressionField
              key={field}
              label={PRIMITIVE_FIELD_LABEL[feature.shape][field] ?? field}
              value={feature[field] ?? 0}
              unit="mm"
              onCommit={(v) => edit({ [field]: v, [`${field}Expression`]: undefined })}
            />
          ))}
          <div>
            <span className={styles.paramLabel}>Side</span>
            <Select
              aria-label={`${feature.name} side`}
              value={feature.flip ? 'in' : 'out'}
              options={[
                { value: 'out', label: feature.plane.kind === 'face' ? 'Outward' : 'Above' },
                { value: 'in', label: feature.plane.kind === 'face' ? 'Into face' : 'Below' },
              ]}
              onChange={(event) =>
                edit({ flip: event.currentTarget.value === 'in' ? true : undefined })
              }
            />
          </div>
          <span className={styles.paramNote}>
            {PRIMITIVE_LABEL[feature.shape]} on{' '}
            {feature.plane.kind === 'plane'
              ? `the ${feature.plane.plane} plane`
              : feature.plane.kind === 'face'
                ? 'a face'
                : 'a construction plane'}
          </span>
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
          {feature.axis ? (
            <span className={styles.paramNote}>About the {axisText(feature.axis)}</span>
          ) : (
            planeOffset(feature.plane)
          )}
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
            {[
              feature.bodyIds.length > 0 ? plural(feature.bodyIds.length, 'body', 'bodies') : '',
              feature.sketchIds?.length
                ? plural(feature.sketchIds.length, 'sketch', 'sketches')
                : '',
              feature.faces?.length ? plural(feature.faces.length, 'face') : '',
            ]
              .filter(Boolean)
              .join(', ')}
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
              label={p.spacingMode === 'total' ? 'Total length' : 'Spacing'}
              value={p.spacing}
              unit="mm"
              onCommit={(v) => edit({ pattern: { ...p, spacing: v } })}
            />
          ) : (
            <ExpressionField
              label={p.angleMode === 'spacing' ? 'Angle between' : 'Total angle'}
              value={p.angle}
              unit="°"
              onCommit={(v) => edit({ pattern: { ...p, angle: v } })}
            />
          )}
          {p.kind === 'linear' && p.second ? (
            <>
              <ExpressionField
                label="Count 2"
                value={p.second.count}
                onCommit={(v) =>
                  edit({ pattern: { ...p, second: { ...p.second!, count: Math.round(v) } } })
                }
              />
              <ExpressionField
                label={p.spacingMode === 'total' ? 'Total length 2' : 'Spacing 2'}
                value={p.second.spacing}
                unit="mm"
                onCommit={(v) => edit({ pattern: { ...p, second: { ...p.second!, spacing: v } } })}
              />
            </>
          ) : null}
          {p.kind === 'circular' ? (
            <div>
              <span className={styles.paramLabel}>Copies</span>
              <Select
                aria-label={`${feature.name} copies`}
                value={p.uniform ? 'uniform' : 'rotated'}
                options={[
                  { value: 'rotated', label: 'Rotated' },
                  { value: 'uniform', label: 'Uniform' },
                ]}
                onChange={(event) =>
                  edit({
                    pattern: {
                      ...p,
                      uniform: event.currentTarget.value === 'uniform' || undefined,
                    },
                  })
                }
              />
            </div>
          ) : null}
          <span className={styles.paramNote}>
            {p.kind === 'linear'
              ? `Linear along the ${axisText(p.direction)}`
              : `Circular about the ${axisText(p.axis)}`}
          </span>
        </div>
      );
    }
    case 'split':
      return (
        <div className={styles.params}>
          {feature.profile ? (
            <span className={styles.paramNote}>With a sketch profile, through the body</span>
          ) : (
            planeOffset(feature.plane)
          )}
          <div>
            <span className={styles.paramLabel}>Original</span>
            <Select
              aria-label={`${feature.name} keep original`}
              value={feature.keepOriginal ? 'keep' : 'split'}
              options={[
                { value: 'split', label: 'Split it' },
                { value: 'keep', label: 'Keep' },
              ]}
              onChange={(event) =>
                edit({ keepOriginal: event.currentTarget.value === 'keep' ? true : undefined })
              }
            />
          </div>
        </div>
      );
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
    case 'rotateAxis':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Angle"
            value={feature.angle}
            unit="°"
            onCommit={(v) => edit({ angle: v })}
          />
          <div>
            <span className={styles.paramLabel}>Result</span>
            <Select
              aria-label={`${feature.name} copy`}
              value={feature.copy ? 'copy' : 'move'}
              options={[
                { value: 'move', label: 'Rotate' },
                { value: 'copy', label: 'Copy' },
              ]}
              onChange={(event) => edit({ copy: event.currentTarget.value === 'copy' })}
            />
          </div>
          <span className={styles.paramNote}>
            {plural(feature.bodyIds.length, 'body', 'bodies')} about the {axisText(feature.axis)}
          </span>
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
    case 'hole':
    case 'emboss':
    case 'draft':
    case 'rib':
    case 'thicken':
      return <PrintFeatureParams feature={feature} state={state} />;
  }
}
