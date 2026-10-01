/**
 * Sketch edits outside sketch mode (History panel, agents): change a
 * dimension of a sketch feature, re-solve, and commit the solved sketch as
 * one document undo step. Dependent features (extrudes of its profiles)
 * re-evaluate through the normal document evaluation.
 */

import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { isPlainNumber } from '../../foundation/document/expressions.js';
import { rememberRegions } from '../../foundation/sketch-solver/regionMemory.js';
import { deleteItems, toggleConstruction } from '../../foundation/sketch-solver/edits.js';
import { describeProblem } from './session.js';
import { getSketchSolver } from '../../foundation/sketch-solver/solverProvider.js';
import { sketchDataOf, type SketchData } from '../../foundation/sketch-solver/types.js';

/**
 * An edit of selected curves of a sketch outside sketch mode (SEL-12:
 * Delete from Sketch, Construction): applied, re-solved and committed as one
 * document undo step. Resolves `null` when applied, else the reason.
 */
export async function editSketchCurves(
  featureId: string,
  entityIds: readonly string[],
  edit: 'delete' | 'construction',
): Promise<string | null> {
  const feature = useAssemblerStore
    .getState()
    .features.find((f): f is SketchFeature => f.id === featureId && f.kind === 'sketch');
  if (!feature) return `Sketch "${featureId}" not found`;
  const base = sketchDataOf(feature);
  const known = entityIds.filter((id) => base.entities.some((e) => e.id === id));
  if (known.length === 0) return 'Those curves are no longer in the sketch';
  const sketch = edit === 'delete' ? deleteItems(base, known) : toggleConstruction(base, known);
  const result = await getSketchSolver().solve({ sketch });
  if (result.status !== 'ok') return describeProblem(result, sketch).message;
  const current = useAssemblerStore.getState().features.find((f) => f.id === featureId);
  if (current !== feature) return 'The sketch changed meanwhile; try again';
  useAssemblerStore.getState().editFeatureParams(featureId, {
    ...rememberRegions(result.sketch, base),
    // A deletion may remove the last projection / pattern record: clear the stored lists too.
    ...(base.projections && !result.sketch.projections ? { projections: [] } : {}),
    ...(base.patterns && !result.sketch.patterns ? { patterns: [] } : {}),
  });
  return null;
}

/**
 * Sets dimension `dimensionId` of sketch `featureId` to `input` (a number
 * or an expression such as `"d1 / 2"`). Resolves `null` when applied, else
 * a user-facing reason (nothing changes then).
 */
export async function setSketchDimension(
  featureId: string,
  dimensionId: string,
  input: string | number,
): Promise<string | null> {
  const feature = useAssemblerStore
    .getState()
    .features.find((f): f is SketchFeature => f.id === featureId && f.kind === 'sketch');
  if (!feature) return `Sketch "${featureId}" not found`;
  const dimension = feature.dimensions.find((d) => d.id === dimensionId);
  if (!dimension) return `Dimension "${dimensionId}" not found`;
  if (dimension.driven)
    return `${dimension.name} is a reference dimension; it follows the geometry`;
  const text = typeof input === 'number' ? String(input) : input.trim();
  if (text === '') return 'Enter a value';
  const plain = isPlainNumber(text);
  const { expression: _previous, ...rest } = dimension;
  const next = plain
    ? { ...rest, value: Number(text.replace(',', '.').replace(/\s*(mm|°|deg)\s*$/i, '')) }
    : { ...rest, expression: text };
  const base = sketchDataOf(feature);
  const sketch: SketchData = {
    ...base,
    dimensions: base.dimensions.map((d) => (d.id === dimensionId ? next : d)),
  };
  const result = await getSketchSolver().solve({ sketch });
  if (result.status !== 'ok') return describeProblem(result, sketch).message;
  // The document may have changed while solving: apply only onto the same sketch.
  const current = useAssemblerStore.getState().features.find((f) => f.id === featureId);
  if (current !== feature) return 'The sketch changed meanwhile; try again';
  useAssemblerStore
    .getState()
    .editFeatureParams(featureId, { ...rememberRegions(result.sketch, base) });
  return null;
}
