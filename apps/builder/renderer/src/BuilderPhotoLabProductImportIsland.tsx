import { logEvent } from '@himmelcad/console';
import { Button, ProgressBar } from '@himmelcad/ui';
import { FolderOpen, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { BuilderCanonicalProjectSession } from './project.js';
import styles from './BuilderPhotoLabProductImportIsland.module.css';

type ProductImportRow = Awaited<
  ReturnType<NonNullable<Window['himmelcad']>['productImport']['list']>
>['rows'][number];

const PHASES = [
  'Verify manifest / SHA-256',
  'Verify ready record',
  'Stage / copy',
  'Register dataset',
  'Create entity',
] as const;

export function BuilderPhotoLabProductImportIsland({
  session,
  onCommitted,
  onClose,
}: {
  readonly session: BuilderCanonicalProjectSession;
  readonly onCommitted: () => void | Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const [sourcePath, setSourcePath] = useState('');
  const [rows, setRows] = useState<readonly ProductImportRow[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [phaseIndex, setPhaseIndex] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const selected = useMemo(
    () => rows.find((row) => row.packagePath === selectedPackage) ?? null,
    [rows, selectedPackage],
  );

  useEffect(() => {
    const api = window.himmelcad;
    if (!api) return;
    let active = true;
    void api.productImport.choose().then(async (path) => {
      if (!active || !path) return;
      await loadCatalog(
        path,
        api,
        active,
        setSourcePath,
        setRows,
        setSelectedPackage,
        setCatalogError,
        setCatalogBusy,
      );
    });
    return () => {
      active = false;
    };
  }, []);

  const choose = async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api) return;
    const path = await api.productImport.choose();
    if (!path) return;
    await loadCatalog(
      path,
      api,
      true,
      setSourcePath,
      setRows,
      setSelectedPackage,
      setCatalogError,
      setCatalogBusy,
    );
  };

  const importSelected = async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api || !selected?.packagePath || selected.readiness !== 'ready') return;
    setCatalogError(null);
    setResult(null);
    const existing = await session.productProvenance(
      Object.keys(session.projectSnapshot().entities),
    );
    const duplicate = existing.find(
      (candidate) => candidate.provenance.packageSha256 === selected.packageSha256,
    );
    if (duplicate) {
      const message = `already imported as ${duplicate.entityId}`;
      setResult(message);
      logEvent('info', 'renderer', `PhotoLab product ${message}`);
      return;
    }
    const nextJobId = `product-import-${crypto.randomUUID()}`;
    setJobId(nextJobId);
    setPhaseIndex(0);
    await api.jobs.register({
      id: nextJobId,
      label: `PhotoLab product · ${selected.product}`,
      owner: 'builder.import',
      expectedDurationMs:
        selected.totalBytes && selected.totalBytes > 64 * 1024 * 1024 ? 60_000 : 5_000,
      progressKey: nextJobId,
      cancellable: true,
      context: {
        sourcePath: selected.packagePath,
        packageSha256: selected.packageSha256,
        productKind: selected.productKind,
      },
    });
    try {
      await api.jobs.update(nextJobId, { phase: PHASES[0], fraction: 0 });
      const staged = await session.stageRegisteredImport(
        selected.packagePath,
        {
          schemaVersion: 1,
          recipeId: 'import-photolab-product-source-coordinates',
          label: 'Keep published coordinates',
          method: { kind: 'sourceCoordinates' },
        },
        {},
        nextJobId,
      );
      if (staged.phase !== 'readyToCommit' || staged.preview?.accepted !== true) {
        throw new Error(staged.message ?? 'PhotoLab product did not reach the commit boundary.');
      }
      setPhaseIndex(1);
      await api.jobs.update(nextJobId, { phase: PHASES[1], fraction: 0.2 });
      setPhaseIndex(2);
      await api.jobs.update(nextJobId, { phase: PHASES[2], fraction: 0.4 });
      await session.commitRegisteredImport(nextJobId);
      setPhaseIndex(3);
      await api.jobs.update(nextJobId, { phase: PHASES[3], fraction: 0.8 });
      await api.stagedRegistration.revoke(nextJobId);
      setPhaseIndex(4);
      await onCommitted();
      await api.jobs.complete(nextJobId, `Imported ${selected.product}`);
      setResult(`Imported ${selected.product}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const job = await api.jobs.get(nextJobId);
      if (job.state === 'cancelling') await api.jobs.cancelled(nextJobId);
      else await api.jobs.fail(nextJobId, message);
      setCatalogError(message);
    } finally {
      setJobId(null);
      setPhaseIndex(null);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!jobId) {
      onClose();
      return;
    }
    await window.himmelcad?.jobs.cancel(jobId);
  };

  return (
    <section className={styles.island} aria-label="PhotoLab product import">
      <header className={styles.header} data-task-drag-handle>
        <div>
          <strong>PhotoLab product dataset</strong>
          <span>Import an immutable published product</span>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => void cancel()}
          disabled={jobId !== null}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className={styles.body}>
        <div className={styles.pathRow}>
          <input
            aria-label="PhotoLab source"
            readOnly
            value={sourcePath}
            placeholder="Choose a PhotoLab project or package directory"
          />
          <Button
            size="small"
            variant="secondary"
            icon={<FolderOpen size={14} />}
            onClick={() => void choose()}
            disabled={jobId !== null}
          >
            Choose…
          </Button>
        </div>

        <div className={styles.tableFrame} aria-busy={catalogBusy}>
          <table>
            <thead>
              <tr>
                <th>Kind · product</th>
                <th>Producer</th>
                <th>Counts</th>
                <th>Size</th>
                <th>Readiness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const importable = row.readiness === 'ready' && row.packagePath !== null;
                const active = row.packagePath === selectedPackage;
                return (
                  <tr
                    key={`${row.productId}:${row.productVersionHash}`}
                    data-selected={active || undefined}
                    data-disabled={!importable || undefined}
                  >
                    <td>
                      <button
                        type="button"
                        disabled={!importable || jobId !== null}
                        onClick={() => setSelectedPackage(row.packagePath)}
                        aria-pressed={active}
                      >
                        <span className={styles.glyph} aria-hidden="true">
                          {productGlyph(row.productKind)}
                        </span>
                        <span>
                          <strong>{row.product}</strong>
                          <small>{row.datasetLabel}</small>
                        </span>
                      </button>
                    </td>
                    <td>{row.producer}</td>
                    <td>{formatCounts(row)}</td>
                    <td>{formatBytes(row.totalBytes)}</td>
                    <td>
                      <span className={row.readiness === 'ready' ? styles.ready : styles.notReady}>
                        {row.readiness === 'ready' ? 'Ready' : 'Not ready'}
                      </span>
                      <small className={styles.reason}>{row.reason}</small>
                    </td>
                  </tr>
                );
              })}
              {!catalogBusy && rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    Choose a PhotoLab project or package directory.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <p className={styles.explanation}>
          Import copies the verified immutable package bytes into this project’s content-addressed
          dataset store.
        </p>
        {phaseIndex !== null ? (
          <div className={styles.progressRow} aria-live="polite">
            <div>
              <span>{PHASES[phaseIndex]}</span>
              <small>
                {phaseIndex + 1} / {PHASES.length}
              </small>
            </div>
            <ProgressBar
              value={(phaseIndex + 0.25) / PHASES.length}
              ariaLabel="PhotoLab product import progress"
            />
          </div>
        ) : null}
        {catalogError ? (
          <p className={styles.error} role="alert">
            {catalogError}
          </p>
        ) : null}
        {result ? (
          <p className={styles.result} role="status">
            {result}
          </p>
        ) : null}
      </div>

      <footer className={styles.footer}>
        <Button variant="secondary" onClick={() => void cancel()}>
          {jobId ? 'Cancel job' : 'Cancel'}
        </Button>
        <Button
          variant="primary"
          loading={jobId !== null}
          loadingLabel="Importing"
          disabled={!selected}
          onClick={() => void importSelected()}
        >
          Import
        </Button>
      </footer>
    </section>
  );
}

async function loadCatalog(
  path: string,
  api: NonNullable<Window['himmelcad']>,
  active: boolean,
  setSourcePath: (value: string) => void,
  setRows: (value: readonly ProductImportRow[]) => void,
  setSelected: (value: string | null) => void,
  setError: (value: string | null) => void,
  setBusy: (value: boolean) => void,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    const catalog = await api.productImport.list(path);
    if (!active) return;
    setSourcePath(catalog.sourcePath);
    setRows(catalog.rows);
    setSelected(catalog.rows.find((row) => row.readiness === 'ready')?.packagePath ?? null);
  } catch (error) {
    if (active) setError(error instanceof Error ? error.message : String(error));
  } finally {
    if (active) setBusy(false);
  }
}

function productGlyph(kind: string): string {
  if (kind === 'dem') return '⌁';
  if (kind === 'mesh') return '◇';
  if (kind === 'gaussianSplat') return '✣';
  if (kind === 'orthomosaic') return '▧';
  return '✦';
}

function formatCounts(row: ProductImportRow): string {
  if (row.objectCount === null || row.artifactCount === null) return '—';
  return `${row.objectCount.toLocaleString()} obj · ${row.artifactCount.toLocaleString()} files`;
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000).toFixed(0)} kB`;
}
