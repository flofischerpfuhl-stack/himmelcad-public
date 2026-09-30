/**
 * History-card parameters of the print features (`model/printFeatures.ts`)
 * and of the Fillet/Chamfer/Shell/Boolean variants
 * (`model/blendOptions.ts`). Every numeric parameter is an
 * `ExpressionField`, options are `Select`s; each edit is one
 * `editFeatureParams` call (one undo step). Picked edges and rules can be
 * removed one by one ("Fillet: remove" by editing).
 */
import { X } from 'lucide-react';

import { Select } from '@himmelcad/ui';

import type {
  BooleanFeature,
  ChamferFeature,
  FilletFeature,
  ShellFeature,
} from '../model/document.js';
import { edgeRuleLabel } from '../model/blendOptions.js';
import {
  METRIC_HOLE_SIZES,
  holePreset,
  holeSummary,
  type HoleFeature,
  type PrintFeature,
} from '../model/printFeatures.js';
import type { AssemblerState, FeaturePatch } from '../model/store.js';
import { ExpressionField } from './ExpressionField.js';
import styles from './HistoryPanel.module.css';

const OPERATION_OPTIONS = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function useEdit(state: AssemblerState, featureId: string) {
  return (patch: Record<string, unknown>) =>
    state.editFeatureParams(featureId, patch as FeaturePatch);
}

/** A removable reference row (edge, rule, face thickness). */
function RefRow({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove: (() => void) | null;
  removeLabel: string;
}): JSX.Element {
  return (
    <div className={styles.paramsFull} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className={styles.paramNote} style={{ flex: 1 }}>
        {label}
      </span>
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          style={{
            display: 'inline-flex',
            border: 'none',
            background: 'transparent',
            color: 'var(--hc-fg-subtle)',
            cursor: 'pointer',
            padding: 2,
          }}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function HoleParams({
  feature,
  state,
}: {
  feature: HoleFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = useEdit(state, feature.id);
  const setType = (holeType: HoleFeature['holeType']) => {
    const size = feature.thread ?? 'M3';
    const preset = holePreset(size, 'clearanceNormal', holeType);
    edit({
      holeType,
      ...(holeType === 'counterbore'
        ? {
            counterboreDiameter: Math.max(preset?.counterboreDiameter ?? 0, feature.diameter + 1),
            counterboreDepth: preset?.counterboreDepth ?? 3,
          }
        : {}),
      ...(holeType === 'countersink'
        ? {
            countersinkDiameter: Math.max(preset?.countersinkDiameter ?? 0, feature.diameter + 1),
            countersinkAngle: 90,
          }
        : {}),
    });
  };
  return (
    <div className={styles.params}>
      <span className={styles.paramsFull}>
        <span className={styles.paramNote}>{holeSummary(feature)}</span>
      </span>
      {feature.preset ? (
        <span className={styles.paramsFull}>
          <span className={styles.paramNote}>Preset: {feature.preset}</span>
        </span>
      ) : null}
      <ExpressionField
        label="Diameter"
        value={feature.diameter}
        unit="mm"
        onCommit={(v) => edit({ diameter: v })}
      />
      {feature.extent.kind === 'blind' ? (
        <ExpressionField
          label="Depth"
          value={feature.extent.depth}
          unit="mm"
          onCommit={(v) => edit({ extent: { kind: 'blind', depth: v } })}
        />
      ) : null}
      <div>
        <span className={styles.paramLabel}>Type</span>
        <Select
          aria-label={`${feature.name} hole type`}
          value={feature.holeType}
          options={[
            { value: 'simple', label: 'Simple' },
            { value: 'counterbore', label: 'Counterbore' },
            { value: 'countersink', label: 'Countersink' },
          ]}
          onChange={(event) => setType(event.currentTarget.value as HoleFeature['holeType'])}
        />
      </div>
      <div>
        <span className={styles.paramLabel}>Extent</span>
        <Select
          aria-label={`${feature.name} extent`}
          value={feature.extent.kind}
          options={[
            { value: 'through', label: 'Through all' },
            { value: 'blind', label: 'Blind' },
          ]}
          onChange={(event) =>
            edit({
              extent:
                event.currentTarget.value === 'through'
                  ? { kind: 'through' }
                  : { kind: 'blind', depth: Math.max(5, feature.diameter * 2) },
            })
          }
        />
      </div>
      {feature.holeType === 'counterbore' ? (
        <>
          <ExpressionField
            label="Counterbore Ø"
            value={feature.counterboreDiameter ?? 0}
            unit="mm"
            onCommit={(v) => edit({ counterboreDiameter: v })}
          />
          <ExpressionField
            label="Counterbore depth"
            value={feature.counterboreDepth ?? 0}
            unit="mm"
            onCommit={(v) => edit({ counterboreDepth: v })}
          />
        </>
      ) : null}
      {feature.holeType === 'countersink' ? (
        <>
          <ExpressionField
            label="Countersink Ø"
            value={feature.countersinkDiameter ?? 0}
            unit="mm"
            onCommit={(v) => edit({ countersinkDiameter: v })}
          />
          <ExpressionField
            label="Countersink angle"
            value={feature.countersinkAngle ?? 90}
            unit="°"
            onCommit={(v) => edit({ countersinkAngle: v })}
          />
        </>
      ) : null}
      <div className={styles.paramsFull}>
        <span className={styles.paramLabel}>Cosmetic thread</span>
        <Select
          aria-label={`${feature.name} cosmetic thread`}
          value={feature.thread ?? ''}
          options={[
            { value: '', label: 'None' },
            ...METRIC_HOLE_SIZES.map((s) => ({
              value: s.thread,
              label: `${s.thread} (label only)`,
            })),
          ]}
          onChange={(event) => edit({ thread: event.currentTarget.value || undefined })}
        />
      </div>
    </div>
  );
}

export function PrintFeatureParams({
  feature,
  state,
}: {
  feature: PrintFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = useEdit(state, feature.id);
  switch (feature.kind) {
    case 'hole':
      return <HoleParams feature={feature} state={state} />;
    case 'emboss':
      return (
        <div className={styles.params}>
          <ExpressionField
            label={feature.depth < 0 ? 'Engrave depth' : 'Emboss height'}
            value={feature.depth}
            unit="mm"
            onCommit={(v) => edit({ depth: v })}
          />
          <span className={styles.paramNote}>
            {feature.face.signature.surface === 'cylinder'
              ? 'Wrapped around a cylinder'
              : 'On a planar face'}
          </span>
        </div>
      );
    case 'draft':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Angle"
            value={feature.angle}
            unit="°"
            onCommit={(v) => edit({ angle: v })}
          />
          <div>
            <span className={styles.paramLabel}>Pull direction</span>
            <Select
              aria-label={`${feature.name} pull direction`}
              value={feature.flip ? 'flip' : 'normal'}
              options={[
                { value: 'normal', label: 'Away from neutral' },
                { value: 'flip', label: 'Reversed' },
              ]}
              onChange={(event) => edit({ flip: event.currentTarget.value === 'flip' })}
            />
          </div>
          <span className={styles.paramNote}>
            {plural(feature.faces.length, 'face')}, neutral{' '}
            {feature.neutral.kind === 'plane'
              ? `${feature.neutral.plane} at ${feature.neutral.offset} mm`
              : 'face'}
          </span>
        </div>
      );
    case 'rib':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Thickness"
            value={feature.thickness}
            unit="mm"
            onCommit={(v) => edit({ thickness: v })}
          />
          <div>
            <span className={styles.paramLabel}>Side</span>
            <Select
              aria-label={`${feature.name} side`}
              value={feature.flip ? 'flip' : 'body'}
              options={[
                { value: 'body', label: 'Towards the body' },
                { value: 'flip', label: 'Other side' },
              ]}
              onChange={(event) => edit({ flip: event.currentTarget.value === 'flip' })}
            />
          </div>
          <span className={styles.paramNote}>
            {plural(feature.entityIds.length, 'sketch line')}
          </span>
        </div>
      );
    case 'thicken':
      return (
        <div className={styles.params}>
          <ExpressionField
            label="Thickness"
            value={feature.thickness}
            unit="mm"
            onCommit={(v) => edit({ thickness: v })}
          />
          <div>
            <span className={styles.paramLabel}>Direction</span>
            <Select
              aria-label={`${feature.name} direction`}
              value={feature.direction}
              options={[
                { value: 'outside', label: 'Outside' },
                { value: 'inside', label: 'Inside' },
                { value: 'both', label: 'Both sides' },
              ]}
              onChange={(event) => edit({ direction: event.currentTarget.value })}
            />
          </div>
          <div className={styles.paramsFull}>
            <span className={styles.paramLabel}>Operation</span>
            <Select
              aria-label={`${feature.name} operation`}
              value={feature.operation}
              options={OPERATION_OPTIONS}
              onChange={(event) => edit({ operation: event.currentTarget.value })}
            />
          </div>
        </div>
      );
  }
}

// ---- Fillet / Chamfer / Shell / Boolean -------------------------------------------------------

export function BlendParams({
  feature,
  state,
}: {
  feature: FilletFeature | ChamferFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = useEdit(state, feature.id);
  const rules = feature.rules ?? [];
  const total = feature.edges.length + rules.length;
  const removeEdge = (key: string) => edit({ edges: feature.edges.filter((e) => e.key !== key) });
  const removeRule = (index: number) => {
    const next = rules.filter((_, i) => i !== index);
    edit({ rules: next.length > 0 ? next : undefined });
  };
  return (
    <div className={styles.params}>
      {feature.kind === 'fillet' ? (
        <>
          <ExpressionField
            label={feature.radius2 !== undefined ? 'Start radius' : 'Radius'}
            value={feature.radius}
            unit="mm"
            onCommit={(v) => edit({ radius: v })}
          />
          {feature.radius2 !== undefined ? (
            <ExpressionField
              label="End radius"
              value={feature.radius2}
              unit="mm"
              onCommit={(v) => edit({ radius2: v })}
            />
          ) : null}
          <div>
            <span className={styles.paramLabel}>Radius</span>
            <Select
              aria-label={`${feature.name} radius law`}
              value={feature.radius2 !== undefined ? 'variable' : 'constant'}
              options={[
                { value: 'constant', label: 'Constant' },
                { value: 'variable', label: 'Variable (start to end)' },
              ]}
              onChange={(event) =>
                edit({
                  radius2:
                    event.currentTarget.value === 'variable' ? feature.radius * 2 : undefined,
                })
              }
            />
          </div>
        </>
      ) : (
        <>
          <ExpressionField
            label={feature.mode && feature.mode !== 'equal' ? 'Distance 1' : 'Distance'}
            value={feature.distance}
            unit="mm"
            onCommit={(v) => edit({ distance: v })}
          />
          {feature.mode === 'twoDistances' ? (
            <ExpressionField
              label="Distance 2"
              value={feature.distance2 ?? feature.distance}
              unit="mm"
              onCommit={(v) => edit({ distance2: v })}
            />
          ) : null}
          {feature.mode === 'distanceAngle' ? (
            <ExpressionField
              label="Angle"
              value={feature.angle ?? 45}
              unit="°"
              onCommit={(v) => edit({ angle: v })}
            />
          ) : null}
          <div>
            <span className={styles.paramLabel}>Chamfer</span>
            <Select
              aria-label={`${feature.name} chamfer type`}
              value={feature.mode ?? 'equal'}
              options={[
                { value: 'equal', label: 'Equal distance' },
                { value: 'twoDistances', label: 'Two distances' },
                { value: 'distanceAngle', label: 'Distance and angle' },
              ]}
              onChange={(event) => {
                const mode = event.currentTarget.value;
                edit({
                  mode: mode === 'equal' ? undefined : mode,
                  distance2:
                    mode === 'twoDistances'
                      ? (feature.distance2 ?? feature.distance * 2)
                      : undefined,
                  angle: mode === 'distanceAngle' ? (feature.angle ?? 45) : undefined,
                });
              }}
            />
          </div>
          {feature.mode && feature.mode !== 'equal' ? (
            <div>
              <span className={styles.paramLabel}>Side</span>
              <Select
                aria-label={`${feature.name} chamfer side`}
                value={feature.flip ? 'flip' : 'first'}
                options={[
                  { value: 'first', label: 'Distance 1 on face A' },
                  { value: 'flip', label: 'Distance 1 on face B' },
                ]}
                onChange={(event) =>
                  edit({ flip: event.currentTarget.value === 'flip' || undefined })
                }
              />
            </div>
          ) : null}
        </>
      )}
      <span className={styles.paramsFull}>
        <span className={styles.paramNote}>{plural(total, 'edge selection')}</span>
      </span>
      {feature.edges.map((edge, i) => (
        <RefRow
          key={edge.key}
          label={`Edge ${i + 1}${edge.signature.curve === 'circle' ? ' (round)' : ''}`}
          removeLabel={`Remove edge ${i + 1} from ${feature.name}`}
          onRemove={total > 1 ? () => removeEdge(edge.key) : null}
        />
      ))}
      {rules.map((rule, i) => (
        <RefRow
          key={`rule-${i}`}
          label={`Rule: ${edgeRuleLabel(rule)}`}
          removeLabel={`Remove rule ${i + 1} from ${feature.name}`}
          onRemove={total > 1 ? () => removeRule(i) : null}
        />
      ))}
    </div>
  );
}

export function ShellParams({
  feature,
  state,
}: {
  feature: ShellFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = useEdit(state, feature.id);
  const walls = feature.faceThickness ?? [];
  return (
    <div className={styles.params}>
      <ExpressionField
        label="Thickness"
        value={feature.thickness}
        unit="mm"
        onCommit={(v) => edit({ thickness: v })}
      />
      <div>
        <span className={styles.paramLabel}>Direction</span>
        <Select
          aria-label={`${feature.name} direction`}
          value={feature.direction ?? 'inside'}
          options={[
            { value: 'inside', label: 'Inside' },
            { value: 'outside', label: 'Outside' },
          ]}
          onChange={(event) =>
            event.currentTarget.value === 'outside'
              ? edit({ direction: 'outside' })
              : edit({ direction: undefined, clearance: undefined })
          }
        />
      </div>
      {feature.direction === 'outside' ? (
        <ExpressionField
          label="Clearance"
          value={feature.clearance ?? 0}
          unit="mm"
          onCommit={(v) => edit({ clearance: v > 0 ? v : undefined })}
        />
      ) : null}
      <span className={styles.paramsFull}>
        <span className={styles.paramNote}>
          {feature.faces.length} open {feature.faces.length === 1 ? 'face' : 'faces'}
        </span>
      </span>
      {walls.map((wall, i) => (
        <div key={wall.face.key} className={styles.paramsFull} style={{ display: 'flex', gap: 6 }}>
          <ExpressionField
            label={`Wall ${i + 1}`}
            value={wall.thickness}
            unit="mm"
            onCommit={(v) =>
              edit({
                faceThickness: walls.map((w, j) => (j === i ? { ...w, thickness: v } : w)),
              })
            }
          />
          <RefRow
            label=""
            removeLabel={`Remove wall ${i + 1} thickness`}
            onRemove={() => {
              const next = walls.filter((_, j) => j !== i);
              edit({ faceThickness: next.length > 0 ? next : undefined });
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function BooleanParams({
  feature,
  state,
}: {
  feature: BooleanFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = useEdit(state, feature.id);
  return (
    <div className={styles.params}>
      <div>
        <span className={styles.paramLabel}>Operation</span>
        <Select
          aria-label={`${feature.name} operation`}
          value={feature.operation}
          options={[
            { value: 'union', label: 'Union' },
            { value: 'subtract', label: 'Subtract' },
            { value: 'intersect', label: 'Intersect' },
          ]}
          onChange={(event) => edit({ operation: event.currentTarget.value })}
        />
      </div>
      <div>
        <span className={styles.paramLabel}>Tool bodies</span>
        <Select
          aria-label={`${feature.name} keep tools`}
          value={feature.keepTools ? 'keep' : 'consume'}
          options={[
            { value: 'consume', label: 'Consumed' },
            { value: 'keep', label: 'Kept' },
          ]}
          onChange={(event) =>
            edit({ keepTools: event.currentTarget.value === 'keep' || undefined })
          }
        />
      </div>
      <span className={styles.paramNote}>
        {plural(feature.toolBodyIds.length, 'tool body', 'tool bodies')}
      </span>
    </div>
  );
}
