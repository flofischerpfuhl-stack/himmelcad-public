/**
 * Top bar: product mark + project name (click to rename inline), File/Edit/
 * View/Help menus (dropdowns listing registry commands of those groups with
 * shortcuts), and Undo/Redo icon buttons. The native window frame stays —
 * this is an in-app bar, not a titlebar replacement.
 */
import { Redo2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Dialog,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  Tooltip,
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { onCloseRequested, onOpenRequested } from '../../foundation/document/persistence.js';
import { host } from '../../foundation/host/index.js';
import { usePreferences } from '../../platform/input/preferences.js';
import { MAX_SAVED_VIEWS, useWorkspaceStore } from './workspace.js';
import { useProjectStore } from './project/projectStore.js';
import { CommandGroupMenu } from './CommandGroupMenu.js';
import { DisplayMenuItems } from '../../modules/display/ui/DisplayMenu.js';
import { RecentFilesMenu } from './RecentFilesMenu.js';
import { BrandMark, PreviewBadge } from './BrandMark.js';
import type { AssemblerState } from '../../foundation/commands/store.js';
import styles from './TopBar.module.css';

const PENDING_ACTION_LABEL: Record<'new' | 'open' | 'openFile' | 'template' | 'close', string> = {
  new: 'starting a new project',
  template: 'starting a new project',
  open: 'opening another project',
  openFile: 'opening another project',
  close: 'closing',
};

export function TopBar({ state }: { state: AssemblerState }): JSX.Element {
  // Settings may move Undo/Redo below the tools (Shapr3D on Windows, UI-18).
  const undoInTitle = usePreferences((p) => p.undoRedoPlacement === 'titleBar');
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const project = useProjectStore();
  // The Home screen shows the recovery offer itself while it is open.
  const homeOpen = useWorkspaceStore((s) => s.homeOpen);

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

  // Double-click on a `.hcasm` (file association), a CLI path, or a second
  // app instance forwarding its argv (`electron/main.ts`,
  // `requestSingleInstanceLock`) — main pushes the already-read file here
  // rather than the renderer polling for it.
  useEffect(() => {
    // Unsaved changes are asked about in the same dialog as New/Open.
    return onOpenRequested((opened) =>
      useProjectStore.getState().requestOpenFile(() => Promise.resolve(opened)),
    );
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.brand}>
        <BrandMark size={16} className={styles.mark} />
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
          extraItems={<RecentFilesMenu />}
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
          extraItems={
            <>
              <DisplayMenuItems state={state} />
              <SavedViewItems />
            </>
          }
        />
        <HelpMenu />
      </nav>
      <div className={styles.spacer} />
      {undoInTitle ? (
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
      ) : null}

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
        open={project.recoveryOffer !== null && !homeOpen}
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

/** Saved views (up to 8) at the end of the View menu: go to a view, or delete one. */
function SavedViewItems(): JSX.Element | null {
  const views = useWorkspaceStore((s) => s.savedViews);
  if (views.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      <MenuItem disabled>
        Saved views ({views.length}/{MAX_SAVED_VIEWS})
      </MenuItem>
      {views.map((view, index) => (
        <MenuItem
          key={`${view.name}:${index}`}
          {...(view.section?.enabled ? { title: 'Restores the camera and the section' } : {})}
          onSelect={() => useWorkspaceStore.getState().restoreView(index)}
        >
          {view.name}
          {view.section?.enabled ? ' · section' : ''}
        </MenuItem>
      ))}
      <MenuSubmenu label="Delete saved view" ariaLabel="Delete saved view">
        {views.map((view, index) => (
          <MenuItem
            key={`${view.name}:${index}`}
            onSelect={() => useWorkspaceStore.getState().deleteView(index)}
          >
            {view.name}
          </MenuItem>
        ))}
      </MenuSubmenu>
    </>
  );
}

function HelpMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'about' | null>(null);

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
                useWorkspaceStore.getState().setShortcutOverlay(true);
                setOpen(false);
              }}
            >
              Keyboard shortcuts
            </MenuItem>
            <MenuItem
              onSelect={() => {
                useWorkspaceStore.getState().setSettingsOpen(true);
                setOpen(false);
              }}
            >
              Settings…
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
        open={dialog === 'about'}
        onClose={() => setDialog(null)}
        title="About Himmel:CAD Assembler"
      >
        <p className={styles.aboutTitle}>
          <BrandMark size={32} />
          <span>Himmel:CAD Assembler: CAD for 3D printing.</span>
          <PreviewBadge />
        </p>
        <p>
          This application makes use of, and is based on facilities provided by, the Open CASCADE
          Technology software (OCCT 8.0.1, LGPL 2.1 with the Open CASCADE exception), compiled to
          WebAssembly by opencascade.js and loaded at runtime as a separate, replaceable module.
          Modelling API: replicad (MIT).
        </p>
        <p>
          Sketch constraints are solved by FreeCAD&apos;s planeGCS (LGPL 2.0 or later), compiled to
          WebAssembly by @salusoft89/planegcs and loaded at runtime as a separate, replaceable
          module.
        </p>
        <p>
          License texts, source locations and replacement instructions ship with the application in
          <code> licenses/THIRD-PARTY-NOTICES.txt</code>.
        </p>
        {host().kind === 'web' ? (
          // The web build serves them next to the app (with the OCCT build recipe, LGPL source offer).
          <p>
            Open the{' '}
            <a
              className={styles.aboutLink}
              href="licenses/THIRD-PARTY-NOTICES.txt"
              target="_blank"
              rel="noreferrer"
            >
              third-party notices
            </a>{' '}
            or the{' '}
            <a
              className={styles.aboutLink}
              href="licenses/SOURCE-OFFER.txt"
              target="_blank"
              rel="noreferrer"
            >
              LGPL source offer
            </a>
            .
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
