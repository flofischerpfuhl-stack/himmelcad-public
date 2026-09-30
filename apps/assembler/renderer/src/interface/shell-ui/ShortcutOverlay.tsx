/**
 * Keyboard cheat sheet (hold Ctrl, press `?`, or Help › Keyboard shortcuts):
 * generated from the command registry, so every shortcut shown is the one
 * that runs — plus the viewport gestures of the active navigation preset
 * and the box-selection keys.
 */
import { X } from 'lucide-react';
import { useEffect } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import { shortcutSections, type ShortcutRow } from '../../foundation/commands/shortcutSheet.js';
import { usePreferences } from '../../platform/input/preferences.js';
import { useWorkspaceStore } from './workspace.js';
import { describeBindings, navigationPreset } from '../../platform/input/navigation.js';
import styles from './ShortcutOverlay.module.css';

function close(): void {
  useWorkspaceStore.getState().setShortcutOverlay(false);
}

function Keys({ keys }: { keys: string }): JSX.Element {
  const parts = keys === '?' ? ['?'] : keys.split('+').map((part) => part.trim());
  return (
    <span className={styles.keys}>
      {parts.map((part, index) => (
        <kbd key={index} className={styles.kbd}>
          {part}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutOverlay(): JSX.Element | null {
  const open = useWorkspaceStore((s) => s.shortcutOverlay);
  const singleKeys = usePreferences((p) => p.singleKeyHotkeys);
  const presetId = usePreferences((p) => p.navigationPreset);

  useEffect(() => {
    if (!open) return;
    return registerEscapeRung('modal', () => (close(), true));
  }, [open]);

  if (!open) return null;
  const preset = navigationPreset(presetId);
  const sections = shortcutSections(singleKeys);
  const navigation: ShortcutRow[] = [
    ...describeBindings(preset).map((b) => ({ label: b.action, keys: b.gesture })),
    { label: 'Zoom', keys: 'Wheel' },
    { label: 'Box select (drag right: inside, left: touching)', keys: 'Left drag' },
    { label: 'Box filter while dragging', keys: 'Tab / A / B / F / E' },
    { label: 'Add to selection', keys: 'Shift+Click' },
    { label: 'Select whole body', keys: 'Double-click' },
    { label: 'Look at face under the pointer', keys: 'Space' },
    { label: 'Command search', keys: 'Ctrl+F' },
    ...(singleKeys ? [{ label: 'Command search', keys: 'X' }] : []),
    { label: 'Items panel', keys: 'Ctrl+Alt+S' },
    { label: 'History panel', keys: 'Ctrl+Alt+H' },
    { label: 'Parameters panel', keys: 'Ctrl+Alt+P' },
  ];

  return (
    <div className={styles.layer} onPointerDown={close}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-label="Keyboard shortcuts"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Keyboard shortcuts</h2>
          <span className={styles.subtitle}>
            {preset.label} navigation · single-key hotkeys {singleKeys ? 'on' : 'off'}
          </span>
          <button type="button" className={styles.close} aria-label="Close" onClick={close}>
            <X size={14} />
          </button>
        </header>
        <div className={styles.columns}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Navigation & selection</h3>
            {navigation.map((row) => (
              <div key={`${row.label}${row.keys}`} className={styles.row}>
                <span className={styles.label}>{row.label}</span>
                <Keys keys={row.keys} />
              </div>
            ))}
          </section>
          {sections.map((section) => (
            <section key={section.title} className={styles.section}>
              <h3 className={styles.sectionTitle}>{section.title}</h3>
              {section.rows.map((row) => (
                <div key={`${row.label}${row.keys}`} className={styles.row}>
                  <span className={styles.label}>{row.label}</span>
                  <Keys keys={row.keys} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
