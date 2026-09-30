/**
 * Display popover of the right dock (interaction research §5 "Display
 * modes"): Shaded with edges / Shaded / Wireframe / X-Ray / Visualized /
 * Zebra / Curvature (Alt+1…7), the Edges, Hidden edges, Grid and Axes
 * toggles and the render quality. Every entry runs the same registry command
 * as the View › Display menu, command search and the shortcuts. Native
 * radios and checkboxes (shared `Radio`/`Checkbox`) keep keyboard access:
 * arrows move within the modes, Tab reaches the toggles, Escape closes.
 */
import { Check, ChevronDown, SunMedium } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Checkbox,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  Radio,
  Tooltip,
  registerEscapeRung,
} from '@himmelcad/ui';

import { COMMANDS, findCommand } from '../model/commands/registry.js';
import { usePreferences } from '../model/preferences.js';
import type { AssemblerState } from '../model/store.js';
import {
  DISPLAY_MODE_ENTRIES,
  activeDisplayEntry,
  edgesToggleApplies,
} from '../viewport/displayModes.js';
import styles from './DisplayMenu.module.css';

function run(state: AssemblerState, id: string): void {
  const command = findCommand(id);
  if (!command || !command.availability(state).enabled) return;
  command.run(state);
  state.pushRecentCommand(id);
}

/** View menu › Display: the same commands as the popover, as menu rows with shortcuts. */
export function DisplayMenuItems({ state }: { state: AssemblerState }): JSX.Element {
  const commands = COMMANDS.filter((c) => c.group === 'display');
  const activeId = `display.${activeDisplayEntry(state.viewState.displayMode, state.viewState.edgesVisible)}`;
  return (
    <>
      <MenuSeparator />
      <MenuSubmenu label="Display" ariaLabel="Display">
        {commands.map((command) => {
          const availability = command.availability(state);
          const current = command.id === activeId;
          return (
            <MenuItem
              key={command.id}
              disabled={!availability.enabled}
              {...(availability.reason ? { title: availability.reason } : {})}
              onSelect={() => run(state, command.id)}
            >
              <span className={styles.menuRow}>
                <span className={styles.menuCheck} aria-hidden>
                  {current ? <Check size={12} /> : null}
                </span>
                <span className={styles.menuLabel}>{command.label}</span>
                {command.shortcut ? (
                  <kbd className={styles.shortcut}>{command.shortcut}</kbd>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
      </MenuSubmenu>
    </>
  );
}

export function DisplayMenu({ state }: { state: AssemblerState }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const quality = usePreferences((p) => p.renderQuality);
  const view = state.viewState;
  const active = activeDisplayEntry(view.displayMode, view.edgesVisible);
  const activeEntry = DISPLAY_MODE_ENTRIES.find((e) => e.id === active)!;

  useEffect(() => {
    if (!open) return;
    const unregister = registerEscapeRung('menu', () => {
      setOpen(false);
      triggerRef.current?.focus();
      return true;
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    queueMicrotask(() =>
      rootRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus(),
    );
    return () => {
      unregister();
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const toggle = (id: string, checked: boolean, label: string, disabledReason?: string) => {
    const command = findCommand(id);
    const availability = command?.availability(state);
    const disabled = !availability?.enabled;
    return (
      <Checkbox
        label={label}
        checked={checked}
        disabled={disabled}
        title={disabled ? (availability?.reason ?? disabledReason) : undefined}
        onChange={() => run(state, id)}
      />
    );
  };

  return (
    <div className={styles.host} ref={rootRef}>
      <Tooltip content="Display mode and overlays">
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Display: ${activeEntry.label}`}
          onClick={() => setOpen((v) => !v)}
        >
          <SunMedium size={14} aria-hidden />
          <span className={styles.triggerLabel}>{activeEntry.label}</span>
          <ChevronDown size={12} aria-hidden />
        </button>
      </Tooltip>
      {open ? (
        <div className={styles.popover} role="dialog" aria-label="Display">
          <div className={styles.sectionTitle} id="hc-display-modes">
            Display mode
          </div>
          <div role="radiogroup" aria-labelledby="hc-display-modes" className={styles.modes}>
            {DISPLAY_MODE_ENTRIES.map((entry) => (
              <div key={entry.id} className={styles.modeRow}>
                <Radio
                  name="hc-display-mode"
                  label={
                    <span className={styles.modeLabel}>
                      <span>{entry.label}</span>
                      {entry.hint ? <span className={styles.hint}>{entry.hint}</span> : null}
                    </span>
                  }
                  checked={entry.id === active}
                  onChange={() => run(state, `display.${entry.id}`)}
                />
                <kbd className={styles.shortcut}>{entry.shortcut}</kbd>
              </div>
            ))}
          </div>
          <div className={styles.separator} role="separator" />
          <div className={styles.sectionTitle}>Show</div>
          <div className={styles.toggles}>
            {toggle(
              'display.edges',
              view.displayMode === 'wireframe' || view.edgesVisible,
              'Edges',
              edgesToggleApplies(view.displayMode) ? undefined : 'Wireframe always shows edges.',
            )}
            {toggle('display.hiddenEdges', view.hiddenEdgesVisible, 'Hidden edges (dashed)')}
            {toggle('display.grid', view.gridVisible, 'Grid')}
            {toggle('display.axes', view.axesVisible, 'Axes')}
          </div>
          <div className={styles.separator} role="separator" />
          <div className={styles.toggles}>
            <Checkbox
              label={
                <span className={styles.modeLabel}>
                  <span>High quality</span>
                  <span className={styles.hint}>Ambient occlusion, contact shadow</span>
                </span>
              }
              checked={quality === 'high'}
              onChange={() => run(state, 'display.quality')}
            />
          </div>
          {view.displayMode === 'visualized' ? (
            <p className={styles.note}>
              Materials are set per body with Appearance (colour and material).
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
