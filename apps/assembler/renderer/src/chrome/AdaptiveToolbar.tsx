/**
 * Adaptive toolbar (interaction research §2): when the selection is
 * non-empty and no tool is active, replaces the main menu icons in the
 * left column with `resolveAdaptive(ctx)` — recommended command first and
 * visually emphasised — a "More" button for the rest, and a clear-selection
 * (x) button. Availability only ever reads `ctx.selection`, never
 * `ctx.hover`, so this never reflows on mouse-over, only on a committed
 * selection change.
 */
import { MoreHorizontal, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { Menu, MenuItem, Tooltip } from '@himmelcad/ui';

import { resolveAdaptive, type Command } from '../model/commands/registry.js';
import { usePreferences } from '../model/preferences.js';
import { commandIcon } from './icons.js';
import type { AssemblerState } from '../model/store.js';
import styles from './AdaptiveToolbar.module.css';

const MAX_VISIBLE = 4;

export function AdaptiveToolbar({ state }: { state: AssemblerState }): JSX.Element {
  const labels = usePreferences((p) => p.labels);
  const commands = resolveAdaptive(state);
  const visible = commands.slice(0, MAX_VISIBLE);
  const overflow = commands.slice(MAX_VISIBLE);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();

  useLayoutEffect(() => {
    if (!moreOpen || !moreRef.current) return;
    const rect = moreRef.current.getBoundingClientRect();
    setMenuStyle({ position: 'fixed', top: rect.top, left: rect.right + 6 });
  }, [moreOpen]);

  const run = (command: Command): void => {
    command.run(state);
    state.pushRecentCommand(command.id);
  };

  return (
    <div className={styles.root} role="toolbar" aria-label="Adaptive commands for selection">
      {visible.map((command, index) => {
        const Icon = commandIcon(command);
        const recommended = index === 0;
        const button = (
          <button
            key={command.id}
            type="button"
            className={`${styles.button} ${recommended ? styles.recommended : ''} ${labels === 'always' ? styles.labelled : ''}`}
            aria-label={command.label}
            onClick={() => run(command)}
          >
            <Icon size={16} />
            {labels === 'always' ? (
              // A break opportunity after "/" ("Move/Rotate" wraps as "Move/ Rotate").
              <span className={styles.caption}>{command.label.replace('/', '/​')}</span>
            ) : null}
          </button>
        );
        // Settings › Toolbar labels: icons only, tooltip on hover, or always captioned.
        if (labels !== 'hover') return button;
        return (
          <Tooltip
            key={command.id}
            content={`${command.label}${command.shortcut ? ` (${command.shortcut})` : ''}`}
            // The recommended command's tooltip shows immediately (no
            // hover delay) since it's the emphasised, most-likely-next
            // action for the current selection.
            {...(recommended ? { delay: 0 } : {})}
          >
            {button}
          </Tooltip>
        );
      })}
      {overflow.length > 0 ? (
        <div style={{ position: 'relative' }}>
          <Tooltip content="More commands">
            <button
              ref={moreRef}
              type="button"
              className={styles.button}
              aria-label="More commands"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreHorizontal size={16} />
            </button>
          </Tooltip>
          {moreOpen ? (
            <Menu
              ariaLabel="More commands"
              onClose={() => setMoreOpen(false)}
              {...(menuStyle ? { style: menuStyle } : {})}
            >
              {overflow.map((command) => (
                <MenuItem
                  key={command.id}
                  onSelect={() => {
                    run(command);
                    setMoreOpen(false);
                  }}
                >
                  {command.label}
                  {command.shortcut ? ` (${command.shortcut})` : ''}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
        </div>
      ) : null}
      <div className={styles.divider} />
      <Tooltip content="Clear selection (Esc)">
        <button
          type="button"
          className={`${styles.button} ${styles.clear}`}
          aria-label="Clear selection"
          onClick={() => state.clearSelection()}
        >
          <X size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
