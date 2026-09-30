/**
 * Workspace view state of the open project (interaction research §7
 * `workspaceViewState`): Select Through, saved views, camera commands for
 * the viewport and panel requests such as "Reveal in Items". Kept out of
 * `store.ts` (the document/tool store): none of it is geometry, none of it
 * is undoable. Saved views are written into the project file's `viewState`
 * (see `project/projectStore.ts`), the rest resets with the session.
 */
import { create } from 'zustand';

import type { CameraPose } from '../../platform/viewport/camera.js';
import type { CameraCommand } from '../../platform/viewport/cameraChannel.js';
import { usePreferences } from '../../platform/input/preferences.js';

export const MAX_SAVED_VIEWS = 8;

type Triple = [number, number, number];

/**
 * The Section View state a saved view carries (Shapr3D 26.30/26.80: saved
 * views store camera and section — plane position, 2D section/Section
 * Only; research `notes/coverage-audit.md`).
 */
export interface SavedSection {
  enabled: boolean;
  axis: 'X' | 'Y' | 'Z';
  offset: number;
  flipped: boolean;
  plane: { normal: Triple; origin: Triple; label: string } | null;
  sectionOnly: boolean;
}

export interface SavedView {
  name: string;
  pose: CameraPose;
  /** Section state when the view was saved; absent in views saved by older builds (camera only). */
  section?: SavedSection;
}

/** Reads/applies the store's section state (registered by `store.ts`; keeps this module store-free). */
let sectionAccess: { read: () => SavedSection; apply: (section: SavedSection) => void } | null =
  null;

export function setSectionAccess(access: typeof sectionAccess): void {
  sectionAccess = access;
}

export type { CameraCommand } from '../../platform/viewport/cameraChannel.js';

/** Reads the viewport's live camera (registered by the mounted viewport). */
type PoseProbe = () => CameraPose | null;
let poseProbe: PoseProbe | null = null;

export function setCameraPoseProbe(probe: PoseProbe | null): void {
  poseProbe = probe;
}

export function currentCameraPose(): CameraPose | null {
  return poseProbe?.() ?? null;
}

export interface WorkspaceState {
  /** Picks and boxes also reach geometry hidden behind other geometry. */
  selectThrough: boolean;
  setSelectThrough: (on: boolean) => void;

  savedViews: SavedView[];
  /** Saves the current camera (up to {@link MAX_SAVED_VIEWS}); returns `false` when full or no viewport. */
  saveCurrentView: (name?: string) => boolean;
  restoreView: (index: number) => void;
  deleteView: (index: number) => void;
  renameView: (index: number, name: string) => void;
  setSavedViews: (views: SavedView[]) => void;

  cameraCommand: { command: CameraCommand; nonce: number } | null;
  sendCamera: (command: CameraCommand) => void;

  /** "Reveal in Items": the Items panel scrolls to and flashes this row key. */
  revealRequest: { key: string; nonce: number } | null;
  revealInItems: (key: string) => void;

  /** Starts inline renaming of an Items row (context menu "Rename"). */
  renameRequest: { key: string; nonce: number } | null;
  renameInItems: (key: string) => void;
  /** Body colour dialog for these bodies (`null` = closed). */
  colourDialogBodyIds: string[] | null;
  setColourDialog: (bodyIds: string[] | null) => void;

  /** Keyboard shortcut overlay (hold Ctrl or press ?). */
  shortcutOverlay: boolean;
  setShortcutOverlay: (open: boolean) => void;
  /**
   * The Home screen (recent projects, templates, getting started, recovery):
   * shown at start unless turned off in Settings, and via File › Home.
   */
  homeOpen: boolean;
  setHomeOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  /** Transient message shown in the status area (e.g. a refused reorder). */
  notice: { text: string; tone: 'info' | 'warning'; nonce: number } | null;
  notify: (text: string, tone?: 'info' | 'warning') => void;
  clearNotice: () => void;
}

/**
 * "Nearest ortho" (Shapr3D Views menu, interaction research §5): the world
 * axis direction closest to `direction` (target → eye), as a unit vector.
 */
export function nearestOrthoDirection(direction: readonly [number, number, number]): Triple {
  let axis = 0;
  for (let i = 1; i < 3; i += 1) {
    if (Math.abs(direction[i]!) > Math.abs(direction[axis]!)) axis = i;
  }
  const out: Triple = [0, 0, 0];
  out[axis] = direction[axis]! < 0 ? -1 : 1;
  return out;
}

export function nextViewName(views: readonly SavedView[]): string {
  let n = views.length + 1;
  while (views.some((v) => v.name === `View ${n}`)) n += 1;
  return `View ${n}`;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  selectThrough: false,
  setSelectThrough: (on) => set({ selectThrough: on }),

  savedViews: [],
  saveCurrentView: (name) => {
    const views = get().savedViews;
    if (views.length >= MAX_SAVED_VIEWS) return false;
    const pose = currentCameraPose();
    if (!pose) return false;
    const trimmed = name?.trim();
    const section = sectionAccess?.read();
    set({
      savedViews: [
        ...views,
        {
          name: trimmed ? trimmed : nextViewName(views),
          pose: { ...pose, target: [...pose.target] as [number, number, number] },
          ...(section ? { section: structuredClone(section) } : {}),
        },
      ],
    });
    return true;
  },
  restoreView: (index) => {
    const view = get().savedViews[index];
    if (!view) return;
    if (view.section) sectionAccess?.apply(structuredClone(view.section));
    get().sendCamera({ kind: 'pose', pose: view.pose });
  },
  deleteView: (index) => set((s) => ({ savedViews: s.savedViews.filter((_, i) => i !== index) })),
  renameView: (index, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({
      savedViews: s.savedViews.map((v, i) => (i === index ? { ...v, name: trimmed } : v)),
    }));
  },
  setSavedViews: (views) => set({ savedViews: views.slice(0, MAX_SAVED_VIEWS) }),

  cameraCommand: null,
  sendCamera: (command) =>
    set((s) => ({ cameraCommand: { command, nonce: (s.cameraCommand?.nonce ?? 0) + 1 } })),

  revealRequest: null,
  revealInItems: (key) =>
    set((s) => ({ revealRequest: { key, nonce: (s.revealRequest?.nonce ?? 0) + 1 } })),

  renameRequest: null,
  renameInItems: (key) =>
    set((s) => ({ renameRequest: { key, nonce: (s.renameRequest?.nonce ?? 0) + 1 } })),
  colourDialogBodyIds: null,
  setColourDialog: (bodyIds) => set({ colourDialogBodyIds: bodyIds }),

  shortcutOverlay: false,
  setShortcutOverlay: (open) => set({ shortcutOverlay: open }),
  homeOpen: usePreferences.getState().showHomeOnStartup,
  setHomeOpen: (open) => set({ homeOpen: open }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  notice: null,
  notify: (text, tone = 'info') =>
    set((s) => ({ notice: { text, tone, nonce: (s.notice?.nonce ?? 0) + 1 } })),
  clearNotice: () => set({ notice: null }),
}));

/** A saved view's section state from a project file, or `null` when absent/malformed. */
export function parseSavedSection(raw: unknown): SavedSection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const vec = (v: unknown): v is Triple =>
    Array.isArray(v) && v.length === 3 && (v as unknown[]).every(finite);
  if (typeof s.enabled !== 'boolean' || !['X', 'Y', 'Z'].includes(s.axis as string)) return null;
  if (!finite(s.offset) || typeof s.flipped !== 'boolean') return null;
  let plane: SavedSection['plane'] = null;
  if (s.plane !== null && s.plane !== undefined) {
    const p = s.plane as Record<string, unknown>;
    if (!vec(p.normal) || !vec(p.origin) || typeof p.label !== 'string') return null;
    plane = { normal: [...p.normal] as Triple, origin: [...p.origin] as Triple, label: p.label };
  }
  return {
    enabled: s.enabled,
    axis: s.axis as SavedSection['axis'],
    offset: s.offset,
    flipped: s.flipped,
    plane,
    sectionOnly: s.sectionOnly === true,
  };
}

/** Validates saved views read from a project file; drops malformed entries. */
export function parseSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: SavedView[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const pose = e.pose as Record<string, unknown> | undefined;
    if (typeof e.name !== 'string' || typeof pose !== 'object' || pose === null) continue;
    const target = pose.target as unknown;
    if (
      !Array.isArray(target) ||
      target.length !== 3 ||
      !(target as unknown[]).every(finite) ||
      !finite(pose.distance) ||
      pose.distance <= 0 ||
      !finite(pose.yaw) ||
      !finite(pose.pitch)
    ) {
      continue;
    }
    const section = parseSavedSection(e.section);
    out.push({
      name: e.name,
      pose: {
        target: [target[0] as number, target[1] as number, target[2] as number],
        distance: pose.distance,
        yaw: pose.yaw,
        pitch: pose.pitch,
        ...(finite(pose.roll) ? { roll: pose.roll } : {}),
        ...(finite(pose.fov) ? { fov: pose.fov } : {}),
      },
      ...(section ? { section } : {}),
    });
    if (out.length >= MAX_SAVED_VIEWS) break;
  }
  return out;
}
