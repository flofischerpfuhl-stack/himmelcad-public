/**
 * Left column: Items toggle + Search on top, the main menu (Sketch / Add /
 * Transform / Tools flyouts) — swapped for the adaptive toolbar whenever
 * the selection is non-empty and no tool is active — and, at the bottom,
 * the Section View / Isolate / Measure mode toggles.
 */
import { Boxes, Crosshair, Layers, Redo2, Scan, Search, Undo2 } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import { findCommand } from '../../foundation/commands/registry.js';
import { registeredModeButtons } from '../../platform/widgets/moduleUi.js';
import { usePreferences } from '../../platform/input/preferences.js';
import { effectiveToolbarLabels, useTabletLayout } from '../../platform/input/tabletLayout.js';

type SketchIconType = (typeof GROUP_ICON)['sketch'];
import { AdaptiveToolbar } from './AdaptiveToolbar.js';
import { CommandGroupMenu } from './CommandGroupMenu.js';
import { GROUP_ICON } from './icons.js';
import type { AssemblerState } from '../../foundation/commands/store.js';
import styles from './LeftDock.module.css';

export interface LeftDockProps {
  state: AssemblerState;
  onOpenSearch: () => void;
}

export function LeftDock({ state, onOpenSearch }: LeftDockProps): JSX.Element {
  // Tablet layout: no hover, so the captions show instead of hover tips.
  const tablet = useTabletLayout((s) => s.tablet);
  const labels = effectiveToolbarLabels(
    usePreferences((p) => p.labels),
    tablet,
  );
  // Left-handed: the column is on the right edge, its menus open towards the canvas.
  const menuAlign = usePreferences((p) => (p.handedness === 'left' ? 'right' : 'left'));
  const tip = (text: string) => (labels === 'hover' ? text : undefined);
  const trigger = (Icon: SketchIconType, text: string) =>
    labels === 'always' ? (
      <span className={styles.labelled}>
        <Icon size={16} />
        <span className={styles.caption}>{text}</span>
      </span>
    ) : (
      <Icon size={16} />
    );
  const showAdaptive = state.selection.length > 0 && !state.activeTool;
  const SketchIcon = GROUP_ICON.sketch;
  const AddIcon = GROUP_ICON.add;
  const TransformIcon = GROUP_ICON.transform;
  const ToolsIcon = GROUP_ICON.tools;
  const ConstructIcon = GROUP_ICON.construct;

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
            tooltip={tip('Sketch')}
            triggerClassName={styles.iconButton}
            align={menuAlign}
            trigger={trigger(SketchIcon, 'Sketch')}
          />
          <CommandGroupMenu
            label="Add"
            group="add"
            getState={() => state}
            tooltip={tip('Add')}
            triggerClassName={styles.iconButton}
            align={menuAlign}
            trigger={trigger(AddIcon, 'Add')}
            emptyHint="No Add commands in Phase 0"
          />
          <CommandGroupMenu
            label="Construct"
            group="construct"
            getState={() => state}
            tooltip={tip('Construct')}
            triggerClassName={styles.iconButton}
            align={menuAlign}
            trigger={trigger(ConstructIcon, 'Construct')}
          />
          <CommandGroupMenu
            label="Transform"
            group="transform"
            getState={() => state}
            tooltip={tip('Transform')}
            triggerClassName={styles.iconButton}
            align={menuAlign}
            trigger={trigger(TransformIcon, 'Transform')}
          />
          <CommandGroupMenu
            label="Tools"
            group="tools"
            getState={() => state}
            tooltip={tip('Tools')}
            triggerClassName={styles.iconButton}
            align={menuAlign}
            trigger={trigger(ToolsIcon, 'Tools')}
          />
        </div>
      )}

      <div className={styles.spacer} />

      {tablet ? (
        // Undo/Redo within reach of the tool hand (the gestures do the same: two-finger tap,
        // three-finger tap; assembler/TOUCH.md).
        <div className={`${styles.group} ${styles.historyGroup}`}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Undo"
            title={state.history.canUndo ? 'Undo (two-finger tap)' : 'Nothing to undo'}
            disabled={!state.history.canUndo}
            onClick={() => state.undo()}
          >
            <Undo2 size={18} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Redo"
            title={state.history.canRedo ? 'Redo (three-finger tap)' : 'Nothing to redo'}
            disabled={!state.history.canRedo}
            onClick={() => state.redo()}
          >
            <Redo2 size={18} />
          </button>
        </div>
      ) : null}

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
        {registeredModeButtons().map(({ id, component: ModeButton }) => (
          // The modules' mode toggles (Print), registered with defineModuleUi.
          <ModeButton
            key={id}
            className={styles.modeButton}
            activeClassName={styles.modeButtonActive}
            stateClassName={styles.modeState}
          />
        ))}
      </div>
    </div>
  );
}
