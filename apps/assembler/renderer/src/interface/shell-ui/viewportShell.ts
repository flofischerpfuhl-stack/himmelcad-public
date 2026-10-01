/**
 * The shell's side of the viewport (`platform/viewport/viewportHooks.ts`):
 * the workspace state the viewport reads (camera commands, Select Through,
 * Save View, toasts, the live pose for saved views) and the History "Fix…"
 * session's viewport part (its ghost of the missing reference and the click
 * that picks the replacement). Registered by `module.ui.ts`.
 */
import type { Vec3 } from '../../platform/viewport/math.js';
import type { SceneDatum } from '../../platform/viewport/scene.js';
import type {
  ViewportClickHandler,
  ViewportDatumProvider,
  ViewportShell,
} from '../../platform/viewport/viewportHooks.js';
import { applyFixPick, useFixStore } from './fixReference.js';
import { setCameraPoseProbe, useWorkspaceStore } from './workspace.js';

export const SHELL_VIEWPORT: ViewportShell = {
  cameraCommand: () => useWorkspaceStore.getState().cameraCommand,
  subscribeCameraCommand: (onChange) =>
    useWorkspaceStore.subscribe((s, previous) => {
      if (s.cameraCommand !== previous.cameraCommand) onChange();
    }),
  sendCamera: (command) => useWorkspaceStore.getState().sendCamera(command),
  useSelectThrough: () => useWorkspaceStore((s) => s.selectThrough),
  selectThrough: () => useWorkspaceStore.getState().selectThrough,
  setSelectThrough: (on) => useWorkspaceStore.getState().setSelectThrough(on),
  saveCurrentView: () => {
    useWorkspaceStore.getState().saveCurrentView();
  },
  setCameraPoseProbe,
};

/** History "Fix…": the missing reference's last known place, drawn in the error colour. */
export const FIX_GHOST_DATUMS: ViewportDatumProvider = {
  id: 'shell.fix',
  datums: (s) => {
    const session = useFixStore.getState().session;
    const ghost = session?.missing.ghost;
    if (!session || !ghost || s.activeTool) return [];
    const base = { featureId: `fix:${session.featureId}`, state: 'error' as const, ghost: true };
    if (ghost.kind === 'plane') {
      return [
        { ...base, kind: 'plane', frame: ghost.frame, center: ghost.center, size: ghost.size },
      ];
    }
    if (ghost.kind === 'axis') {
      const frame = { origin: ghost.point, u: ghost.dir, v: ghost.dir, normal: ghost.dir };
      return [{ ...base, kind: 'axis', frame, center: ghost.point, size: ghost.size }];
    }
    // A point: a small cross of two segments.
    const p = ghost.point;
    return (
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as Vec3[]
    ).map(
      (dir, i): SceneDatum => ({
        ...base,
        featureId: `${base.featureId}:${i}`,
        kind: 'axis',
        frame: { origin: p, u: dir, v: dir, normal: dir },
        center: p,
        size: 3,
      }),
    );
  },
  // The ghost redraws with its session.
  subscribe: (onChange) => useFixStore.subscribe(onChange),
};

/** History "Fix…": the click is the replacement reference. */
export const FIX_PICK_CLICK: ViewportClickHandler = {
  id: 'shell.fix',
  order: 300,
  click: ({ item }) => {
    if (!useFixStore.getState().session) return false;
    if (item) void applyFixPick(item);
    return true;
  },
};
