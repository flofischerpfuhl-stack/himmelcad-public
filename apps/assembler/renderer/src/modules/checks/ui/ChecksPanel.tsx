/**
 * Checks panel (assembler/CHECKS.md): the document's stored requirements
 * with their state — pass, fail, error, out of date, off — re-evaluated in
 * the background after every rebuild. Click a check to locate it (select
 * and frame what it points at, closest points drawn); edit its range, label
 * or on/off; delete it; add one from the selection (+) or from a
 * measurement (Measure › Add as check). Every edit is one undo step.
 *
 * Passive by design: results only change this list and the badge — no
 * toast, dialog or focus change, whatever fails.
 */
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Checkbox, Spinner, Tooltip } from '@himmelcad/ui';

import {
  addStoredCheck,
  CheckEditError,
  checkDisplayName,
  checkKind,
  checkKinds,
  commitStoredChecks,
  formatCheckValue,
  patchedStoredCheck,
  summarizeResults,
  type CheckField,
  type CheckKindDefinition,
  type CheckResult,
} from '../../../foundation/commands/checks.js';
import { useAssemblerStore, type AssemblerState } from '../../../foundation/commands/store.js';
import type { StoredCheck } from '../../../foundation/document/checks.js';
import { evaluateExpression } from '../../../platform/widgets/expression.js';
import panelStyles from '../../../platform/widgets/Panel.module.css';
import type { PanelProps } from '../../../platform/widgets/moduleUi.js';
import { useCheckResults } from '../checksStore.js';
import { focusCheck } from '../locate.js';
import { bodyNamer, cancelChecks, resultsStale, runChecksNow } from '../runner.js';
import styles from './ChecksPanel.module.css';

type RowState = CheckResult['state'] | 'pending';

function StatusIcon({ state, stale }: { state: RowState; stale: boolean }): JSX.Element {
  const muted = stale ? styles.muted : '';
  switch (state) {
    case 'pass':
      return <CircleCheck size={13} className={`${styles.icon} ${muted || styles.pass}`} />;
    case 'fail':
      return <CircleX size={13} className={`${styles.icon} ${muted || styles.fail}`} />;
    case 'error':
      return <TriangleAlert size={13} className={`${styles.icon} ${muted || styles.error}`} />;
    case 'unsupported':
      return <CircleHelp size={13} className={`${styles.icon} ${styles.muted}`} />;
    case 'disabled':
      return <CircleMinus size={13} className={`${styles.icon} ${styles.muted}`} />;
    case 'pending':
      return <CircleDashed size={13} className={`${styles.icon} ${styles.muted}`} />;
  }
}

const STATE_TEXT: Record<RowState, string> = {
  pass: 'Passes',
  fail: 'Fails',
  error: 'Could not be evaluated',
  unsupported: 'Unknown check kind',
  disabled: 'Off',
  pending: 'Not evaluated yet',
};

/** A number field that may be empty (an open range bound). */
function NumberField({
  field,
  text,
  onChange,
}: {
  field: CheckField;
  text: string;
  onChange: (text: string) => void;
}): JSX.Element {
  const unit = field.unit === 'deg' ? '°' : field.unit;
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>
        {field.label}
        {field.optional ? '' : ' *'}
      </span>
      <span className={styles.fieldWrap}>
        <input
          className={styles.fieldInput}
          inputMode="decimal"
          data-hc-keypad="expression"
          data-hc-keypad-units={unit || undefined}
          aria-label={field.label}
          placeholder={field.optional ? 'none' : ''}
          value={text}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
        {unit ? <span className={styles.fieldUnit}>{unit}</span> : null}
      </span>
    </label>
  );
}

function fieldText(params: Record<string, unknown>, field: CheckField): string {
  const value = params[field.key];
  return typeof value === 'number' ? String(Number(value.toFixed(6))) : '';
}

/** The fields' texts applied to `params`; a problem text instead when one does not parse. */
function applyFields(
  params: Record<string, unknown>,
  fields: readonly CheckField[],
  texts: Record<string, string>,
): Record<string, unknown> | string {
  const out: Record<string, unknown> = { ...params };
  for (const field of fields) {
    const text = (texts[field.key] ?? '').trim();
    if (text === '') {
      if (!field.optional) return `${field.label}: enter a value.`;
      delete out[field.key];
      continue;
    }
    const value = evaluateExpression(text.replace(',', '.'));
    if (value === null || !Number.isFinite(value)) return `${field.label}: not a number.`;
    if (field.min !== undefined && value < field.min) {
      return `${field.label}: at least ${field.min}.`;
    }
    out[field.key] = field.integer ? Math.round(value) : value;
  }
  return out;
}

function editMessage(error: unknown): string {
  return error instanceof CheckEditError || error instanceof Error
    ? error.message.replace(/^params(\.\w+)?: /, '')
    : String(error);
}

/** Editor of a stored check (range, label, on/off) or of a new one (`kind` + `params`). */
function CheckEditor({
  check,
  kind,
  params,
  onDone,
}: {
  check: StoredCheck | null;
  kind: CheckKindDefinition;
  params: Record<string, unknown>;
  onDone: () => void;
}): JSX.Element {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(kind.fields.map((f) => [f.key, fieldText(params, f)])),
  );
  const [name, setName] = useState(check?.name ?? '');
  const [enabled, setEnabled] = useState(check?.enabled !== false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    const next = applyFields(params, kind.fields, texts);
    if (typeof next === 'string') {
      setProblem(next);
      return;
    }
    try {
      if (check) {
        const patched = patchedStoredCheck(check, {
          params: next,
          name: name.trim() === '' ? null : name.trim(),
          enabled,
        });
        // Read at save time, so a concurrent edit (an agent, undo) is not lost.
        const checks = useAssemblerStore.getState().checks;
        commitStoredChecks(checks.map((c) => (c.id === check.id ? patched : c)));
      } else {
        addStoredCheck(kind.kind, next, {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(enabled ? {} : { enabled: false }),
        });
      }
      onDone();
    } catch (error) {
      setProblem(editMessage(error));
    }
  };

  return (
    <div
      className={styles.editor}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <span className={styles.editorTitle}>
        {check ? 'Edit check' : 'New check'} · {kind.label}
      </span>
      {kind.fields.length > 0 ? (
        <div className={styles.fields}>
          {kind.fields.map((field) => (
            <NumberField
              key={field.key}
              field={field}
              text={texts[field.key] ?? ''}
              onChange={(text) => setTexts({ ...texts, [field.key]: text })}
            />
          ))}
        </div>
      ) : null}
      <input
        className={styles.nameInput}
        aria-label="Check label"
        placeholder="Label (optional)"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <Checkbox
        label="Evaluate after every change"
        checked={enabled}
        onChange={(e) => setEnabled(e.currentTarget.checked)}
      />
      {problem ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
      <div className={styles.buttons}>
        <Button size="small" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button size="small" variant="primary" onClick={save}>
          {check ? 'Save' : 'Add check'}
        </Button>
      </div>
    </div>
  );
}

/** The kinds to add from, with what the selection gives each (or why it does not fit). */
function KindPicker({
  state,
  onPick,
  onCancel,
}: {
  state: AssemblerState;
  onPick: (kind: CheckKindDefinition, params: Record<string, unknown>) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className={styles.editor}>
      <span className={styles.editorTitle}>Add a check</span>
      <span className={styles.hint}>
        Uses the current selection where a kind needs items (select two bodies for a clearance).
      </span>
      <div className={styles.kinds} role="list">
        {checkKinds().map((kind) => {
          const params = kind.fromSelection
            ? kind.fromSelection(state.selection, state.evaluation)
            : {};
          const reason = typeof params === 'string' ? params : null;
          return (
            <button
              key={kind.kind}
              type="button"
              role="listitem"
              className={styles.kindButton}
              aria-disabled={reason !== null}
              onClick={() => {
                if (typeof params !== 'string') onPick(kind, params);
              }}
            >
              <span className={`${styles.kindLabel} ${reason ? styles.muted : ''}`}>
                {kind.label}
              </span>
              <span className={styles.kindReason}>{reason ?? kind.hint}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.buttons}>
        <Button size="small" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CheckRow({
  check,
  result,
  stale,
  focused,
  bodyName,
}: {
  check: StoredCheck;
  result: CheckResult | undefined;
  stale: boolean;
  focused: boolean;
  bodyName: (id: string) => string;
}): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state: RowState = check.enabled === false ? 'disabled' : result ? result.state : 'pending';
  const name = checkDisplayName(check, bodyName);
  const message = result?.outcome?.message;
  const value =
    result?.outcome?.value !== undefined &&
    result.outcome.value !== null &&
    result.outcome.unit !== undefined
      ? formatCheckValue(result.outcome.value, result.outcome.unit)
      : null;
  return (
    <div className={`${styles.row} ${focused ? styles.rowFocused : ''}`}>
      <button
        type="button"
        className={styles.rowMain}
        aria-pressed={focused}
        title={`${STATE_TEXT[state]}${stale && state !== 'disabled' ? ' (out of date)' : ''}${value ? ` · ${value}` : ''}`}
        onClick={() => focusCheck(focused || !result ? null : result)}
      >
        <StatusIcon state={state} stale={stale && state !== 'disabled'} />
        <span className={styles.text}>
          <span className={`${styles.name} ${state === 'disabled' ? styles.disabledName : ''}`}>
            {name}
          </span>
          {message && state !== 'disabled' ? (
            <span className={styles.message}>
              {message}
              {stale ? ' · out of date' : ''}
            </span>
          ) : null}
        </span>
      </button>
      <span className={styles.actions}>
        <Tooltip content="Edit check">
          <button
            type="button"
            className={styles.action}
            aria-label={`Edit ${name}`}
            onClick={() => useCheckResults.setState({ editingId: check.id, draft: null })}
          >
            <Pencil size={12} />
          </button>
        </Tooltip>
        <Tooltip content={confirmDelete ? 'Click again to delete' : 'Delete check'}>
          <button
            type="button"
            className={`${styles.action} ${styles.danger}`}
            aria-label={confirmDelete ? `Confirm deleting ${name}` : `Delete ${name}`}
            onBlur={() => setConfirmDelete(false)}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              try {
                commitStoredChecks(
                  useAssemblerStore.getState().checks.filter((c) => c.id !== check.id),
                );
              } catch {
                setConfirmDelete(false);
              }
            }}
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

export function ChecksPanel({ state }: PanelProps): JSX.Element {
  const results = useCheckResults((s) => s.results);
  const running = useCheckResults((s) => s.running);
  const progress = useCheckResults((s) => s.progress);
  const focusedId = useCheckResults((s) => s.focusedId);
  const editingId = useCheckResults((s) => s.editingId);
  const draft = useCheckResults((s) => s.draft);
  const stale = resultsStale();
  const bodyName = bodyNamer(state.evaluation);
  const checks = state.checks;
  const current = checks.map((c) => results[c.id]).filter((r): r is CheckResult => r !== undefined);
  const summary = summarizeResults(current);
  const enabled = checks.filter((c) => c.enabled !== false).length;
  const editing = editingId && editingId !== 'new' ? checks.find((c) => c.id === editingId) : null;
  const editingKind = editing ? checkKind(editing.kind) : draft ? checkKind(draft.kind) : null;

  // A deleted (or undone) check closes its editor.
  useEffect(() => {
    if (editingId && editingId !== 'new' && !checks.some((c) => c.id === editingId)) {
      useCheckResults.setState({ editingId: null });
    }
  }, [checks, editingId]);

  const closeEditor = () => useCheckResults.setState({ editingId: null, draft: null });
  const statusText = running
    ? `Checking${progress ? ` ${progress.done}/${progress.total}` : ''}…`
    : checks.length === 0
      ? ''
      : stale
        ? 'Out of date'
        : `${summary.passed}/${enabled} pass`;

  return (
    <div className={`${panelStyles.root} ${styles.placement}`} role="region" aria-label="Checks">
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>Checks</span>
        <span className={styles.status} aria-live="polite">
          {statusText}
        </span>
        {running ? <Spinner size="small" /> : null}
        <span className={panelStyles.headerSpacer} />
        <Tooltip content="Add a check">
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="Add a check"
            onClick={() => useCheckResults.setState({ editingId: 'new', draft: null })}
          >
            <Plus size={14} />
          </button>
        </Tooltip>
        {running ? (
          <Tooltip content="Stop checking (results stay out of date)">
            <button
              type="button"
              className={panelStyles.headerButton}
              aria-label="Stop checking"
              onClick={() => cancelChecks()}
            >
              <Square size={11} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content="Run checks now">
            <button
              type="button"
              className={panelStyles.headerButton}
              aria-label="Run checks now"
              disabled={checks.length === 0}
              onClick={() => void runChecksNow()}
            >
              <RefreshCw size={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Close Checks">
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="Close Checks"
            onClick={() => {
              focusCheck(null);
              state.setChecksPanelOpen(false);
            }}
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={panelStyles.body}>
        {editingId === 'new' && !draft ? (
          <KindPicker
            state={state}
            onCancel={closeEditor}
            onPick={(kind, params) =>
              useCheckResults.setState({ draft: { kind: kind.kind, params } })
            }
          />
        ) : null}
        {editingId === 'new' && draft && editingKind ? (
          <CheckEditor
            key={`new-${draft.kind}`}
            check={null}
            kind={editingKind}
            params={draft.params}
            onDone={closeEditor}
          />
        ) : null}
        {checks.length === 0 && editingId !== 'new' ? (
          <div className={panelStyles.empty}>
            No checks. A check is a requirement the model keeps, e.g. a minimum clearance between
            lid and base — add one with +, or from a value in Measure.
          </div>
        ) : null}
        {checks.map((check) =>
          editing?.id === check.id && editingKind ? (
            <CheckEditor
              key={check.id}
              check={check}
              kind={editingKind}
              params={check.params}
              onDone={closeEditor}
            />
          ) : (
            <CheckRow
              key={check.id}
              check={check}
              result={results[check.id]}
              stale={stale}
              focused={focusedId === check.id}
              bodyName={bodyName}
            />
          ),
        )}
        {editing && !editingKind ? (
          <div className={styles.problem}>This app cannot edit a check of this kind.</div>
        ) : null}
      </div>
    </div>
  );
}
