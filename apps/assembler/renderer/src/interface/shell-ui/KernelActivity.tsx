/**
 * Kernel work that takes longer than `LONG_OPERATION_MS` (2 s): what is
 * being computed, a progress bar (features evaluated of the features this
 * computation needs — cached ones are skipped) and Cancel, which stops the
 * computation within the kernel restart time and restores the last
 * computed state (`store.cancelKernelWork`). Also shows one-off kernel
 * notices, e.g. after the kernel crashed and was restarted.
 */
import { Info, LoaderCircle, X } from 'lucide-react';

import { Button, Tooltip } from '@himmelcad/ui';

import type { AssemblerState } from '../../foundation/commands/store.js';
import styles from './KernelActivity.module.css';

function describe(activity: NonNullable<AssemblerState['kernelActivity']>): {
  title: string;
  detail: string;
  fraction: number | null;
} {
  const title =
    activity.channel === 'preview'
      ? 'Computing preview…'
      : activity.channel === 'background'
        ? 'Testing parameter range…'
        : 'Updating model…';
  const progress = activity.progress;
  if (!progress) return { title, detail: 'Starting', fraction: null };
  if (progress.phase === 'tessellate') {
    return { title, detail: 'Building the display mesh', fraction: 1 };
  }
  const name = progress.featureName ?? 'feature';
  return {
    title,
    detail: `${name} (${progress.done + 1} of ${progress.total})`,
    fraction: progress.total > 0 ? progress.done / progress.total : null,
  };
}

export function KernelActivity({ state }: { state: AssemblerState }): JSX.Element | null {
  const activity = state.kernelActivity;
  const notice = state.kernelNotice;
  if (!activity && !notice) return null;
  const info = activity ? describe(activity) : null;
  return (
    <div className={styles.root}>
      {activity && info ? (
        <div className={styles.island} role="status" aria-live="polite">
          <LoaderCircle size={14} aria-hidden />
          <div className={styles.label}>
            <span>
              {info.title} <span className={styles.detail}>{info.detail}</span>
            </span>
            <span
              className={styles.progress}
              role="progressbar"
              aria-label="Kernel computation"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(info.fraction !== null
                ? { 'aria-valuenow': Math.round(info.fraction * 100) }
                : {})}
            >
              <span
                className={styles.progressFill}
                style={{ width: `${Math.round((info.fraction ?? 0.05) * 100)}%` }}
              />
            </span>
          </div>
          <Tooltip content="Stop and restore the last computed state">
            <Button
              variant="secondary"
              size="small"
              icon={<X size={14} />}
              onClick={() => state.cancelKernelWork()}
            >
              Cancel
            </Button>
          </Tooltip>
        </div>
      ) : null}
      {notice ? (
        <div className={styles.island} role="alert">
          <Info size={14} aria-hidden />
          <span className={styles.notice}>{notice}</span>
          <Tooltip content="Dismiss">
            <Button
              variant="quiet"
              size="small"
              icon={<X size={14} />}
              aria-label="Dismiss notice"
              onClick={() => state.dismissKernelNotice()}
            />
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
