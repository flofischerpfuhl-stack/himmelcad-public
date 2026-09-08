import type { AppJob } from '@himmelcad/app';
import { Button, ProgressBar } from '@himmelcad/ui';
import { Eraser, Scissors } from 'lucide-react';

import styles from './PointcloudSegmentPanel.module.css';

export interface PointcloudSegmentPanelProps {
  readonly fenceKind: 'polygon' | 'rectangle';
  readonly vertexCount: number;
  readonly area: number | null;
  readonly closed: boolean;
  readonly appliesTo: number;
  readonly activeJob: AppJob | null;
  readonly error: string | null;
  readonly onFenceKindChange: (kind: 'polygon' | 'rectangle') => void;
  readonly onKeepInside: () => void;
  readonly onRemoveInside: () => void;
  readonly onClearFence: () => void;
  readonly onCancel: (jobId: string) => void;
}

export function PointcloudSegmentPanel({
  fenceKind,
  vertexCount,
  area,
  closed,
  appliesTo,
  activeJob,
  error,
  onFenceKindChange,
  onKeepInside,
  onRemoveInside,
  onClearFence,
  onCancel,
}: PointcloudSegmentPanelProps): JSX.Element {
  const running = Boolean(
    activeJob && !['completed', 'failed', 'cancelled'].includes(activeJob.state),
  );
  return (
    <div className={styles.panel} aria-busy={running}>
      <section className={styles.section}>
        <div className={styles.heading}>Fence</div>
        <div className={styles.kindButtons}>
          <Button
            variant={fenceKind === 'polygon' ? 'primary' : 'secondary'}
            disabled={running || vertexCount > 0}
            onClick={() => onFenceKindChange('polygon')}
          >
            Polygon
          </Button>
          <Button
            variant={fenceKind === 'rectangle' ? 'primary' : 'secondary'}
            disabled={running || vertexCount > 0}
            onClick={() => onFenceKindChange('rectangle')}
          >
            Rectangle
          </Button>
        </div>
        <p className={styles.help}>
          {closed
            ? `Applies to: ${appliesTo} cloud${appliesTo === 1 ? '' : 's'}`
            : fenceKind === 'polygon'
              ? 'Click vertices, then click the first vertex or press Enter to close.'
              : 'Drag in the viewport, or place the first corner and type Width and Height.'}
        </p>
        <dl className={styles.metrics}>
          <div>
            <dt>Vertices</dt>
            <dd>{vertexCount}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>
              {area === null
                ? '—'
                : `${area.toLocaleString(undefined, { maximumFractionDigits: 3 })} m²`}
            </dd>
          </div>
        </dl>
      </section>

      {activeJob ? (
        <section className={styles.section} aria-live="polite">
          <div className={styles.status}>
            <span>{activeJob.phase}</span>
            <span>{activeJob.state === 'cancelling' ? 'Stopping…' : null}</span>
          </div>
          <ProgressBar
            value={activeJob.fraction ?? 0}
            ariaLabel="Point-cloud segmentation progress"
            indeterminate={activeJob.fraction === null}
          />
          {running ? (
            <Button
              variant="secondary"
              disabled={!activeJob.cancellation.cancellable}
              onClick={() => onCancel(activeJob.id)}
            >
              Cancel
            </Button>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button variant="primary" disabled={!closed || running} onClick={onKeepInside}>
          <Scissors size={16} aria-hidden /> Keep inside
        </Button>
        <Button variant="secondary" disabled={!closed || running} onClick={onRemoveInside}>
          <Eraser size={16} aria-hidden /> Remove inside
        </Button>
      </div>
      <Button variant="quiet" disabled={vertexCount === 0 || running} onClick={onClearFence}>
        Clear fence
      </Button>
    </div>
  );
}
