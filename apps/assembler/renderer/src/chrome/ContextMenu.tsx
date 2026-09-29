/**
 * Shared right-click command menu — viewport (via `Viewport`'s
 * `onContextMenu`), Items rows and History rows all funnel through this so
 * the same selection produces the same menu everywhere (interaction
 * research §7). Content: the entity commands of `resolveAdaptive(ctx)`
 * for the (now-selected) target (tools, transforms, sketch editing; at
 * most eight), then a fixed tail — Look at face, Rename, Colour, Reveal in
 * Items, Hide, Isolate, Zoom to selection/fit, Select Through, Delete —
 * each shown even when disabled (title = reason). On empty space: view
 * commands (Zoom to fit, Home, Select Through, visibility, Save view).
 * Active toggles (Select Through) carry a check mark.
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

const CONTEXT_GROUPS = new Set<string>(['tools', 'transform', 'sketch']);
/** Sketch drawing tools and plane-sketch starters stay in the Sketch menu, not the entity menu. */
const DRAWING_TOOL_ID =
  /^sketch\.(line|arc|circle|rectangle|polygon|spline|trim|offset|dimension|newXY|newXZ|newYZ)$/;
const MAX_PRIMARY = 8;

/** Empty space: view commands only (no entity commands to show). */
const EMPTY_TAIL_IDS = [
  'view.zoomToFit',
  'view.iso',
  'select.through',
  'edit.showAll',
  'edit.invertVisibility',
  'view.saveView',
];
const TAIL_COMMAND_IDS = [
  'view.lookAt',
  'edit.renameBody',
  'edit.bodyColour',
  'edit.revealInItems',
  'edit.hide',
  'modes.isolate',
  'view.zoomToSelection',
  'view.zoomToFit',
  'select.through',
  'transform.delete',
];

export interface CommandContextMenuProps {
  x: number;
  y: number;
  state: AssemblerState;
  onClose: () => void;
}

export function CommandContextMenu({ x, y, state, onClose }: CommandContextMenuProps): JSX.Element {
  const empty = state.selection.length === 0;
  // Entity commands only (tools, transforms, modes, sketch editing) — not every enabled
  // global command — recommended first, at most MAX_PRIMARY; the fixed tail follows.
  const primary = empty
    ? []
    : resolveAdaptive(state)
        .filter(
          (c) =>
            CONTEXT_GROUPS.has(c.group) &&
            !DRAWING_TOOL_ID.test(c.id) &&
            !TAIL_COMMAND_IDS.includes(c.id),
        )
        .slice(0, MAX_PRIMARY);
  const primaryIds = new Set(primary.map((c) => c.id));
  const tail = (empty ? EMPTY_TAIL_IDS : TAIL_COMMAND_IDS)
    .map((id) => findCommand(id))
    .filter((c): c is Command => c !== undefined && !primaryIds.has(c.id));
  // Rows are 30 px, plus padding and the separator.
  const position = clampMenuPosition(x, y, 240, 30 * (primary.length + tail.length) + 28);

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
            <Row command={command} on={command.adaptive === false && availability.recommended} />
          </MenuItem>
        );
      })}
    </UiContextMenu>
  );
}

/** `on` marks an active toggle (Select Through) with a check. */
function Row({ command, on }: { command: Command; on?: boolean | undefined }): JSX.Element {
  return (
    <span className={styles.row}>
      <span className={styles.label}>
        {on ? '✓ ' : ''}
        {command.label}
      </span>
      {command.shortcut ? <span className={styles.shortcut}>{command.shortcut}</span> : null}
    </span>
  );
}
