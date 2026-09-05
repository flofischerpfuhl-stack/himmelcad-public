import {
  commandsForSurface,
  type CommandContext,
  type CommandExecutor,
  type CommandGroup,
  type RuntimeCommandId,
  type RuntimeCommandEntry,
} from '../../app/src/commands.js';
import { ContextMenu, MenuItem, MenuSeparator, MenuSubmenu } from './Menu.js';
import styles from './CommandSurfaces.module.css';

export interface CommandSurfacePosition {
  readonly x: number;
  readonly y: number;
}

export interface EntityCommandMenuProps extends CommandSurfacePosition {
  readonly context: CommandContext;
  readonly target: EntityCommandTarget;
  readonly onExecute: EntityCommandExecutor;
  readonly onClose: () => void;
  readonly currentCandidateId?: string;
  readonly candidateSubmenuOpen?: boolean;
}

export interface EntityCommandTarget {
  readonly entityIds: readonly string[];
  readonly kind: string;
}

export type EntityCommandExecutor = (
  commandId: RuntimeCommandId,
  target: EntityCommandTarget,
) => void | Promise<void>;

export function EntityCommandMenu({
  x,
  y,
  context,
  target,
  onExecute,
  onClose,
  currentCandidateId,
  candidateSubmenuOpen = false,
}: EntityCommandMenuProps): JSX.Element {
  const position = clampMenuPosition(x, y, 240, 320);
  const entries = commandsForSurface('contextMenu', context);
  return (
    <ContextMenu
      {...position}
      onClose={onClose}
      ariaLabel="Entity commands"
      className={styles.menu!}
    >
      <CommandRows
        entries={entries}
        onExecute={(entry, targetOverride) => onExecute(entry.id, targetOverride ?? target)}
        {...(context.candidates ? { candidates: context.candidates } : {})}
        {...(currentCandidateId ? { currentCandidateId } : {})}
        candidateSubmenuOpen={candidateSubmenuOpen}
        onClose={onClose}
      />
    </ContextMenu>
  );
}

export interface QuickCommandSurfaceProps extends CommandSurfacePosition {
  readonly context: CommandContext;
  readonly onExecute: CommandExecutor;
  readonly onClose: () => void;
}

export function QuickCommandSurface({
  x,
  y,
  context,
  onExecute,
  onClose,
}: QuickCommandSurfaceProps): JSX.Element {
  const position = clampMenuPosition(x, y, 240, 260);
  return (
    <ContextMenu
      {...position}
      onClose={onClose}
      ariaLabel="Viewport quick surface"
      className={styles.menu!}
    >
      <div className={styles.header}>Viewport</div>
      <CommandRows
        entries={commandsForSurface('quickSurface', context)}
        onExecute={(entry, targetOverride) =>
          onExecute({
            id: entry.id,
            args: targetOverride?.entityIds ?? [],
            source: 'quickSurface',
            ...(targetOverride ? { payload: targetOverride } : {}),
          })
        }
      />
    </ContextMenu>
  );
}

function CommandRows({
  entries,
  onExecute,
  candidates,
  currentCandidateId,
  candidateSubmenuOpen,
  onClose,
}: {
  readonly entries: readonly RuntimeCommandEntry[];
  readonly onExecute: (
    entry: RuntimeCommandEntry,
    targetOverride?: EntityCommandTarget,
  ) => void | Promise<void>;
  readonly candidates?: CommandContext['candidates'];
  readonly currentCandidateId?: string;
  readonly candidateSubmenuOpen?: boolean;
  readonly onClose?: () => void;
}): JSX.Element {
  let previousGroup: CommandGroup | null = null;
  return (
    <>
      {entries.map((entry) => {
        const separator = previousGroup !== null && previousGroup !== entry.group;
        previousGroup = entry.group;
        const content = (
          <span className={styles.itemContent}>
            <span className={styles.label}>{entry.label}</span>
            {entry.shortcut ? <span className={styles.shortcut}>{entry.shortcut}</span> : null}
          </span>
        );
        return (
          <span key={entry.id}>
            {separator ? <MenuSeparator /> : null}
            {entry.id === 'select.set' && candidates && candidates.length > 1 ? (
              <MenuSubmenu
                label={content}
                ariaLabel="Select under cursor"
                className={`${styles.menu!} ${styles.submenu!}`}
                {...(candidateSubmenuOpen === undefined
                  ? {}
                  : { defaultOpen: candidateSubmenuOpen })}
              >
                {candidates.map((candidate) => (
                  <MenuItem
                    key={candidate.entityId}
                    aria-current={candidate.entityId === currentCandidateId ? 'true' : undefined}
                    onSelect={() => {
                      const selectEntry = entries.find((entry) => entry.id === 'select.set');
                      if (selectEntry) {
                        void onExecute(selectEntry, {
                          entityIds: [candidate.entityId],
                          kind: candidate.kind,
                        });
                      }
                      onClose?.();
                    }}
                  >
                    <span className={styles.itemContent}>
                      <span className={styles.label}>
                        {candidate.kind} · {candidate.name}
                      </span>
                      <span className={styles.mark} aria-hidden>
                        {candidate.entityId === currentCandidateId ? '✓' : ''}
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuSubmenu>
            ) : (
              <MenuItem
                onSelect={() => void onExecute(entry)}
              >
                {content}
              </MenuItem>
            )}
          </span>
        );
      })}
    </>
  );
}

export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth,
  viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight,
): CommandSurfacePosition {
  return {
    x: Math.max(4, Math.min(x, viewportWidth - width - 4)),
    y: Math.max(4, Math.min(y, viewportHeight - height - 4)),
  };
}
