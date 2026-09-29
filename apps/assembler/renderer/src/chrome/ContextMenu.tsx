/**
 * Shared right-click command menu — viewport (via `Viewport`'s
 * `onContextMenu`), Items rows and History rows all funnel through this so
 * the same selection produces the same menu everywhere (interaction
 * research §7). Content: `resolveAdaptive(ctx)` for the (now-selected)
 * target, then a fixed Hide / Isolate / Zoom to fit / Delete tail, each
 * shown even when disabled (title = reason), skipping ids already listed
 * above.
 */
import {
  ContextMenu as UiContextMenu,
  MenuItem,
  MenuSeparator,
  clampMenuPosition,
} from '@himmelcad/ui';

import { findCommand, resolveAdaptive, type Command } from '../model/commands/registry.js';
import type { AssemblerState } from '../model/store.js';
import styles from './ContextMenu.module.css';

const TAIL_COMMAND_IDS = ['edit.hide', 'modes.isolate', 'view.zoomToFit', 'transform.delete'];

export interface CommandContextMenuProps {
  x: number;
  y: number;
  state: AssemblerState;
  onClose: () => void;
}

export function CommandContextMenu({ x, y, state, onClose }: CommandContextMenuProps): JSX.Element {
  const position = clampMenuPosition(x, y, 220, 260);
  const primary = resolveAdaptive(state);
  const primaryIds = new Set(primary.map((c) => c.id));
  const tail = TAIL_COMMAND_IDS.map((id) => findCommand(id)).filter(
    (c): c is Command => c !== undefined && !primaryIds.has(c.id),
  );

  const run = (command: Command): void => {
    command.run(state);
    state.pushRecentCommand(command.id);
    onClose();
  };

  return (
    <UiContextMenu
      {...position}
      onClose={onClose}
      ariaLabel="Selection commands"
      className={styles.menu ?? ''}
    >
      {primary.length === 0 && tail.length === 0 ? (
        <MenuItem disabled>No commands for this selection</MenuItem>
      ) : null}
      {primary.map((command) => (
        <MenuItem key={command.id} onSelect={() => run(command)}>
          <Row command={command} />
        </MenuItem>
      ))}
      {primary.length > 0 && tail.length > 0 ? <MenuSeparator /> : null}
      {tail.map((command) => {
        const availability = command.availability(state);
        return (
          <MenuItem
            key={command.id}
            disabled={!availability.enabled}
            {...(availability.reason ? { title: availability.reason } : {})}
            onSelect={() => run(command)}
          >
            <Row command={command} />
          </MenuItem>
        );
      })}
    </UiContextMenu>
  );
}

function Row({ command }: { command: Command }): JSX.Element {
  return (
    <span className={styles.row}>
      <span className={styles.label}>{command.label}</span>
      {command.shortcut ? <span className={styles.shortcut}>{command.shortcut}</span> : null}
    </span>
  );
}
