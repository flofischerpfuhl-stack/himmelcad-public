/**
 * Navigation presets: which mouse button + modifiers orbit, pan or select,
 * as plain data (interaction research §6 — Shapr3D ships a default preset
 * plus presets that mimic other CAD programs). The viewport only asks
 * {@link resolveDrag}; adding a preset is adding a table entry.
 */

export type NavigationPresetId = 'shapr3d' | 'fusion' | 'solidworks';

export type DragAction = 'orbit' | 'pan' | 'select';

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface DragBinding {
  /** `MouseEvent.button`: 0 left, 1 middle, 2 right. */
  button: 0 | 1 | 2;
  /** Required modifiers; unlisted modifiers must be up. */
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  action: DragAction;
}

export interface NavigationPreset {
  id: NavigationPresetId;
  label: string;
  /** One-line description for the Settings dialog. */
  summary: string;
  /** First match wins. */
  bindings: readonly DragBinding[];
  /** A right click without dragging opens the context menu (all presets). */
  rightClickMenu: true;
}

export const NAVIGATION_PRESETS: readonly NavigationPreset[] = [
  {
    id: 'shapr3d',
    label: 'Shapr3D (default)',
    summary: 'Right drag orbits, middle or Shift + right drag pans, wheel zooms.',
    rightClickMenu: true,
    bindings: [
      { button: 2, shift: true, action: 'pan' },
      { button: 2, action: 'orbit' },
      { button: 1, action: 'pan' },
      { button: 0, action: 'select' },
      { button: 0, shift: true, action: 'select' },
      { button: 0, ctrl: true, action: 'select' },
    ],
  },
  {
    id: 'fusion',
    label: 'Fusion 360 style',
    summary: 'Shift + middle drag orbits, middle drag pans, wheel zooms.',
    rightClickMenu: true,
    bindings: [
      { button: 1, shift: true, action: 'orbit' },
      { button: 1, action: 'pan' },
      { button: 0, action: 'select' },
      { button: 0, shift: true, action: 'select' },
      { button: 0, ctrl: true, action: 'select' },
    ],
  },
  {
    id: 'solidworks',
    label: 'SolidWorks style',
    summary: 'Middle drag orbits, Ctrl + middle drag pans, wheel zooms.',
    rightClickMenu: true,
    bindings: [
      { button: 1, ctrl: true, action: 'pan' },
      { button: 1, action: 'orbit' },
      { button: 0, action: 'select' },
      { button: 0, shift: true, action: 'select' },
      { button: 0, ctrl: true, action: 'select' },
    ],
  },
];

export function navigationPreset(id: NavigationPresetId): NavigationPreset {
  return NAVIGATION_PRESETS.find((p) => p.id === id) ?? NAVIGATION_PRESETS[0]!;
}

/** What a drag with `button` and `modifiers` does under `preset`, `null` if nothing. */
export function resolveDrag(
  preset: NavigationPreset,
  button: number,
  modifiers: Modifiers,
): DragAction | null {
  for (const binding of preset.bindings) {
    if (binding.button !== button) continue;
    if ((binding.shift ?? false) !== modifiers.shift) continue;
    if ((binding.ctrl ?? false) !== modifiers.ctrl) continue;
    if ((binding.alt ?? false) !== modifiers.alt) continue;
    return binding.action;
  }
  return null;
}

/** Human-readable gesture list of a preset (shortcut overlay, Settings). */
export function describeBindings(preset: NavigationPreset): { gesture: string; action: string }[] {
  const buttonName = ['Left', 'Middle', 'Right'] as const;
  return preset.bindings
    .filter((b) => b.action !== 'select')
    .map((b) => ({
      gesture: [
        b.ctrl ? 'Ctrl' : null,
        b.shift ? 'Shift' : null,
        b.alt ? 'Alt' : null,
        `${buttonName[b.button]} drag`,
      ]
        .filter(Boolean)
        .join(' + '),
      action: b.action === 'orbit' ? 'Orbit' : 'Pan',
    }));
}
