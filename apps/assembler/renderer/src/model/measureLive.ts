/**
 * Live measurements for the Measure panel and the viewport's dimension
 * overlay: the current one (measured points, else the selection) and the
 * pinned ones, re-measured whenever the document, the selection or a kernel
 * distance result changes. Also formats values in the display unit.
 */
import { useMemo } from 'react';

import { bodyMaterials } from '../platform/viewport/displayModes.js';
import { displayBodyName, useItemsStore } from '../foundation/commands/items.js';
import {
  currentRefs,
  measure,
  type MeasureContext,
  type MeasureRef,
  type MeasureValue,
  type Measurement,
} from './measure.js';
import { useMeasureStore, type PinnedMeasurement } from './measureStore.js';
import {
  formatArea,
  formatLength,
  formatVolume,
  usePreferences,
  type LengthUnit,
} from '../platform/input/preferences.js';
import { useAssemblerStore, type AssemblerState } from '../foundation/commands/store.js';

export interface LiveMeasurement {
  refs: MeasureRef[];
  measurement: Measurement;
}

export interface LiveMeasurements {
  current: LiveMeasurement | null;
  pinned: { pin: PinnedMeasurement; measurement: Measurement }[];
}

function activeCount(s: Pick<AssemblerState, 'features' | 'rollbackBefore'>): number {
  const index = s.rollbackBefore ? s.features.findIndex((f) => f.id === s.rollbackBefore) : -1;
  return index >= 0 ? index : s.features.length;
}

/** Current and pinned measurements (React hook). */
export function useLiveMeasurements(): LiveMeasurements {
  const evaluation = useAssemblerStore((s) => s.evaluation);
  const features = useAssemblerStore((s) => s.features);
  const rollbackBefore = useAssemblerStore((s) => s.rollbackBefore);
  const selection = useAssemblerStore((s) => s.selection);
  const referenceMeshes = useAssemblerStore((s) => s.referenceMeshes);
  const pins = useMeasureStore((s) => s.pins);
  const points = useMeasureStore((s) => s.points);
  const distances = useMeasureStore((s) => s.distances);
  const meta = useItemsStore();
  return useMemo(() => {
    void distances; // re-measure when a kernel distance arrives
    const ctx: MeasureContext = {
      bodies: evaluation.bodies,
      referenceMeshes,
      bodyName: (body) => displayBodyName(body, meta),
      materials: bodyMaterials(features, activeCount({ features, rollbackBefore })),
      distance: (a, b) => {
        // The kernel replays the evaluated steps: those above the History rollback bar.
        const active = features.slice(0, activeCount({ features, rollbackBefore }));
        const result = useMeasureStore.getState().kernelDistance(active, evaluation, a, b);
        return result === 'failed' ? null : result;
      },
    };
    const refs = currentRefs(selection, points);
    const current = measure(refs, ctx);
    return {
      current: current ? { refs, measurement: current } : null,
      pinned: pins.flatMap((pin) => {
        const measurement = measure(pin.refs, ctx);
        return measurement ? [{ pin, measurement }] : [];
      }),
    };
  }, [
    evaluation,
    features,
    rollbackBefore,
    selection,
    referenceMeshes,
    pins,
    points,
    distances,
    meta,
  ]);
}

// ---- formatting --------------------------------------------------------------------------------

/** A value in the display unit, e.g. "12.5 mm", "≈ 3.2 mm", "90°", "14.2 g". */
export function formatMeasureValue(value: MeasureValue, unit: LengthUnit): string {
  const prefix = value.approx ? '≈ ' : '';
  switch (value.kind) {
    case 'length':
      return prefix + formatLength(value.value, unit);
    case 'area':
      return prefix + formatArea(value.value, unit);
    case 'volume':
      return prefix + formatVolume(value.value, unit);
    case 'angle':
      return `${prefix}${Number(value.value.toFixed(2))}°`;
    case 'mass':
      return value.value >= 1000
        ? `${prefix}${Number((value.value / 1000).toFixed(3))} kg`
        : `${prefix}${Number(value.value.toFixed(value.value < 10 ? 2 : 1))} g`;
    case 'count':
      return `${prefix}${value.value}`;
  }
}

/** The measurement as copyable text ("Diameter: 6 mm; Radius: 3 mm"). */
export function measurementText(m: Measurement, unit: LengthUnit): string {
  const values = m.values.map((v) => `${v.label}: ${formatMeasureValue(v, unit)}`).join('; ');
  return `${m.title}${m.subject ? ` (${m.subject})` : ''}: ${values}`;
}

/** The value a graphic is labelled with in the viewport (see `measure.ts` graphics). */
export function graphicLabel(m: Measurement, index: number, unit: LengthUnit): string {
  const primary = m.values.filter((v) => !v.secondary);
  const value = m.graphics.length > 1 ? primary[index] : primary[0];
  return value ? formatMeasureValue(value, unit) : '';
}

export function useDisplayUnit(): LengthUnit {
  return usePreferences((p) => p.units);
}
