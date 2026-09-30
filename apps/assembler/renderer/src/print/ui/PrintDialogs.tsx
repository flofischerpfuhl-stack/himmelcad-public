/**
 * Print dialogs: "Export STL…" (scope, binary/ASCII, resolution preset,
 * live triangle-count preview) and "Slicers…" (detected and registered
 * slicers, add/remove/default, Open in Slicer).
 */
import { Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Dialog, Select, Tooltip } from '@himmelcad/ui';

import { MESH_RESOLUTIONS, type MeshResolution } from '../../kernel/meshExport.js';
import type { StlFormat } from '../../kernel/stlExport.js';
import { useAssemblerStore } from '../../model/store.js';
import { useWorkspaceStore } from '../../model/workspace.js';
import {
  estimateStlBytes,
  exportStl,
  previewTriangleCounts,
  stlBodyIds,
  type StlScope,
} from '../exporting.js';
import { usePrintStore } from '../printStore.js';
import { useSlicerStore } from '../slicerStore.js';
import styles from './PrintDialogs.module.css';

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function StlExportDialog(): JSX.Element {
  const open = usePrintStore((s) => s.stlDialogOpen);
  const selection = useAssemblerStore((s) => s.selection);
  const evaluation = useAssemblerStore((s) => s.evaluation);
  const hasSelectedBody = selection.some((s) => s.kind === 'body');
  const [scope, setScope] = useState<StlScope>('all');
  const [format, setFormat] = useState<StlFormat>('binary');
  const [resolution, setResolution] = useState<MeshResolution>('current');
  const [preview, setPreview] = useState<{ id: string; name: string; triangles: number }[] | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setScope(hasSelectedBody ? 'selected' : 'all');
    // Only when the dialog opens: the user's choice wins afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview(null);
    setPreviewError(null);
    const timer = setTimeout(() => {
      previewTriangleCounts({ scope, format, resolution }).then(
        (counts) => alive && setPreview(counts),
        (error: unknown) =>
          alive && setPreviewError(error instanceof Error ? error.message : String(error)),
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, scope, format, resolution, evaluation, selection]);

  const close = () => usePrintStore.getState().setStlDialogOpen(false);
  const total = preview?.reduce((s, p) => s + p.triangles, 0) ?? null;
  const files = scope === 'each' ? (preview?.length ?? 0) : 1;
  const bodyCount = stlBodyIds(scope).length;

  const run = async () => {
    setBusy(true);
    try {
      const written = await exportStl({ scope, format, resolution });
      if (written > 0) {
        close();
        useWorkspaceStore
          .getState()
          .notify(written === 1 ? 'STL exported.' : `${written} STL files exported.`);
      }
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Export STL"
      actions={
        <>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            loadingLabel="Exporting"
            disabled={bodyCount === 0 || total === null}
            onClick={() => void run()}
          >
            Export
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Row label="Bodies">
          <Select
            aria-label="Bodies to export"
            value={scope}
            options={[
              { value: 'all', label: 'All bodies, one file' },
              { value: 'visible', label: 'Visible bodies, one file' },
              {
                value: 'selected',
                label: 'Selected bodies, one file',
                disabled: !hasSelectedBody,
                description: 'Select bodies first.',
              },
              { value: 'each', label: 'Each body as its own file' },
            ]}
            onChange={(e) => setScope(e.currentTarget.value as StlScope)}
          />
        </Row>
        <Row label="Format">
          <Select
            aria-label="STL format"
            value={format}
            options={[
              { value: 'binary', label: 'Binary (smaller)' },
              { value: 'ascii', label: 'ASCII (text)' },
            ]}
            onChange={(e) => setFormat(e.currentTarget.value as StlFormat)}
          />
        </Row>
        <Row label="Resolution">
          <Select
            aria-label="Mesh resolution"
            value={resolution}
            options={[
              { value: 'current', label: 'As displayed' },
              ...(['coarse', 'standard', 'fine'] as const).map((r) => ({
                value: r,
                label: MESH_RESOLUTIONS[r].label,
              })),
            ]}
            onChange={(e) => setResolution(e.currentTarget.value as MeshResolution)}
          />
        </Row>
        <div className={styles.preview} aria-live="polite">
          {previewError ? (
            <span className={styles.warning}>{previewError}</span>
          ) : total === null ? (
            'Counting triangles…'
          ) : (
            <>
              <span className={styles.previewTotal}>
                {total.toLocaleString('en-US')} triangles · ≈
                {formatBytes(estimateStlBytes(total, format, preview?.length ?? 1))}
                {files > 1 ? ` in ${files} files` : ''}
              </span>
              {preview && preview.length > 1 ? (
                <ul className={styles.previewList}>
                  {preview.map((p) => (
                    <li key={p.id}>
                      <span>{p.name}</span>
                      <span>{p.triangles.toLocaleString('en-US')}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <p className={styles.hint}>
          Millimetres. Presets re-tessellate the exact geometry (chordal and angular deflection);
          “As displayed” uses the viewport mesh. 3MF keeps names and colours — prefer it for
          slicers.
        </p>
      </div>
    </Dialog>
  );
}

export function SlicerDialog(): JSX.Element {
  const open = usePrintStore((s) => s.slicerDialogOpen);
  const slicers = useSlicerStore();
  useEffect(() => {
    if (open) void useSlicerStore.getState().refresh();
  }, [open]);
  const close = () => usePrintStore.getState().setSlicerDialogOpen(false);
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
