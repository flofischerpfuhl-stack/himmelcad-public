import { GripHorizontal, X } from 'lucide-react';

import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';
import { Select } from './Select.js';
import { Tooltip } from './Tooltip.js';
import styles from './ExportIsland.module.css';

export type ExportScope = 'selection' | 'visible' | 'project';

export interface ExportFormatChoice {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export interface ExportPlanRow {
  readonly entityKind: string;
  readonly count: number;
  readonly writtenAs: string;
  readonly lossNote: string | null;
  readonly lossCodes?: readonly string[];
}

export interface ExportRunningState {
  readonly phase: string;
  readonly fraction: number | null;
  readonly cancelling?: boolean;
}

export interface ExportIslandProps {
  readonly formats: readonly ExportFormatChoice[];
  readonly formatId: string;
  readonly scope: ExportScope;
  readonly selectionCount: number;
  readonly path: string;
  readonly planRows: readonly ExportPlanRow[] | null;
  readonly outputs?: readonly string[];
  readonly planning?: boolean;
  readonly running?: ExportRunningState | null;
  readonly error?: string | null;
  readonly onFormatChange: (formatId: string) => void;
  readonly onScopeChange: (scope: ExportScope) => void;
  readonly onChoosePath: () => void;
  readonly onPlan: () => void;
  readonly onExport: () => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}

export function ExportIsland({
  formats,
  formatId,
  scope,
  selectionCount,
  path,
  planRows,
  outputs = [],
  planning = false,
  running = null,
  error = null,
  onFormatChange,
  onScopeChange,
  onChoosePath,
  onPlan,
  onExport,
  onCancel,
  onClose,
}: ExportIslandProps): JSX.Element {
  const enabledFormats = formats.filter((format) => format.enabled);
  const noRepresentableFormat = formats.length > 0 && enabledFormats.length === 0;
  const lossless = planRows !== null && planRows.every((row) => row.lossNote === null);
  return (
    <section className={styles.island} aria-label="Export">
      <header className={styles.header} data-task-drag-handle>
        <div>
          <h2>Export</h2>
          <p>Review scope, output, and semantic loss before writing.</p>
        </div>
        <GripHorizontal size={16} aria-hidden />
        <button type="button" className={styles.close} aria-label="Close Export" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className={styles.body}>
        <label className={styles.field}>
          <span>Format</span>
          <Select
            aria-label="Export format"
            value={formatId}
            disabled={running !== null}
            options={formats.map((format) => ({
              value: format.id,
              label: format.label,
              disabled: !format.enabled,
              description: format.disabledReason,
            }))}
            onChange={(event) => onFormatChange(event.currentTarget.value)}
          />
        </label>

        {noRepresentableFormat ? (
          <p className={styles.empty}>
            The selection contains only point-cloud data; no installed export format can represent
            it.
          </p>
        ) : null}

        <fieldset className={styles.scope} disabled={running !== null}>
          <legend>Scope</legend>
          <div className={styles.segments}>
            {(
              [
                ['selection', `Selection${selectionCount > 0 ? ` (${selectionCount})` : ''}`],
                ['visible', 'Visible'],
                ['project', 'Project'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                disabled={value === 'selection' && selectionCount === 0}
                onClick={() => onScopeChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className={styles.field}>
          <span>Target</span>
          <div className={styles.pathRow}>
            <output title={path}>{path || 'Choose an output file…'}</output>
            <Button variant="secondary" size="small" disabled={running !== null} onClick={onChoosePath}>
              Choose…
            </Button>
          </div>
        </div>

        {planRows !== null ? (
          <section className={styles.plan} aria-label="Export plan">
            <div className={styles.planHeading}>
              <h3>Plan</h3>
              <span data-lossless={lossless ? 'true' : 'false'}>
                {lossless ? 'Lossless export' : 'Losses disclosed'}
              </span>
            </div>
            {outputs.length > 0 ? <p className={styles.outputs}>Writes {outputs.join(', ')}</p> : null}
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Entity kind</th>
                    <th>Count</th>
                    <th>Written as</th>
                    <th>Loss note</th>
                  </tr>
                </thead>
                <tbody>
                  {planRows.map((row) => (
                    <tr key={`${row.entityKind}:${row.writtenAs}`}>
                      <td>{row.entityKind}</td>
                      <td>{row.count.toLocaleString()}</td>
                      <td>{row.writtenAs}</td>
                      <td className={row.lossNote ? styles.loss : undefined}>
                        {row.lossNote ? (
                          <Tooltip content={(row.lossCodes ?? []).join('\n') || row.lossNote}>
                            <span tabIndex={0}>{row.lossNote}</span>
                          </Tooltip>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {running ? (
          <section className={styles.running} aria-live="polite">
            <div>
              <strong>{running.cancelling ? 'Cancelling…' : running.phase}</strong>
              <span>
                {running.fraction === null ? 'In progress' : `${Math.round(running.fraction * 100)}%`}
              </span>
            </div>
            <ProgressBar
              value={running.fraction ?? 0}
              indeterminate={running.fraction === null}
              ariaLabel="Export progress"
            />
          </section>
        ) : null}

        {error ? <p className={styles.error}>{error}</p> : null}
      </div>

      <footer className={styles.footer}>
        <Button
          variant="secondary"
          disabled={planning || running !== null || !formatId || !path || noRepresentableFormat}
          loading={planning}
          loadingLabel="Planning export"
          onClick={onPlan}
        >
          Plan
        </Button>
        <span className={styles.footerSpacer} />
        <Button
          variant="primary"
          disabled={planRows === null || running !== null}
          onClick={onExport}
        >
          Export
        </Button>
        <Button variant="secondary" onClick={running ? onCancel : onClose}>
          Cancel
        </Button>
      </footer>
    </section>
  );
}
