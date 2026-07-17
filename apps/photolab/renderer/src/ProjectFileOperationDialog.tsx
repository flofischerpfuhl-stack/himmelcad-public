import { AlertTriangle, LoaderCircle, X } from 'lucide-react';

import type { ProjectFileOperationState } from './projectFileOperation.js';
import styles from './ProjectFileOperationDialog.module.css';

export function ProjectFileOperationDialog({
  operation,
  onCancel,
  onClose,
}: {
  operation: ProjectFileOperationState;
  onCancel: () => void;
  onClose: () => void;
}): JSX.Element {
  const archive = operation.archive;
  const percentage = Math.round(operation.fraction * 100);
  return (
    <section
      className={styles.dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-file-operation-title"
      aria-describedby="project-file-operation-status"
    >
      <header data-task-drag-handle>
        <div>
          <span>PROJECT FILE</span>
          <h2 id="project-file-operation-title">{operation.title}</h2>
        </div>
        {operation.error && (
          <button type="button" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </header>
      <div className={styles.content}>
        <div className={styles.statusLine} id="project-file-operation-status">
          {operation.error ? (
            <AlertTriangle className={styles.errorIcon} size={17} />
          ) : (
            <LoaderCircle className={styles.spinner} size={17} />
          )}
          <div>
            <strong>{operation.message}</strong>
            {archive?.currentPath && (
              <small title={archive.currentPath}>{archive.currentPath}</small>
            )}
          </div>
          {!operation.error && <b>{percentage}%</b>}
        </div>
        {!operation.error && (
          <>
            <div
              className={styles.progress}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage}
            >
              <span style={{ width: `${percentage}%` }} />
            </div>
            <div className={styles.metrics}>
              <span>
                Phase bytes
                <strong>
                  {formatBytes(archive?.bytesCompleted ?? 0)} /{' '}
                  {formatBytes(archive?.bytesTotal ?? 0)}
                </strong>
              </span>
              <span>
                Files
                <strong>
                  {formatCount(archive?.filesCompleted)} / {formatCount(archive?.filesTotal)}
                </strong>
              </span>
            </div>
          </>
        )}
        {operation.error && <p className={styles.error}>{operation.error}</p>}
      </div>
      <footer>
        {operation.error ? (
          <button type="button" onClick={onClose}>
            Close
          </button>
        ) : (
          <button type="button" disabled={operation.cancelRequested} onClick={onCancel}>
            {operation.cancelRequested ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </footer>
    </section>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** unit;
  return `${scaled.toFixed(unit === 0 || scaled >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatCount(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : Math.max(0, value).toLocaleString('en');
}
