/**
 * Parameters ("variables") panel (Shapr3D-like): named values usable from
 * any sketch dimension expression or extrude/fillet/chamfer/shell size field
 * (`ParamExpressionField`, `model/parameters.ts`). Add, rename (cascades to
 * every expression that names it), edit the value/expression, change the
 * unit, and delete (refused with the list of users when still referenced).
 * Every edit is one undo step (`model/store.ts` `editParameter`): changing a
 * value re-solves every sketch whose dimensions use it and re-evaluates the
 * features that depend on it; an edit a sketch cannot satisfy is refused as
 * a whole and the reason shown. Value fields complete parameter names
 * (`ExpressionSuggestInput`).
 *
 * Block 9: a parameter may have a range (min/max, numbers or formulas) and a
 * slider step, edited under the row (the range button). With both bounds a
 * compact slider sits under the value field — the field stays primary. A
 * drag previews live (`previewParameterValue`: planned like an edit,
 * evaluated incrementally on the kernel's preview channel) and commits on
 * release as one undo step; Esc during the drag drops it. A typed value
 * outside the range is refused with the reason, never clamped. "Test range"
 * (header) rebuilds the model over the ranges without changing it
 * (`TestRangeSection`).
 */
import { AlertTriangle, FlaskConical, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { consumeEscapeBlurCommitSuppression, Select, Slider, Tooltip } from '@himmelcad/ui';

import {
  describeParameterRange,
  parameterRangeViolation,
  resolveParameterRanges,
  resolveParameterValues,
  type Parameter,
  type ParameterRange,
  type ParameterUnit,
} from '../../../foundation/document/parameters.js';
import type { AssemblerState } from '../../../foundation/commands/store.js';
import { parameterCandidates } from '../../../platform/widgets/expressionSuggest.js';
import { ExpressionSuggestInput } from '../../../platform/widgets/ExpressionSuggestInput.js';
import panelStyles from '../../../platform/widgets/Panel.module.css';
import styles from './ParametersPanel.module.css';
import { TestRangeSection } from './TestRangeSection.js';

const UNIT_OPTIONS: { value: ParameterUnit; label: string }[] = [
  { value: 'mm', label: 'mm' },
  { value: 'deg', label: '°' },
  { value: '', label: '—' },
];

export interface ParametersPanelProps {
  state: AssemblerState;
}

export function ParametersPanel({ state }: ParametersPanelProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = resolveParameterValues(state.parameters);
  const values = resolved.ok ? resolved.values : new Map<string, number>();
  const ranges = resolved.ok ? resolveParameterRanges(state.parameters, values) : null;
  const rangeOf = (p: Parameter): ParameterRange =>
    ranges?.ok
      ? (ranges.ranges.get(p.id) ?? {})
      : {
          ...(p.min !== undefined ? { min: p.min } : {}),
          ...(p.max !== undefined ? { max: p.max } : {}),
          ...(p.step !== undefined ? { step: p.step } : {}),
        };
  const testOpen = testing || state.parameterSweep !== null;

  return (
    <div
      className={`${panelStyles.root} ${panelStyles.parametersPlacement}`}
      aria-label="Parameters panel"
    >
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>Parameters</span>
        <span className={panelStyles.count}>{state.parameters.length}</span>
        <span className={panelStyles.headerSpacer} />
        <Tooltip content={testOpen ? 'Close Test range' : 'Test range: rebuild over the ranges'}>
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="Test range"
            aria-pressed={testOpen}
            data-active={testOpen ? 'true' : undefined}
            onClick={() => {
              if (testOpen) {
                state.clearParameterSweep();
                setTesting(false);
              } else setTesting(true);
            }}
          >
            <FlaskConical size={14} />
          </button>
        </Tooltip>
        <Tooltip content="Add parameter">
          <button
            type="button"
            className={panelStyles.headerButton}
            aria-label="Add parameter"
            onClick={() => setAdding(true)}
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={panelStyles.body}>
        {state.parameters.length === 0 && !adding ? (
          <div className={panelStyles.empty}>
            No parameters yet. Add one to reuse a value across dimensions and features.
          </div>
        ) : null}
        {!resolved.ok ? (
          <div className={styles.docError}>
            <AlertTriangle size={12} />
            {resolved.message}
          </div>
        ) : null}
        {ranges && !ranges.ok ? (
          <div className={styles.docError}>
            <AlertTriangle size={12} />
            {ranges.message}
          </div>
        ) : null}
        {state.parameters.map((p) => (
          <ParameterRow
            key={p.id}
            parameter={p}
            resolvedValue={values.get(p.name) ?? p.value}
            range={rangeOf(p)}
            state={state}
            onError={setError}
          />
        ))}
        {adding ? (
          <NewParameterRow
            parameters={state.parameters}
            onCancel={() => setAdding(false)}
            onCreate={async (input) => {
              const outcome = await state.upsertParameter(input);
              if (outcome.ok) {
                setAdding(false);
                setError(null);
              } else setError(outcome.message);
            }}
          />
        ) : null}
        {error ? (
          <div className={styles.rowError} role="alert">
            <AlertTriangle size={12} />
            {error}
          </div>
        ) : null}
        {testOpen ? (
          <TestRangeSection
            state={state}
            rangeOf={rangeOf}
            onClose={() => {
              state.clearParameterSweep();
              setTesting(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Decimals that show a value at `step` resolution (at most 4). */
function decimalsOf(step: number): number {
  if (!(step > 0)) return 3;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

/** The slider increment: the parameter's step, else about 1/100 of the range on a 1-2-5 scale. */
export function sliderStep(range: ParameterRange): number {
  if (range.step !== undefined && range.step > 0) return range.step;
  const span = (range.max ?? 0) - (range.min ?? 0);
  if (!(span > 0)) return 1;
  const raw = span / 100;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 2 ? 1 : unit < 5 ? 2 : 5) * power;
}

/** A slider value on the step grid from `min`, within the range. */
export function snapToStep(
  value: number,
  range: Required<Pick<ParameterRange, 'min' | 'max'>>,
  step: number,
): number {
  const snapped = range.min + Math.round((value - range.min) / step) * step;
  const clamped = Math.min(range.max, Math.max(range.min, snapped));
  return Math.round(clamped * 1e9) / 1e9;
}

function formulaOrValue(p: Parameter, field: 'min' | 'max' | 'step'): string {
  const formula = p[`${field}Expression`];
  if (formula !== undefined) return formula;
  const value = p[field];
  return value === undefined ? '' : String(value);
}

function ParameterRow({
  parameter,
  resolvedValue,
  range,
  state,
  onError,
}: {
  parameter: Parameter;
  resolvedValue: number;
  range: ParameterRange;
  state: AssemblerState;
  onError: (message: string | null) => void;
}): JSX.Element {
  const nameId = useId();
  const [nameDraft, setNameDraft] = useState(parameter.name);
  const [valueDraft, setValueDraft] = useState(parameter.expression ?? String(parameter.value));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [valueFocused, setValueFocused] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const dragging = useRef(false);
  const slider = state.parameterSlider?.parameterId === parameter.id ? state.parameterSlider : null;

  // Keeps the drafts in sync with committed changes from elsewhere (undo/redo,
  // the agent API, a rename cascade touching this same parameter) as long as
  // the field is not being edited right now.
  useEffect(() => {
    if (!nameFocused) setNameDraft(parameter.name);
  }, [parameter.name, nameFocused]);
  useEffect(() => {
    if (!valueFocused) setValueDraft(parameter.expression ?? String(parameter.value));
  }, [parameter.value, parameter.expression, valueFocused]);

  const commitName = async (): Promise<void> => {
    const trimmed = nameDraft.trim();
    if (trimmed === parameter.name || trimmed === '') {
      setNameDraft(parameter.name);
      return;
    }
    const outcome = await state.renameParameter(parameter.id, trimmed);
    if (!outcome.ok) {
      onError(outcome.message);
      setNameDraft(parameter.name);
    } else {
      onError(null);
    }
  };

  const commitValue = async (): Promise<void> => {
    const text = valueDraft.trim();
    if (text === '' || text === (parameter.expression ?? String(parameter.value))) {
      setValueDraft(parameter.expression ?? String(parameter.value));
      return;
    }
    const isPlain = /^-?\d+(\.\d+)?$/.test(text.replace(',', '.'));
    const outcome = await state.upsertParameter({
      id: parameter.id,
      name: parameter.name,
      unit: parameter.unit,
      ...(isPlain ? { value: Number(text.replace(',', '.')) } : { expression: text }),
    });
    if (!outcome.ok) {
      onError(outcome.message);
      setValueDraft(parameter.expression ?? String(parameter.value));
    } else {
      onError(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    const outcome = await state.deleteParameter(parameter.id);
    if (!outcome.ok) {
      const list = (outcome.usages ?? []).map((u) => `${u.featureName} (${u.field})`).join(', ');
      onError(`"${parameter.name}" is used by ${list || 'other fields'}.`);
      setConfirmDelete(false);
    } else {
      onError(null);
    }
  };

  const hasSlider =
    range.min !== undefined &&
    range.max !== undefined &&
    range.max > range.min &&
    parameter.expression === undefined;
  const step = sliderStep(range);
  const decimals = decimalsOf(step);
  const outOfRange = parameterRangeViolation(parameter, resolvedValue, range);
  const shownValue = slider ? slider.value.toFixed(decimals).replace(/\.?0+$/, '') : valueDraft;
  const rangeText = describeParameterRange(range, parameter.unit);

  const endDrag = (commit: boolean): void => {
    if (!dragging.current) return;
    dragging.current = false;
    void state.endParameterPreview(commit).then((outcome) => {
      if (outcome && !outcome.ok) onError(outcome.message);
      else if (outcome) onError(null);
    });
  };

  return (
    <div className={styles.parameter} data-parameter={parameter.name}>
      <div className={styles.row}>
        <input
          className={styles.nameInput}
          aria-label={`Parameter name (${parameter.name})`}
          value={nameDraft}
          title={parameter.expression ? `${parameter.name} = ${parameter.expression}` : undefined}
          onFocus={() => setNameFocused(true)}
          onChange={(event) => setNameDraft(event.currentTarget.value)}
          onBlur={(event) => {
            setNameFocused(false);
            if (consumeEscapeBlurCommitSuppression(event.currentTarget)) return;
            void commitName();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setNameDraft(parameter.name);
          }}
        />
        <ExpressionSuggestInput
          id={nameId}
          className={styles.valueInput}
          aria-label={`${parameter.name} value or expression`}
          aria-invalid={outOfRange ? true : undefined}
          data-out-of-range={outOfRange ? 'true' : undefined}
          value={shownValue}
          suggestions={parameterCandidates(state.parameters, parameter.name)}
          title={
            outOfRange ??
            (parameter.expression
              ? `${parameter.expression} = ${resolvedValue}`
              : rangeText
                ? `${resolvedValue} (range ${rangeText})`
                : String(resolvedValue))
          }
          onFocus={() => setValueFocused(true)}
          onValueChange={setValueDraft}
          onBlur={(event) => {
            setValueFocused(false);
            if (consumeEscapeBlurCommitSuppression(event.currentTarget)) return;
            void commitValue();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape')
              setValueDraft(parameter.expression ?? String(parameter.value));
          }}
        />
        <Select
          wrapClassName={styles.unitSelect}
          aria-label={`${parameter.name} unit`}
          value={parameter.unit}
          options={UNIT_OPTIONS}
          onChange={(event) =>
            void state.upsertParameter({
              id: parameter.id,
              name: parameter.name,
              unit: event.currentTarget.value as ParameterUnit,
              value: parameter.value,
              ...(parameter.expression !== undefined ? { expression: parameter.expression } : {}),
            })
          }
        />
        <Tooltip content={rangeText ? `Range ${rangeText}` : 'Range and slider'}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`${parameter.name} range`}
            aria-expanded={rangeOpen}
            data-active={rangeText ? 'true' : undefined}
            onClick={() => setRangeOpen((open) => !open)}
          >
            <SlidersHorizontal size={13} />
          </button>
        </Tooltip>
        <Tooltip content={confirmDelete ? 'Click again to confirm' : 'Delete parameter'}>
          <button
            type="button"
            className={styles.deleteButton}
            aria-label={`Delete ${parameter.name}`}
            onClick={() => {
              if (confirmDelete) void handleDelete();
              else setConfirmDelete(true);
            }}
            onBlur={() => setConfirmDelete(false)}
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
      {outOfRange ? (
        <div className={styles.rowWarning}>
          <AlertTriangle size={11} />
          {outOfRange}
        </div>
      ) : null}
      {hasSlider ? (
        <div className={styles.sliderRow}>
          <span className={styles.bound}>{trimNumber(range.min!)}</span>
          <Slider
            className={styles.slider}
            aria-label={`${parameter.name} slider`}
            min={range.min}
            max={range.max}
            step={step}
            value={Math.min(range.max!, Math.max(range.min!, slider?.value ?? resolvedValue))}
            valueText={`${shownValue}${parameter.unit === 'deg' ? '°' : parameter.unit ? ` ${parameter.unit}` : ''}`}
            data-pending={slider?.pending ? 'true' : undefined}
            onPointerDown={() => {
              dragging.current = true;
              // The release may happen anywhere (the pointer left the slider while dragging).
              const up = (): void => {
                window.removeEventListener('pointercancel', cancel);
                endDrag(true);
              };
              const cancel = (): void => {
                window.removeEventListener('pointerup', up);
                endDrag(false);
              };
              window.addEventListener('pointerup', up, { once: true });
              window.addEventListener('pointercancel', cancel, { once: true });
            }}
            onValueChange={(next) => {
              const value = snapToStep(next, { min: range.min!, max: range.max! }, step);
              // Keyboard steps commit on key release; a drag previews until release.
              if (!dragging.current) dragging.current = true;
              state.previewParameterValue(parameter.id, value);
            }}
            onKeyUp={(event) => {
              if (
                event.key.startsWith('Arrow') ||
                ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
              ) {
                endDrag(true);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && dragging.current) {
                event.preventDefault();
                endDrag(false);
              }
            }}
            onBlur={() => endDrag(true)}
          />
          <span className={styles.bound}>{trimNumber(range.max!)}</span>
        </div>
      ) : null}
      {slider?.error ? (
        <div className={styles.rowWarning} role="status">
          <AlertTriangle size={11} />
          {slider.error}
        </div>
      ) : null}
      {rangeOpen ? <RangeEditor parameter={parameter} state={state} onError={onError} /> : null}
    </div>
  );
}

function trimNumber(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

/** Min, max and step of one parameter: numbers, formulas or text with a unit; empty removes. */
function RangeEditor({
  parameter,
  state,
  onError,
}: {
  parameter: Parameter;
  state: AssemblerState;
  onError: (message: string | null) => void;
}): JSX.Element {
  const fields = ['min', 'max', 'step'] as const;
  const [drafts, setDrafts] = useState(
    () =>
      Object.fromEntries(fields.map((f) => [f, formulaOrValue(parameter, f)])) as Record<
        (typeof fields)[number],
        string
      >,
  );
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (focused) return;
    setDrafts(
      Object.fromEntries(fields.map((f) => [f, formulaOrValue(parameter, f)])) as Record<
        (typeof fields)[number],
        string
      >,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parameter, focused]);

  const commit = async (field: (typeof fields)[number]): Promise<void> => {
    const text = drafts[field].trim();
    if (text === formulaOrValue(parameter, field)) return;
    const outcome = await state.upsertParameter({
      id: parameter.id,
      name: parameter.name,
      unit: parameter.unit,
      [field]: text === '' ? null : text,
    });
    if (!outcome.ok) {
      onError(outcome.message);
      setDrafts((d) => ({ ...d, [field]: formulaOrValue(parameter, field) }));
    } else onError(null);
  };

  return (
    <div className={styles.rangeEditor} role="group" aria-label={`${parameter.name} range`}>
      {fields.map((field) => (
        <label key={field} className={styles.rangeField}>
          <span>{field === 'min' ? 'Min' : field === 'max' ? 'Max' : 'Step'}</span>
          <ExpressionSuggestInput
            className={styles.valueInput}
            aria-label={`${parameter.name} ${field}`}
            placeholder={field === 'step' ? 'auto' : 'none'}
            value={drafts[field]}
            suggestions={parameterCandidates(state.parameters, parameter.name)}
            onFocus={() => setFocused(field)}
            onValueChange={(text) => setDrafts((d) => ({ ...d, [field]: text }))}
            onBlur={(event) => {
              setFocused(null);
              if (consumeEscapeBlurCommitSuppression(event.currentTarget)) return;
              void commit(field);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDrafts((d) => ({ ...d, [field]: formulaOrValue(parameter, field) }));
              }
            }}
          />
        </label>
      ))}
    </div>
  );
}

function NewParameterRow({
  parameters,
  onCreate,
  onCancel,
}: {
  parameters: readonly Parameter[];
  onCreate: (input: {
    name: string;
    unit: ParameterUnit;
    value?: number;
    expression?: string;
  }) => void | Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const existingNames = parameters.map((p) => p.name);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<ParameterUnit>('mm');
  const [value, setValue] = useState('1');

  const create = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    const text = value.trim();
    const isPlain = /^-?\d+(\.\d+)?$/.test(text.replace(',', '.'));
    void onCreate({
      name: trimmed,
      unit,
      ...(isPlain ? { value: Number(text.replace(',', '.')) || 0 } : { expression: text }),
    });
  };

  return (
    <div className={styles.row}>
      <input
        className={styles.nameInput}
        aria-label="New parameter name"
        placeholder="name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') create();
          if (event.key === 'Escape') onCancel();
        }}
      />
      <ExpressionSuggestInput
        className={styles.valueInput}
        aria-label="New parameter value"
        value={value}
        suggestions={parameterCandidates(parameters)}
        onValueChange={setValue}
        onKeyDown={(event) => {
          if (event.key === 'Enter') create();
          if (event.key === 'Escape') onCancel();
        }}
      />
      <Select
        wrapClassName={styles.unitSelect}
        aria-label="New parameter unit"
        value={unit}
        options={UNIT_OPTIONS}
        onChange={(event) => setUnit(event.currentTarget.value as ParameterUnit)}
      />
      <button type="button" className={styles.deleteButton} aria-label="Add" onClick={create}>
        <Plus size={13} />
      </button>
      {existingNames.includes(name.trim()) ? (
        <span className={styles.rowError} role="alert">
          Name already used
        </span>
      ) : null}
    </div>
  );
}
