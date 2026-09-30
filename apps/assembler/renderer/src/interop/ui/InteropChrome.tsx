/**
 * Import/export chrome: the drop target over the whole window, the import
 * progress island (Cancel), the DXF placement dialog, the unit check for
 * unitless meshes, the result report, and the STEP / DXF export dialogs.
 * State and actions: `interop/interopStore.ts`.
 */
import { FileDown, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Checkbox, Dialog, NumberInput, ProgressBar, Select, Tooltip } from '@himmelcad/ui';

import { useAssemblerStore } from '../../model/store.js';
import { useWorkspaceStore } from '../../model/workspace.js';
import { INTEROP_FORMATS } from '../formats.js';
import { dxfExportTarget, useInteropStore, type StepExportSettings } from '../interopStore.js';
import styles from './InteropChrome.module.css';

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

/** Window-wide drag & drop: files dropped anywhere are imported. */
function useFileDrop(): void {
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      useInteropStore.getState().setDragActive(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the browser/Electron would navigate to the dropped file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) useInteropStore.getState().setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      useInteropStore.getState().setDragActive(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      void Promise.all(
        files.map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ).then((read) => useInteropStore.getState().importFiles(read));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}

function DropOverlay(): JSX.Element | null {
  const active = useInteropStore((s) => s.dragActive);
  if (!active) return null;
  const formats = INTEROP_FORMATS.filter((f) => f.format !== 'iges').map((f) => f.label);
  return (
    <div className={styles.dropOverlay} aria-hidden>
      <div className={styles.dropCard}>
        <FileDown size={28} />
        <strong>Drop to import</strong>
        <span>{[...formats, 'HimmelCAD project (.hcasm)'].join(' · ')}</span>
      </div>
    </div>
  );
}

function JobIsland(): JSX.Element | null {
  const job = useInteropStore((s) => s.job);
  if (!job) return null;
  return (
    <div className={styles.job} role="status" aria-live="polite">
      <LoaderCircle size={16} className={styles.spin} aria-hidden />
      <div className={styles.jobText}>
        <span className={styles.jobTitle}>{job.title}</span>
        <ProgressBar
          value={job.fraction ?? 0}
          ariaLabel={job.detail}
          indeterminate={job.fraction === null}
          indeterminateLabel={job.detail}
        />
      </div>
      <Tooltip content="Stop and leave the document as it was">
        <Button
          variant="quiet"
          size="small"
          icon={<X size={14} />}
          onClick={() => useInteropStore.getState().cancelJob()}
        >
          Cancel
        </Button>
      </Tooltip>
    </div>
  );
}

function ReportDialog(): JSX.Element {
  const report = useInteropStore((s) => s.report);
  const close = () => useInteropStore.getState().dismissReport();
  return (
    <Dialog
      open={report !== null}
      onClose={close}
      title={report?.title ?? ''}
      actions={
        <Button variant="primary" onClick={close}>
          OK
        </Button>
      }
    >
      <ul className={report?.tone === 'error' ? styles.reportError : styles.report}>
        {(report?.lines ?? []).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </Dialog>
  );
}

function DxfImportDialog(): JSX.Element {
  const pending = useInteropStore((s) => s.dxfPending);
  const [placement, setPlacement] = useState<'plane' | 'face'>('plane');
  const [plane, setPlane] = useState<'XY' | 'XZ' | 'YZ'>('XY');
  const [offset, setOffset] = useState(0);
  const [connect, setConnect] = useState(true);
  const [units, setUnits] = useState('file');
  useEffect(() => {
    if (!pending) return;
    setPlacement(pending.face ? 'face' : 'plane');
    setUnits('file');
  }, [pending]);
  const close = () => useInteropStore.getState().dismissDxf();
  const counts = new Map<string, number>();
  for (const e of pending?.drawing.entities ?? [])
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const skipped = Object.entries(pending?.drawing.skipped ?? {});
  const unitScale = units === 'file' ? null : Number(units);
  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      title={`Import DXF: ${pending?.fileName ?? ''}`}
      actions={
        <>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              useInteropStore
                .getState()
                .confirmDxf({ placement, plane, offset, connect, unitScale })
            }
          >
            Import as sketch
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Row label="Place on">
          <Select
            aria-label="Sketch placement"
            value={placement === 'face' ? 'face' : plane}
            options={[
              { value: 'XY', label: 'XY plane (top)' },
              { value: 'XZ', label: 'XZ plane (front)' },
              { value: 'YZ', label: 'YZ plane (right)' },
              {
                value: 'face',
                label: 'Selected face',
                disabled: !pending?.face,
                description: 'Select a planar face before importing.',
              },
            ]}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (value === 'face') setPlacement('face');
              else {
                setPlacement('plane');
                setPlane(value as 'XY' | 'XZ' | 'YZ');
              }
            }}
          />
        </Row>
        {placement === 'plane' ? (
          <Row label="Plane offset">
            <NumberInput
              aria-label="Plane offset"
              value={offset}
              unit="mm"
              onCommit={(value) => setOffset(value)}
            />
          </Row>
        ) : null}
        <Row label="Units">
          <Select
            aria-label="Drawing units"
            value={units}
            options={[
              {
                value: 'file',
                label: pending?.units.fileUnit
                  ? `File: ${pending.units.fileUnit}`
                  : 'File has none: millimetres',
              },
              { value: '1', label: 'Millimetres' },
              { value: '10', label: 'Centimetres' },
              { value: '1000', label: 'Metres' },
              { value: '25.4', label: 'Inches' },
              { value: '304.8', label: 'Feet' },
            ]}
            onChange={(e) => setUnits(e.currentTarget.value)}
          />
        </Row>
        <Checkbox
          label="Connect end points (coincident)"
          checked={connect}
          onChange={(e) => setConnect(e.currentTarget.checked)}
        />
        <div className={styles.summary}>
          {[...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`).join(' · ')}
          {skipped.length > 0 ? (
            <div className={styles.muted}>
              Not imported: {skipped.map(([t, n]) => `${n} × ${t}`).join(', ')}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function UnitOfferDialog(): JSX.Element {
  const offer = useInteropStore((s) => s.unitOffer);
  const resolve = (apply: boolean) => useInteropStore.getState().resolveUnitOffer(apply);
  return (
    <Dialog
      open={offer !== null}
      onClose={() => resolve(false)}
      title="Check the imported mesh's units"
      actions={
        <>
          <Button variant="quiet" onClick={() => resolve(false)}>
            Keep as imported
          </Button>
          <Button variant="primary" onClick={() => resolve(true)}>
            Rescale to millimetres
          </Button>
        </>
      }
    >
      <p className={styles.text}>
        {offer
          ? `The file has no unit, and its size looks like ${offer.hint === 'm' ? 'metres' : 'inches'} rather than millimetres. Rescale ${offer.meshIds.length === 1 ? 'it' : `all ${offer.meshIds.length} meshes`} (×${offer.scaleToMm}), or keep the coordinates as imported?`
          : ''}
      </p>
    </Dialog>
  );
}

function StepExportDialog(): JSX.Element {
  const open = useInteropStore((s) => s.stepExportOpen);
  const initial = useInteropStore((s) => s.stepExportSettings);
  const selection = useAssemblerStore((s) => s.selection);
  const hiddenCount = useAssemblerStore((s) => s.hiddenBodyIds.length);
  const hasSelectedBody = selection.some((s) => s.kind === 'body');
  const [settings, setSettings] = useState<StepExportSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSettings({
      ...initial,
      scope: hasSelectedBody ? 'selected' : initial.scope === 'selected' ? 'all' : initial.scope,
    });
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = () => useInteropStore.getState().setStepExportOpen(false);
  const patch = (next: Partial<StepExportSettings>) => setSettings((s) => ({ ...s, ...next }));
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const written = await useInteropStore.getState().exportStep(settings);
      if (written > 0) {
        close();
        useWorkspaceStore
          .getState()
          .notify(written === 1 ? 'STEP exported.' : `${written} STEP files exported.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Export STEP"
      actions={
        <>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            loadingLabel="Exporting"
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
            value={settings.scope}
            options={[
              { value: 'all', label: 'All bodies' },
              {
                value: 'visible',
                label: 'Visible bodies only',
                description: hiddenCount > 0 ? `${hiddenCount} hidden` : 'Nothing is hidden.',
              },
              {
                value: 'selected',
                label: 'Selected bodies',
                disabled: !hasSelectedBody,
                description: 'Select bodies first.',
              },
            ]}
            onChange={(e) => patch({ scope: e.currentTarget.value as StepExportSettings['scope'] })}
          />
        </Row>
        <Row label="Structure">
          <Select
            aria-label="STEP structure"
            value={settings.structure}
            options={[
              { value: 'folders', label: 'Assembly (Items folders)' },
              { value: 'flat', label: 'Parts, one file' },
              { value: 'each', label: 'Each body as its own file' },
            ]}
            onChange={(e) =>
              patch({ structure: e.currentTarget.value as StepExportSettings['structure'] })
            }
          />
        </Row>
        <Row label="Protocol">
          <Select
            aria-label="STEP application protocol"
            value={settings.schema}
            options={[
              { value: 'AP242', label: 'AP242 (current)' },
              { value: 'AP214', label: 'AP214 (widest support)' },
            ]}
            onChange={(e) =>
              patch({ schema: e.currentTarget.value as StepExportSettings['schema'] })
            }
          />
        </Row>
        <Row label="Units">
          <Select
            aria-label="STEP length unit"
            value={settings.unit}
            options={[
              { value: 'mm', label: 'Millimetres' },
              { value: 'cm', label: 'Centimetres' },
              { value: 'm', label: 'Metres' },
              { value: 'in', label: 'Inches' },
            ]}
            onChange={(e) => patch({ unit: e.currentTarget.value as StepExportSettings['unit'] })}
          />
        </Row>
        {error ? <p className={styles.errorText}>{error}</p> : null}
        <p className={styles.hint}>
          Exact B-rep with body names and colours. The unit is written to the file; the geometry is
          converted, not rescaled. IGES export is not in this build.
        </p>
      </div>
    </Dialog>
  );
}

function DxfExportDialog(): JSX.Element {
  const open = useInteropStore((s) => s.dxfExportOpen);
  const [version, setVersion] = useState<'R2000' | 'R12'>('R2000');
  const [construction, setConstruction] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const target = open ? dxfExportTarget() : null;
  const close = () => useInteropStore.getState().setDxfExportOpen(false);
  const run = async () => {
    setError(null);
    try {
      const ok = await useInteropStore
        .getState()
        .exportDxf({ version, includeConstruction: construction });
      if (ok) {
        close();
        useWorkspaceStore.getState().notify('DXF exported.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Export DXF"
      actions={
        <>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!target} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.text}>
          {target
            ? target.kind === 'sketch'
              ? `Sketch "${target.name}", in its sketch coordinates (mm).`
              : `Outline of the selected face of "${target.body.name}", in the face's sketch frame (mm).`
            : 'Select a sketch or a planar face first.'}
        </p>
        <Row label="Version">
          <Select
            aria-label="DXF version"
            value={version}
            options={[
              { value: 'R2000', label: 'R2000 (splines, ellipses)' },
              { value: 'R12', label: 'R12 (widest support)' },
            ]}
            onChange={(e) => setVersion(e.currentTarget.value as 'R2000' | 'R12')}
          />
        </Row>
        {target?.kind === 'sketch' ? (
          <Checkbox
            label="Include construction geometry (own layer)"
            checked={construction}
            onChange={(e) => setConstruction(e.currentTarget.checked)}
          />
        ) : null}
        {error ? <p className={styles.errorText}>{error}</p> : null}
        <p className={styles.hint}>
          R12 has no splines or ellipses: they are written as polylines. Text is exported as its
          outlines.
        </p>
      </div>
    </Dialog>
  );
}

export function InteropChrome(): JSX.Element {
  useFileDrop();
  return (
    <>
      <DropOverlay />
      <JobIsland />
      <DxfImportDialog />
      <UnitOfferDialog />
      <StepExportDialog />
      <DxfExportDialog />
      <ReportDialog />
    </>
  );
}
