import { FilePlus, FolderOpen, History, Trash2 } from 'lucide-react';

import styles from './RecentProjects.module.css';

export interface RecentProjectAvailability {
  readonly name: string;
  readonly path: string;
  readonly lastOpenedUnixMs: number;
  readonly exists: boolean;
}

export function RecentProjects({
  projects,
  welcome = false,
  onNew,
  onOpen,
  onOpenRecent,
  onRemove,
}: {
  projects: readonly RecentProjectAvailability[];
  welcome?: boolean;
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemove: (path: string) => void;
}): JSX.Element {
  return (
    <section className={welcome ? styles.welcome : styles.panel} aria-label="Recent projects">
      <header>
        <span className={styles.icon} aria-hidden="true">
          <History size={18} />
        </span>
        <div>
          <h2>{welcome ? 'Welcome to PhotoLab' : 'Recent projects'}</h2>
          {welcome && <p>Start a new survey or continue where you left off.</p>}
        </div>
      </header>
      <div className={styles.primaryActions}>
        <button type="button" className={styles.primary} onClick={onNew}>
          <FilePlus size={16} />
          New project
        </button>
        <button type="button" onClick={onOpen}>
          <FolderOpen size={16} />
          Open project…
        </button>
      </div>
      <div className={styles.listHeader}>Recent projects</div>
      {projects.length === 0 ? (
        <p className={styles.empty}>No recent projects yet.</p>
      ) : (
        <ul className={styles.list}>
          {projects.map((project) => (
            <li key={project.path} className={project.exists ? undefined : styles.missing}>
              <button
                type="button"
                className={styles.project}
                disabled={!project.exists}
                onClick={() => onOpenRecent(project.path)}
              >
                <strong>{project.name}</strong>
                <span title={project.path}>{project.path}</span>
                <small>
                  {project.exists
                    ? `Last opened ${formatRecentTime(project.lastOpenedUnixMs)}`
                    : 'Not found'}
                </small>
              </button>
              {!project.exists && (
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => onRemove(project.path)}
                  aria-label={`Remove ${project.name} from recent projects`}
                  title="Remove from recent projects"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatRecentTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}
