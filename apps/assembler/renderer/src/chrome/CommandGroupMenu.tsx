/**
 * A trigger button that opens a dropdown/flyout listing one
 * {@link CommandGroup}'s commands from the shared registry — used for the
 * top-bar File/Edit/View/Help menus and the left-column Sketch/Add/
 * Transform/Tools flyouts. One source of truth (`COMMANDS`) so the menu,
 * search, shortcuts and context menu never drift apart (interaction
 * research §1/§7).
 */
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Menu, MenuItem, Tooltip } from '@himmelcad/ui';

import { COMMANDS, type CommandGroup } from '../foundation/commands/registry.js';
import type { AssemblerState } from '../foundation/commands/store.js';
import styles from './CommandGroupMenu.module.css';

export interface CommandGroupMenuProps {
  label: string;
  group: CommandGroup;
  getState: () => AssemblerState;
  trigger: ReactNode;
  triggerClassName?: string | undefined;
  tooltip?: string | undefined;
  extraItems?: ReactNode;
  emptyHint?: string | undefined;
  align?: 'left' | 'right';
}

export function CommandGroupMenu({
  label,
  group,
  getState,
  trigger,
  triggerClassName,
  tooltip,
  extraItems,
  emptyHint,
  align = 'left',
}: CommandGroupMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();

  // Measured when opening, before the menu is rendered: an unpositioned menu in the
  // trigger's flex host would shift the trigger and skew the measurement.
  const placeMenu = (): void => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 6,
      [align === 'left' ? 'left' : 'right']:
        align === 'left' ? rect.left : window.innerWidth - rect.right,
    });
  };

  const state = open ? getState() : null;
  const commands = COMMANDS.filter((c) => c.group === group);

  const button = (
    <button
      ref={buttonRef}
      type="button"
      className={triggerClassName ? `${styles.trigger} ${triggerClassName}` : styles.trigger}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => {
        if (!open) placeMenu();
        setOpen((v) => !v);
      }}
    >
      {trigger}
    </button>
  );

  return (
    <div className={styles.host}>
      {tooltip && !open ? <Tooltip content={tooltip}>{button}</Tooltip> : button}
      {open && state ? (
        <Menu
          ariaLabel={label}
          onClose={() => setOpen(false)}
          className={styles.menu ?? ''}
          {...(menuStyle ? { style: menuStyle } : {})}
        >
          {commands.length === 0 && !extraItems ? (
            <div className={styles.empty}>{emptyHint ?? 'No commands yet'}</div>
          ) : null}
          {commands.map((command) => {
            const availability = command.availability(state);
            return (
              <MenuItem
                key={command.id}
                disabled={!availability.enabled}
                {...(availability.reason ? { title: availability.reason } : {})}
                onSelect={() => {
                  command.run(state);
                  state.pushRecentCommand(command.id);
                }}
              >
                <span className={styles.row}>
                  <span className={styles.label}>{command.label}</span>
                  {command.shortcut ? (
                    <span className={styles.shortcut}>{command.shortcut}</span>
                  ) : null}
                </span>
              </MenuItem>
            );
          })}
          {extraItems}
        </Menu>
      ) : null}
    </div>
  );
}
