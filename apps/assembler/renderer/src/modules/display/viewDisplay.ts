/**
 * Display and section view state ↔ the project file's `viewState`
 * (display mode, edge/hidden-edge/axes toggles, face-aligned section plane,
 * section-only view). Pure; validated field by field so a malformed or
 * newer file never breaks Open — unknown values keep the current setting.
 */
import type { Body, FaceInfo } from '../../foundation/geometry-kernel/types.js';
import { isDisplayMode } from '../../platform/viewport/displayModes.js';
import type { ProjectViewState } from '../../foundation/document/format.js';
import {
  clampXrayOpacity,
  DEFAULT_XRAY_OPACITY,
  isGridPlane,
  type SectionPlane,
  type ViewState,
} from '../../foundation/commands/store.js';

type Vec3 = [number, number, number];

declare module '../../foundation/document/format.js' {
  interface ProjectViewState {
    /** Unknown modes (from newer apps) are ignored on load. */
    displayMode?: 'shaded' | 'wireframe' | 'xray' | 'visualized' | 'zebra' | 'curvature';
    /** Display toggles; absent = defaults. */
    display?: {
      edges?: boolean;
      hiddenEdges?: boolean;
      axes?: boolean;
      /** X-Ray surface opacity 0.05..0.95; absent = the default (0.32). Block 8. */
      xrayOpacity?: number;
      /** Grid plane `XZ` / `YZ`; absent = `XY`. Block 8. */
      gridPlane?: 'XY' | 'XZ' | 'YZ';
    };
  }
  interface ProjectSectionView {
    /** Face-aligned plane (overrides `axis`). */
    plane?: { normal: [number, number, number]; origin: [number, number, number]; label: string };
    /** 2D "section only" view. */
    sectionOnly?: boolean;
  }
}

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

export function parseSectionPlane(raw: unknown): SectionPlane | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isVec3(r.normal) || !isVec3(r.origin)) return null;
  const length = Math.hypot(...r.normal);
  if (!(length > 1e-9)) return null;
  return {
    normal: [r.normal[0] / length, r.normal[1] / length, r.normal[2] / length],
    origin: [r.origin[0], r.origin[1], r.origin[2]],
    label: typeof r.label === 'string' ? r.label : 'Face',
  };
}

/**
 * A section plane on a planar face (normal = the face's outward normal, so
 * the removed side is outside the body) and a starting offset halfway
 * through the body behind the face, so turning it on shows a cut at once.
 * `null` for non-planar faces.
 */
export function sectionPlaneFromFace(
  body: Pick<Body, 'min' | 'max'>,
  face: Pick<FaceInfo, 'normal' | 'centroid'>,
  label: string,
): { plane: SectionPlane; offset: number } | null {
  if (!face.normal) return null;
  const n = face.normal;
  const length = Math.hypot(n[0], n[1], n[2]);
  if (!(length > 1e-9)) return null;
  const normal: Vec3 = [n[0] / length, n[1] / length, n[2] / length];
  const origin: Vec3 = [face.centroid[0], face.centroid[1], face.centroid[2]];
  // Depth of the body behind the face: the box corner deepest along −normal.
  let deepest = 0;
  for (const x of [body.min[0], body.max[0]])
    for (const y of [body.min[1], body.max[1]])
      for (const z of [body.min[2], body.max[2]]) {
        const d =
          (x - origin[0]) * normal[0] + (y - origin[1]) * normal[1] + (z - origin[2]) * normal[2];
        deepest = Math.min(deepest, d);
      }
  return { plane: { normal, origin, label }, offset: deepest / 2 };
}

/** The display/section fields a project file sets (only valid ones). */
export function viewDisplayFromProject(view: ProjectViewState): Partial<ViewState> {
  const out: Partial<ViewState> = {};
  if (isDisplayMode(view.displayMode)) out.displayMode = view.displayMode;
  const display = view.display;
  if (display && typeof display === 'object') {
    if (typeof display.edges === 'boolean') out.edgesVisible = display.edges;
    if (typeof display.hiddenEdges === 'boolean') out.hiddenEdgesVisible = display.hiddenEdges;
    if (typeof display.axes === 'boolean') out.axesVisible = display.axes;
    const xray = clampXrayOpacity(display.xrayOpacity);
    if (xray !== null) out.xrayOpacity = xray;
    if (isGridPlane(display.gridPlane)) out.gridPlane = display.gridPlane;
  }
  const section = view.section;
  if (section && typeof section === 'object') {
    if ('plane' in section) out.sectionPlane = parseSectionPlane(section.plane);
    if (typeof section.sectionOnly === 'boolean') out.sectionOnly = section.sectionOnly;
  }
  return out;
}

/** What {@link viewDisplayFromProject} reads back, from the live view state. */
export function viewDisplayToProject(view: ViewState): {
  displayMode: NonNullable<ProjectViewState['displayMode']>;
  display: NonNullable<ProjectViewState['display']>;
  sectionExtras: Pick<NonNullable<ProjectViewState['section']>, 'plane' | 'sectionOnly'>;
} {
  return {
    displayMode: view.displayMode,
    display: {
      edges: view.edgesVisible,
      hiddenEdges: view.hiddenEdgesVisible,
      axes: view.axesVisible,
      // Only a changed opacity is written: files with the default keep their bytes.
      ...(Math.abs(view.xrayOpacity - DEFAULT_XRAY_OPACITY) > 1e-9
        ? { xrayOpacity: Math.round(view.xrayOpacity * 100) / 100 }
        : {}),
      ...(view.gridPlane !== 'XY' ? { gridPlane: view.gridPlane } : {}),
    },
    sectionExtras: {
      ...(view.sectionPlane
        ? {
            plane: {
              normal: [...view.sectionPlane.normal],
              origin: [...view.sectionPlane.origin],
              label: view.sectionPlane.label,
            },
          }
        : {}),
      sectionOnly: view.sectionOnly,
    },
  };
}
