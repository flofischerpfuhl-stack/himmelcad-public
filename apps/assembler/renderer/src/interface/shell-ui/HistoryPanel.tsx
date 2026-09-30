/**
 * History panel (right): feature cards in document order. Expanding a
 * card shows its editable parameters (`ExpressionField`s, committing via
 * `editFeatureParams` — one undo step per edit, the signature parametric
 * demo). Card menu (Shapr3D card settings, interaction research §3): Rename,
 * Suppress/Unsuppress, Breakpoint after this step / Remove breakpoint (the
 * rollback marker), Zoom to, Duplicate, Move up/down, Delete. A focused
 * card: Del suppresses, Shift+Del deletes, Enter expands, F2 renames. The
 * header expands/collapses all cards. Suppressed cards are dimmed; cards
 * with an `evaluation.errors` entry show a warning style and the message.
 *
 * The header filter shows only the steps relevant to the selection. The
 * rollback marker (drag it, or "Roll back to here") excludes the steps
 * below it from evaluation (greyed) and new steps are inserted at it.
 * Cards are reordered by dragging; a move that would put a step before
 * something it references is refused with the reason.
 */
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GripHorizontal,
  ListFilter,
  MoreHorizontal,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import {
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
  Tooltip,
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { anchoredMenuStyle } from '../../platform/widgets/anchoredMenu.js';
import { featureKindIcon } from './icons.js';
import { ExpressionField } from '../../platform/widgets/ExpressionField.js';
import { ParamExpressionField } from '../../platform/widgets/ParamExpressionField.js';
import { historyCardFor } from '../../platform/widgets/moduleUi.js';
import {
  checkMove,
  duplicateStep,
  featureZoomTargets,
  historyFilterItems,
  moveFeature,
  relevantFeatureIds,
  stepNamePrefix,
} from './historyTools.js';
import { nextFeatureName } from '../../foundation/commands/store.js';
import { startFix } from './fixReference.js';
import { resolveParameterValues } from '../../foundation/document/parameters.js';
import { useWorkspaceStore } from './workspace.js';
import type { AssemblerState, FeaturePatch } from '../../foundation/commands/store.js';
import type { ExtrudeOperation, Feature } from '../../foundation/document/document.js';
import { useSketchStore } from '../../sketch/session.js';
import panelStyles from '../../platform/widgets/Panel.module.css';
import styles from '../../platform/widgets/HistoryCard.module.css';

export interface HistoryPanelProps {
  state: AssemblerState;
  onContextMenu: (x: number, y: number) => void;
}

const DRAG_STEP = 'application/x-hcasm-step';
const DRAG_MARKER = 'application/x-hcasm-rollback';

/** Moves a step (validated against references) as one undo step, or explains why not. */
function tryMoveStep(state: AssemblerState, from: number, to: number): void {
  if (from === to) return;
  const check = checkMove(state.features, from, to);
  if (!check.ok) {
    useWorkspaceStore.getState().notify(check.reason, 'warning');
    return;
  }
  const moved = state.commitDocumentChange(moveFeature(state.features, from, to), {
    keepRollback: true,
    selection: state.selection,
  });
  if (!moved) useWorkspaceStore.getState().notify('Finish the running tool first.', 'warning');
}

/** History card "Duplicate": a copy right after the step, as one undo step. */
function duplicateHistoryStep(state: AssemblerState, feature: Feature): void {
  const id = state.allocateFeatureId(feature.kind);
  const name = nextFeatureName(stepNamePrefix(feature.name), state.features);
  const done = state.commitDocumentChange(duplicateStep(state.features, feature.id, id, name), {
    keepRollback: true,
    selection: [{ kind: 'feature', featureId: id }],
  });
  if (!done) useWorkspaceStore.getState().notify('Finish the running tool first.', 'warning');
}

/** History card "Zoom to": frames the step's geometry without changing the selection. */
function zoomToStep(state: AssemblerState, feature: Feature): void {
  const items = featureZoomTargets(feature, state.features, state.evaluation);
  if (items.length === 0) {
    useWorkspaceStore.getState().notify(`"${feature.name}" has no geometry to zoom to.`);
    return;
  }
  useWorkspaceStore.getState().sendCamera({ kind: 'fitItems', items });
}

export function HistoryPanel({ state, onContextMenu }: HistoryPanelProps): JSX.Element {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [filterToSelection, setFilterToSelection] = useState(false);
  /** Insertion gap (0..n) highlighted while a step or the rollback marker is dragged. */
  const [dropGap, setDropGap] = useState<number | null>(null);

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const features = state.features;
  const markerIndex = state.rollbackBefore
    ? features.findIndex((f) => f.id === state.rollbackBefore)
    : -1;
  // Shapr3D: the History filters to the selection's steps, or — nothing selected, Isolate on —
  // to the isolated objects' steps.
  const filterItems = historyFilterItems(state.selection, state.isolatedBodyIds);
  const relevant = useMemo(() => {
    const items = historyFilterItems(state.selection, state.isolatedBodyIds);
    return filterToSelection && items.length > 0
      ? relevantFeatureIds(features, state.evaluation, items)
      : null;
  }, [filterToSelection, features, state.evaluation, state.selection, state.isolatedBodyIds]);
  const shown = features.filter((f) => !relevant || relevant.has(f.id));
  const allExpanded = shown.length > 0 && shown.every((f) => expandedIds.has(f.id));

  /** Gap index (before feature `index`, or after it for the lower half). */
  const gapFromEvent = (event: React.DragEvent, index: number): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
  };

  const onDropAt = (event: React.DragEvent, gap: number) => {
    setDropGap(null);
    const step = event.dataTransfer.getData(DRAG_STEP);
    const marker = event.dataTransfer.getData(DRAG_MARKER);
    event.preventDefault();
    if (marker) {
      state.setRollback(features[gap]?.id ?? null);
      return;
    }
    if (step) {
      const from = features.findIndex((f) => f.id === step);
      if (from < 0) return;
      tryMoveStep(state, from, gap > from ? gap - 1 : gap);
    }
  };

  const dragOver = (event: React.DragEvent, gap: number) => {
    const types = event.dataTransfer.types;
    if (!types.includes(DRAG_STEP) && !types.includes(DRAG_MARKER)) return;
    event.preventDefault();
    if (dropGap !== gap) setDropGap(gap);
  };

  const marker = (
    <RollbackMarker
      key="rollback-marker"
      active={markerIndex >= 0}
      rolledBack={markerIndex >= 0 ? features.length - markerIndex : 0}
      onRollForward={() => state.setRollback(null)}
      disabled={state.activeTool !== null}
    />
  );

  return (
    <div
      className={`${panelStyles.root} ${panelStyles.historyPlacement}`}
      aria-label="History panel"
    >
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>History</span>
        <span className={panelStyles.count}>
          {relevant ? `${shown.length} of ${features.length}` : features.length}{' '}
          {features.length === 1 ? 'step' : 'steps'}
        </span>
        <span className={panelStyles.headerSpacer} />
        <Tooltip content={allExpanded ? 'Collapse all steps' : 'Expand all steps'}>
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label={allExpanded ? 'Collapse all steps' : 'Expand all steps'}
            disabled={features.length === 0}
            onClick={() =>
              setExpandedIds(allExpanded ? new Set() : new Set(shown.map((f) => f.id)))
            }
          >
            {allExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </button>
        </Tooltip>
        <Tooltip
          content={
            filterItems.length === 0
              ? 'Show only steps of the selection or of the isolated objects (select or isolate something first)'
              : filterToSelection
                ? 'Show all steps'
                : state.selection.length > 0
                  ? 'Show only steps of the selection'
                  : 'Show only steps of the isolated objects'
          }
        >
          <button
            type="button"
            className={`${panelStyles.headerButton} ${filterToSelection ? styles.headerButtonActive : ''}`}
            aria-label="Filter to selection or isolated objects"
            aria-pressed={filterToSelection}
            onClick={() => setFilterToSelection((v) => !v)}
          >
            <ListFilter size={14} />
          </button>
        </Tooltip>
      </div>
      <div
        className={panelStyles.body}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropGap(null);
        }}
      >
        {features.length === 0 ? <div className={panelStyles.empty}>No history yet</div> : null}
        {relevant && shown.length === 0 ? (
          <div className={panelStyles.empty}>
            {state.selection.length > 0
              ? 'No steps for the selection'
              : 'No steps for the isolated objects'}
          </div>
        ) : null}
        {features.map((feature, index) => {
          if (relevant && !relevant.has(feature.id)) {
            return index === markerIndex ? marker : null;
          }
          return (
            <Fragment key={feature.id}>
              {index === markerIndex ? marker : null}
              <div
                className={`${styles.dropZone} ${dropGap === index ? styles.dropBefore : ''} ${dropGap === index + 1 && index === features.length - 1 ? styles.dropAfter : ''}`}
                onDragOver={(event) => dragOver(event, gapFromEvent(event, index))}
                onDrop={(event) => onDropAt(event, gapFromEvent(event, index))}
              >
                <HistoryCard
                  feature={feature}
                  index={index}
                  state={state}
                  rolledBack={markerIndex >= 0 && index >= markerIndex}
                  breakpointAfter={markerIndex === index + 1}
                  expanded={expandedIds.has(feature.id)}
                  onToggleExpanded={() => toggleExpanded(feature.id)}
                  menuOpen={menuOpenId === feature.id}
                  onMenuOpenChange={(open) => setMenuOpenId(open ? feature.id : null)}
                  renaming={renamingId === feature.id}
                  onRenamingChange={(renaming) => setRenamingId(renaming ? feature.id : null)}
                  onContextMenu={(x, y) => {
                    state.select({ kind: 'feature', featureId: feature.id });
                    onContextMenu(x, y);
                  }}
                />
              </div>
            </Fragment>
          );
        })}
        {features.length > 0 && markerIndex < 0 ? (
          <div
            onDragOver={(event) => dragOver(event, features.length)}
            onDrop={(event) => onDropAt(event, features.length)}
          >
            {marker}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The rollback bar: at the end of the list it marks "everything active"
 * (drag it up to roll back); inside the list, steps below it are rolled
 * back (not evaluated, greyed) and new steps are inserted at it.
 */
function RollbackMarker({
  active,
  rolledBack,
  onRollForward,
  disabled,
}: {
  active: boolean;
  rolledBack: number;
  onRollForward: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div
      className={`${styles.marker} ${active ? styles.markerActive : ''}`}
      draggable={!disabled}
      role="separator"
      aria-label={
        active
          ? `Rollback marker: ${rolledBack} ${rolledBack === 1 ? 'step' : 'steps'} rolled back`
          : 'Rollback marker at the end of the history'
      }
      title={
        disabled ? 'Finish the running tool first' : 'Drag to roll the history back or forward'
      }
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MARKER, '1');
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <GripHorizontal size={12} className={styles.markerGrip} aria-hidden />
      <span className={styles.markerLine} />
      {active ? (
        <>
          <span className={styles.markerLabel} title="New steps are inserted here">
            {rolledBack} rolled back
          </span>
          <button
            type="button"
            className={styles.markerButton}
            onClick={onRollForward}
            disabled={disabled}
          >
            Roll forward
          </button>
        </>
      ) : (
        <span className={styles.markerLabelQuiet}>End</span>
      )}
    </div>
  );
}

interface HistoryCardProps {
  feature: Feature;
  index: number;
  /** Below the rollback marker: not evaluated, greyed. */
  rolledBack: boolean;
  /** The rollback marker (Shapr3D "breakpoint") sits right after this step. */
  breakpointAfter: boolean;
  state: AssemblerState;
  expanded: boolean;
  onToggleExpanded: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  onContextMenu: (x: number, y: number) => void;
}

function HistoryCard({
  feature,
  index,
  rolledBack,
  breakpointAfter,
  state,
  expanded,
  onToggleExpanded,
  menuOpen,
  onMenuOpenChange,
  renaming,
  onRenamingChange,
  onContextMenu,
}: HistoryCardProps): JSX.Element {
  const Icon = featureKindIcon(feature.kind);
  const error = state.evaluation.errors[feature.id];
  const warning = state.evaluation.warnings[feature.id];
  const selected = state.selection.some(
    (item) => item.kind === 'feature' && item.featureId === feature.id,
  );
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  useEffect(() => {
    if (!renaming) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = renameInputRef.current;
      if (!input || document.activeElement !== input) return false;
      revertEscapeField(input, feature.name);
      onRenamingChange(false);
      return true;
    });
  }, [renaming, feature.name, onRenamingChange]);

  return (
    <div
      className={`${styles.card} ${selected ? styles.cardSelected : ''} ${
        feature.suppressed ? styles.cardSuppressed : ''
      } ${error ? styles.cardError : ''} ${rolledBack ? styles.cardRolledBack : ''}`}
      title={rolledBack ? 'Rolled back: not part of the model until you roll forward' : undefined}
    >
      <div
        className={styles.cardHeader}
        tabIndex={renaming ? -1 : 0}
        aria-label={`${feature.name}${feature.suppressed ? ' (suppressed)' : ''}`}
        onKeyDown={(event) => {
          if (renaming || event.target !== event.currentTarget) return;
          // Shapr3D History: Delete/Backspace suppresses the step, Shift+Delete deletes it.
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            if (event.shiftKey) state.deleteFeature(feature.id);
            else state.setSuppressed(feature.id, !feature.suppressed);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            state.select({ kind: 'feature', featureId: feature.id });
            onToggleExpanded();
          } else if (event.key === 'F2') {
            event.preventDefault();
            onRenamingChange(true);
          }
        }}
        draggable={!renaming}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_STEP, feature.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => {
          state.select({ kind: 'feature', featureId: feature.id });
          onToggleExpanded();
        }}
        onDoubleClick={() => {
          // Double-clicking a sketch step opens it in sketch mode (Shapr3D).
          if (feature.kind === 'sketch') useSketchStore.getState().begin({ featureId: feature.id });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY);
        }}
      >
        <span className={styles.chevron}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className={styles.icon}>
          <Icon size={13} />
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className={styles.name}
            defaultValue={feature.name}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (consumeEscapeBlurCommitSuppression(event.currentTarget)) {
                onRenamingChange(false);
                return;
              }
              const value = event.currentTarget.value.trim();
              if (value && value !== feature.name) state.renameFeature(feature.id, value);
              onRenamingChange(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        ) : (
          <span className={styles.name}>{feature.name}</span>
        )}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={styles.menuButton}
            aria-label={`${feature.name} options`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              if (!menuOpen) setMenuStyle(anchoredMenuStyle(event.currentTarget, 230));
              onMenuOpenChange(!menuOpen);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen ? (
            <Menu
              ariaLabel={`${feature.name} options`}
              onClose={() => onMenuOpenChange(false)}
              style={menuStyle}
            >
              <MenuItem
                onSelect={() => {
                  onRenamingChange(true);
                }}
              >
                Rename
              </MenuItem>
              <MenuItem onSelect={() => state.setSuppressed(feature.id, !feature.suppressed)}>
                <span className={styles.menuRow}>
                  {feature.suppressed ? 'Unsuppress' : 'Suppress'}
                  <span className={styles.menuShortcut}>Del</span>
                </span>
              </MenuItem>
              <MenuItem
                disabled={
                  state.activeTool !== null ||
                  (!breakpointAfter && index === state.features.length - 1)
                }
                {...(!breakpointAfter && index === state.features.length - 1
                  ? { title: 'This is the last step; nothing comes after it.' }
                  : {})}
                onSelect={() =>
                  state.setRollback(
                    breakpointAfter ? null : (state.features[index + 1]?.id ?? null),
                  )
                }
              >
                {breakpointAfter ? 'Remove breakpoint' : 'Breakpoint after this step'}
              </MenuItem>
              <MenuItem onSelect={() => zoomToStep(state, feature)}>Zoom to</MenuItem>
              <MenuItem
                disabled={state.activeTool !== null}
                onSelect={() => duplicateHistoryStep(state, feature)}
              >
                Duplicate
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={index === 0}
                onSelect={() => tryMoveStep(state, index, index - 1)}
              >
                Move up
              </MenuItem>
              <MenuItem
                disabled={index === state.features.length - 1}
                onSelect={() => tryMoveStep(state, index, index + 1)}
              >
                Move down
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => state.deleteFeature(feature.id)}>
                <span className={styles.menuRow}>
                  Delete
                  <span className={styles.menuShortcut}>Shift+Del</span>
                </span>
              </MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className={styles.errorMessage}>
          <AlertTriangle size={12} />
          <span className={styles.errorText}>{error}</span>
          {/^Missing reference/.test(error) || /no longer resolve/.test(error) ? (
            <button
              type="button"
              className={styles.fixButton}
              disabled={state.activeTool !== null}
              aria-label={`Fix ${feature.name}: pick a replacement reference`}
              title="Show where the missing reference was and pick a replacement"
              onClick={(event) => {
                event.stopPropagation();
                const reason = startFix(feature.id);
                if (reason) useWorkspaceStore.getState().notify(reason, 'warning');
              }}
            >
              Fix…
            </button>
          ) : null}
        </div>
      ) : null}
      {!error && warning ? (
        <div className={styles.warningMessage}>
          <AlertTriangle size={12} />
          {warning}
        </div>
      ) : null}
      {expanded ? <FeatureParams feature={feature} state={state} /> : null}
    </div>
  );
}

function extrudeSides(feature: {
  symmetric: boolean;
  distance2?: number | undefined;
}): 'one' | 'symmetric' | 'two' {
  if (feature.symmetric) return 'symmetric';
  return feature.distance2 !== undefined && feature.distance2 > 0 ? 'two' : 'one';
}

function FeatureParams({
  feature,
  state,
}: {
  feature: Feature;
  state: AssemblerState;
}): JSX.Element {
  const edit = (patch: FeaturePatch) => state.editFeatureParams(feature.id, patch);
  const paramResolved = resolveParameterValues(state.parameters);
  const paramValues = paramResolved.ok ? paramResolved.values : new Map<string, number>();

  // Kinds whose module registered an editor (`defineModuleUi({ historyCards })`).
  const card = historyCardFor(feature.kind);
  if (card) {
    const Card = card.component;
    return (
      <Card
        feature={feature}
        state={state}
        className={styles.params}
        fullClassName={styles.paramsFull}
      />
    );
  }

  if (feature.kind === 'extrude') {
    return (
      <div className={styles.params}>
        <ParamExpressionField
          label="Distance"
          value={feature.distance}
          expression={feature.distanceExpression}
          unit="mm"
          parameters={state.parameters}
          paramValues={paramValues}
          onCommitValue={(v) => edit({ distance: v, distanceExpression: undefined })}
          onCommitExpression={(expr) => edit({ distanceExpression: expr })}
        />
        <div>
          <span className={styles.paramLabel}>Sides</span>
          <Select
            aria-label="Extrude sides"
            value={extrudeSides(feature)}
            options={[
              { value: 'one', label: 'One side' },
              { value: 'symmetric', label: 'Symmetric' },
              { value: 'two', label: 'Two sides' },
            ]}
            onChange={(event) => {
              const sides = event.currentTarget.value;
              edit({
                symmetric: sides === 'symmetric',
                distance2:
                  sides === 'two' ? (feature.distance2 ?? Math.abs(feature.distance)) : undefined,
              });
            }}
          />
        </div>
        {extrudeSides(feature) === 'two' ? (
          <ExpressionField
            label="Distance 2"
            value={feature.distance2 ?? 0}
            unit="mm"
            onCommit={(v) => edit({ distance2: Math.max(0, v) })}
          />
        ) : null}
        <div>
          <span className={styles.paramLabel}>Extent</span>
          <Select
            aria-label="Extrude extent"
            value={feature.extent?.kind ?? 'distance'}
            options={[
              { value: 'distance', label: 'Distance' },
              { value: 'throughAll', label: 'Through All' },
              ...(feature.extent?.kind === 'toObject'
                ? [{ value: 'toObject', label: 'To Object' }]
                : []),
            ]}
            onChange={(event) => {
              const kind = event.currentTarget.value;
              if (kind === 'toObject') return;
              edit({ extent: kind === 'distance' ? undefined : { kind: 'throughAll' } });
            }}
          />
        </div>
        <ExpressionField
          label="Start offset"
          value={feature.startOffset ?? 0}
          unit="mm"
          onCommit={(v) => edit({ startOffset: v === 0 ? undefined : v })}
        />
        {feature.extent?.kind === 'toObject' ? (
          <span className={styles.paramNote}>
            To{' '}
            {feature.extent.target.kind === 'body'
              ? 'a body'
              : feature.extent.target.face.signature.surface === 'plane'
                ? 'a planar face (its plane)'
                : 'a face'}
          </span>
        ) : null}
        <div className={styles.paramsFull}>
          <span className={styles.paramLabel}>Operation</span>
          <Select
            aria-label="Extrude operation"
            value={feature.operation}
            options={
              feature.profile.kind === 'sketch'
                ? [
                    { value: 'new', label: 'New body' },
                    { value: 'join', label: 'Join' },
                    { value: 'cut', label: 'Cut' },
                    { value: 'intersect', label: 'Intersect' },
                  ]
                : [
                    // Push/pull: joins outwards, cuts inwards; Intersect is the one explicit choice.
                    { value: feature.distance < 0 ? 'cut' : 'join', label: 'Automatic' },
                    { value: 'intersect', label: 'Intersect' },
                  ]
            }
            onChange={(event) => edit({ operation: event.currentTarget.value as ExtrudeOperation })}
          />
        </div>
      </div>
    );
  }

  if (feature.kind === 'move') {
    return (
      <div className={styles.params}>
        <ExpressionField
          label="dX"
          value={feature.dx}
          unit="mm"
          onCommit={(v) => edit({ dx: v })}
        />
        <ExpressionField
          label="dY"
          value={feature.dy}
          unit="mm"
          onCommit={(v) => edit({ dy: v })}
        />
        <ExpressionField
          label="dZ"
          value={feature.dz}
          unit="mm"
          onCommit={(v) => edit({ dz: v })}
        />
      </div>
    );
  }

  return <div className={styles.params}>No editable parameters.</div>;
}
