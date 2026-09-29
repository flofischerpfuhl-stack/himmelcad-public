/**
 * History-card parameters of a sketch feature: its driving dimensions
 * (number or expression, e.g. `d1 / 2`; each change is solved and applied
 * as one undo step, dependent features follow), the plane offset, and an
 * Edit button that opens sketch mode (double-clicking the card does too).
 */
import { PenSquare } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  Button,
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { ExpressionField } from '../../chrome/ExpressionField.js';
import fieldStyles from '../../chrome/ExpressionField.module.css';
import type { SketchFeature } from '../../model/document.js';
import type { AssemblerState } from '../../model/store.js';
import { setSketchDimension } from '../featureOps.js';
import { useSketchStore } from '../session.js';
import type { SketchDimension } from '../types.js';

const KIND_LABEL: Record<SketchDimension['kind'], string> = {
  distance: 'Length',
  horizontalDistance: 'Horizontal',
  verticalDistance: 'Vertical',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

function formatValue(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function DimensionField({
  feature,
  dimension,
}: {
  feature: SketchFeature;
  dimension: SketchDimension;
}): JSX.Element {
  const committed = dimension.expression ?? formatValue(dimension.value);
  const [draft, setDraft] = useState(committed);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focused) setDraft(committed);
  }, [committed, focused]);

  useEffect(() => {
    if (!focused) return;
    return registerEscapeRung('fieldRevert', () => {
      if (!input || document.activeElement !== input) return false;
      revertEscapeField(input, committed);
      setDraft(committed);
      setError(null);
      return true;
    });
  }, [focused, input, committed]);

  const commit = async () => {
    if (draft.trim() === committed) return;
    const reason = await setSketchDimension(feature.id, dimension.id, draft);
    setError(reason);
  };

  const unit = dimension.kind === 'angle' ? '°' : 'mm';
  const label = `${dimension.name} · ${KIND_LABEL[dimension.kind]}`;
  return (
    <div className={fieldStyles.field}>
      <span className={fieldStyles.label}>{label}</span>
      <div className={`${fieldStyles.wrap} ${error ? fieldStyles.wrapInvalid : ''}`}>
        <input
          ref={setInput}
          className={fieldStyles.input}
          value={draft}
          aria-label={label}
          aria-invalid={error !== null || undefined}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            consumeEscapeBlurCommitSuppression(event.currentTarget);
            setDraft(event.currentTarget.value);
            setError(null);
          }}
          onBlur={(event) => {
            setFocused(false);
            if (consumeEscapeBlurCommitSuppression(event.currentTarget)) return;
            void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <span className={fieldStyles.unit}>
          {dimension.expression ? `= ${formatValue(dimension.value)} ${unit}` : unit}
        </span>
      </div>
      {error ? (
        <span role="alert" className={fieldStyles.message}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function SketchParams({
  feature,
  state,
  className,
  fullClassName,
}: {
  feature: SketchFeature;
  state: AssemblerState;
  /** Grid container class of the history card. */
  className?: string | undefined;
  /** Class for a full-width grid cell. */
  fullClassName?: string | undefined;
}): JSX.Element {
  const curves = feature.entities.filter((e) => e.kind !== 'point').length;
  return (
    <div className={className}>
      {feature.dimensions.map((dimension) => (
        <DimensionField key={dimension.id} feature={feature} dimension={dimension} />
      ))}
      {feature.plane.kind === 'plane' ? (
        <ExpressionField
          label="Plane offset"
          value={feature.plane.offset}
          unit="mm"
          onCommit={(v) =>
            feature.plane.kind === 'plane' &&
            state.editFeatureParams(feature.id, { plane: { ...feature.plane, offset: v } })
          }
        />
      ) : null}
      <div className={fullClassName}>
        <Button
          variant="secondary"
          size="small"
          icon={<PenSquare size={13} />}
          onClick={() => useSketchStore.getState().begin({ featureId: feature.id })}
        >
          Edit sketch ({curves} {curves === 1 ? 'curve' : 'curves'}, {feature.constraints.length}{' '}
          constraints)
        </Button>
      </div>
    </div>
  );
}
