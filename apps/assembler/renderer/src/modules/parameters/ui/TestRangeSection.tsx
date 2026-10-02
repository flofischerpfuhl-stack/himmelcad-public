/**
 * "Test range" in the Parameters panel: choose parameters with a range, the
 * values (min / nominal / max, or N samples) and whether they vary one at a
 * time or in every combination; Run rebuilds the model at each sample
 * without changing it (`slice.ts` `runParameterSweep`, `sweep.ts`), with
 * progress and Cancel. The result is a compact table: one row per sample,
 * the swept values, and Rebuilt / the failing step and its reason, plus the
 * stored checks when a checks module is installed.
 */
import { AlertTriangle, Check, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button, Checkbox, ProgressBar, Select } from '@himmelcad/ui';

import type { AssemblerState } from '../../../foundation/commands/store.js';
import {
  describeParameterRange,
  type Parameter,
  type ParameterRange,
} from '../../../foundation/document/parameters.js';
import {
  MAX_SAMPLES_PER_PARAMETER,
  planSweep,
  type SweepSampleResult,
  type SweepSpec,
} from '../sweep.js';
import styles from './ParametersPanel.module.css';

const MODE_OPTIONS = [
  { value: 'range', label: 'Min · nominal · max' },
  { value: 'samples', label: 'Samples' },
];
const COMBINE_OPTIONS = [
  { value: 'each', label: 'One at a time' },
  { value: 'all', label: 'All combinations' },
];

function unitSuffix(unit: Parameter['unit']): string {
  return unit === 'deg' ? '°' : unit ? ` ${unit}` : '';
}

function short(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** One sample's result cell: what failed and why, or "Rebuilt". */
function outcomeText(sample: SweepSampleResult): string {
  if (sample.outcome === 'refused') {
    return sample.featureName
      ? `${sample.featureName}: ${sample.reason ?? ''}`
      : (sample.reason ?? '');
  }
  if (sample.outcome === 'failed') return sample.reason ?? 'The kernel failed';
  const first = sample.errors[0];
  if (first) {
    const more = sample.errors.length > 1 ? ` (+${sample.errors.length - 1})` : '';
    return `${first.featureName}: ${first.message}${more}`;
  }
  const failedChecks = (sample.checks ?? []).filter((c) => c.status !== 'pass');
  if (failedChecks.length > 0) {
    return failedChecks.map((c) => `${c.name}${c.message ? `: ${c.message}` : ''}`).join('; ');
  }
  return 'Rebuilt';
}

export function TestRangeSection({
  state,
  rangeOf,
  onClose,
}: {
  state: AssemblerState;
  rangeOf: (p: Parameter) => ParameterRange;
  onClose: () => void;
}): JSX.Element {
  const sweep = state.parameterSweep;
  const testable = state.parameters.filter((p) => {
    const r = rangeOf(p);
    return p.expression === undefined && r.min !== undefined && r.max !== undefined;
  });
  const [picked, setPicked] = useState<string[]>(() =>
    sweep ? sweep.spec.parameters.map((a) => a.parameter) : testable.slice(0, 1).map((p) => p.id),
  );
  const [mode, setMode] = useState<'range' | 'samples'>(sweep?.spec.mode ?? 'range');
  const [samples, setSamples] = useState(String(sweep?.spec.samples ?? 5));
  const [combine, setCombine] = useState<'each' | 'all'>(sweep?.spec.combine ?? 'each');
  const chosen = testable.filter((p) => picked.includes(p.id));

  const spec: SweepSpec = useMemo(
    () => ({
      parameters: chosen.map((p) => ({ parameter: p.id })),
      mode,
      ...(mode === 'samples' ? { samples: Number(samples) } : {}),
      combine,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked.join(','), mode, samples, combine, testable.length],
  );
  const plan = chosen.length > 0 ? planSweep(state.parameters, spec) : null;
  const running = sweep?.running ?? false;
  const report = sweep?.report ?? null;
  const rows = sweep?.samples ?? [];
  const axes = report?.axes ?? (plan?.ok ? plan.axes : []);

  return (
    <section className={styles.testRange} aria-label="Test range">
      <div className={styles.testHeader}>
        <span className={styles.testTitle}>Test range</span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close Test range"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </div>
      {testable.length === 0 ? (
        <div className={styles.testHint}>
          Give a parameter a min and max (the range button of its row) to test it.
        </div>
      ) : (
        <>
          <div className={styles.testPick} role="group" aria-label="Parameters to test">
            {testable.map((p) => (
              <Checkbox
                key={p.id}
                label={`${p.name} (${describeParameterRange(rangeOf(p), p.unit)})`}
                checked={picked.includes(p.id)}
                disabled={running}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setPicked((list) =>
                    on
                      ? [...list.filter((id) => id !== p.id), p.id]
                      : list.filter((id) => id !== p.id),
                  );
                }}
              />
            ))}
          </div>
          <div className={styles.testOptions}>
            <Select
              aria-label="Values"
              value={mode}
              options={MODE_OPTIONS}
              disabled={running}
              onChange={(event) => setMode(event.currentTarget.value as 'range' | 'samples')}
            />
            {mode === 'samples' ? (
              <input
                className={styles.samplesInput}
                aria-label="Samples per parameter"
                inputMode="numeric"
                data-hc-keypad="number"
                value={samples}
                disabled={running}
                onChange={(event) => setSamples(event.currentTarget.value)}
                title={`2 to ${MAX_SAMPLES_PER_PARAMETER}, min and max included`}
              />
            ) : null}
            {chosen.length > 1 ? (
              <Select
                aria-label="Combine"
                value={combine}
                options={COMBINE_OPTIONS}
                disabled={running}
                onChange={(event) => setCombine(event.currentTarget.value as 'each' | 'all')}
              />
            ) : null}
            {running ? (
              <Button size="small" onClick={() => state.cancelParameterSweep()}>
                Cancel
              </Button>
            ) : (
              <Button
                size="small"
                variant="primary"
                disabled={!plan?.ok}
                onClick={() => void state.runParameterSweep(spec)}
              >
                {plan?.ok ? `Run ${plan.samples.length}` : 'Run'}
              </Button>
            )}
          </div>
          {plan && !plan.ok && !running ? (
            <div className={styles.testHint} role="alert">
              <AlertTriangle size={11} /> {plan.message}
            </div>
          ) : null}
        </>
      )}
      {sweep?.error ? (
        <div className={styles.testHint} role="alert">
          <AlertTriangle size={11} /> {sweep.error}
        </div>
      ) : null}
      {running ? (
        <ProgressBar
          value={sweep && sweep.total > 0 ? sweep.done / sweep.total : 0}
          ariaLabel={`Testing ${sweep?.done ?? 0} of ${sweep?.total ?? 0}`}
        />
      ) : null}
      {report ? (
        <div className={styles.testSummary} role="status" data-sweep-summary>
          {report.cancelled ? 'Cancelled: ' : ''}
          {report.passed} of {report.total} passed
          {report.failed > 0 ? `, ${report.failed} failed` : ''}
          {report.checksAvailable ? '' : ' · checks not available'}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.testTableWrap}>
          <table className={styles.testTable} data-sweep-table>
            <thead>
              <tr>
                <th aria-label="Result" />
                {axes.map((a) => (
                  <th key={a.parameterId} scope="col">
                    {a.name}
                  </th>
                ))}
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((sample) => (
                <tr
                  key={sample.index}
                  data-ok={sample.ok ? 'true' : 'false'}
                  title={
                    sample.errors.map((e) => `${e.featureName}: ${e.message}`).join('\n') ||
                    undefined
                  }
                >
                  <td className={styles.testStatus}>
                    {sample.ok ? (
                      <Check size={12} aria-label="Passed" />
                    ) : (
                      <X size={12} aria-label="Failed" />
                    )}
                  </td>
                  {axes.map((a) => (
                    <td
                      key={a.parameterId}
                      data-nominal={sample.values[a.name] === a.nominal ? 'true' : undefined}
                    >
                      {short(sample.values[a.name] ?? a.nominal)}
                      {unitSuffix(a.unit)}
                    </td>
                  ))}
                  <td className={styles.testOutcome}>{outcomeText(sample)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
