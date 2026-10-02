/**
 * "Add as check" from the Measure panel (assembler/CHECKS.md "Creating
 * checks"): a measured value becomes a stored check of the measure
 * module's kinds — two bodies' distance a clearance check, a distance or
 * angle a range around the current value, a size a `length` check, a
 * volume/mass a `volume`/`mass` check. The new check opens in the Checks
 * panel's editor so the user sets the range they actually want.
 */
import {
  addStoredCheck,
  CheckEditError,
  openCheckEditor,
} from '../../foundation/commands/checks.js';
import { notify } from '../../foundation/commands/notices.js';
import type { MeasureRef, MeasureValue } from './measure.js';
import { targetOfRef } from './checkKinds.js';

type Json = Record<string, unknown>;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** A range around `value`: ± `abs`, or ± `rel` of it when that is larger. */
function around(value: number, abs: number, rel: number): { min: number; max: number } {
  const tol = Math.max(abs, Math.abs(value) * rel);
  return { min: round3(value - tol), max: round3(value + tol) };
}

const SIZE_QUANTITY: Record<string, string> = {
  Length: 'length',
  'Arc length': 'length',
  Circumference: 'length',
  Diameter: 'diameter',
  Radius: 'radius',
  'Width (X)': 'width',
  'Depth (Y)': 'depth',
  'Height (Z)': 'height',
  Area: 'area',
  'Surface area': 'area',
};

/** The check a measured value can become (`null`: none, e.g. ΔX/ΔY/ΔZ read-outs). */
export function checkForValue(
  refs: readonly MeasureRef[],
  value: MeasureValue,
): { kind: string; params: Json } | null {
  if (value.approx) return null;
  const bodies = refs.every((r) => r.kind === 'body')
    ? refs.map((r) => (r as Extract<MeasureRef, { kind: 'body' }>).bodyId)
    : null;
  if (refs.length === 2) {
    const [a, b] = refs as [MeasureRef, MeasureRef];
    if (
      bodies &&
      (value.kind === 'length' || value.label === 'Overlap volume') &&
      !value.secondary
    ) {
      // Two bodies: a clearance requirement (at least the gap they have now; overlap: none).
      const min = value.label === 'Overlap volume' ? 0 : Math.floor(value.value * 100 + 1e-6) / 100;
      return { kind: 'clearance', params: { a: bodies[0], b: bodies[1], min } };
    }
    const ta = targetOfRef(a);
    const tb = targetOfRef(b);
    if (!ta || !tb || value.secondary) return null;
    if (value.kind === 'length') {
      return { kind: 'distance', params: { a: ta, b: tb, ...around(value.value, 0.05, 0) } };
    }
    if (value.kind === 'angle' && value.label === 'Angle') {
      return { kind: 'angle', params: { a: ta, b: tb, ...around(value.value, 0.5, 0) } };
    }
    return null;
  }
  if (value.kind === 'volume' && bodies) {
    return { kind: 'volume', params: { bodies, ...around(value.value, 0, 0.02) } };
  }
  if (value.kind === 'mass' && bodies) {
    return { kind: 'mass', params: { bodies, ...around(value.value, 0, 0.02) } };
  }
  if (refs.length === 1) {
    const quantity = SIZE_QUANTITY[value.label];
    const target = targetOfRef(refs[0]!);
    if (!quantity || !target) return null;
    const range = quantity === 'area' ? around(value.value, 0, 0.01) : around(value.value, 0.05, 0);
    return { kind: 'length', params: { target, quantity, ...range } };
  }
  return null;
}

/** Adds the check of a measured value and opens it in the Checks panel; never throws. */
export function addCheckForValue(refs: readonly MeasureRef[], value: MeasureValue): void {
  const spec = checkForValue(refs, value);
  if (!spec) return;
  try {
    const check = addStoredCheck(spec.kind, spec.params);
    openCheckEditor(check.id);
  } catch (error) {
    // Only an explicit user action reports here (a tool or sketch is open).
    notify(error instanceof CheckEditError ? error.message : 'Could not add the check.', 'warning');
  }
}
