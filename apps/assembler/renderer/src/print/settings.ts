/**
 * 3D-printing settings: thresholds of the printability analysis, material
 * presets (density, price) and printer build volumes. Plain data shared by
 * the UI, the analysis worker, the agent API and the tests.
 */

export type MaterialId = 'PLA' | 'PETG' | 'ABS' | 'TPU' | 'custom';

export interface MaterialPreset {
  id: Exclude<MaterialId, 'custom'>;
  label: string;
  /** g/cm³, typical datasheet value of the unfilled polymer. */
  density: number;
  /** Rough filament price per kg in the chosen currency (user-editable). */
  costPerKg: number;
}

export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
  { id: 'PLA', label: 'PLA', density: 1.24, costPerKg: 20 },
  { id: 'PETG', label: 'PETG', density: 1.27, costPerKg: 22 },
  { id: 'ABS', label: 'ABS', density: 1.04, costPerKg: 22 },
  { id: 'TPU', label: 'TPU', density: 1.21, costPerKg: 35 },
];

export type BuildVolumeId = 'none' | 'bambuX1' | 'bambuP1' | 'prusaMk4' | 'ender3' | 'custom';

export interface BuildVolumePreset {
  id: Exclude<BuildVolumeId, 'none' | 'custom'>;
  label: string;
  /** Printable width (X), depth (Y), height (Z), mm. */
  size: [number, number, number];
}

export const BUILD_VOLUME_PRESETS: readonly BuildVolumePreset[] = [
  { id: 'bambuX1', label: 'Bambu Lab X1', size: [256, 256, 256] },
  { id: 'bambuP1', label: 'Bambu Lab P1', size: [256, 256, 256] },
  { id: 'prusaMk4', label: 'Prusa MK4', size: [250, 210, 220] },
  { id: 'ender3', label: 'Creality Ender-3', size: [220, 220, 250] },
];

export interface PrintSettings {
  /** Faces steeper than this from vertical (degrees) count as overhangs. 45° is the common FDM rule. */
  overhangAngleDeg: number;
  /** Walls thinner than this (mm) are flagged. 0.8 mm ≈ two 0.4 mm nozzle lines. */
  minWallMm: number;
  /** Holes with a smaller diameter (mm) are flagged. */
  minHoleMm: number;
  /** Pins/bosses with a smaller diameter (mm) are flagged. */
  minPinMm: number;
  material: MaterialId;
  /** Used when `material` is `custom`, else overwritten by the preset on selection. */
  density: number;
  costPerKg: number;
  currency: string;
  buildVolume: BuildVolumeId;
  /** Custom build volume, mm. */
  customVolume: [number, number, number];
  /** Draw the build volume box in the viewport while Print mode is on. */
  showBuildVolume: boolean;
  /** Overlays shown in the viewport. */
  showOverhangs: boolean;
  showThinWalls: boolean;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  overhangAngleDeg: 45,
  minWallMm: 0.8,
  minHoleMm: 2,
  minPinMm: 1,
  material: 'PLA',
  density: 1.24,
  costPerKg: 20,
  currency: 'EUR',
  buildVolume: 'bambuX1',
  customVolume: [200, 200, 200],
  showBuildVolume: true,
  showOverhangs: true,
  showThinWalls: true,
};

/** Build volume size of the settings, or `null` for "no printer". */
export function buildVolumeSize(settings: PrintSettings): [number, number, number] | null {
  if (settings.buildVolume === 'none') return null;
  if (settings.buildVolume === 'custom') return [...settings.customVolume];
  const preset = BUILD_VOLUME_PRESETS.find((p) => p.id === settings.buildVolume);
  return preset ? [...preset.size] : null;
}

export function buildVolumeLabel(settings: PrintSettings): string {
  if (settings.buildVolume === 'none') return 'None';
  if (settings.buildVolume === 'custom') return 'Custom';
  return BUILD_VOLUME_PRESETS.find((p) => p.id === settings.buildVolume)?.label ?? 'Custom';
}

function finiteIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Validates settings from storage or an agent call; unknown/invalid fields fall back to the defaults. */
export function sanitizePrintSettings(input: unknown): PrintSettings {
  const d = DEFAULT_PRINT_SETTINGS;
  const s = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const material = (['PLA', 'PETG', 'ABS', 'TPU', 'custom'] as const).includes(
    s.material as MaterialId,
  )
    ? (s.material as MaterialId)
    : d.material;
  const volume = (['none', 'bambuX1', 'bambuP1', 'prusaMk4', 'ender3', 'custom'] as const).includes(
    s.buildVolume as BuildVolumeId,
  )
    ? (s.buildVolume as BuildVolumeId)
    : d.buildVolume;
  const custom = Array.isArray(s.customVolume) ? s.customVolume : d.customVolume;
  const preset = MATERIAL_PRESETS.find((p) => p.id === material);
  return {
    overhangAngleDeg: finiteIn(s.overhangAngleDeg, 0, 89, d.overhangAngleDeg),
    minWallMm: finiteIn(s.minWallMm, 0, 100, d.minWallMm),
    minHoleMm: finiteIn(s.minHoleMm, 0, 1000, d.minHoleMm),
    minPinMm: finiteIn(s.minPinMm, 0, 1000, d.minPinMm),
    material,
    density: finiteIn(s.density, 0.01, 30, preset?.density ?? d.density),
    costPerKg: finiteIn(s.costPerKg, 0, 1e6, preset?.costPerKg ?? d.costPerKg),
    currency:
      typeof s.currency === 'string' && s.currency.trim()
        ? s.currency.trim().slice(0, 8)
        : d.currency,
    buildVolume: volume,
    customVolume: [0, 1, 2].map((i) => finiteIn(custom[i], 1, 10000, d.customVolume[i]!)) as [
      number,
      number,
      number,
    ],
    showBuildVolume: typeof s.showBuildVolume === 'boolean' ? s.showBuildVolume : d.showBuildVolume,
    showOverhangs: typeof s.showOverhangs === 'boolean' ? s.showOverhangs : d.showOverhangs,
    showThinWalls: typeof s.showThinWalls === 'boolean' ? s.showThinWalls : d.showThinWalls,
  };
}
