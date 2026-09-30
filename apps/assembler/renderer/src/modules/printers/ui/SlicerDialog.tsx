/**
 * "Slicers…": detected and registered slicers, add/remove/default, Open in
 * Slicer (moved from the print dialogs unchanged).
 */
import { Star, Trash2 } from 'lucide-react';
import { useEffect } from 'react';

import { Button, Dialog, Tooltip } from '@himmelcad/ui';

import { useAssemblerStore } from '../../../foundation/commands/store.js';
import { useSlicerStore } from '../slicerStore.js';
import styles from './SlicerDialog.module.css';

export function SlicerDialog(): JSX.Element {
  const open = useSlicerStore((s) => s.dialogOpen);
  const slicers = useSlicerStore();
  useEffect(() => {
    if (open) void useSlicerStore.getState().refresh();
  }, [open]);
  const close = () => useSlicerStore.getState().setDialogOpen(false);
  const hasBodies = useAssemblerStore((s) => s.evaluation.bodies.length > 0);

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Slicers"
      actions={
        <>
          <Button variant="quiet" onClick={close}>
            Close
          </Button>
          <Button
            variant="primary"
            loading={slicers.busy}
            loadingLabel="Opening"
            disabled={!hasBodies || (slicers.available && !slicers.defaultId)}
            onClick={() => void slicers.open().then(() => close())}
          >
            {slicers.available ? 'Open in Slicer' : 'Download 3MF'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {!slicers.available ? (
          <p className={styles.hint}>
            The browser build cannot start programs: Open in Slicer downloads the 3MF so you can
            open it in your slicer. The desktop app detects Bambu Studio, OrcaSlicer, PrusaSlicer
            and UltiMaker Cura and hands the file over directly.
          </p>
        ) : (
          <>
            <p className={styles.hint}>
              The model is written to a temporary 3MF (names and colours kept) and the slicer is
              started with it. Nothing is installed.
            </p>
            <div className={styles.slicers} role="list" aria-label="Slicers">
              {slicers.loaded && slicers.slicers.length === 0 ? (
                <p className={styles.hint}>
                  No slicer found in the usual install folders. Add the slicer program (.exe).
                </p>
              ) : null}
              {slicers.slicers.map((s) => (
                <div
                  key={s.id}
                  role="listitem"
                  className={`${styles.slicer} ${slicers.defaultId === s.id ? styles.slicerDefault : ''}`}
                >
                  <span className={styles.slicerText}>
                    <span className={styles.slicerName}>{s.name}</span>
                    <span className={styles.slicerPath} title={s.path}>
                      {s.path}
                    </span>
                  </span>
                  <span className={styles.badge}>
                    {!s.available ? 'Missing' : s.source === 'detected' ? 'Detected' : 'Added'}
                  </span>
                  <Tooltip content={slicers.defaultId === s.id ? 'Default slicer' : 'Make default'}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`Make ${s.name} the default slicer`}
                      aria-pressed={slicers.defaultId === s.id}
                      onClick={() => void slicers.setDefault(s.id)}
                    >
                      <Star size={14} fill={slicers.defaultId === s.id ? 'currentColor' : 'none'} />
                    </button>
                  </Tooltip>
                  {s.source === 'user' ? (
                    <Tooltip content="Remove">
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={`Remove ${s.name}`}
                        onClick={() => void slicers.remove(s.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
              ))}
            </div>
            <div>
              <Button size="small" onClick={() => void slicers.add()}>
                Add slicer…
              </Button>
            </div>
          </>
        )}
        {slicers.message ? (
          <p
            className={`${styles.hint} ${slicers.message.tone === 'warning' ? styles.warning : ''}`}
          >
            {slicers.message.text}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
