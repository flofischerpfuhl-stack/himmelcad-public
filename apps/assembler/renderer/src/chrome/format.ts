/**
 * Small presentation helpers shared across the chrome: selection summary
 * text, body dimensions, and feature/command display names. Pure, no
 * store access — callers pass in the already-read state.
 */
import type { Body } from '../foundation/geometry-kernel/types.js';
import type { Feature } from '../foundation/document/document.js';
import { MODELING_FEATURE_LABEL } from '../model/features.js';
import type { SelectionItem } from '../foundation/commands/store.js';

const KIND_LABELS: Record<SelectionItem['kind'], [string, string]> = {
  body: ['body', 'bodies'],
  face: ['face', 'faces'],
  edge: ['edge', 'edges'],
  sketchProfile: ['sketch', 'sketches'],
  feature: ['feature', 'features'],
  mesh: ['reference mesh', 'reference meshes'],
  datum: ['plane or axis', 'planes and axes'],
};

/** `"1 face"`, `"2 edges & 1 body"`, `""` for an empty selection. */
export function selectionSummary(selection: readonly SelectionItem[]): string {
  if (selection.length === 0) return '';
  const counts = new Map<SelectionItem['kind'], number>();
  for (const item of selection) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, count]) => {
    const [singular, plural] = KIND_LABELS[kind];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/** `"80 x 50 x 6 mm"` — width (X) x depth (Y) x height (Z). */
export function formatBodyDimensions(body: Body): string {
  const [w, d, h] = [0, 1, 2].map((axis) => round1(Math.abs(body.max[axis]! - body.min[axis]!)));
  return `${w} × ${d} × ${h} mm`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Display name for a feature-history card icon lookup / a11y label. */
export function featureKindLabel(kind: Feature['kind']): string {
  switch (kind) {
    case 'sketch':
      return 'Sketch';
    case 'extrude':
      return 'Extrude';
    case 'fillet':
      return 'Fillet';
    case 'chamfer':
      return 'Chamfer';
    case 'shell':
      return 'Shell';
    case 'boolean':
      return 'Boolean';
    case 'move':
      return 'Move';
    case 'setAppearance':
      return 'Appearance';
    case 'importStep':
      return 'Import';
    case 'meshSolid':
      return 'Mesh to Solid';
    default:
      return MODELING_FEATURE_LABEL[kind];
  }
}
