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
import type { Body, EdgeInfo, EvaluationResult, FaceInfo } from '../kernel/types.js';
import type { Feature } from '../model/document.js';
import { isPreviewTool, useAssemblerStore } from '../model/store.js';
import { getViewportProbe, type ScreenPoint } from '../viewport/automation.js';
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
  /** A visible point of a drag handle: extrude arrow, fillet/chamfer, shell or section plane. */
  handleAnchor(handle: 'extrude' | 'blend' | 'shell' | 'section'): ScreenPoint | null;
  /** Bodies currently displayed (the active tool's preview if there is one). */
  bodies(): { id: string; name: string; volume: number; min: number[]; max: number[] }[];
  faces(bodyId: string): FaceListing[];
  edges(bodyId: string): EdgeListing[];
  /** Resolves once no kernel evaluation/preview is outstanding and that state is drawn. */
  waitForKernelIdle(): Promise<void>;
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
    waitForKernelIdle: async () => {
      await store.getState().whenSettled();
      // Let React commit and the viewport draw (and pick-render) the settled state.
      await nextFrame();
      await (getViewportProbe()?.nextFrame() ?? nextFrame());
    },
  };
}
