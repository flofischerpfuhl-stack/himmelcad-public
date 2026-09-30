/**
 * Body colour as a document feature (`setAppearance`, see `model/items.ts`
 * for the decision). Pure: computes the next feature list; the caller
 * commits it as one undo step.
 */
import { bodyMaterials, type MaterialId } from '../viewport/displayModes.js';
import type { Feature, SetAppearanceFeature } from './document.js';

/** Filament-like palette offered first; any `#RRGGBB` works. */
export const BODY_PALETTE: readonly { name: string; color: string }[] = [
  { name: 'Light grey', color: '#C9CDD3' },
  { name: 'Graphite', color: '#4A4F57' },
  { name: 'White', color: '#F2F2F0' },
  { name: 'Black', color: '#1E1F22' },
  { name: 'Signal red', color: '#D23B3B' },
  { name: 'Orange', color: '#F08A24' },
  { name: 'Yellow', color: '#F2C530' },
  { name: 'Green', color: '#4FA35A' },
  { name: 'Teal', color: '#2A9D8F' },
  { name: 'Blue', color: '#3A7BD5' },
  { name: 'Purple', color: '#7E57C2' },
  { name: 'Pink', color: '#E0679B' },
];

export function isHexColour(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Normalizes "abc", "#abc", "AABBCC" to "#AABBCC"; `null` if not a colour. */
export function normalizeHexColour(value: string): string | null {
  let v = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = [...v].map((c) => c + c).join('');
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : null;
}

/**
 * Next features after setting the material ("Visualized" display mode,
 * mass density) of the given bodies, each keeping its current colour
 * (`material: null` clears it). Same step rule as {@link withBodyColour}:
 * the last active step of that single body is updated in place.
 */
export function withBodyMaterial(
  features: readonly Feature[],
  activeCount: number,
  targets: readonly { bodyId: string; color: string }[],
  material: MaterialId | null,
  allocate: (index: number) => { id: string; name: string },
): Feature[] {
  const next = [...features];
  const lastActive = next[activeCount - 1];
  const apply = (f: SetAppearanceFeature): SetAppearanceFeature => {
    const { material: _old, ...rest } = f;
    return material ? { ...rest, material } : rest;
  };
  if (
    targets.length === 1 &&
    lastActive?.kind === 'setAppearance' &&
    lastActive.bodyId === targets[0]!.bodyId
  ) {
    next[activeCount - 1] = apply(lastActive);
    return next;
  }
  targets.forEach((target, index) => {
    const { id, name } = allocate(index);
    next.push(
      apply({
        id,
        name,
        suppressed: false,
        kind: 'setAppearance',
        bodyId: target.bodyId,
        color: target.color,
      }),
    );
  });
  return next;
}

/**
 * Next features after colouring `bodyIds`. When the last active step
 * already colours exactly that body it is updated in place (trying colours
 * does not pile up History steps); otherwise a new `setAppearance` step is
 * appended per body.
 */
export function withBodyColour(
  features: readonly Feature[],
  activeCount: number,
  bodyIds: readonly string[],
  color: string,
  allocate: (index: number) => { id: string; name: string },
): Feature[] {
  const next = [...features];
  const lastActive = next[activeCount - 1];
  if (
    bodyIds.length === 1 &&
    lastActive?.kind === 'setAppearance' &&
    lastActive.bodyId === bodyIds[0]
  ) {
    next[activeCount - 1] = { ...lastActive, color };
    return next;
  }
  // A new colour step keeps the body's material (the last step decides it).
  const materials = bodyMaterials(features, activeCount);
  bodyIds.forEach((bodyId, index) => {
    const { id, name } = allocate(index);
    const material = materials.get(bodyId);
    const feature: SetAppearanceFeature = {
      id,
      name,
      suppressed: false,
      kind: 'setAppearance',
      bodyId,
      color,
      ...(material ? { material } : {}),
    };
    next.push(feature);
  });
  return next;
}
