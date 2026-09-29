/**
 * Tool-session chrome: a top-centre pill (tool name, shortcut, one-line
 * prompt, the tool's option badge — Extrude New/Join/Cut, Fillet/Chamfer,
 * Union/Subtract/Intersect, Radius/Diameter — and the kernel's error for
 * the current parameters) plus floating Done/Cancel buttons near the bottom
 * centre. Rendered whenever `activeTool` is set; the viewport owns the
 * in-canvas handles and editable dimension chips this refers to.
 */
import { AlertTriangle, ArrowLeftRight, Check, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Select, Tooltip } from '@himmelcad/ui';

import { edgeRuleLabel } from '../model/blendOptions.js';
import { evaluateExpression } from './expression.js';

import {
  isPreviewTool,
  type AssemblerState,
  type ToolSession as ToolSessionState,
} from '../model/store.js';
import { draftBadges, draftMeta } from '../model/featureTools.js';
import styles from './ToolSession.module.css';

interface ToolMeta {
  label: string;
  shortcut: string;
  prompt: string;
}

function toolMeta(tool: ToolSessionState): ToolMeta {
  switch (tool.kind) {
    case 'extrude':
      return {
        label: 'Extrude',
        shortcut: 'E',
        prompt:
          tool.distance === 0
            ? 'Drag the arrow or type a distance.'
            : 'Drag the arrow or type a distance, then Done.',
      };
    case 'move':
      return {
        label: 'Move/Rotate',
        shortcut: 'M',
        prompt:
          'Drag an arrow or ring, or type a value. Rings snap to 15° (Shift: free); drag the centre to move the pivot.',
      };
    case 'feature':
      return draftMeta(tool.draft);
    case 'edgeBlend':
      return {
        label: tool.blend === 'fillet' ? 'Fillet' : 'Chamfer',
        shortcut: 'F',
        prompt: `Drag the arrow or type a ${tool.blend === 'fillet' ? 'radius' : 'distance'}. ${tool.edges.length} ${tool.edges.length === 1 ? 'edge' : 'edges'}; click edges to add or remove.`,
      };
    case 'shell':
      return {
        label: 'Shell',
        shortcut: 'H',
        prompt: `Drag the arrow or type a wall thickness. ${tool.faces.length} open ${tool.faces.length === 1 ? 'face' : 'faces'}; click faces to open or close them.`,
      };
    case 'boolean':
      return {
        label: 'Boolean',
        shortcut: '',
        prompt: `Keeps the target body; ${tool.toolBodyIds.length === 1 ? '1 tool body' : `${tool.toolBodyIds.length} tool bodies`} ${tool.keepTools ? 'kept' : 'consumed'}. Click bodies to add or remove tools.`,
      };
  }
}

interface BadgeOption<T extends string> {
  value: T;
  label: string;
}

function Badge<T extends string>(props: {
  ariaLabel: string;
  value: T;
  options: readonly BadgeOption<T>[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <span className={styles.badge} role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          className={`${styles.badgeOption} ${props.value === option.value ? styles.badgeOptionActive : ''}`}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/** A compact numeric entry inside the pill (second fillet radius, chamfer distance/angle). */
function PillNumber(props: {
  label: string;
  value: number;
  unit: string;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(props.value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(String(Math.round(props.value * 1000) / 1000)), [props.value]);
  const commit = () => {
    const parsed = evaluateExpression(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== props.value) props.onCommit(parsed);
  };
  return (
    <label className={`${styles.pillField} ${invalid ? styles.pillFieldInvalid : ''}`}>
      <span>{props.label}</span>
      <input
        value={draft}
        aria-label={props.label}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commit();
          }
        }}
      />
      <span>{props.unit}</span>
    </label>
  );
}

function BlendVariantControls({
  state,
  tool,
}: {
  state: AssemblerState;
  tool: Extract<ToolSessionState, { kind: 'edgeBlend' }>;
}): JSX.Element {
  const rules = tool.rules ?? [];
  const ruleNote =
    rules.length > 0 ? (
      <span className={styles.prompt}>+ {rules.map(edgeRuleLabel).join(', ')}</span>
    ) : null;
  if (tool.blend === 'fillet') {
    return (
      <>
        <Badge
          ariaLabel="Fillet radius"
          value={tool.radius2 !== undefined ? 'variable' : 'constant'}
          options={[
            { value: 'constant', label: 'Constant' },
            { value: 'variable', label: 'Variable' },
          ]}
          onChange={(v) =>
            state.setBlendOptions({ radius2: v === 'variable' ? tool.size * 2 : undefined })
          }
        />
        {tool.radius2 !== undefined ? (
          <PillNumber
            label="End R"
            value={tool.radius2}
            unit="mm"
            onCommit={(v) => state.setBlendOptions({ radius2: v })}
          />
        ) : null}
        {ruleNote}
      </>
    );
  }
  const mode = tool.chamferMode ?? 'equal';
  return (
    <>
      <Badge
        ariaLabel="Chamfer type"
        value={mode}
        options={[
          { value: 'equal', label: 'Equal' },
          { value: 'twoDistances', label: 'Two distances' },
          { value: 'distanceAngle', label: 'Distance + angle' },
        ]}
        onChange={(v) =>
          state.setBlendOptions({ chamferMode: v === 'equal' ? undefined : v })
        }
      />
      {mode === 'twoDistances' ? (
        <PillNumber
          label="D2"
          value={tool.distance2 ?? tool.size * 2}
          unit="mm"
          onCommit={(v) => state.setBlendOptions({ distance2: v })}
        />
      ) : null}
      {mode === 'distanceAngle' ? (
        <PillNumber
          label="Angle"
          value={tool.angle ?? 45}
          unit="°"
          onCommit={(v) => state.setBlendOptions({ angle: v })}
        />
      ) : null}
      {mode !== 'equal' ? (
        <Button
          variant="secondary"
          size="small"
          icon={<ArrowLeftRight size={13} />}
          aria-label="Swap chamfer sides"
          onClick={() => state.setBlendOptions({ flip: tool.flip ? undefined : true })}
        >
          Flip
        </Button>
      ) : null}
      {ruleNote}
    </>
  );
}

function ToolBadge({
  state,
  tool,
}: {
  state: AssemblerState;
  tool: ToolSessionState;
}): JSX.Element | null {
  switch (tool.kind) {
    case 'extrude':
      if (tool.profile.kind !== 'sketch') return null;
      return (
        <Badge
          ariaLabel="Extrude operation"
          value={tool.operation}
          options={[
            { value: 'new', label: 'New body' },
            { value: 'join', label: 'Join' },
            { value: 'cut', label: 'Cut' },
          ]}
          onChange={(operation) => state.setExtrudeOperation(operation)}
        />
      );
    case 'edgeBlend':
      return (
        <>
          <Badge
            ariaLabel="Edge treatment"
            value={tool.blend}
            options={[
              { value: 'fillet', label: 'Fillet' },
              { value: 'chamfer', label: 'Chamfer' },
            ]}
            onChange={(blend) => state.setBlendKind(blend)}
          />
          <BlendVariantControls state={state} tool={tool} />
        </>
      );
    case 'shell':
      return (
        <Badge
          ariaLabel="Shell direction"
          value={tool.direction ?? 'inside'}
          options={[
            { value: 'inside', label: 'Inside' },
            { value: 'outside', label: 'Outside' },
          ]}
          onChange={(direction) => state.setShellDirection(direction)}
        />
      );
    case 'boolean':
      return (
        <>
          <Badge
            ariaLabel="Boolean operation"
            value={tool.operation}
            options={[
              { value: 'union', label: 'Union' },
              { value: 'subtract', label: 'Subtract' },
              { value: 'intersect', label: 'Intersect' },
            ]}
            onChange={(operation) => state.setBooleanOperation(operation)}
          />
          <Badge
            ariaLabel="Tool bodies"
            value={tool.keepTools ? 'keep' : 'consume'}
            options={[
              { value: 'consume', label: 'Consume tools' },
              { value: 'keep', label: 'Keep tools' },
            ]}
            onChange={(value) => state.setBooleanKeepTools(value === 'keep')}
          />
          <Tooltip content="Swap target and tool">
            <Button
              variant="secondary"
              size="small"
              icon={<ArrowLeftRight size={13} />}
              aria-label="Swap target and tool"
              onClick={() => state.swapBooleanTarget()}
            >
              Swap
            </Button>
          </Tooltip>
        </>
      );
    case 'move':
      return (
        <Badge
          ariaLabel="Move or copy"
          value={tool.copy ? 'copy' : 'move'}
          options={[
            { value: 'move', label: 'Move' },
            { value: 'copy', label: 'Copy' },
          ]}
          onChange={(value) => state.setMoveCopy(value === 'copy')}
        />
      );
    case 'feature':
      return (
        <>
          {draftBadges(tool.draft).map((badge) => {
            const onChange = (value: string) =>
              state.updateFeatureDraft((draft, evaluation) =>
                badge.apply(draft, value, evaluation),
              );
            // Long option lists (hole sizes and fits) are a compact menu, not a row of pills.
            return badge.options.length > 4 ? (
              <span key={badge.ariaLabel} className={styles.badgeSelect}>
                <Select
                  aria-label={badge.ariaLabel}
                  value={badge.value}
                  options={badge.options}
                  onChange={(event) => onChange(event.currentTarget.value)}
                />
              </span>
            ) : (
              <Badge
                key={badge.ariaLabel}
                ariaLabel={badge.ariaLabel}
                value={badge.value}
                options={badge.options}
                onChange={onChange}
              />
            );
          })}
        </>
      );
    default:
      return null;
  }
}

export function ToolSession({ state }: { state: AssemblerState }): JSX.Element | null {
  const tool = state.activeTool;
  if (!tool) return null;
  const meta = toolMeta(tool);
  const preview = isPreviewTool(tool) ? tool : null;
  const error = preview?.previewError ?? null;
  const blocked = error !== null && !(preview?.previewPending ?? false);

  return (
    <>
      <div className={styles.pill} role="status" aria-label={`${meta.label} tool active`}>
        <span className={styles.name}>{meta.label}</span>
        {meta.shortcut ? <span className={styles.shortcut}>{meta.shortcut}</span> : null}
        <span className={styles.divider} aria-hidden />
        <span className={styles.prompt}>{meta.prompt}</span>
        <ToolBadge state={state} tool={tool} />
        {preview?.previewPending ? (
          <span className={styles.busy} aria-label="Computing preview">
            <LoaderCircle size={13} />
          </span>
        ) : null}
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={13} aria-hidden />
          <span>{error}</span>
          <span className={styles.errorHint}>Showing the last valid preview.</span>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Tooltip content="Cancel (Esc)">
          <Button
            variant="secondary"
            size="small"
            icon={<X size={14} />}
            aria-label="Cancel tool"
            onClick={() => state.cancel()}
          >
            Cancel
          </Button>
        </Tooltip>
        <Tooltip content={blocked ? 'Fix the error first' : 'Done (Enter)'}>
          <Button
            variant="primary"
            size="small"
            icon={<Check size={14} />}
            aria-label="Commit tool"
            disabled={blocked}
            onClick={() => state.commit()}
          >
            Done
          </Button>
        </Tooltip>
      </div>
    </>
  );
}
