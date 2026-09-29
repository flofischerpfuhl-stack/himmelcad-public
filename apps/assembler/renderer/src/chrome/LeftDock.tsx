/**
 * Left column: Items toggle + Search on top, the main menu (Sketch / Add /
 * Transform / Tools flyouts) — swapped for the adaptive toolbar whenever
 * the selection is non-empty and no tool is active — and, at the bottom,
 * the Section View / Isolate / Measure mode toggles.
 */
import { Boxes, Crosshair, Layers, Scan, Search } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import { findCommand } from '../model/commands/registry.js';
import { AdaptiveToolbar } from './AdaptiveToolbar.js';
import { CommandGroupMenu } from './CommandGroupMenu.js';
import { GROUP_ICON } from './icons.js';
import type { AssemblerState } from '../model/store.js';
import styles from './LeftDock.module.css';

export interface LeftDockProps {
  state: AssemblerState;
  onOpenSearch: () => void;
}

export function LeftDock({ state, onOpenSearch }: LeftDockProps): JSX.Element {
  const showAdaptive = state.selection.length > 0 && !state.activeTool;
  const SketchIcon = GROUP_ICON.sketch;
  const AddIcon = GROUP_ICON.add;
  const TransformIcon = GROUP_ICON.transform;
  const ToolsIcon = GROUP_ICON.tools;

  const sectionCommand = findCommand('modes.section')!;
  const isolateCommand = findCommand('modes.isolate')!;
  const measureCommand = findCommand('modes.measure')!;
  const sectionAvailability = sectionCommand.availability(state);
  const isolateAvailability = isolateCommand.availability(state);
  const measureAvailability = measureCommand.availability(state);

  return (
    <div className={styles.root}>
      <div className={styles.group}>
        <Tooltip content="Items (Ctrl+Alt+S)">
          <button
            type="button"
            className={`${styles.iconButton} ${state.panels.items ? styles.iconButtonActive : ''}`}
            aria-label="Toggle items panel"
            aria-pressed={state.panels.items}
            onClick={() => state.togglePanel('items')}
          >
            <Layers size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Search (X, Ctrl+F)">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Open command search"
            onClick={onOpenSearch}
          >
            <Search size={16} />
          </button>
        </Tooltip>
      </div>

      {showAdaptive ? (
        <AdaptiveToolbar state={state} />
      ) : (
        <div className={styles.group}>
          <CommandGroupMenu
            label="Sketch"
            group="sketch"
            getState={() => state}
            tooltip="Sketch"
            triggerClassName={styles.iconButton}
            trigger={<SketchIcon size={16} />}
          />
          <CommandGroupMenu
            label="Add"
            group="add"
            getState={() => state}
            tooltip="Add"
            triggerClassName={styles.iconButton}
            trigger={<AddIcon size={16} />}
            emptyHint="No Add commands in Phase 0"
          />
          <CommandGroupMenu
            label="Transform"
            group="transform"
            getState={() => state}
            tooltip="Transform"
            triggerClassName={styles.iconButton}
            trigger={<TransformIcon size={16} />}
          />
          <CommandGroupMenu
            label="Tools"
            group="tools"
            getState={() => state}
            tooltip="Tools"
            triggerClassName={styles.iconButton}
            trigger={<ToolsIcon size={16} />}
          />
        </div>
      )}

      <div className={styles.spacer} />

      <div className={styles.group}>
        <Tooltip content={sectionAvailability.reason ?? 'Section View'}>
          <button
            type="button"
            className={`${styles.modeButton} ${state.viewState.sectionEnabled ? styles.modeButtonActive : ''}`}
            aria-pressed={state.viewState.sectionEnabled}
            disabled={!sectionAvailability.enabled}
            title={sectionAvailability.reason}
            onClick={() => sectionCommand.run(state)}
          >
            <Scan size={14} />
            Section
            <span className={styles.modeState}>
              {state.viewState.sectionEnabled ? 'On' : 'Off'}
            </span>
          </button>
        </Tooltip>
        <Tooltip content={isolateAvailability.reason ?? 'Isolate'}>
          <button
            type="button"
            className={`${styles.modeButton} ${state.isolatedBodyIds !== null ? styles.modeButtonActive : ''}`}
            aria-pressed={state.isolatedBodyIds !== null}
            disabled={!isolateAvailability.enabled}
            title={isolateAvailability.reason}
            onClick={() => isolateCommand.run(state)}
          >
            <Boxes size={14} />
            Isolate
            <span className={styles.modeState}>
              {state.isolatedBodyIds !== null ? 'On' : 'Off'}
            </span>
          </button>
        </Tooltip>
        <Tooltip content={measureAvailability.reason ?? 'Measure'}>
          <button
            type="button"
            className={`${styles.modeButton} ${state.viewState.measureEnabled ? styles.modeButtonActive : ''}`}
            aria-pressed={state.viewState.measureEnabled}
            disabled={!measureAvailability.enabled}
            title={measureAvailability.reason}
            onClick={() => measureCommand.run(state)}
          >
            <Crosshair size={14} />
            Measure
            <span className={styles.modeState}>
              {state.viewState.measureEnabled ? 'On' : 'Off'}
            </span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
