/**
 * History panel (right): feature cards in document order. Expanding a
 * card shows its editable parameters (`ExpressionField`s, committing via
 * `editFeatureParams` — one undo step per edit, the signature parametric
 * demo). Card menu: Rename, Suppress/Unsuppress, Roll back to here, Move
 * up/down, Delete. Suppressed cards are dimmed; cards with an
 * `evaluation.errors` entry show a warning style and the message.
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

import { anchoredMenuStyle } from './anchoredMenu.js';
import { featureKindIcon } from './icons.js';
import { ExpressionField } from './ExpressionField.js';
import { ModelingFeatureParams } from './FeatureParams.js';
import { isModelingFeature } from '../model/features.js';
import { checkMove, moveFeature, relevantFeatureIds } from '../model/historyTools.js';
import { useWorkspaceStore } from '../model/workspace.js';
import type { AssemblerState, FeaturePatch } from '../model/store.js';
import type { ExtrudeOperation, Feature } from '../model/document.js';
import { useSketchStore } from '../sketch/session.js';
import { SketchParams } from '../sketch/ui/SketchParams.js';
import panelStyles from './Panel.module.css';
import styles from './HistoryPanel.module.css';

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
  const relevant = useMemo(
    () =>
      filterToSelection && state.selection.length > 0
        ? relevantFeatureIds(features, state.evaluation, state.selection)
        : null,
    [filterToSelection, features, state.evaluation, state.selection],
  );
  const shown = features.filter((f) => !relevant || relevant.has(f.id));

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
        <Tooltip
          content={
            state.selection.length === 0
              ? 'Show only steps of the selection (select something first)'
              : filterToSelection
                ? 'Show all steps'
                : 'Show only steps of the selection'
          }
        >
          <button
            type="button"
            className={`${panelStyles.headerButton} ${filterToSelection ? styles.headerButtonActive : ''}`}
            aria-label="Filter to selection"
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
          <div className={panelStyles.empty}>No steps for the selection</div>
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
                {feature.suppressed ? 'Unsuppress' : 'Suppress'}
              </MenuItem>
              <MenuItem
                disabled={state.activeTool !== null}
                onSelect={() => state.setRollback(state.features[index + 1]?.id ?? null)}
              >
                {rolledBack ? 'Roll forward to here' : 'Roll back to here'}
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
              <MenuItem onSelect={() => state.deleteFeature(feature.id)}>Delete</MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className={styles.errorMessage}>
          <AlertTriangle size={12} />
          {error}
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

function FeatureParams({
  feature,
  state,
}: {
  feature: Feature;
  state: AssemblerState;
}): JSX.Element {
  const edit = (patch: FeaturePatch) => state.editFeatureParams(feature.id, patch);

  if (feature.kind === 'sketch') {
    return (
      <SketchParams
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
        <ExpressionField
          label="Distance"
          value={feature.distance}
          unit="mm"
          onCommit={(v) => edit({ distance: v })}
        />
        <div>
          <span className={styles.paramLabel}>Direction</span>
          <Select
            aria-label="Extrude direction"
            value={feature.symmetric ? 'both' : 'one'}
            options={[
              { value: 'one', label: 'One side' },
              { value: 'both', label: 'Both sides' },
            ]}
            onChange={(event) => edit({ symmetric: event.currentTarget.value === 'both' })}
          />
        </div>
        {feature.profile.kind === 'sketch' ? (
          <div className={styles.paramsFull}>
            <span className={styles.paramLabel}>Operation</span>
            <Select
              aria-label="Extrude operation"
              value={feature.operation}
              options={[
                { value: 'new', label: 'New body' },
                { value: 'join', label: 'Join' },
                { value: 'cut', label: 'Cut' },
              ]}
              onChange={(event) =>
                edit({ operation: event.currentTarget.value as ExtrudeOperation })
              }
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (feature.kind === 'fillet' || feature.kind === 'chamfer') {
    return (
      <div className={styles.params}>
        <ExpressionField
          label={feature.kind === 'fillet' ? 'Radius' : 'Distance'}
          value={feature.kind === 'fillet' ? feature.radius : feature.distance}
          unit="mm"
          onCommit={(v) => edit(feature.kind === 'fillet' ? { radius: v } : { distance: v })}
        />
        <span className={styles.paramNote}>
          {feature.edges.length} {feature.edges.length === 1 ? 'edge' : 'edges'}
        </span>
      </div>
    );
  }

  if (feature.kind === 'shell') {
    return (
      <div className={styles.params}>
        <ExpressionField
          label="Thickness"
          value={feature.thickness}
          unit="mm"
          onCommit={(v) => edit({ thickness: v })}
        />
        <span className={styles.paramNote}>
          {feature.faces.length} open {feature.faces.length === 1 ? 'face' : 'faces'}
        </span>
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

  if (isModelingFeature(feature)) return <ModelingFeatureParams feature={feature} state={state} />;

  return <div className={styles.params}>No editable parameters.</div>;
}
