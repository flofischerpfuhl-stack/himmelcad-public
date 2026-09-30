/**
 * Home screen (Shapr3D-like start dashboard): shown when the app starts
 * without a file (Settings › Home at start) and via File › Home
 * (Ctrl+Shift+H). New project, Open…, project templates built by the agent
 * API (`templates/projectTemplates.ts` — real, editable histories), recent
 * projects with the thumbnail stored in each `.hcasm` at Save, a crash
 * recovery offer, and a short "Getting started" card whose keys come from
 * the command registry.
 *
 * A modal layer over the model: Escape or the close button returns to the
 * current document; only File shortcuts work while it is open
 * (`useGlobalKeyboard.ts`). Unsaved changes are asked about by the same
 * dialog as New/Open (`projectStore.ts` pending actions).
 */
import {
  Box,
  Cable,
  CornerDownRight,
  FilePlus,
  FolderOpen,
  LifeBuoy,
  Package,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Spinner, registerEscapeRung } from '@himmelcad/ui';

import { findCommand } from '../foundation/commands/registry.js';
import {
  isElectron,
  listRecentFiles,
  locateRecentFile,
  openRecentFile,
  removeRecentFile,
  type RecentFileInfo,
} from '../foundation/document/persistence.js';
import { useProjectStore } from '../model/project/projectStore.js';
import { useWorkspaceStore } from '../model/workspace.js';
import { PROJECT_TEMPLATES, type ProjectTemplateId } from '../templates/projectTemplates.js';
import styles from './HomeScreen.module.css';

const TEMPLATE_ICON: Record<ProjectTemplateId, LucideIcon> = {
  blank: FilePlus,
  enclosure: Package,
  bracket: CornerDownRight,
  cableClip: Cable,
};

/** Five first shortcuts; keys are read from the command registry so they never drift. */
const GETTING_STARTED: { keys: string; commandId?: string; text: string }[] = [
  { keys: 'Ctrl+F', text: 'Search every command by name' },
  { keys: 'E', commandId: 'tools.extrude', text: 'Extrude a sketch profile or a face' },
  { keys: 'F', commandId: 'tools.filletChamfer', text: 'Round or bevel the selected edges' },
  {
    keys: 'Ctrl+Shift+S',
    commandId: 'select.through',
    text: 'Select Through: pick geometry behind other geometry',
  },
  { keys: 'Ctrl+Z', commandId: 'edit.undo', text: 'Undo — every step stays editable in History' },
];

function keysOf(entry: (typeof GETTING_STARTED)[number]): string {
  return (entry.commandId ? findCommand(entry.commandId)?.shortcut : undefined) ?? entry.keys;
}

/** "Today 14:05", "Yesterday", "3 days ago", or a date. */
export function relativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  const time = then.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function folderOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

function Kbd({ keys }: { keys: string }): JSX.Element {
  return (
    <span className={styles.keys}>
      {keys.split('+').map((key, i) => (
        <kbd key={`${key}-${i}`} className={styles.kbd}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function HomeScreen(): JSX.Element | null {
  const open = useWorkspaceStore((s) => s.homeOpen);
  const recovery = useProjectStore((s) => s.recoveryOffer);
  const busy = useProjectStore((s) => s.busyMessage);
  const loadError = useProjectStore((s) => s.loadError);
  const [recent, setRecent] = useState<RecentFileInfo[] | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => useWorkspaceStore.getState().setHomeOpen(false), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listRecentFiles().then((list) => {
      if (!cancelled) setRecent(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape returns to the model; focus moves into the screen and back out when it closes.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() =>
      rootRef.current?.querySelector<HTMLButtonElement>('[data-home-autofocus]')?.focus(),
    );
    const unregister = registerEscapeRung('menu', () => {
      close();
      return true;
    });
    return () => {
      unregister();
      previous?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;
  const project = useProjectStore.getState();

  const openRecent = (entry: RecentFileInfo): void => {
    project.requestOpenFile(async () => {
      const opened = await openRecentFile(entry.path);
      if (!opened) {
        setRecent((list) =>
          list ? list.map((e) => (e.path === entry.path ? { ...e, missing: true } : e)) : list,
        );
      }
      return opened;
    });
  };
  const locate = (entry: RecentFileInfo): void => {
    void (async () => {
      const opened = await locateRecentFile(entry.path);
      if (!opened) return;
      setRecent(await listRecentFiles());
      project.requestOpenFile(() => Promise.resolve(opened));
    })();
  };
  const remove = (entry: RecentFileInfo): void => {
    void removeRecentFile(entry.path);
    setRecent((list) => list?.filter((e) => e.path !== entry.path) ?? null);
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-title"
      data-home-screen
    >
      <header className={styles.header}>
        <Box size={18} className={styles.mark} aria-hidden />
        <h1 id="home-title" className={styles.title}>
          Himmel:CAD Assembler
        </h1>
        <span className={styles.spacer} />
        {busy ? (
          <span className={styles.busy} role="status">
            <Spinner size="small" /> {busy}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.close}
          onClick={close}
          aria-label="Close Home and return to the model (Esc)"
          title="Return to the model (Esc)"
        >
          <X size={16} />
        </button>
      </header>

      <div className={styles.layout}>
        <aside className={styles.side} aria-label="Start">
          <Button
            variant="primary"
            size="large"
            icon={<FilePlus size={16} />}
            onClick={() => project.requestNew()}
            data-home-autofocus
            title="New project (Ctrl+N)"
          >
            New project
          </Button>
          <Button
            size="large"
            icon={<FolderOpen size={16} />}
            onClick={() => project.requestOpen()}
            title="Open a project (Ctrl+O)"
          >
            Open…
          </Button>

          <section className={styles.card} aria-labelledby="home-getting-started">
            <h2 id="home-getting-started" className={styles.cardTitle}>
              Getting started
            </h2>
            <ul className={styles.shortcuts}>
              {GETTING_STARTED.map((entry) => (
                <li key={entry.text} className={styles.shortcut}>
                  <Kbd keys={keysOf(entry)} />
                  <span>{entry.text}</span>
                </li>
              ))}
            </ul>
            <p className={styles.note}>
              Press <Kbd keys="?" /> in the model for every shortcut; hold Ctrl for a quick sheet.
            </p>
          </section>
        </aside>

        <main className={styles.main}>
          {loadError ? (
            <p className={styles.error} role="alert">
              {loadError}
            </p>
          ) : null}
          {recovery ? (
            <section className={styles.recovery} role="alert" aria-labelledby="home-recovery">
              <LifeBuoy size={20} className={styles.recoveryIcon} aria-hidden />
              <div className={styles.recoveryText}>
                <h2 id="home-recovery" className={styles.cardTitle}>
                  Recover unsaved work?
                </h2>
                <p className={styles.note}>
                  The app closed unexpectedly. An autosaved copy from{' '}
                  {new Date(recovery.when).toLocaleString('en-GB')} was found.
                </p>
              </div>
              <Button onClick={() => project.dismissRecovery()}>Discard</Button>
              <Button variant="primary" onClick={() => project.restoreRecovery()}>
                Recover
              </Button>
            </section>
          ) : null}

          <section aria-labelledby="home-templates">
            <h2 id="home-templates" className={styles.sectionTitle}>
              New from template
            </h2>
            <div className={styles.templates}>
              {PROJECT_TEMPLATES.map((template) => {
                const Icon = TEMPLATE_ICON[template.id];
                return (
                  <button
                    key={template.id}
                    type="button"
                    className={styles.template}
                    disabled={busy !== null}
                    onClick={() => project.requestTemplate(template.id)}
                  >
                    <span className={styles.templateArt} aria-hidden>
                      <Icon size={30} strokeWidth={1.4} />
                    </span>
                    <span className={styles.templateName}>{template.name}</span>
                    <span className={styles.templateText}>{template.description}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="home-recent">
            <h2 id="home-recent" className={styles.sectionTitle}>
              Recent projects
            </h2>
            {recent && recent.length > 0 ? (
              <ul className={styles.recent}>
                {recent.map((entry) => (
                  <li key={entry.path} className={styles.recentItem}>
                    <button
                      type="button"
                      className={styles.recentOpen}
                      disabled={entry.missing}
                      onClick={() => openRecent(entry)}
                      title={entry.path}
                    >
                      <span className={styles.thumb}>
                        {entry.thumbnail ? (
                          <img src={entry.thumbnail} alt="" className={styles.thumbImage} />
                        ) : (
                          <Box size={28} strokeWidth={1.2} aria-hidden />
                        )}
                      </span>
                      <span className={styles.recentName}>
                        {entry.name.replace(/\.hcasm$/i, '')}
                      </span>
                      <span className={styles.recentMeta}>
                        {entry.missing
                          ? 'Missing — moved or deleted'
                          : relativeTime(entry.modifiedAt ?? entry.openedAt)}
                      </span>
                      <span className={styles.recentPath}>{folderOf(entry.path)}</span>
                    </button>
                    <div className={styles.recentActions}>
                      {entry.missing ? (
                        <Button size="small" variant="quiet" onClick={() => locate(entry)}>
                          Locate…
                        </Button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={`Remove ${entry.name} from recent projects`}
                        title="Remove from recent projects"
                        onClick={() => remove(entry)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>
                {isElectron()
                  ? 'Projects you open or save appear here, with a preview of the model.'
                  : 'Recent projects are listed in the desktop app.'}
              </p>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
