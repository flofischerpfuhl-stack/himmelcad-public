/**
 * Tool-session chrome: a top-centre pill (tool name, shortcut, one-line
 * prompt, the tool's option badge — Extrude New/Join/Cut, Fillet/Chamfer,
 * Union/Subtract/Intersect, Radius/Diameter — and the kernel's error for
 * the current parameters) plus floating Done/Cancel buttons near the bottom
 * centre. Rendered whenever `activeTool` is set; the viewport owns the
 * in-canvas handles and editable dimension chips this refers to.
 */
import { AlertTriangle, ArrowLeftRight, Check, ChevronRight, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Select, Tooltip } from '@himmelcad/ui';

import { edgeRuleLabel, PRINT_CLEARANCES } from '../../foundation/document/blendOptions.js';
import { MAX_EXTRUDE_TAPER } from '../../foundation/document/document.js';

import { evaluateExpression } from '../../platform/widgets/expression.js';

import {
  isPreviewTool,
  type AssemblerState,
  type ToolSession as ToolSessionState,
} from '../../foundation/commands/store.js';

import { draftBadges, draftMeta, draftSteps } from '../../foundation/commands/featureDrafts.js';
import { useFixStore } from './fixReference.js';
import { isWorldAxes } from '../../modules/modeling/moveGizmo.js';
import { PICK_PLANS, removePick, swapPicks } from '../../foundation/commands/pickSession.js';
import { emptyClickFinishes } from '../../foundation/commands/toolFinish.js';
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
          tool.extent === 'toObject'
            ? tool.extentTarget
              ? 'To Object: click another face or body to change it; drag the arrow to flip the direction.'
              : 'To Object: click the face or body to extrude up to.'
            : tool.extent === 'throughAll'
              ? 'Through All: drag the arrow to flip the direction, then Done.'
              : tool.distance === 0
                ? 'Drag the arrow or type a distance.'
                : 'Drag the arrow or type a distance, then Done.',
      };
    case 'move':
      return {
        label: tool.sketch ? 'Move Profile' : 'Move/Rotate',
        shortcut: 'M',
        prompt: tool.sketch
          ? 'Drag an arrow or the plane tile to move the profile in its sketch plane, or type a value.'
          : 'Drag an arrow, a plane tile or a ring, or type a value. Rings snap to 15° (Shift: free); drag the centre to move the pivot.',
      };
    case 'pick': {
      const plan = PICK_PLANS[tool.commandId];
      const step = plan?.steps[Math.min(tool.step, (plan?.steps.length ?? 1) - 1)];
      return {
        label: plan?.label ?? 'Tool',
        shortcut: plan?.shortcut ?? '',
        prompt: step?.prompt ?? '',
      };
    }
    case 'feature':
      return draftMeta(tool.draft);
    case 'edgeBlend': {
      const size = tool.blend === 'fillet' ? 'radius' : 'distance';
      const picked = `${tool.edges.length} ${tool.edges.length === 1 ? 'edge' : 'edges'}`;
      return {
        label: tool.blend === 'fillet' ? 'Fillet' : 'Chamfer',
        shortcut: 'F',
        prompt:
          tool.rules && tool.rules.length > 0
            ? `Drag the arrow or type a ${size}. Edges by rule${tool.edges.length > 0 ? ` + ${picked}` : ''}; click edges to add more.`
            : `Drag the arrow or type a ${size}. ${picked}; click edges to add or remove.`,
      };
    }
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
        prompt: `${tool.keepTarget ? 'Keeps the target unchanged, the result is a new body' : 'Changes the target body'}; ${tool.toolBodyIds.length === 1 ? '1 tool body' : `${tool.toolBodyIds.length} tool bodies`} ${tool.keepTools ? 'kept' : 'consumed'}. Click bodies to add or remove tools.`,
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
        onChange={(v) => state.setBlendOptions({ chamferMode: v === 'equal' ? undefined : v })}
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

/** Extrude: operation (New/Join/Cut/Intersect), extent, sides, second distance, start offset. */
function ExtrudeControls({
  state,
  tool,
}: {
  state: AssemblerState;
  tool: Extract<ToolSessionState, { kind: 'extrude' }>;
}): JSX.Element {
  const sides = tool.sides ?? 'one';
  return (
    <>
      {tool.profile.kind === 'sketch' ? (
        <Badge
          ariaLabel="Extrude operation"
          value={tool.operation}
          options={[
            { value: 'new', label: 'New body' },
            { value: 'join', label: 'Join' },
            { value: 'cut', label: 'Cut' },
            { value: 'intersect', label: 'Intersect' },
          ]}
          onChange={(operation) => state.setExtrudeOperation(operation)}
        />
      ) : (
        <Badge
          ariaLabel="Extrude operation"
          value={tool.operation === 'intersect' ? 'intersect' : 'auto'}
          options={[
            { value: 'auto', label: tool.distance < 0 ? 'Cut' : 'Join' },
            { value: 'intersect', label: 'Intersect' },
          ]}
          onChange={(value) =>
            state.setExtrudeOperation(value === 'intersect' ? 'intersect' : 'join')
          }
        />
      )}
      <Badge
        ariaLabel="Extent"
        value={tool.extent ?? 'distance'}
        options={[
          { value: 'distance', label: 'Distance' },
          { value: 'toObject', label: 'To Object' },
          { value: 'throughAll', label: 'Through All' },
        ]}
        onChange={(extent) => state.setExtrudeOptions({ extent })}
      />
      <Badge
        ariaLabel="Sides"
        value={sides}
        options={[
          { value: 'one', label: 'One side' },
          { value: 'symmetric', label: 'Symmetric' },
          { value: 'two', label: 'Two sides' },
        ]}
        onChange={(value) => state.setExtrudeOptions({ sides: value })}
      />
      {sides === 'two' ? (
        <PillNumber
          label="Side 2"
          value={tool.distance2 ?? 0}
          unit="mm"
          onCommit={(v) => state.setExtrudeOptions({ distance2: Math.max(0, v) })}
        />
      ) : null}
      <PillNumber
        label="Start"
        value={tool.startOffset ?? 0}
        unit="mm"
        onCommit={(v) => state.setExtrudeOptions({ startOffset: v === 0 ? undefined : v })}
      />
      {/* Every extent tapers (Through All and To Object trim the tapered prism, Block 9). */}
      <PillNumber
        label="Taper"
        value={tool.taper ?? 0}
        unit="°"
        onCommit={(v) =>
          state.setExtrudeOptions({
            taper:
              v === 0 ? undefined : Math.max(-MAX_EXTRUDE_TAPER, Math.min(MAX_EXTRUDE_TAPER, v)),
          })
        }
      />
    </>
  );
}

/** Input steps of a feature tool with a Next step (Translate, Align, Rotate Around Axis). */
function DraftStepBadges({
  state,
  tool,
}: {
  state: AssemblerState;
  tool: Extract<ToolSessionState, { kind: 'feature' }>;
}): JSX.Element | null {
  const steps = draftSteps(tool.draft);
  if (!steps) return null;
  const last = steps.current >= steps.labels.length - 1;
  return (
    <>
      <span className={styles.badge} role="group" aria-label="Tool steps">
        {steps.labels.map((label, index) => (
          <button
            key={label}
            type="button"
            aria-current={index === steps.current ? 'step' : undefined}
            className={`${styles.badgeOption} ${index === steps.current ? styles.badgeOptionActive : ''}`}
            onClick={() => state.updateFeatureDraft((draft) => steps.go(draft, index))}
          >
            {index + 1} {label}
          </button>
        ))}
      </span>
      {last ? null : (
        <Button
          variant="secondary"
          size="small"
          icon={<ChevronRight size={13} />}
          aria-label="Next step"
          onClick={() => state.updateFeatureDraft((draft) => steps.go(draft, steps.current + 1))}
        >
          Next
        </Button>
      )}
    </>
  );
}

/** Tool before selection: one badge per reference step with its picks (× removes), Swap. */
function PickBadges({
  state,
  tool,
}: {
  state: AssemblerState;
  tool: Extract<ToolSessionState, { kind: 'pick' }>;
}): JSX.Element | null {
  const plan = PICK_PLANS[tool.commandId];
  if (!plan) return null;
  const label = (item: (typeof tool.picks)[number][number]) => pickItemLabel(state, item);
  return (
    <>
      {plan.steps.map((step, index) => {
        const picks = tool.picks[index] ?? [];
        const current = index === Math.min(tool.step, plan.steps.length - 1);
        const missing = picks.length < step.min;
        return (
          <span
            key={step.role}
            className={`${styles.refBadge} ${current ? styles.refBadgeCurrent : ''} ${missing ? styles.refBadgeMissing : ''}`}
            role="group"
            aria-label={`${step.role}: ${picks.length} picked${missing ? ', needed' : ''}`}
          >
            <span className={styles.refRole}>{step.role}</span>
            {picks.length === 0 ? (
              <span className={styles.refEmpty}>{step.min === 0 ? 'optional' : 'pick'}</span>
            ) : (
              picks.map((item, i) => (
                <button
                  key={`${index}:${i}`}
                  type="button"
                  className={styles.refChip}
                  aria-label={`Remove ${label(item)} from ${step.role}`}
                  title="Remove"
                  onClick={() =>
                    state.updatePickSession((session) => removePick(session, index, i))
                  }
                >
                  {label(item)}
                  <X size={11} aria-hidden />
                </button>
              ))
            )}
          </span>
        );
      })}
      {plan.swap && (tool.picks[plan.swap[1]]?.length ?? 0) > 0 ? (
        <Tooltip content="Swap target and tools">
          <Button
            variant="secondary"
            size="small"
            icon={<ArrowLeftRight size={13} />}
            aria-label="Swap target and tools"
            onClick={() => state.updatePickSession(swapPicks)}
          >
            Swap
          </Button>
        </Tooltip>
      ) : null}
      {tool.problem ? <span className={styles.pickProblem}>{tool.problem}</span> : null}
    </>
  );
}

/** Short badge text of a picked reference ("Body 2", "face", "Sketch 1 profile"). */
function pickItemLabel(
  state: AssemblerState,
  item: Extract<ToolSessionState, { kind: 'pick' }>['picks'][number][number],
): string {
  const bodyName = (id: string) => state.evaluation.bodies.find((b) => b.id === id)?.name ?? 'body';
  const featureName = (id: string) => state.features.find((f) => f.id === id)?.name ?? id;
  switch (item.kind) {
    case 'body':
      return bodyName(item.bodyId);
    case 'face':
      return `${bodyName(item.bodyId)} face`;
    case 'edge':
      return `${bodyName(item.bodyId)} edge`;
    case 'sketchProfile':
      return item.regionKey
        ? `${featureName(item.featureId)} profile`
        : featureName(item.featureId);
    case 'datum':
      return featureName(item.featureId);
    default:
      return item.kind;
  }
}

/** History "Fix…": what to pick, the problem with the last pick, Cancel. */
function FixPill({ itemsOpen }: { itemsOpen: boolean }): JSX.Element | null {
  const session = useFixStore((s) => s.session);
  if (!session) return null;
  return (
    <>
      <div className={pillClass(itemsOpen)} role="status" aria-label={`Fix ${session.featureName}`}>
        <span className={styles.name}>Fix {session.featureName}</span>
        <span className={styles.divider} aria-hidden />
        <span className={styles.prompt}>
          Pick a replacement {session.missing.label}
          {session.missing.ghost ? ' — the missing one is outlined in red' : ''}.
          {session.total > 1 ? ` (${session.total} missing references)` : ''}
        </span>
        {session.problem ? <span className={styles.pickProblem}>{session.problem}</span> : null}
      </div>
      <div className={styles.actions}>
        <Tooltip content="Stop fixing (Esc)">
          <Button
            variant="secondary"
            size="small"
            icon={<X size={14} />}
            aria-label="Stop fixing"
            onClick={() => useFixStore.getState().end()}
          >
            Cancel
          </Button>
        </Tooltip>
      </div>
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
      return <ExtrudeControls state={state} tool={tool} />;
    case 'pick':
      return <PickBadges state={state} tool={tool} />;
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
        <>
          <Badge
            ariaLabel="Shell direction"
            value={tool.direction ?? 'inside'}
            options={[
              { value: 'inside', label: 'Inside' },
              { value: 'outside', label: 'Outside' },
            ]}
            onChange={(direction) => state.setShellDirection(direction)}
          />
          {tool.direction === 'outside' ? (
            // Printing clearance: a case/sleeve that fits over the body.
            <Badge
              ariaLabel="Clearance"
              value={String(tool.clearance ?? 0)}
              options={[
                { value: '0', label: 'No gap' },
                ...PRINT_CLEARANCES.map((c) => ({ value: String(c), label: `+${c}` })),
              ]}
              onChange={(value) => state.setShellClearance(Number(value))}
            />
          ) : null}
        </>
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
          <Badge
            ariaLabel="Target body"
            value={tool.keepTarget ? 'keep' : 'modify'}
            options={[
              { value: 'modify', label: 'Modify target' },
              { value: 'keep', label: 'Keep target' },
            ]}
            onChange={(value) => state.setBooleanKeepTarget(value === 'keep')}
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
        <>
          {tool.sketch ? null : (
            <Badge
              ariaLabel="Move or copy"
              value={tool.copy ? 'copy' : 'move'}
              options={[
                { value: 'move', label: 'Move' },
                { value: 'copy', label: 'Copy' },
              ]}
              onChange={(value) => state.setMoveCopy(value === 'copy')}
            />
          )}
          {!tool.sketch && tool.copy ? (
            // Shapr3D's Link badge: an unlinked copy no longer follows the history (MOD-16).
            <Badge
              ariaLabel="Link to history"
              value={tool.linked === false ? 'unlinked' : 'linked'}
              options={[
                { value: 'linked', label: 'Linked' },
                { value: 'unlinked', label: 'Unlinked' },
              ]}
              onChange={(value) => state.setMoveLinked(value === 'linked')}
            />
          ) : null}
          {tool.unlinking ? (
            <span className={styles.busy} aria-label="Writing the unlinked copy">
              <LoaderCircle size={13} />
            </span>
          ) : null}
          {tool.sketch ? null : (
            <Badge
              ariaLabel="Auto-orientation"
              value={tool.autoOrient === false ? 'off' : 'on'}
              options={[
                { value: 'on', label: 'Auto-orient' },
                { value: 'off', label: 'Fixed' },
              ]}
              onChange={(value) => state.setMoveAutoOrient(value === 'on')}
            />
          )}
          {!tool.sketch && tool.axes && !isWorldAxes(tool.axes) ? (
            <Button
              variant="secondary"
              size="small"
              aria-label="Align the gizmo with the world axes"
              onClick={() => state.setMoveAxes(null)}
            >
              World axes
            </Button>
          ) : null}
          {tool.problem ? <span className={styles.pickProblem}>{tool.problem}</span> : null}
        </>
      );
    case 'feature':
      return (
        <>
          <DraftStepBadges state={state} tool={tool} />
          {draftBadges(tool.draft, state.evaluation).map((badge) => {
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

/**
 * With the Items panel open the pill is centred in the band between that
 * panel and the right dock, so a wide tool bar never covers the panel's
 * header (tablet layout at 1180 px, narrow windows).
 */
function pillClass(itemsOpen: boolean): string {
  return itemsOpen ? `${styles.pill} ${styles.pillBesideItems}` : (styles.pill ?? '');
}

export function ToolSession({ state }: { state: AssemblerState }): JSX.Element | null {
  const tool = state.activeTool;
  if (!tool) return <FixPill itemsOpen={state.panels.items} />;
  const meta = toolMeta(tool);
  const preview = isPreviewTool(tool) ? tool : null;
  const error = preview?.previewError ?? null;
  const blocked = error !== null && !(preview?.previewPending ?? false);
  // A pick session's primary action is "Next" (or "Start" when everything is picked).
  const pickPlan = tool.kind === 'pick' ? PICK_PLANS[tool.commandId] : undefined;
  const pickLast =
    tool.kind === 'pick' && pickPlan ? tool.step >= pickPlan.steps.length - 1 : false;
  const doneLabel = tool.kind === 'pick' ? (pickLast ? 'Start' : 'Next') : 'Done';

  return (
    <>
      <div
        className={pillClass(state.panels.items)}
        role="status"
        aria-label={`${meta.label} tool active`}
      >
        <span className={styles.name}>{meta.label}</span>
        {meta.shortcut ? <span className={styles.shortcut}>{meta.shortcut}</span> : null}
        <span className={styles.divider} aria-hidden />
        <span className={styles.prompt}>{meta.prompt}</span>
        <ToolBadge state={state} tool={tool} />
        {emptyClickFinishes(tool) ? (
          // Empty-space click = Done competes with "deselect": say so (interaction research §4).
          <span
            className={styles.finishHint}
            title="A click on empty space finishes this tool, like Done (Enter). Esc cancels."
          >
            Click empty space to finish
          </span>
        ) : null}
        {preview?.previewPending ? (
          <span className={styles.busy} aria-label="Computing preview">
            <LoaderCircle size={13} />
          </span>
        ) : null}
        {error ? (
          <div className={styles.error} role="alert">
            <AlertTriangle size={13} aria-hidden />
            <span>{error}</span>
            <span className={styles.errorHint}>Showing the last valid preview.</span>
          </div>
        ) : null}
      </div>
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
        <Tooltip content={blocked ? 'Fix the error first' : `${doneLabel} (Enter)`}>
          <Button
            variant="primary"
            size="small"
            icon={<Check size={14} />}
            aria-label="Commit tool"
            disabled={blocked}
            onClick={() => state.commit()}
          >
            {doneLabel}
          </Button>
        </Tooltip>
      </div>
    </>
  );
}
