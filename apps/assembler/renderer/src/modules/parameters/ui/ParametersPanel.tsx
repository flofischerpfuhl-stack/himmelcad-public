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
 */
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { consumeEscapeBlurCommitSuppression, Select, Tooltip } from '@himmelcad/ui';

import {
  resolveParameterValues,
  type Parameter,
  type ParameterUnit,
} from '../../../foundation/document/parameters.js';
import type { AssemblerState } from '../../../foundation/commands/store.js';
import { parameterCandidates } from '../../../platform/widgets/expressionSuggest.js';
import { ExpressionSuggestInput } from '../../../platform/widgets/ExpressionSuggestInput.js';
import panelStyles from '../../../platform/widgets/Panel.module.css';
import styles from './ParametersPanel.module.css';

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
  const [error, setError] = useState<string | null>(null);
  const resolved = resolveParameterValues(state.parameters);
  const values = resolved.ok ? resolved.values : new Map<string, number>();

  return (
    <div
      className={`${panelStyles.root} ${panelStyles.parametersPlacement}`}
      aria-label="Parameters panel"
    >
      <div className={panelStyles.header}>
        <span className={panelStyles.title}>Parameters</span>
        <span className={panelStyles.count}>{state.parameters.length}</span>
        <span className={panelStyles.headerSpacer} />
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
        {state.parameters.map((p) => (
          <ParameterRow
            key={p.id}
            parameter={p}
            resolvedValue={values.get(p.name) ?? p.value}
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
      </div>
    </div>
  );
}

function ParameterRow({
  parameter,
  resolvedValue,
  state,
  onError,
}: {
  parameter: Parameter;
  resolvedValue: number;
  state: AssemblerState;
  onError: (message: string | null) => void;
}): JSX.Element {
  const nameId = useId();
  const [nameDraft, setNameDraft] = useState(parameter.name);
  const [valueDraft, setValueDraft] = useState(parameter.expression ?? String(parameter.value));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [valueFocused, setValueFocused] = useState(false);

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

  return (
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
        value={valueDraft}
        suggestions={parameterCandidates(state.parameters, parameter.name)}
        title={
          parameter.expression
            ? `${parameter.expression} = ${resolvedValue}`
            : String(resolvedValue)
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
