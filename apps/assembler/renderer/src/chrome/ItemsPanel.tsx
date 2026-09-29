/**
 * Items panel (left): bodies with type icon, visibility eye and isolate,
 * plus sketches with a visibility eye (sketches consumed by an extrude are
 * hidden in the viewport by default, like Shapr3D; selecting one here shows
 * it while selected). Click selects (Ctrl/Cmd adds, Shift range), hover sets
 * the store hover so the viewport highlights it, right-click opens the
 * shared context menu for that item.
 */
import { Box, Eye, EyeOff, MoreHorizontal, PenSquare, Target } from 'lucide-react';
import { useState } from 'react';

import { Menu, MenuItem } from '@himmelcad/ui';

import { findCommand } from '../model/commands/registry.js';
import { consumedSketchIds, isSketchVisible } from '../model/modeling.js';
import type { AssemblerState, SelectionItem } from '../model/store.js';
import panelStyles from './Panel.module.css';
import styles from './ItemsPanel.module.css';

interface FlatRow {
  item: SelectionItem;
  key: string;
  name: string;
  kind: 'body' | 'sketch';
}

export interface ItemsPanelProps {
  state: AssemblerState;
  onContextMenu: (x: number, y: number) => void;
}

export function ItemsPanel({ state, onContextMenu }: ItemsPanelProps): JSX.Element {
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const bodyRows: FlatRow[] = state.evaluation.bodies.map((body) => ({
    item: { kind: 'body', bodyId: body.id },
    key: `body:${body.id}`,
    name: body.name,
    kind: 'body',
  }));
  const sketchRows: FlatRow[] = state.evaluation.sketches.map((sketch) => {
    const feature = state.features.find((f) => f.id === sketch.featureId);
    return {
      item: { kind: 'sketchProfile', featureId: sketch.featureId },
      key: `sketch:${sketch.featureId}`,
      name: feature?.name ?? sketch.featureId,
      kind: 'sketch',
    };
  });
  const rows = [...bodyRows, ...sketchRows];

  const isSelected = (item: SelectionItem): boolean =>
    state.selection.some((existing) => selectionEquals(existing, item));

  const selectRow = (
    index: number,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ): void => {
    const row = rows[index];
    if (!row) return;
    if (event.shiftKey && anchorIndex !== null) {
      const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
      const range = rows.slice(start, end + 1);
      range.forEach((r, i) => state.select(r.item, { additive: i > 0 }));
      return;
    }
    setAnchorIndex(index);
    if (event.ctrlKey || event.metaKey) {
      state.toggle(row.item);
    } else {
      state.select(row.item);
    }
  };

  const showAll = findCommand('edit.showAll')!;

  return (
    <div className={`${panelStyles.root} ${panelStyles.itemsPlacement}`} aria-label="Items panel">
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>Items</span>
        <span className={panelStyles.count}>
          {bodyRows.length} {bodyRows.length === 1 ? 'body' : 'bodies'} · {sketchRows.length}{' '}
          {sketchRows.length === 1 ? 'sketch' : 'sketches'}
        </span>
        <span className={panelStyles.headerSpacer} />
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="Items panel options"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
          >
            <MoreHorizontal size={14} />
          </button>
          {overflowOpen ? (
            <Menu
              ariaLabel="Items panel options"
              onClose={() => setOverflowOpen(false)}
              style={{ position: 'absolute', top: '100%', right: 0 }}
            >
              <MenuItem
                disabled={!showAll.availability(state).enabled}
                onSelect={() => showAll.run(state)}
              >
                Show all
              </MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
      <div className={panelStyles.body}>
        {rows.length === 0 ? <div className={panelStyles.empty}>No items yet</div> : null}
        {bodyRows.length > 0 ? <div className={styles.sectionLabel}>Bodies</div> : null}
        {bodyRows.map((row) => (
          <BodyRow
            key={row.key}
            row={row}
            state={state}
            selected={isSelected(row.item)}
            onSelect={(event) => selectRow(rows.indexOf(row), event)}
            onContextMenu={(x, y) => {
              if (!isSelected(row.item)) state.select(row.item);
              onContextMenu(x, y);
            }}
          />
        ))}
        {sketchRows.length > 0 ? <div className={styles.sectionLabel}>Sketches</div> : null}
        {sketchRows.map((row) => (
          <SketchRow
            key={row.key}
            row={row}
            state={state}
            selected={isSelected(row.item)}
            onSelect={(event) => selectRow(rows.indexOf(row), event)}
            onContextMenu={(x, y) => {
              if (!isSelected(row.item)) state.select(row.item);
              onContextMenu(x, y);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function selectionEquals(a: SelectionItem, b: SelectionItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'body' && b.kind === 'body') return a.bodyId === b.bodyId;
  if (a.kind === 'sketchProfile' && b.kind === 'sketchProfile') return a.featureId === b.featureId;
  return false;
}

interface RowProps {
  row: FlatRow;
  state: AssemblerState;
  selected: boolean;
  onSelect: (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  onContextMenu: (x: number, y: number) => void;
}

function BodyRow({ row, state, selected, onSelect, onContextMenu }: RowProps): JSX.Element {
  const bodyId = row.item.kind === 'body' ? row.item.bodyId : '';
  const hidden = state.hiddenBodyIds.includes(bodyId);
  const isolated = state.isolatedBodyIds?.length === 1 && state.isolatedBodyIds[0] === bodyId;
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${hidden ? styles.rowHidden : ''}`}
      onClick={(event) => onSelect(event)}
      onMouseEnter={() => state.setHover(row.item)}
      onMouseLeave={() => state.setHover(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <span className={styles.icon}>
        <Box size={13} />
      </span>
      <span className={styles.name}>{row.name}</span>
      <button
        type="button"
        className={`${styles.rowButton} ${isolated ? styles.rowButtonActive : ''}`}
        aria-label={isolated ? 'Stop isolating' : 'Isolate'}
        title={isolated ? 'Stop isolating' : 'Isolate'}
        onClick={(event) => {
          event.stopPropagation();
          state.setIsolatedBodyIds(isolated ? null : [bodyId]);
        }}
      >
        <Target size={12} />
      </button>
      <button
        type="button"
        className={styles.rowButton}
        aria-label={hidden ? 'Show' : 'Hide'}
        title={hidden ? 'Show' : 'Hide'}
        onClick={(event) => {
          event.stopPropagation();
          if (hidden) state.showBodies([bodyId]);
          else state.hideBodies([bodyId]);
        }}
      >
        {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

function SketchRow({ row, state, selected, onSelect, onContextMenu }: RowProps): JSX.Element {
  const featureId = row.item.kind === 'sketchProfile' ? row.item.featureId : '';
  const consumed = consumedSketchIds(state.features);
  const visible = isSketchVisible(featureId, consumed, state.sketchVisibility);
  const hint = consumed.has(featureId) ? ' (used by an extrude)' : '';
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${visible ? '' : styles.rowHidden}`}
      onClick={(event) => onSelect(event)}
      onMouseEnter={() => state.setHover(row.item)}
      onMouseLeave={() => state.setHover(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <span className={styles.icon}>
        <PenSquare size={13} />
      </span>
      <span className={styles.name}>{row.name}</span>
      <button
        type="button"
        className={styles.rowButton}
        aria-label={visible ? 'Hide sketch' : 'Show sketch'}
        title={visible ? `Hide sketch${hint}` : `Show sketch${hint}`}
        onClick={(event) => {
          event.stopPropagation();
          state.setSketchVisible(featureId, !visible);
        }}
      >
        {visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </div>
  );
}
