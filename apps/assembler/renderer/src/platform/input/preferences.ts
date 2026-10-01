/**
 * User preferences: device/user-wide settings that are **not** part of a
 * document (interaction research §7: `userPreferences` vs.
 * `workspaceViewState` vs. `documentModel`). Persisted in the renderer's
 * `localStorage` (the Electron profile), never in `.hcasm` files, never in
 * the undo history. Edited in the Settings dialog (`chrome/SettingsDialog.tsx`).
 */
import { create } from 'zustand';

import { DEFAULT_SKETCH_SNAPS, type SketchSnapToggles } from './snapToggles.js';
import { NAVIGATION_PRESETS, type NavigationPresetId } from './navigation.js';
import type { FingerDrawing } from './pointer.js';

export type LengthUnit = 'mm' | 'in';
export type ToolbarLabels = 'icons' | 'hover' | 'always';
export type ThemeName = 'dark' | 'light';
export type Projection = 'perspective' | 'orthographic';

export interface Preferences {
  /** Display unit for read-outs (measurements, dimension chips). Documents stay in millimetres. */
  units: LengthUnit;
  /** Grid shown in new sessions. */
  gridVisible: boolean;
  /** Grid step in new sessions, mm. */
  gridStep: number;
  /** Toolbar labels: icons only, on hover (tooltips), or always next to the icon. */
  labels: ToolbarLabels;
  /** Single-letter shortcuts (E = Extrude, …). Off: typing a letter opens command search. */
  singleKeyHotkeys: boolean;
  navigationPreset: NavigationPresetId;
  theme: ThemeName;
  projection: Projection;
  /** Perspective field of view, degrees. */
  fov: number;
  /** Animated camera transitions (also off when the OS asks for reduced motion). */
  animateCamera: boolean;
  /** `high`: ambient occlusion and the ground contact shadow; `standard`: plain lighting (slow GPUs). */
  renderQuality: RenderQuality;
  /**
   * The user picked `renderQuality` (Settings, Display menu, command). Until
   * then the display module may start a session at its GPU tier's preset
   * (`standard` on a software rasterizer, `modules/display/gpuTier.ts`).
   */
  renderQualityChosen: boolean;
  /** Last "Export image…" settings. */
  imageExport: ImageExportPreference;
  /** Where the user last dragged the Measure panel (CSS px from the window's top left); `null` = automatic placement. */
  measurePanelPosition: { x: number; y: number } | null;
  /** Show the Home screen (recent projects, templates) when the app starts without a file. */
  showHomeOnStartup: boolean;
  /** Sketch snap switches (Snap popover); grid snapping is the project's `snapToGrid`. */
  snaps: SketchSnapToggles;
  /** Text hints ("Midpoint", "Horizontal" …) next to the cursor while drawing. */
  snapHints: boolean;
  /**
   * Which selected sketch item stays put when a constraint is added (Shapr3D
   * Constraint Settings "First/Last Selected"); existing constraints win.
   */
  constraintKeep: 'first' | 'last';
  /**
   * Shortcut overrides, command id → shortcut in the registry's display form
   * (`'Shift+E'`, `'Ctrl+Alt+K'`); `''` removes a command's shortcut.
   */
  shortcuts: Record<string, string>;
  /** Every click in the viewport adds to the selection (Shapr3D "Selection Extension"). */
  selectionExtension: boolean;

  // ---- Touch and pen (assembler/TOUCH.md) ----
  /** Larger targets, labels instead of hover tips, the number keypad: with a coarse pointer (`auto`), always or never. */
  tabletLayout: TabletLayoutSetting;
  /** Right-handed: tools on the left (the free hand taps them); left-handed: tools on the right. */
  handedness: Handedness;
  /** What a finger does in a sketch (see `pointer.ts` `FingerDrawing`). */
  fingerDrawing: FingerDrawing;
  /** Pen strokes in a sketch become lines, arcs, circles and rectangles. */
  penShapes: boolean;
  /** A scribble with the pen (or a drawing finger) erases the sketch curves it crosses. */
  scribbleErase: boolean;
  /** Ignore touches while (and shortly after) the pen is used, and palm-sized contacts. */
  palmRejection: boolean;
  /** On-screen number keypad for value fields: with the tablet layout (`auto`), always or never. */
  numericKeypad: TabletLayoutSetting;
  /** The camera keeps gliding after a quick one- or two-finger flick. */
  touchInertia: boolean;
  /** Twisting two fingers rolls the view. */
  twistRoll: boolean;
  /** Two-finger tap undoes, three-finger tap redoes, three-finger swipe left/right undoes/redoes. */
  touchUndoGestures: boolean;
  /** A pen has been used on this device (switches `fingerDrawing: 'auto'` to pen-only drawing). */
  penSeen: boolean;
}

export type TabletLayoutSetting = 'auto' | 'on' | 'off';
export type Handedness = 'right' | 'left';

export type RenderQuality = 'high' | 'standard';

export interface ImageExportPreference {
  /** `view` = the viewport's size × `scale`; else a fixed size. */
  size: 'view' | '1920x1080' | '2560x1440' | '3840x2160' | 'custom';
  scale: 1 | 2 | 3 | 4;
  width: number;
  height: number;
  transparent: boolean;
  grid: boolean;
}

export const DEFAULT_IMAGE_EXPORT: ImageExportPreference = {
  size: 'view',
  scale: 2,
  width: 1920,
  height: 1080,
  transparent: false,
  grid: true,
};

function parseImageExport(raw: unknown): ImageExportPreference {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_IMAGE_EXPORT };
  const r = raw as Record<string, unknown>;
  const dim = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= 16384 ? v : fallback;
  return {
    size: (['view', '1920x1080', '2560x1440', '3840x2160', 'custom'] as const).includes(
      r.size as ImageExportPreference['size'],
    )
      ? (r.size as ImageExportPreference['size'])
      : DEFAULT_IMAGE_EXPORT.size,
    scale: ([1, 2, 3, 4] as const).includes(r.scale as 1) ? (r.scale as 1) : 2,
    width: dim(r.width, DEFAULT_IMAGE_EXPORT.width),
    height: dim(r.height, DEFAULT_IMAGE_EXPORT.height),
    transparent: typeof r.transparent === 'boolean' ? r.transparent : false,
    grid: typeof r.grid === 'boolean' ? r.grid : true,
  };
}

export const DEFAULT_PREFERENCES: Preferences = {
  units: 'mm',
  gridVisible: true,
  gridStep: 5,
  labels: 'hover',
  singleKeyHotkeys: true,
  navigationPreset: 'shapr3d',
  theme: 'dark',
  projection: 'perspective',
  fov: 45,
  animateCamera: true,
  renderQuality: 'high',
  renderQualityChosen: false,
  imageExport: DEFAULT_IMAGE_EXPORT,
  measurePanelPosition: null,
  showHomeOnStartup: true,
  snaps: { ...DEFAULT_SKETCH_SNAPS },
  snapHints: true,
  constraintKeep: 'first',
  shortcuts: {},
  selectionExtension: false,
  tabletLayout: 'auto',
  handedness: 'right',
  fingerDrawing: 'auto',
  penShapes: true,
  scribbleErase: true,
  palmRejection: true,
  numericKeypad: 'auto',
  touchInertia: true,
  twistRoll: true,
  touchUndoGestures: true,
  penSeen: false,
};

function parseSnaps(raw: unknown): SketchSnapToggles {
  const out = { ...DEFAULT_SKETCH_SNAPS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof SketchSnapToggles)[]) {
    if (typeof r[key] === 'boolean') out[key] = r[key] as boolean;
  }
  return out;
}

/** Shortcut overrides: string → string entries only (validated again against the registry when applied). */
function parseShortcuts(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length <= 40 && id.length <= 80) out[id] = value;
  }
  return out;
}

function parsePanelPosition(raw: unknown): { x: number; y: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { x, y } = raw as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20000;
  return ok(x) && ok(y) ? { x: x as number, y: y as number } : null;
}

const STORAGE_KEY = 'himmelcad.assembler.preferences.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Parses stored preferences, keeping only known keys with valid values (unknown/invalid → default). */
export function parsePreferences(text: string | null): Preferences {
  if (!text) return { ...DEFAULT_PREFERENCES };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFERENCES };
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof Preferences>(
    key: K,
    valid: (v: unknown) => boolean,
  ): Preferences[K] => (valid(r[key]) ? (r[key] as Preferences[K]) : DEFAULT_PREFERENCES[key]);
  const oneOf = (values: readonly unknown[]) => (v: unknown) => values.includes(v);
  const bool = (v: unknown) => typeof v === 'boolean';
  // Stored before the flag existed: a non-default quality was the user's choice.
  const renderQualityChosen =
    typeof r.renderQualityChosen === 'boolean'
      ? r.renderQualityChosen
      : r.renderQuality === 'standard';
  const number = (lo: number, hi: number) => (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  return {
    units: pick('units', oneOf(['mm', 'in'])),
    gridVisible: pick('gridVisible', bool),
    gridStep: pick('gridStep', number(0.01, 1000)),
    labels: pick('labels', oneOf(['icons', 'hover', 'always'])),
    singleKeyHotkeys: pick('singleKeyHotkeys', bool),
    navigationPreset: pick('navigationPreset', oneOf(NAVIGATION_PRESETS.map((p) => p.id))),
    theme: pick('theme', oneOf(['dark', 'light'])),
    projection: pick('projection', oneOf(['perspective', 'orthographic'])),
    fov: pick('fov', number(10, 90)),
    animateCamera: pick('animateCamera', bool),
    renderQuality: renderQualityChosen
      ? pick('renderQuality', oneOf(['high', 'standard']))
      : DEFAULT_PREFERENCES.renderQuality,
    renderQualityChosen,
    imageExport: parseImageExport(r.imageExport),
    measurePanelPosition: parsePanelPosition(r.measurePanelPosition),
    showHomeOnStartup: pick('showHomeOnStartup', bool),
    snaps: parseSnaps(r.snaps),
    snapHints: pick('snapHints', bool),
    constraintKeep: r.constraintKeep === 'last' ? 'last' : 'first',
    shortcuts: parseShortcuts(r.shortcuts),
    selectionExtension: pick('selectionExtension', bool),
    tabletLayout: pick('tabletLayout', oneOf(['auto', 'on', 'off'])),
    handedness: pick('handedness', oneOf(['right', 'left'])),
    fingerDrawing: pick('fingerDrawing', oneOf(['auto', 'pen', 'touch'])),
    penShapes: pick('penShapes', bool),
    scribbleErase: pick('scribbleErase', bool),
    palmRejection: pick('palmRejection', bool),
    numericKeypad: pick('numericKeypad', oneOf(['auto', 'on', 'off'])),
    touchInertia: pick('touchInertia', bool),
    twistRoll: pick('twistRoll', bool),
    touchUndoGestures: pick('touchUndoGestures', bool),
    penSeen: pick('penSeen', bool),
  };
}

export interface PreferencesState extends Preferences {
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  resetPreferences: () => void;
}

function persist(prefs: Preferences): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or unavailable: the setting still applies for this session.
  }
}

function snapshot(state: PreferencesState): Preferences {
  const { setPreference: _set, resetPreferences: _reset, ...prefs } = state;
  return prefs;
}

export const usePreferences = create<PreferencesState>((set, get) => ({
  ...parsePreferences(storage()?.getItem(STORAGE_KEY) ?? null),
  setPreference: (key, value) => {
    set({
      [key]: value,
      ...(key === 'renderQuality' ? { renderQualityChosen: true } : {}),
    } as Partial<PreferencesState>);
    persist(snapshot(get()));
  },
  resetPreferences: () => {
    // "A pen was used here" is a fact about the device, not a setting: it survives a reset.
    const penSeen = get().penSeen;
    set({ ...DEFAULT_PREFERENCES, snaps: { ...DEFAULT_SKETCH_SNAPS }, shortcuts: {}, penSeen });
    persist(snapshot(get()));
  },
}));

// ---- display units ---------------------------------------------------------------------------

const MM_PER_INCH = 25.4;

/** Converts millimetres to the display unit. */
export function toDisplayUnit(mm: number, unit: LengthUnit): number {
  return unit === 'in' ? mm / MM_PER_INCH : mm;
}

/** Converts a value typed in the display unit back to millimetres. */
export function fromDisplayUnit(value: number, unit: LengthUnit): number {
  return unit === 'in' ? value * MM_PER_INCH : value;
}

export function unitSuffix(unit: LengthUnit): string {
  return unit === 'in' ? 'in' : 'mm';
}

/** "12.5 mm" / "0.492 in" — trims trailing zeros, 2 decimals for mm, 3 for inches. */
export function formatLength(mm: number, unit: LengthUnit): string {
  const value = toDisplayUnit(mm, unit);
  const digits = unit === 'in' ? 3 : 2;
  return `${Number(value.toFixed(digits))} ${unitSuffix(unit)}`;
}

/** Area in the display unit ("mm²" / "in²"). */
export function formatArea(mm2: number, unit: LengthUnit): string {
  const value = unit === 'in' ? mm2 / (MM_PER_INCH * MM_PER_INCH) : mm2;
  return `${Number(value.toFixed(unit === 'in' ? 4 : 2))} ${unitSuffix(unit)}²`;
}

/** Volume in the display unit ("mm³" / "in³"). */
export function formatVolume(mm3: number, unit: LengthUnit): string {
  const value = unit === 'in' ? mm3 / MM_PER_INCH ** 3 : mm3;
  return `${Number(value.toFixed(unit === 'in' ? 4 : 1))} ${unitSuffix(unit)}³`;
}
