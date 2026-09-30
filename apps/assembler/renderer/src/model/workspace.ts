/**
 * Workspace view state of the open project (interaction research §7
 * `workspaceViewState`): Select Through, saved views, camera commands for
 * the viewport and panel requests such as "Reveal in Items". Kept out of
 * `store.ts` (the document/tool store): none of it is geometry, none of it
 * is undoable. Saved views are written into the project file's `viewState`
 * (see `project/projectStore.ts`), the rest resets with the session.
 */
import { create } from 'zustand';

import type { CameraPose } from '../viewport/camera.js';
import { usePreferences } from './preferences.js';
import type { Vec3 } from '../viewport/math.js';

export const MAX_SAVED_VIEWS = 8;

export interface SavedView {
  name: string;
  pose: CameraPose;
}

/** One-shot camera instruction for the viewport (applied once per `nonce`). */
export type CameraCommand =
  | { kind: 'home' }
  | { kind: 'fitAll' }
  /** Frames the selection (or everything when nothing is selected). */
  | { kind: 'fitSelection' }
  | { kind: 'direction'; direction: Vec3 }
  | { kind: 'roll'; degrees: number }
  | { kind: 'pose'; pose: CameraPose }
  /** Looks straight at a face and frames it (Space over a face). */
  | { kind: 'lookAtFace'; bodyId: string; faceKey: string }
  /** Looks along `-direction` (eye on the `direction` side) and frames the visible model (Look at section). */
  | { kind: 'lookAlong'; direction: Vec3 };

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
    set({
      savedViews: [
        ...views,
        {
          name: trimmed ? trimmed : nextViewName(views),
          pose: { ...pose, target: [...pose.target] as [number, number, number] },
        },
      ],
    });
    return true;
  },
  restoreView: (index) => {
    const view = get().savedViews[index];
    if (view) get().sendCamera({ kind: 'pose', pose: view.pose });
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
    });
    if (out.length >= MAX_SAVED_VIEWS) break;
  }
  return out;
}
