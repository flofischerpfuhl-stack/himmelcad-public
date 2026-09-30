/**
 * DEV-ONLY automation hook (`window.__assembler`) for cheap, calibration-free
 * screen recordings and UI smoke scripts (Playwright). Installed from
 * `main.tsx` behind `import.meta.env.DEV`; absent from production builds and
 * **not part of the product contract** — the canonical command path for
 * agents is the command registry / future automation API.
 *
 * All screen coordinates are CSS pixels relative to the page viewport, i.e.
 * directly usable with `page.mouse.move(x, y)`.
 */
import type {
  Body,
  EdgeInfo,
  EvaluationResult,
  FaceInfo,
} from '../../foundation/geometry-kernel/types.js';
import type { Feature } from '../../foundation/document/document.js';
import {
  COMMANDS,
  findCommand,
  resolveAdaptive,
  searchCommands,
} from '../../foundation/commands/registry.js';
import { useItemsStore } from '../../foundation/commands/items.js';
import { usePreferences } from '../../interface/shell-ui/preferences.js';
import { isPreviewTool, useAssemblerStore } from '../../foundation/commands/store.js';
import { currentCameraPose, useWorkspaceStore } from '../../interface/shell-ui/workspace.js';
import { usePrintStore } from '../../modules/print/printStore.js';
import type { CameraPose } from '../../platform/viewport/camera.js';
import {
  getViewportProbe,
  type ScreenPoint,
  type ViewportProbe,
} from '../../platform/viewport/automation.js';
import { useFixStore } from '../../interface/shell-ui/fixReference.js';
import { useMeasureStore } from '../../model/measureStore.js';
import { useProjectStore } from '../../interface/shell-ui/project/projectStore.js';
import { useInteropStore } from '../../interop/interopStore.js';
import type { ToolHandleKind } from '../../platform/viewport/picking.js';
import { sketchAutomation, type SketchAutomation } from './sketchAutomation.js';

export interface FaceListing {
  bodyId: string;
  faceKey: string;
  name: string;
  surface: FaceInfo['surface'];
  normal: FaceInfo['normal'];
  centroid: FaceInfo['centroid'];
  area: number;
}

export interface EdgeListing {
  bodyId: string;
  edgeKey: string;
  name: string;
  curve: EdgeInfo['curve'];
  midpoint: EdgeInfo['midpoint'];
  length: number;
  radius: number | null;
}

export interface AssemblerAutomation {
  store: typeof useAssemblerStore;
  /** World point (mm) -> CSS pixel position on the page, `null` if behind the camera. */
  project(worldPoint: [number, number, number]): ScreenPoint | null;
  /** A visible, unoccluded point on the face (via the picking id buffer), or `null`. */
  faceAnchor(ref: { bodyId: string; faceKey?: string; key?: string }): ScreenPoint | null;
  /** A visible, unoccluded point on the edge (via the picking id buffer), or `null`. */
  edgeAnchor(ref: { bodyId: string; edgeKey?: string; key?: string }): ScreenPoint | null;
  /**
   * A visible point of a drag handle: extrude arrow, fillet/chamfer, shell or section plane,
   * a feature-tool handle (`feature:angle`, `feature:offset`, …), a Move/Rotate ring (`ring:0..2`)
   * or the gizmo centre (`pivot`).
   */
  handleAnchor(handle: 'extrude' | ToolHandleKind): ScreenPoint | null;
  /** Bodies currently displayed (the active tool's preview if there is one). */
  bodies(): { id: string; name: string; volume: number; min: number[]; max: number[] }[];
  faces(bodyId: string): FaceListing[];
  edges(bodyId: string): EdgeListing[];
  /** Resolves once no kernel evaluation/preview is outstanding and that state is drawn. */
  waitForKernelIdle(): Promise<void>;
  /** Workspace view state: Select Through, saved views, camera commands, overlays. */
  workspaceStore: typeof useWorkspaceStore;
  /** Item names and folders. */
  itemsStore: typeof useItemsStore;
  /** User preferences (theme, units, navigation preset, projection …). */
  preferences: typeof usePreferences;
  /** The live camera pose. */
  cameraPose(): CameraPose | null;
  /** Print mode: printability report, settings, place-on-plate / auto-orient state. */
  printStore: typeof usePrintStore;
  /**
   * Renderer counters (frames drawn, last frame's CPU ms, uploads, draw calls,
   * scene build ms); `finish` makes every frame wait for the GPU (measurement).
   */
  viewportStats(finish?: boolean): ReturnType<NonNullable<ViewportProbe['stats']>> | null;
  /** Mean ms per frame over `frames` back-to-back renders (GPU included; see `Viewport.tsx`). */
  viewportBenchmark(frames: number): number | null;
  /** Measure panel state (pins, points, Point tool). */
  measureStore: typeof useMeasureStore;
  /** Project file state: New/Open/Save, templates (`newFromTemplate`), crash recovery offer. */
  projectStore: typeof useProjectStore;
  /** Import/export: `importFiles`, the running job (Cancel), DXF/STEP dialogs, `convertMeshToSolid`. */
  interopStore: typeof useInteropStore;
  /** The command registry as the UI sees it (gap inventory / smoke scripts). */
  commands: {
    /** Every registered command: id, label, group, shortcut, keywords. */
    list(): { id: string; label: string; group: string; shortcut?: string; keywords?: string[] }[];
    /** Adaptive toolbar order for the current selection (`resolveAdaptive`), with recommendation flags. */
    adaptive(): { id: string; label: string; recommended: boolean; priority: number }[];
    /** Command search results for `query` (enabled first), as the search popover shows them. */
    search(query: string): { id: string; label: string; enabled: boolean; reason?: string }[];
    /** Runs a command if it is enabled; returns whether it ran. */
    run(id: string): boolean;
  };
  /** Construction planes/axes as evaluated (`EvaluatedDatum`) — the shown evaluation. */
  datums(): { featureId: string; kind: 'plane' | 'axis'; center: number[]; size: number }[];
  /** A visible pixel of a construction plane's/axis' outline (pick ribbon), or `null`. */
  datumAnchor(featureId: string): ScreenPoint | null;
  /** History `Fix…` session (`model/fixReference.ts`): `session`, `end`. */
  fixStore: typeof useFixStore;
}

declare global {
  interface Window {
    /** DEV-only automation hook; see `devtools/automationHook.ts`. */
    __assembler?: AssemblerAutomation & SketchAutomation;
  }
}

function displayed(): EvaluationResult {
  const state = useAssemblerStore.getState();
  const tool = state.activeTool;
  return (isPreviewTool(tool) ? tool.previewEvaluation : null) ?? state.evaluation;
}

function bodyOf(bodyId: string): Body | undefined {
  return displayed().bodies.find((b) => b.id === bodyId);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function featureLabel(key: string, features: readonly Feature[]): string {
  const featureId = key.split(':')[0] ?? key;
  const role = key.split(':')[1] ?? '';
  const name = features.find((f) => f.id === featureId)?.name ?? featureId;
  return role ? `${name} ${role}` : name;
}

function axisName(normal: readonly number[] | null): string {
  if (!normal) return '';
  const labels = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(Math.abs(normal[i]!) - 1) < 1e-6)
      return `${normal[i]! > 0 ? '+' : '-'}${labels[i]}`;
  }
  return `(${normal.map(round).join(', ')})`;
}

function describeFace(face: FaceInfo, features: readonly Feature[]): string {
  const where = face.normal
    ? `${axisName(face.normal)} at ${face.centroid.map(round).join(', ')}`
    : `at ${face.centroid.map(round).join(', ')}`;
  return `${featureLabel(face.key, features)} · ${face.surface} ${where} · ${round(face.area)} mm²`;
}

function describeEdge(edge: EdgeInfo): string {
  const at = edge.midpoint.map(round).join(', ');
  if (edge.curve === 'circle' && edge.radius) {
    const full = Math.abs(edge.length - 2 * Math.PI * edge.radius) < 1e-6 * edge.length + 1e-6;
    return full
      ? `Circle Ø${round(edge.radius * 2)} at ${at}`
      : `Arc R${round(edge.radius)} at ${at}`;
  }
  if (edge.curve === 'line')
    return `Line ${axisName(edge.direction)} ${round(edge.length)} mm at ${at}`;
  return `${edge.curve} ${round(edge.length)} mm at ${at}`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function installAutomationHook(store: typeof useAssemblerStore): void {
  window.__assembler = {
    ...sketchAutomation(),
    store,
    project: (point) => getViewportProbe()?.project(point) ?? null,
    faceAnchor: (ref) => {
      const key = ref.faceKey ?? ref.key;
      return (
        getViewportProbe()?.anchor(
          (t) => t.kind === 'face' && t.bodyId === ref.bodyId && t.faceKey === key,
        ) ?? null
      );
    },
    edgeAnchor: (ref) => {
      const key = ref.edgeKey ?? ref.key;
      return (
        getViewportProbe()?.anchor(
          (t) => t.kind === 'edge' && t.bodyId === ref.bodyId && t.edgeKey === key,
        ) ?? null
      );
    },
    handleAnchor: (handle) =>
      getViewportProbe()?.anchor((t) =>
        handle === 'extrude'
          ? t.kind === 'extrudeHandle'
          : t.kind === 'toolHandle' && t.handle === handle,
      ) ?? null,
    bodies: () =>
      displayed().bodies.map((b) => ({
        id: b.id,
        name: b.name,
        volume: b.volume,
        min: [...b.min],
        max: [...b.max],
      })),
    faces: (bodyId) => {
      const features = store.getState().features;
      return (bodyOf(bodyId)?.faces ?? []).map((face) => ({
        bodyId,
        faceKey: face.key,
        name: describeFace(face, features),
        surface: face.surface,
        normal: face.normal,
        centroid: face.centroid,
        area: face.area,
      }));
    },
    edges: (bodyId) =>
      (bodyOf(bodyId)?.edges ?? []).map((edge) => ({
        bodyId,
        edgeKey: edge.key,
        name: describeEdge(edge),
        curve: edge.curve,
        midpoint: edge.midpoint,
        length: edge.length,
        radius: edge.radius ?? null,
      })),
    workspaceStore: useWorkspaceStore,
    itemsStore: useItemsStore,
    printStore: usePrintStore,
    preferences: usePreferences,
    cameraPose: () => currentCameraPose(),
    viewportStats: (finish) => getViewportProbe()?.stats?.(finish) ?? null,
    viewportBenchmark: (frames) => getViewportProbe()?.benchmark?.(frames) ?? null,
    measureStore: useMeasureStore,
    projectStore: useProjectStore,
    interopStore: useInteropStore,
    datums: () =>
      (displayed().datums ?? []).map((d) => ({
        featureId: d.featureId,
        kind: d.kind,
        center: [...d.center],
        size: d.size,
      })),
    datumAnchor: (featureId) =>
      getViewportProbe()?.anchor((t) => t.kind === 'datum' && t.featureId === featureId) ?? null,
    fixStore: useFixStore,
    commands: {
      list: () =>
        COMMANDS.map((c) => ({
          id: c.id,
          label: c.label,
          group: c.group,
          ...(c.shortcut ? { shortcut: c.shortcut } : {}),
          ...(c.keywords ? { keywords: [...c.keywords] } : {}),
        })),
      adaptive: () => {
        const state = store.getState();
        return resolveAdaptive(state).map((c) => {
          const availability = c.availability(state);
          return {
            id: c.id,
            label: c.label,
            recommended: availability.recommended === true,
            priority: availability.priority ?? 0,
          };
        });
      },
      search: (query) =>
        searchCommands(query, store.getState()).map((r) => ({
          id: r.command.id,
          label: r.command.label,
          enabled: r.enabled,
          ...(r.reason !== undefined ? { reason: r.reason } : {}),
        })),
      run: (id) => {
        const state = store.getState();
        const command = findCommand(id);
        if (!command || !command.availability(state).enabled) return false;
        command.run(state);
        state.pushRecentCommand(command.id);
        return true;
      },
    },
    waitForKernelIdle: async () => {
      await store.getState().whenSettled();
      // Let React commit and the viewport draw (and pick-render) the settled state.
      await nextFrame();
      await (getViewportProbe()?.nextFrame() ?? nextFrame());
    },
  };
}
