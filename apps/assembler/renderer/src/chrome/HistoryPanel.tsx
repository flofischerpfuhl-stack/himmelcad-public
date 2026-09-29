/**
 * History panel (right): feature cards in document order. Expanding a
 * card shows its editable parameters (`ExpressionField`s, committing via
 * `editFeatureParams` — one undo step per edit, the signature parametric
 * demo). Card menu: Rename, Suppress/Unsuppress, Delete. Suppressed cards
 * are dimmed; cards with an `evaluation.errors` entry show a warning
 * style and the message.
 */
import { AlertTriangle, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Menu,
  MenuItem,
  Select,
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { featureKindIcon } from './icons.js';
import { ExpressionField } from './ExpressionField.js';
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

export function HistoryPanel({ state, onContextMenu }: HistoryPanelProps): JSX.Element {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className={`${panelStyles.root} ${panelStyles.historyPlacement}`}
      aria-label="History panel"
    >
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>History</span>
        <span className={panelStyles.count}>
          {state.features.length} {state.features.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
      <div className={panelStyles.body}>
        {state.features.length === 0 ? (
          <div className={panelStyles.empty}>No history yet</div>
        ) : null}
        {state.features.map((feature) => (
          <HistoryCard
            key={feature.id}
            feature={feature}
            state={state}
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
        ))}
      </div>
    </div>
  );
}

interface HistoryCardProps {
  feature: Feature;
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
      } ${error ? styles.cardError : ''}`}
    >
      <div
        className={styles.cardHeader}
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
              onMenuOpenChange(!menuOpen);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen ? (
            <Menu
              ariaLabel={`${feature.name} options`}
              onClose={() => onMenuOpenChange(false)}
              style={{ position: 'absolute', top: '100%', right: 0 }}
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

  return <div className={styles.params}>No editable parameters.</div>;
}
