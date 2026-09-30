/**
 * Display modes, material presets and analysis colour scales of the
 * viewport (interaction research §5: Wireframe, X-Ray, Shaded, Visualized
 * with materials, Zebra/Curvature, edge/hidden-edge toggles). Pure data —
 * shared by the render loop, the display menu, commands and tests.
 *
 * A display mode is view state (saved in the project's `viewState`), never
 * a geometry edit. A body's material is stored next to its colour in the
 * `setAppearance` History step (`material`, optional); it only changes how
 * "Visualized" renders the body and which density the Measure panel uses
 * for mass.
 */
import type { Feature } from '../foundation/document/document.js';
import type { DisplayMode } from '../foundation/commands/store.js';

export interface MaterialParams {
  /** 0 = mirror-like .. 1 = fully matte. */
  roughness: number;
  /** Specular strength 0..1 (dielectric highlight). */
  specular: number;
  /** 0 = plastic .. 1 = metal (tinted reflections, dark diffuse). */
  metalness: number;
  /** Glossy top coat 0..1 (sharp white highlight + rim). */
  clearcoat: number;
  /** Light wrapping into the shadow side 0..1 (soft, slightly translucent look). */
  wrap: number;
}

export type MaterialId = 'pla' | 'petg' | 'metal' | 'resin';

export interface MaterialPreset {
  id: MaterialId;
  label: string;
  /** Density for the Measure panel's mass read-out, g/cm³ (solid part, 100 % infill). */
  density: number;
  params: MaterialParams;
}

export const MATERIALS: readonly MaterialPreset[] = [
  {
    id: 'pla',
    label: 'PLA matte',
    density: 1.24,
    params: { roughness: 0.85, specular: 0.12, metalness: 0, clearcoat: 0, wrap: 0.15 },
  },
  {
    id: 'petg',
    label: 'PETG glossy',
    density: 1.27,
    params: { roughness: 0.25, specular: 0.45, metalness: 0, clearcoat: 0.55, wrap: 0.1 },
  },
  {
    id: 'metal',
    label: 'Metal (aluminium)',
    density: 2.7,
    params: { roughness: 0.35, specular: 0.9, metalness: 1, clearcoat: 0, wrap: 0 },
  },
  {
    id: 'resin',
    label: 'Resin (SLA)',
    density: 1.15,
    params: { roughness: 0.4, specular: 0.3, metalness: 0, clearcoat: 0.25, wrap: 0.45 },
  },
];

export const MATERIAL_IDS: readonly MaterialId[] = MATERIALS.map((m) => m.id);

export function isMaterialId(value: unknown): value is MaterialId {
  return typeof value === 'string' && (MATERIAL_IDS as readonly string[]).includes(value);
}

export function materialPreset(id: MaterialId): MaterialPreset {
  return MATERIALS.find((m) => m.id === id)!;
}

/** Density used for mass when a body has no material: PLA, the common default filament. */
export const DEFAULT_DENSITY_MATERIAL: MaterialId = 'pla';

/** The neutral CAD look of Shaded / Shaded with edges (a soft satin plastic). */
export const SHADED_MATERIAL: MaterialParams = {
  roughness: 0.6,
  specular: 0.22,
  metalness: 0,
  clearcoat: 0,
  wrap: 0.1,
};

/**
 * Material per body id from the active `setAppearance` steps: the body's
 * last active step decides (a step without `material` means none).
 * Suppressed steps and steps after the rollback marker are ignored — the
 * same rule the kernel applies to colour. Colour edits carry the material
 * over (`model/appearance.ts`).
 */
export function bodyMaterials(
  features: readonly Feature[],
  activeCount = features.length,
): Map<string, MaterialId> {
  const out = new Map<string, MaterialId>();
  for (let i = 0; i < Math.min(activeCount, features.length); i += 1) {
    const f = features[i]!;
    if (f.kind !== 'setAppearance' || f.suppressed) continue;
    const material = (f as { material?: unknown }).material;
    if (isMaterialId(material)) out.set(f.bodyId, material);
    else out.delete(f.bodyId);
  }
  return out;
}

// ---- display menu ---------------------------------------------------------------------------

/** One entry of the display-mode menu ("Shaded" and "Shaded with edges" share the `shaded` mode). */
export interface DisplayModeEntry {
  id: 'shaded' | 'shadedEdges' | 'wireframe' | 'xray' | 'visualized' | 'zebra' | 'curvature';
  label: string;
  mode: DisplayMode;
  /** Edge lines forced by the entry (`undefined` = keep the Edges toggle). */
  edges?: boolean;
  shortcut: string;
  hint: string;
}

export const DISPLAY_MODE_ENTRIES: readonly DisplayModeEntry[] = [
  {
    id: 'shadedEdges',
    label: 'Shaded with edges',
    mode: 'shaded',
    edges: true,
    shortcut: 'Alt+1',
    hint: 'Default',
  },
  { id: 'shaded', label: 'Shaded', mode: 'shaded', edges: false, shortcut: 'Alt+2', hint: '' },
  {
    id: 'wireframe',
    label: 'Wireframe',
    mode: 'wireframe',
    shortcut: 'Alt+3',
    hint: 'Edges and outlines only',
  },
  {
    id: 'xray',
    label: 'X-Ray',
    mode: 'xray',
    shortcut: 'Alt+4',
    hint: 'Transparent faces',
  },
  {
    id: 'visualized',
    label: 'Visualized',
    mode: 'visualized',
    shortcut: 'Alt+5',
    hint: 'Materials (PLA, PETG, metal, resin)',
  },
  {
    id: 'zebra',
    label: 'Zebra stripes',
    mode: 'zebra',
    shortcut: 'Alt+6',
    hint: 'Surface continuity',
  },
  {
    id: 'curvature',
    label: 'Curvature map',
    mode: 'curvature',
    shortcut: 'Alt+7',
    hint: 'Estimated from the mesh',
  },
];

/** The menu entry that shows the current state. */
export function activeDisplayEntry(mode: DisplayMode, edges: boolean): DisplayModeEntry['id'] {
  if (mode === 'shaded') return edges ? 'shadedEdges' : 'shaded';
  return mode;
}

export const DISPLAY_MODES: readonly DisplayMode[] = [
  'shaded',
  'wireframe',
  'xray',
  'visualized',
  'zebra',
  'curvature',
];

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as readonly string[]).includes(value);
}

/** Whether the Edges toggle applies to a mode (wireframe always draws edges). */
export function edgesToggleApplies(mode: DisplayMode): boolean {
  return mode !== 'wireframe';
}

// ---- curvature scale -----------------------------------------------------------------------

/**
 * Radius range of the curvature map, mm: radii at or below `min` get the
 * strongest colour, radii at or above `max` read as flat. `max` follows the
 * model size so a large part is not all "flat".
 */
export function curvatureRange(modelDiagonal: number): { min: number; max: number } {
  const max = Math.min(1000, Math.max(20, modelDiagonal));
  return { min: Math.max(0.2, max / 400), max };
}

/**
 * Colour of a signed curvature `k` (1/mm) on the map: neutral grey-green
 * for flat, yellow→red for convex, cyan→blue for concave — the same ramp
 * the shader uses (`gl.ts` `curvatureColor`), mirrored here for the legend
 * and tests.
 */
export function curvatureColor(
  k: number,
  range: { min: number; max: number },
): [number, number, number] {
  const t = curvatureStrength(k, range);
  const flat: [number, number, number] = [0.55, 0.62, 0.55];
  if (t <= 0) return flat;
  const mid: [number, number, number] = k > 0 ? [0.95, 0.85, 0.25] : [0.25, 0.8, 0.9];
  const strong: [number, number, number] = k > 0 ? [0.9, 0.2, 0.15] : [0.15, 0.3, 0.9];
  const mix = (a: [number, number, number], b: [number, number, number], s: number) =>
    [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s] as [
      number,
      number,
      number,
    ];
  return t < 0.5 ? mix(flat, mid, t * 2) : mix(mid, strong, (t - 0.5) * 2);
}

/** 0 (radius ≥ max, flat) .. 1 (radius ≤ min), logarithmic in the radius. */
export function curvatureStrength(k: number, range: { min: number; max: number }): number {
  const magnitude = Math.abs(k);
  if (magnitude < 1e-12) return 0;
  const radius = 1 / magnitude;
  const lo = Math.log10(range.min);
  const hi = Math.log10(range.max);
  const t = (hi - Math.log10(radius)) / (hi - lo);
  return Math.min(1, Math.max(0, t));
}
