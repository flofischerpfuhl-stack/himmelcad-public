/**
 * Top bar: product mark + project name (click to rename inline), File/Edit/
 * View/Help menus (dropdowns listing registry commands of those groups with
 * shortcuts), and Undo/Redo icon buttons. The native window frame stays —
 * this is an in-app bar, not a titlebar replacement.
 */
import { Box, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Dialog,
  Menu,
  MenuItem,
  Tooltip,
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { COMMANDS } from '../model/commands/registry.js';
import { onCloseRequested } from '../model/project/persistence.js';
import { useProjectStore } from '../model/project/projectStore.js';
import { CommandGroupMenu } from './CommandGroupMenu.js';
import type { AssemblerState } from '../model/store.js';
import styles from './TopBar.module.css';

const PENDING_ACTION_LABEL: Record<'new' | 'open' | 'close', string> = {
  new: 'starting a new project',
  open: 'opening another project',
  close: 'closing',
};

export function TopBar({ state }: { state: AssemblerState }): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const project = useProjectStore();

  useEffect(() => {
    if (!renaming) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) return false;
      revertEscapeField(input, state.projectName);
      setRenaming(false);
      return true;
    });
  }, [renaming, state.projectName]);

  // Runs once: checks for a crash-recovery copy and wires up the Electron
  // "window is closing" confirmation. Both are process-lifetime concerns,
  // not per-render ones.
  useEffect(() => {
    void useProjectStore.getState().checkRecovery();
    return onCloseRequested(() => useProjectStore.getState().requestCloseWindow());
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.brand}>
        <Box size={16} className={styles.mark} aria-hidden />
        <span className={styles.wordmark}>Himmel:CAD Assembler</span>
      </div>
      {renaming ? (
        <input
          ref={inputRef}
          className={styles.projectNameInput}
          aria-label="Project name"
          defaultValue={state.projectName}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            if (consumeEscapeBlurCommitSuppression(event.currentTarget)) {
              setRenaming(false);
              return;
            }
            state.setProjectName(event.currentTarget.value);
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      ) : (
        <button
          type="button"
          className={styles.projectName}
          title={
            project.dirty
              ? 'Unsaved changes — click to rename the project'
              : 'Click to rename the project'
          }
          onClick={() => setRenaming(true)}
        >
          {state.projectName}
          {project.dirty ? ' •' : ''}
        </button>
      )}
      <nav className={styles.menus} aria-label="Main menu">
        <CommandGroupMenu
          label="File"
          group="file"
          getState={() => state}
          trigger="File"
          triggerClassName={styles.menuTrigger}
        />
        <CommandGroupMenu
          label="Edit"
          group="edit"
          getState={() => state}
          trigger="Edit"
          triggerClassName={styles.menuTrigger}
        />
        <CommandGroupMenu
          label="View"
          group="view"
          getState={() => state}
          trigger="View"
          triggerClassName={styles.menuTrigger}
        />
        <HelpMenu />
      </nav>
      <div className={styles.spacer} />
      <div className={styles.historyButtons}>
        <Tooltip content={state.history.canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo'}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Undo"
            disabled={!state.history.canUndo}
            onClick={() => state.undo()}
          >
            <Undo2 size={15} />
          </button>
        </Tooltip>
        <Tooltip content={state.history.canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo'}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Redo"
            disabled={!state.history.canRedo}
            onClick={() => state.redo()}
          >
            <Redo2 size={15} />
          </button>
        </Tooltip>
      </div>

      <Dialog
        open={project.pendingAction !== null}
        onClose={() => useProjectStore.getState().cancelPending()}
        title="Unsaved changes"
      >
        <p>
          {state.projectName} has unsaved changes. Save before{' '}
          {project.pendingAction ? PENDING_ACTION_LABEL[project.pendingAction] : ''}?
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={() => useProjectStore.getState().cancelPending()}>
            Cancel
          </button>
          <button type="button" onClick={() => useProjectStore.getState().confirmDiscard()}>
            Discard changes
          </button>
          <button type="button" onClick={() => void useProjectStore.getState().saveThenProceed()}>
            Save
          </button>
        </div>
      </Dialog>

      <Dialog
        open={project.recoveryOffer !== null}
        onClose={() => useProjectStore.getState().dismissRecovery()}
        title="Recover unsaved changes?"
      >
        <p>
          {project.recoveryOffer
            ? `An autosaved copy from ${new Date(project.recoveryOffer.when).toLocaleString()} was found. ` +
              `Recover it, or discard it and keep the current document?`
            : ''}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={() => useProjectStore.getState().dismissRecovery()}>
            Discard
          </button>
          <button type="button" onClick={() => useProjectStore.getState().restoreRecovery()}>
            Recover
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function HelpMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'shortcuts' | 'about' | null>(null);
  const shortcuts = COMMANDS.filter((c) => c.shortcut !== undefined);

  return (
    <>
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          type="button"
          className={styles.menuTrigger}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Help
        </button>
        {open ? (
          <Menu
            ariaLabel="Help"
            onClose={() => setOpen(false)}
            style={{ position: 'absolute', top: '100%', left: 0 }}
          >
            <MenuItem
              onSelect={() => {
                setDialog('shortcuts');
                setOpen(false);
              }}
            >
              Keyboard shortcuts
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setDialog('about');
                setOpen(false);
              }}
            >
              About Himmel:CAD Assembler
            </MenuItem>
          </Menu>
        ) : null}
      </div>
      <Dialog
        open={dialog === 'shortcuts'}
        onClose={() => setDialog(null)}
        title="Keyboard shortcuts"
      >
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {shortcuts.map((command) => (
            <li
              key={command.id}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
            >
              <span>{command.label}</span>
              <code>{command.shortcut}</code>
            </li>
          ))}
        </ul>
      </Dialog>
      <Dialog
        open={dialog === 'about'}
        onClose={() => setDialog(null)}
        title="About Himmel:CAD Assembler"
      >
        <p>Himmel:CAD Assembler — Phase 1 CAD-kernel spike.</p>
        <p>
          This application makes use of, and is based on facilities provided by, the Open CASCADE
          Technology software (OCCT 8.0.1, LGPL 2.1 with the Open CASCADE exception), compiled to
          WebAssembly by opencascade.js and loaded at runtime as a separate, replaceable module.
          Modelling API: replicad (MIT).
        </p>
        <p>
          License texts, source locations and replacement instructions ship with the application in
          <code> licenses/THIRD-PARTY-NOTICES.txt</code>.
        </p>
      </Dialog>
    </>
  );
}
