/**
 * Turns document/view/selection state into the GL batches `gl.ts` draws,
 * plus the picking id table for the same frame. Kept separate from
 * `Viewport.tsx` so the "what does the scene look like" logic is easy to
 * read without React/pointer-event noise. Not unit tested (feeds straight
 * into WebGL) but written as pure data-in/data-out; the pure pieces it
 * builds on (`bodyGeometry.ts`, `displayModes.ts`, `camera.ts#depthRange`,
 * `toolAnchors.ts`) are.
 *
 * Body geometry is passed to the GPU as the kernel's own stable arrays
 * (indexed mesh, concatenated edges, silhouette candidates), so a frame
 * allocates almost nothing for bodies; per-frame arrays are limited to the
 * grid, highlights and tool chrome.
 */
import type { Body, EvaluatedSketch } from '../../foundation/geometry-kernel/types.js';
import type { Bounds3 } from '../../model/modeling.js';
import { referenceMeshIdOf } from '../../model/referenceMesh.js';
import type {
  DisplayMode,
  SectionAxis,
  SectionPlane,
  SelectionItem,
} from '../../foundation/commands/store.js';
import {
  billboardEye,
  cameraBasis,
  depthRange,
  eyeOf,
  isOrthographic,
  viewHeightAt,
  viewProjectionMatrix,
  worldPerPixel as cameraWorldPerPixel,
  type CameraPose,
} from './camera.js';
import {
  bodyGeometry,
  sectionContour,
  silhouetteCandidates,
  vertexCurvature,
} from './bodyGeometry.js';
import {
  curvatureRange,
  materialPreset,
  SHADED_MATERIAL,
  type MaterialId,
} from './displayModes.js';
import { buildEdgeRibbon, buildPolylineRibbon, buildScreenRibbon } from './geometry.js';
import {
  sectionClip,
  sectionOutline,
  sectionPlaneDistance,
  type AxisHandle,
  type SectionView,
} from '../../viewport/toolAnchors.js';
import { PickTable, type PickTarget, type ToolHandleKind } from './picking.js';
import type {
  DrawBatch,
  GroundShadow,
  IdBatch,
  LineBatch,
  RGB,
  SceneFrame,
  SectionCaps,
  Shading,
  TriBatch,
} from './gl.js';
import type { ViewportColors } from './theme.js';
import type { Vec3 } from './math.js';

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
  /** Visible model bounds: the plane outline is limited to them (+ margin). */
  bounds: Bounds3 | null;
  /** Face-aligned plane (overrides `axis`). */
  plane?: SectionPlane | null;
  /** 2D "section only": caps and cut outlines, no bodies. */
  sectionOnly?: boolean;
}

/** A tool drag handle (fillet/chamfer size, shell thickness, section offset). */
export interface AxisHandleState extends AxisHandle {
  hovered: boolean;
}

export interface MovePreviewState {
  bodyId: string;
  delta: { dx: number; dy: number; dz: number };
}

/** Extrude tool's draggable arrow handle: shaft+arrowhead from `origin` along `normal`. */
export interface ExtrudeHandleState {
  origin: Vec3;
  normal: Vec3;
  distance: number;
  hovered: boolean;
}

/** Move tool's three draggable axis arrows, anchored at the body's (translated) centre. */
export interface MoveHandleState {
  origin: Vec3;
  delta: { dx: number; dy: number; dz: number };
  hoveredAxis: 0 | 1 | 2 | null;
  /** Gizmo orientation (auto-orientation); default world X, Y, Z. */
  axes?: readonly [Vec3, Vec3, Vec3];
  /** Axes without an arrow (a sketch profile does not leave its plane). */
  hiddenAxes?: readonly (0 | 1 | 2)[];
  /** Plane tiles (move in a plane), by the index of the plane's normal axis. */
  tiles?: readonly (0 | 1 | 2)[];
  hoveredTile?: 0 | 1 | 2 | null;
}

/** In-progress sketch outline/fill (rectangle corners or a closed circle outline) + the snap indicator dot, drawn on top of everything. */
export interface SketchPreviewState {
  corners: readonly [Vec3, Vec3, Vec3, Vec3] | null;
  cursorPoint: Vec3 | null;
  /** Closed outline (first point not repeated) filled as a fan around `center`. */
  outline?: readonly Vec3[] | null;
  /** Placed circle centre (drawn as a dot, with a radius line to the cursor). */
  center?: Vec3 | null;
}

export interface SceneInput {
  colors: ViewportColors;
  pose: CameraPose;
  aspect: number;
  viewportHeightPx: number;
  bodies: readonly Body[];
  sketches: readonly EvaluatedSketch[];
  hiddenBodyIds: readonly string[];
  isolatedBodyIds: readonly string[] | null;
  displayMode: DisplayMode;
  section: SectionState;
  gridVisible: boolean;
  gridStep: number;
  selection: readonly SelectionItem[];
  hover: SelectionItem | null;
  movePreview: MovePreviewState | null;
  /** Extrude-preview provisional body id (rendered translucent with an accent outline). */
  extrudePreviewBodyId: string | null;
  /** Draggable arrow handle for the active extrude tool, if any. */
  extrudeHandle: ExtrudeHandleState | null;
  /** Draggable axis arrows for the active move tool, if any. */
  moveHandle: MoveHandleState | null;
  /** In-progress sketch-rectangle outline + snap dot for the active sketch tool, if any. */
  sketchPreview: SketchPreviewState | null;
  /**
   * Straight sketch lines become pick targets (`sketchLine`) and are drawn
   * emphasised — while a tool takes an axis (Revolve, Pattern).
   */
  pickSketchLines?: boolean;
  /** Device pixel ratio (`viewportHeightPx` is in device pixels); selection lines are ≈3 CSS px wide. */
  dpr?: number;
  /** Bodies of a fillet/chamfer/shell/boolean preview: opaque, edges in the preview accent. */
  previewAccentBodyIds?: readonly string[];
  /** Faces whose key starts with this prefix (created by the provisional feature) get an accent tint. */
  previewFaceKeyPrefix?: string | null;
  /** Committed bodies drawn only as faint accent outlines (e.g. boolean tool bodies being consumed). */
  ghostBodies?: readonly Body[];
  /** Drag handles of the active tool / the section plane. */
  axisHandles?: readonly AxisHandleState[];
  /** Bodies the running tool creates (translucent, preview accent), like an extrude preview. */
  previewNewBodyIds?: readonly string[];
  /** Angle drags: Move/Rotate rings, revolve and circular-pattern arcs. */
  angleHandles?: readonly AngleHandleState[];
  /** Reference geometry of the running tool: axis lines and planes. */
  guides?: { lines: readonly [Vec3, Vec3][]; planes: readonly [Vec3, Vec3, Vec3, Vec3][] } | null;
  /** Move/Rotate gizmo centre (the rotation pivot), draggable onto geometry. */
  pivot?: { point: Vec3; hovered: boolean; pickable?: boolean } | null;
  /** Multiplies the edge pick widths (e.g. 2 for touch/coarse pointers). Default 1. */
  hitScale?: number;
  /** B-rep edge lines on shaded bodies. Default `true`. */
  edgesVisible?: boolean;
  /** Hidden edges, dashed. Default `false`. */
  hiddenEdgesVisible?: boolean;
  /** World axes. Default `true`. */
  axesVisible?: boolean;
  /** Material per body id ("Visualized"). */
  materials?: ReadonlyMap<string, MaterialId>;
  /** Screen-space ambient occlusion and the ground contact shadow. Default `true`. */
  highQuality?: boolean;
  /** Measurement geometry of the Measure panel (pinned items, the current pick). */
  measureLines?: readonly LineBatch[];
  /** Image export: no picking data. */
  forExport?: boolean;
  /**
   * Mode overlays on body surfaces (e.g. Print mode overhangs), drawn right
   * after the shaded bodies — below edges and selection highlights.
   */
  extraOverlays?: readonly DrawBatch[];
  /** Mode overlays drawn after everything else (e.g. the translucent build volume). */
  extraOverlaysLast?: readonly DrawBatch[];
  /**
   * Geometry a feature error points at (the edge a fillet fails on, the
   * outline of a face a draft cannot tilt) as world line-segment pairs of
   * the committed model, drawn in the error colour.
   */
  errorHighlight?: { segments: readonly Float32Array[] } | null;
  /**
   * Construction planes and axes (`model/construction.ts`): a translucent
   * square with an outline / a segment, picked by their outline. `ghost`
   * datums are drawn dashed-faint and not picked (the last known place of a
   * missing reference while History "Fix…" runs).
   */
  datums?: readonly SceneDatum[];
}

export interface SceneDatum {
  featureId: string;
  kind: 'plane' | 'axis';
  frame: { origin: Vec3; u: Vec3; v: Vec3; normal: Vec3 };
  center: Vec3;
  size: number;
  state: 'normal' | 'hovered' | 'selected' | 'error';
  ghost?: boolean;
}

/** An angle handle: arc about `axis` through `center`, from `ref` by `value` degrees. */
export interface AngleHandleState {
  handle: ToolHandleKind;
  center: Vec3;
  axis: Vec3;
  ref: Vec3;
  radius: number;
  value: number;
  /** Full rotation ring (the gizmo) instead of a value arc with a knob. */
  ring: boolean;
  /** Ring colour; `null` = the tool accent. */
  color: readonly [number, number, number] | null;
  hovered: boolean;
}

export interface BuiltScene {
  frame: SceneFrame;
  idBatches: IdBatch[];
  pickTable: PickTable;
}

/** Width of selected/hovered edges, CSS pixels. */
const HIGHLIGHT_EDGE_PX = 3;
/** Width of body edges and silhouettes, CSS pixels. */
const EDGE_PX = 1.25;
/** Edge pick tolerance, CSS pixels (either side ≈ half). */
const EDGE_HIT_PX = 8;
/** Relative depth offset of lines towards the eye (see `SceneFrame.depth.lineBias`). */
const LINE_DEPTH_BIAS = 5e-4;

function isSelected(selection: readonly SelectionItem[], item: SelectionItem): boolean {
  return selection.some((s) => selectionEquals(s, item));
}

function selectionEquals(a: SelectionItem, b: SelectionItem): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'body':
      return b.kind === 'body' && a.bodyId === b.bodyId;
    case 'face':
      return b.kind === 'face' && a.bodyId === b.bodyId && a.faceKey === b.faceKey;
    case 'edge':
      return b.kind === 'edge' && a.bodyId === b.bodyId && a.edgeKey === b.edgeKey;
    case 'sketchProfile':
      return (
        b.kind === 'sketchProfile' && a.featureId === b.featureId && a.regionKey === b.regionKey
      );
    case 'feature':
      return false;
    case 'mesh':
      return b.kind === 'mesh' && a.meshId === b.meshId;
    default:
      return false;
  }
}

function lineColors(vertexCount: number, color: readonly [number, number, number], alpha: number) {
  const colors = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i += 1) colors.set([color[0], color[1], color[2], alpha], i * 4);
  return colors;
}

function rgba(color: readonly [number, number, number], alpha: number) {
  return [color[0], color[1], color[2], alpha] as const;
}

function pushFlatLine(
  target: { positions: number[]; colors: number[] },
  a: Vec3,
  b: Vec3,
  color: readonly [number, number, number],
  alpha: number,
): void {
  target.positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  target.colors.push(color[0], color[1], color[2], alpha, color[0], color[1], color[2], alpha);
}

function pushFlatQuad(
  target: { positions: number[]; colors: number[] },
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  color: readonly [number, number, number],
  alpha: number,
): void {
  const [a, b, c, d] = corners;
  const tris: Vec3[] = [a, b, c, a, c, d];
  for (const p of tris) target.positions.push(p[0], p[1], p[2]);
  for (let i = 0; i < 6; i += 1) target.colors.push(color[0], color[1], color[2], alpha);
}

const arraySerials = new WeakMap<object, number>();
let nextArraySerial = 1;
/** A stable small number per array object (shadow-map cache key). */
function arraySerial(array: object): number {
  let serial = arraySerials.get(array);
  if (serial === undefined) {
    serial = nextArraySerial++;
    arraySerials.set(array, serial);
  }
  return serial;
}

function unionBounds(bodies: readonly Body[]): Bounds3 | null {
  if (bodies.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  return { min, max };
}

function expandBounds(bounds: Bounds3 | null, points: readonly Vec3[]): Bounds3 | null {
  if (points.length === 0) return bounds;
  const min: [number, number, number] = bounds ? [...bounds.min] : [...points[0]!];
  const max: [number, number, number] = bounds ? [...bounds.max] : [...points[0]!];
  for (const p of points) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  }
  return { min, max };
}

function padBounds(bounds: Bounds3 | null): Bounds3 | null {
  if (!bounds) return null;
  const diag = Math.hypot(...sub3(bounds.max, bounds.min));
  // Tool chrome is included explicitly (handle points); this only covers
  // section-plane margins and line widths.
  const pad = Math.max(1, diag * 0.12);
  return {
    min: [bounds.min[0] - pad, bounds.min[1] - pad, bounds.min[2] - pad],
    max: [bounds.max[0] + pad, bounds.max[1] + pad, bounds.max[2] + pad],
  };
}

/** Builds the full frame of GL batches plus the picking table for one render. */
export function buildScene(input: SceneInput): BuiltScene {
  const pickTable = new PickTable();
  // Orthographic views: a far eye along the view direction (parallel rays) for ribbons/billboards.
  const eye = billboardEye(input.pose);
  const hitScale = input.hitScale ?? 1;
  const edgeHitWidth = (distance: number): number => baseEdgeHitWidth(distance) * hitScale;

  const lit: TriBatch[] = [];
  const underlay: DrawBatch[] = [];
  const flat: DrawBatch[] = [];
  const idBatches: IdBatch[] = [];
  /** Highlights drawn after all bodies, so no later body pass paints over them. */
  const overlays: DrawBatch[] = [];

  const dpr = input.dpr ?? 1;
  const cssHeight = Math.max(1, input.viewportHeightPx / dpr);
  const worldPerPixel = (distance: number): number =>
    cameraWorldPerPixel(input.pose, distance, cssHeight);
  /** A selection/hover highlight line: crisp where visible plus an "on top" ghost. */
  const highlightLines = (
    segments: Float32Array,
    color: readonly [number, number, number],
    widthPx = HIGHLIGHT_EDGE_PX,
    range?: { first: number; count: number },
    ghostAlpha = 0.4,
  ): void => {
    if (segments.length === 0) return;
    const base = { kind: 'lines' as const, segments, widthPx, ...(range ?? {}) };
    overlays.push({ ...base, color: rgba(color, 1), depthTest: true });
    // "On top" ghost: the hidden part of a selected edge stays readable.
    overlays.push({ ...base, color: rgba(color, ghostAlpha), depthTest: false });
  };
  const thickEdges = (
    segments: Float32Array,
    color: readonly [number, number, number],
    widthPx = HIGHLIGHT_EDGE_PX,
  ): void => highlightLines(segments, color, widthPx);
  const accentBodies = new Set(input.previewAccentBodyIds ?? []);
  const newPreviewBodies = new Set(input.previewNewBodyIds ?? []);

  const hiddenSet = new Set(input.hiddenBodyIds);
  const isolatedSet = input.isolatedBodyIds ? new Set(input.isolatedBodyIds) : null;
  const visibleBodies = input.bodies.filter((b) => {
    if (hiddenSet.has(b.id)) return false;
    if (isolatedSet && !isolatedSet.has(b.id)) return false;
    return true;
  });
  const drawnBounds = unionBounds(visibleBodies);

  const mode = input.displayMode;
  const isWireframe = mode === 'wireframe';
  const isXray = mode === 'xray';
  const sectionOn = input.section.enabled;
  const sectionOnly = sectionOn && (input.section.sectionOnly ?? false);
  const edgesOn = isWireframe || (input.edgesVisible ?? true);
  const shading: Shading = mode === 'zebra' ? 'zebra' : mode === 'curvature' ? 'curvature' : 'lit';
  const highQuality = input.highQuality ?? true;
  const lineInk = isWireframe || isXray ? input.colors.wire : input.colors.bodyEdge;

  // ---- Grid (XY plane, z = 0) ----------------------------------------------
  const gridExtent = Math.min(20000, Math.max(200, input.pose.distance * 6));
  if (input.gridVisible && !sectionOnly) {
    const step = Math.max(0.001, input.gridStep);
    const extent = gridExtent;
    const maxLines = 400;
    const count = Math.min(maxLines, Math.ceil(extent / step));
    const minor = { positions: [] as number[], colors: [] as number[] };
    const major = { positions: [] as number[], colors: [] as number[] };
    const fadeRadius = extent;
    for (let i = -count; i <= count; i += 1) {
      const coord = i * step;
      if (Math.abs(coord) > extent) continue;
      const isMajor = i % 10 === 0;
      const target = isMajor ? major : minor;
      const color = isMajor ? input.colors.gridMajor : input.colors.gridMinor;
      const fadeAt = (x: number, y: number): number => {
        const d = Math.hypot(x - input.pose.target[0], y - input.pose.target[1]);
        return Math.max(0, 1 - d / fadeRadius) * (isMajor ? 0.55 : 0.28);
      };
      pushFlatLine(
        target,
        [coord, -extent, 0],
        [coord, extent, 0],
        color,
        Math.min(fadeAt(coord, -extent), fadeAt(coord, extent)) || 0.05,
      );
      pushFlatLine(
        target,
        [-extent, coord, 0],
        [extent, coord, 0],
        color,
        Math.min(fadeAt(-extent, coord), fadeAt(extent, coord)) || 0.05,
      );
    }
    for (const lines of [minor, major]) {
      if (lines.positions.length === 0) continue;
      underlay.push({
        positions: new Float32Array(lines.positions),
        colors: new Float32Array(lines.colors),
        mode: 'lines',
        depthTest: true,
        noClip: true,
      });
    }
  }

  // ---- World axes (Shapr3D-style red/green/blue) ---------------------------
  if ((input.axesVisible ?? true) && !sectionOnly) {
    const axisLen = Math.max(50, input.pose.distance * 0.6);
    const axes: { color: readonly [number, number, number]; to: Vec3 }[] = [
      { color: input.colors.axisX, to: [axisLen, 0, 0] },
      { color: input.colors.axisY, to: [0, axisLen, 0] },
      { color: input.colors.axisZ, to: [0, 0, axisLen] },
    ];
    for (const axis of axes) {
      underlay.push({
        kind: 'lines',
        segments: new Float32Array([0, 0, 0, axis.to[0], axis.to[1], axis.to[2]]),
        color: rgba(axis.color, 0.9),
        widthPx: 1.5,
        depthTest: true,
        noClip: true,
      });
    }
  }

  // ---- Section clip -----------------------------------------------------
  // Material on the positive side of `normal` (offset along it) is cut away;
  // Flip reverses the normal. The plane's outline covers the visible model's
  // extent plus a margin, not the whole screen.
  const sectionView: SectionView = {
    axis: input.section.axis,
    offset: input.section.offset,
    flipped: input.section.flipped,
    plane: input.section.plane ?? null,
  };
  const clipPlane = sectionClip(sectionView);
  const clip = { enabled: sectionOn, normal: clipPlane.normal, offset: clipPlane.offset };
  const sectionPlaneBatches: DrawBatch[] = [];
  let caps: SectionCaps | null = null;
  if (sectionOn) {
    const corners = sectionOutline(sectionView, input.section.bounds);
    if (!sectionOnly) {
      const outline = { positions: [] as number[], colors: [] as number[] };
      for (let i = 0; i < 4; i += 1) {
        pushFlatLine(outline, corners[i]!, corners[(i + 1) % 4]!, input.colors.sketchOutline, 0.85);
      }
      const fill = { positions: [] as number[], colors: [] as number[] };
      pushFlatQuad(fill, corners, input.colors.sketchOutline, 0.07);
      // Drawn after the bodies (depth-tested) so the model shows through the tint.
      sectionPlaneBatches.push(
        {
          positions: new Float32Array(fill.positions),
          colors: new Float32Array(fill.colors),
          mode: 'triangles',
          depthTest: true,
          noClip: true,
        },
        {
          positions: new Float32Array(outline.positions),
          colors: new Float32Array(outline.colors),
          mode: 'lines',
          depthTest: false,
          noClip: true,
        },
      );
    }
    if (!isWireframe && !isXray) {
      caps = {
        bodies: [],
        plane: sectionOutline(sectionView, drawnBounds ?? input.section.bounds),
        hatch: true,
      };
    }
  }
  const contourNormal: Vec3 = sectionView.plane
    ? sectionView.plane.normal
    : input.section.axis === 'X'
      ? [1, 0, 0]
      : input.section.axis === 'Y'
        ? [0, 1, 0]
        : [0, 0, 1];
  const contourOffset = sectionPlaneDistance(sectionView);

  // ---- Bodies ---------------------------------------------------------------
  const bodyLines: DrawBatch[] = [];
  const hiddenLines: DrawBatch[] = [];
  const shadowCasters: Body[] = [];
  for (const body of visibleBodies) {
    const isExtrudePreview =
      input.extrudePreviewBodyId === body.id || newPreviewBodies.has(body.id);
    const geometry = bodyGeometry(body);
    const { positions, normals, indices } = body.mesh;
    const rgb = hexToRgb01(body.color);
    const edgeRange = (edgeIndex: number) => geometry.edgeRanges[edgeIndex]!;

    const opaque = !isXray && !isExtrudePreview;
    if (!isWireframe && !sectionOnly) {
      const alpha = isXray ? 0.32 : isExtrudePreview ? 0.55 : 1;
      const materialId = input.materials?.get(body.id);
      lit.push({
        positions,
        normals,
        indices,
        ...(shading === 'curvature' ? { curvature: vertexCurvature(body) } : {}),
        color: rgb,
        alpha,
        depthTest: true,
        depthWrite: opaque,
        polygonOffset: true,
        material:
          mode === 'visualized' ? materialPreset(materialId ?? 'pla').params : SHADED_MATERIAL,
        shading,
      });
      if (opaque) shadowCasters.push(body);
    }
    if (caps && opaque) {
      caps.bodies.push({ positions, indices, color: capColor(rgb) });
    }
    if (sectionOn && !isWireframe) {
      const contour = sectionContour(body, contourNormal, contourOffset);
      if (contour.length > 0) {
        bodyLines.push({
          kind: 'lines',
          segments: contour,
          // Section only: the outline stands on the background, not on a body.
          color: rgba(sectionOnly ? input.colors.wire : lineInk, 1),
          widthPx: sectionOnly ? 1.75 : 1.5,
          depthTest: true,
          noClip: true,
        });
      }
    }
    // Per-face picking ids by naming key, one draw per body. In wireframe the
    // triangles are invisible hit targets so face-click still works.
    if (!sectionOnly && !input.forExport) {
      const baseId = pickTable.addRange(
        body.faces.map((face) => ({ kind: 'face', bodyId: body.id, faceKey: face.key })),
      );
      idBatches.push({
        kind: 'mesh',
        positions,
        indices,
        localIndex: geometry.faceIndex,
        baseId,
      });
    }

    const isAccentPreview = accentBodies.has(body.id);
    const edgeColor = isExtrudePreview ? input.colors.activePreview : lineInk;
    // Faces the provisional feature created (fillet round, chamfer, shell walls)
    // get an accent tint and accent borders; the rest of the body stays as is.
    const prefix = input.previewFaceKeyPrefix;
    if (prefix && isAccentPreview) {
      body.faces.forEach((face) => {
        if (!face.key.startsWith(prefix)) return;
        overlays.push({
          kind: 'meshRange',
          positions,
          indices,
          firstTriangle: face.triangleStart,
          triangleCount: face.triangleCount,
          color: rgba(input.colors.activePreview, 0.42),
          depthTest: true,
        });
        for (const e of face.edgeIndices) {
          overlays.push({
            kind: 'lines',
            segments: geometry.edgeSegments,
            ...edgeRange(e),
            color: rgba(input.colors.activePreview, 0.95),
            widthPx: 1.5,
            depthTest: true,
          });
        }
      });
    }
    if (!sectionOnly && geometry.edgeSegments.length > 0) {
      if (edgesOn || isExtrudePreview) {
        bodyLines.push({
          kind: 'lines',
          segments: geometry.edgeSegments,
          color: rgba(edgeColor, isXray ? 0.6 : 0.9),
          widthPx: EDGE_PX,
          depthTest: true,
        });
      }
      if ((input.hiddenEdgesVisible ?? false) && !isXray && !isWireframe) {
        hiddenLines.push({
          kind: 'lines',
          segments: geometry.edgeSegments,
          color: rgba(edgeColor, 0.5),
          widthPx: 1,
          depthTest: true,
          hiddenOnly: true,
          dashPx: 4,
        });
      }
      if (!input.forExport) {
        const baseId = pickTable.addRange(
          body.edges.map((edge) => ({ kind: 'edge', bodyId: body.id, edgeKey: edge.key })),
        );
        idBatches.push({
          kind: 'lines',
          segments: geometry.edgeSegments,
          localIndex: geometry.edgeIndex,
          baseId,
          widthPx: EDGE_HIT_PX * hitScale,
        });
      }
    }
    // Outlines of curved faces (cylinders, fillets) that no B-rep edge describes.
    if (!sectionOnly && (edgesOn || isWireframe || isXray)) {
      const silhouettes = silhouetteCandidates(body);
      if (silhouettes.length > 0) {
        bodyLines.push({
          kind: 'lines',
          segments: silhouettes,
          silhouette: true,
          color: rgba(edgeColor, isXray ? 0.6 : 0.9),
          widthPx: EDGE_PX,
          depthTest: true,
        });
      }
    }

    // Selection / hover highlight overlays (crisp + depth-test-off ghost pass).
    const bodyItem: SelectionItem = { kind: 'body', bodyId: body.id };
    if (isSelected(input.selection, bodyItem)) {
      highlightLines(geometry.edgeSegments, input.colors.selection, 2, undefined, 0.28);
    } else if (input.hover?.kind === 'body' && input.hover.bodyId === body.id) {
      highlightLines(geometry.edgeSegments, input.colors.hover, 2, undefined, 0.28);
    }
    // A reference mesh is selected/hovered as a whole (`{ kind: 'mesh' }`); its one
    // whole-mesh face carries the highlight.
    const meshId = referenceMeshIdOf(body.id);
    body.faces.forEach((face) => {
      const faceItem: SelectionItem =
        meshId !== null
          ? { kind: 'mesh', meshId }
          : { kind: 'face', bodyId: body.id, faceKey: face.key };
      const selected = isSelected(input.selection, faceItem);
      const hovered =
        !selected &&
        (meshId !== null
          ? input.hover?.kind === 'mesh' && input.hover.meshId === meshId
          : input.hover?.kind === 'face' &&
            input.hover.bodyId === body.id &&
            input.hover.faceKey === face.key);
      if (!selected && !hovered) return;
      // Selected faces get a strong tint (always the selection-orange
      // token, regardless of body appearance) so selection is unmistakable
      // on every palette color; hover is a visibly lighter tint.
      const color = selected ? input.colors.selection : input.colors.hover;
      const range = {
        kind: 'meshRange' as const,
        positions,
        indices,
        firstTriangle: face.triangleStart,
        triangleCount: face.triangleCount,
      };
      overlays.push({ ...range, color: rgba(color, selected ? 0.45 : 0.2), depthTest: true });
      overlays.push({ ...range, color: rgba(color, selected ? 0.18 : 0.08), depthTest: false });
      // Selected/hovered faces also get their own border in the same
      // color as the fill, not just a translucent fill — the border reads
      // correctly even in wireframe/x-ray and against edge-ink neighbours.
      for (const e of face.edgeIndices) {
        highlightLines(geometry.edgeSegments, color, 2, edgeRange(e), 0.28);
      }
    });
    body.edges.forEach((edge, edgeIndex) => {
      const edgeItem: SelectionItem = { kind: 'edge', bodyId: body.id, edgeKey: edge.key };
      const selected = isSelected(input.selection, edgeItem);
      const hovered =
        !selected &&
        input.hover?.kind === 'edge' &&
        input.hover.bodyId === body.id &&
        input.hover.edgeKey === edge.key;
      if (!selected && !hovered) return;
      const color = selected ? input.colors.selection : input.colors.hover;
      highlightLines(geometry.edgeSegments, color, HIGHLIGHT_EDGE_PX, edgeRange(edgeIndex));
    });
  }

  // Where a feature failed (a fillet edge, a draft face's outline): thick lines in the error colour.
  if (input.errorHighlight) {
    const errorColor = input.colors.error ?? input.colors.axisX;
    for (const segments of input.errorHighlight.segments) {
      thickEdges(segments, errorColor, HIGHLIGHT_EDGE_PX + 1);
    }
  }

  // ---- Ghosts (e.g. boolean tool bodies being consumed) ------------------
  for (const ghost of input.ghostBodies ?? []) {
    const segments = bodyGeometry(ghost).edgeSegments;
    if (segments.length === 0) continue;
    overlays.push({
      kind: 'lines',
      segments,
      color: rgba(input.colors.support, 0.55),
      widthPx: 1.25,
      depthTest: false,
    });
  }

  // Mode overlays on the surfaces, then edges (the hidden-edge pass right
  // after them, while only surfaces are in the depth buffer), measurement
  // lines, highlights and the section plane.
  flat.push(...(input.extraOverlays ?? []));
  flat.push(...bodyLines, ...hiddenLines);
  flat.push(...(input.measureLines ?? []));
  flat.push(...overlays, ...sectionPlaneBatches);
  // ---- Sketches ---------------------------------------------------------
  for (const sketch of input.sketches) {
    // A whole-sketch selection/hover (no region key) highlights every region.
    const matches = (item: SelectionItem | null, regionKey: string): boolean =>
      item?.kind === 'sketchProfile' &&
      item.featureId === sketch.featureId &&
      (item.regionKey === undefined || item.regionKey === regionKey);
    const outline = { positions: [] as number[], colors: [] as number[] };
    const fill = { positions: [] as number[], colors: [] as number[] };
    // Curves (open ones and construction geometry included) in the plain sketch colour.
    for (const curve of sketch.curves ?? []) {
      for (let i = 0; i + 1 < curve.points.length; i += 1) {
        pushFlatLine(
          outline,
          curve.points[i]!,
          curve.points[i + 1]!,
          input.colors.sketchOutline,
          curve.construction ? 0.45 : 0.9,
        );
      }
      if (input.pickSketchLines && curve.kind === 'line' && curve.points.length >= 2) {
        const a = curve.points[0]!;
        const b = curve.points[curve.points.length - 1]!;
        const segment = new Float32Array([...a, ...b]);
        // Axis candidates: drawn solid and wide enough to hit, on top of the profile fill.
        thickEdges(segment, input.colors.sketchOutline, 2);
        idBatches.push({
          positions: buildPolylineRibbon(segment, eye, edgeHitWidth(input.pose.distance) * 1.5),
          id: pickTable.add({
            kind: 'sketchLine',
            featureId: sketch.featureId,
            entityId: curve.entityId,
          }),
          mode: 'triangles',
          onTop: true,
        });
      }
    }
    for (const profile of sketch.profiles) {
      const selected = input.selection.some((item) => matches(item, profile.key));
      const hovered = !selected && matches(input.hover, profile.key);
      const color = selected
        ? input.colors.selection
        : hovered
          ? input.colors.hover
          : input.colors.sketchOutline;
      const fillAlphaValue = selected ? 0.18 : hovered ? 0.12 : 0.06;
      if (selected || hovered) {
        for (const loop of [profile.outline, ...profile.holes]) {
          for (let i = 0; i < loop.length; i += 1) {
            pushFlatLine(outline, loop[i]!, loop[(i + 1) % loop.length]!, color, 0.95);
          }
        }
      }
      const tris = profile.triangles;
      for (let t = 0; t + 8 < tris.length; t += 9) {
        pushFlatTri(
          fill,
          [tris[t]!, tris[t + 1]!, tris[t + 2]!],
          [tris[t + 3]!, tris[t + 4]!, tris[t + 5]!],
          [tris[t + 6]!, tris[t + 7]!, tris[t + 8]!],
          color,
          fillAlphaValue,
        );
      }
      const id = pickTable.add({
        kind: 'sketchProfile',
        featureId: sketch.featureId,
        regionKey: profile.key,
      });
      idBatches.push({ positions: new Float32Array(tris), id, mode: 'triangles' });
    }
    flat.push({
      positions: new Float32Array(outline.positions),
      colors: new Float32Array(outline.colors),
      mode: 'lines',
      depthTest: true,
    });
    flat.push({
      positions: new Float32Array(fill.positions),
      colors: new Float32Array(fill.colors),
      mode: 'triangles',
      depthTest: true,
    });
  }

  // ---- Construction planes and axes ---------------------------------------------
  for (const datum of input.datums ?? []) {
    const color =
      datum.state === 'selected'
        ? input.colors.selection
        : datum.state === 'hovered'
          ? input.colors.hover
          : datum.state === 'error'
            ? (input.colors.error ?? input.colors.axisX)
            : input.colors.sketchOutline;
    const emphasis = datum.state === 'selected' || datum.state === 'hovered';
    const lineAlpha = datum.ghost ? 0.55 : emphasis ? 1 : 0.8;
    const widthPx = datum.ghost ? 1.25 : emphasis ? 2.25 : 1.5;
    let segments: Float32Array;
    if (datum.kind === 'plane') {
      const { u, v } = datum.frame;
      const s = datum.size;
      const corner = (a: number, b: number): Vec3 => [
        datum.center[0] + (u[0] * a + v[0] * b) * s,
        datum.center[1] + (u[1] * a + v[1] * b) * s,
        datum.center[2] + (u[2] * a + v[2] * b) * s,
      ];
      const quad: [Vec3, Vec3, Vec3, Vec3] = [
        corner(-1, -1),
        corner(1, -1),
        corner(1, 1),
        corner(-1, 1),
      ];
      const fill = { positions: [] as number[], colors: [] as number[] };
      const fillAlpha = datum.ghost ? 0.03 : emphasis ? 0.14 : 0.07;
      pushFlatQuad(fill, quad, color, fillAlpha);
      pushFlatQuad(fill, [quad[0], quad[3], quad[2], quad[1]], color, fillAlpha);
      flat.push({
        positions: new Float32Array(fill.positions),
        colors: new Float32Array(fill.colors),
        mode: 'triangles',
        depthTest: true,
        noClip: true,
      });
      segments = new Float32Array(quad.flatMap((p, i) => [...p, ...quad[(i + 1) % 4]!]));
    } else {
      const d = datum.frame.normal;
      const s = datum.size;
      segments = new Float32Array([
        datum.center[0] - d[0] * s,
        datum.center[1] - d[1] * s,
        datum.center[2] - d[2] * s,
        datum.center[0] + d[0] * s,
        datum.center[1] + d[1] * s,
        datum.center[2] + d[2] * s,
      ]);
    }
    const ribbon = buildScreenRibbon(segments, eye, widthPx, worldPerPixel, 0);
    flat.push({
      positions: ribbon,
      colors: lineColors(ribbon.length / 3, color, lineAlpha),
      mode: 'triangles',
      depthTest: !emphasis,
      noClip: true,
    });
    if (!datum.ghost && !input.forExport) {
      idBatches.push({
        positions: buildPolylineRibbon(segments, eye, edgeHitWidth(input.pose.distance) * 1.5),
        id: pickTable.add({ kind: 'datum', featureId: datum.featureId }),
        mode: 'triangles',
        onTop: false,
      });
    }
  }

  // ---- Extrude tool arrow handle (drawn on top, no depth test) -------------
  if (input.extrudeHandle) {
    const { origin, normal, distance, hovered } = input.extrudeHandle;
    const sign = distance < 0 ? -1 : 1;
    const dir: Vec3 = [normal[0] * sign, normal[1] * sign, normal[2] * sign];
    const visualLength = Math.max(Math.abs(distance), 12);
    const color = hovered ? input.colors.hover : input.colors.selection;
    pushArrow(
      flat,
      idBatches,
      pickTable,
      { kind: 'extrudeHandle' },
      origin,
      dir,
      visualLength,
      color,
      eye,
      edgeHitWidth(input.pose.distance) * 4,
    );
  }

  // ---- Move tool axis arrows (drawn on top, no depth test) -----------------
  if (input.moveHandle) {
    const { origin, delta, hoveredAxis } = input.moveHandle;
    const base: Vec3 = [origin[0] + delta.dx, origin[1] + delta.dy, origin[2] + delta.dz];
    const dirs = input.moveHandle.axes ?? [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const hidden = new Set(input.moveHandle.hiddenAxes ?? []);
    const axisColors = [input.colors.axisX, input.colors.axisY, input.colors.axisZ] as const;
    const axes: { axis: 0 | 1 | 2; dir: Vec3; color: readonly [number, number, number] }[] = (
      [0, 1, 2] as const
    )
      .filter((axis) => !hidden.has(axis))
      .map((axis) => ({ axis, dir: dirs[axis]! as Vec3, color: axisColors[axis] }));
    // Plane tiles (Shapr3D gizmo: move in a plane): a small square between two arrows,
    // coloured like the plane's normal axis.
    for (const plane of input.moveHandle.tiles ?? []) {
      const [i, j] = ([0, 1, 2] as const).filter((k) => k !== plane) as [0 | 1 | 2, 0 | 1 | 2];
      const u = dirs[i]!;
      const v = dirs[j]!;
      const at = (a: number, b: number): Vec3 => [
        base[0] + u[0] * a + v[0] * b,
        base[1] + u[1] * a + v[1] * b,
        base[2] + u[2] * a + v[2] * b,
      ];
      const scaleMm = worldPerPixel(Math.hypot(...sub3(eye, base))) * 36;
      const lo = scaleMm * 0.4;
      const hi = scaleMm;
      const quad: [Vec3, Vec3, Vec3, Vec3] = [at(lo, lo), at(hi, lo), at(hi, hi), at(lo, hi)];
      const hovered = input.moveHandle.hoveredTile === plane;
      const color = hovered ? input.colors.hover : axisColors[plane];
      const alpha = hovered ? 0.8 : 0.6;
      const fill = { positions: [] as number[], colors: [] as number[] };
      pushFlatQuad(fill, quad, color, alpha);
      pushFlatQuad(fill, [quad[0], quad[3], quad[2], quad[1]], color, alpha);
      const tris = new Float32Array(fill.positions);
      flat.push({
        positions: tris,
        colors: new Float32Array(fill.colors),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
      idBatches.push({
        positions: tris,
        id: pickTable.add({ kind: 'moveTile', plane }),
        mode: 'triangles',
        onTop: true,
      });
    }
    for (const a of axes) {
      const color = hoveredAxis === a.axis ? input.colors.hover : a.color;
      pushArrow(
        flat,
        idBatches,
        pickTable,
        { kind: 'moveHandle', axis: a.axis },
        base,
        a.dir,
        MOVE_HANDLE_LENGTH_MM,
        color,
        eye,
        edgeHitWidth(input.pose.distance) * 4,
      );
    }
  }

  // ---- In-progress sketch rectangle preview (drawn on top, like Shapr3D) ---
  if (input.sketchPreview) {
    const { corners, cursorPoint } = input.sketchPreview;
    if (corners) {
      const outline = { positions: [] as number[], colors: [] as number[] };
      for (let i = 0; i < 4; i += 1)
        pushFlatLine(outline, corners[i]!, corners[(i + 1) % 4]!, input.colors.sketchOutline, 0.95);
      flat.push({
        positions: new Float32Array(outline.positions),
        colors: new Float32Array(outline.colors),
        mode: 'lines',
        depthTest: false,
      });
      const fill = { positions: [] as number[], colors: [] as number[] };
      pushFlatQuad(fill, corners, input.colors.sketchOutline, 0.16);
      flat.push({
        positions: new Float32Array(fill.positions),
        colors: new Float32Array(fill.colors),
        mode: 'triangles',
        depthTest: false,
      });
    }
    const { outline: ring, center } = input.sketchPreview;
    if (ring && ring.length > 2 && center) {
      const lines = new Float32Array(ring.length * 6);
      const fill = { positions: [] as number[], colors: [] as number[] };
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length]!;
        lines.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
        pushFlatTri(fill, center, a, b, input.colors.sketchOutline, 0.16);
      });
      flat.push({
        positions: new Float32Array(fill.positions),
        colors: new Float32Array(fill.colors),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
      const ribbon = buildScreenRibbon(lines, eye, 2, worldPerPixel, 0);
      flat.push({
        positions: ribbon,
        colors: lineColors(ribbon.length / 3, input.colors.sketchOutline, 0.95),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
    }
    const dots = [cursorPoint, center ?? null].filter((p): p is Vec3 => p !== null);
    if (center && cursorPoint) {
      const radius = { positions: [] as number[], colors: [] as number[] };
      pushFlatLine(radius, center, cursorPoint, input.colors.sketchOutline, 0.7);
      flat.push({
        positions: new Float32Array(radius.positions),
        colors: new Float32Array(radius.colors),
        mode: 'lines',
        depthTest: false,
        noClip: true,
      });
    }
    for (const point of dots) {
      const dotRadius = worldPerPixel(Math.hypot(...sub3(eye, point))) * 3.5;
      const dot = { positions: [] as number[], colors: [] as number[] };
      pushBillboardQuad(dot, eye, point, dotRadius, input.colors.sketchOutline, 0.95);
      flat.push({
        positions: new Float32Array(dot.positions),
        colors: new Float32Array(dot.colors),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
    }
  }

  // ---- Tool / section drag handles (on top; picked before anything else) ---
  for (const handle of input.axisHandles ?? []) {
    const color = handle.hovered
      ? input.colors.hover
      : handle.handle === 'section'
        ? input.colors.sketchOutline
        : input.colors.selection;
    pushArrow(
      flat,
      idBatches,
      pickTable,
      { kind: 'toolHandle', handle: handle.handle },
      handle.base,
      handle.dir,
      handle.length,
      color,
      eye,
      worldPerPixel(Math.hypot(...sub3(eye, handle.base))) * 14,
    );
  }

  // ---- Tool guides: axis lines and planes (on top, not picked) ----------------
  if (input.guides) {
    const color = input.colors.sketchOutline;
    for (const [a, b] of input.guides.lines) {
      const ribbon = buildScreenRibbon(new Float32Array([...a, ...b]), eye, 1.5, worldPerPixel, 0);
      flat.push({
        positions: ribbon,
        colors: lineColors(ribbon.length / 3, color, 0.9),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
    }
    for (const quad of input.guides.planes) {
      const fill = { positions: [] as number[], colors: [] as number[] };
      pushFlatQuad(fill, quad, color, 0.05);
      pushFlatQuad(fill, [quad[0], quad[3], quad[2], quad[1]], color, 0.05);
      const outline = { positions: [] as number[], colors: [] as number[] };
      for (let i = 0; i < 4; i += 1)
        pushFlatLine(outline, quad[i]!, quad[(i + 1) % 4]!, color, 0.85);
      flat.push(
        {
          positions: new Float32Array(fill.positions),
          colors: new Float32Array(fill.colors),
          mode: 'triangles',
          depthTest: true,
          noClip: true,
        },
        {
          positions: new Float32Array(outline.positions),
          colors: new Float32Array(outline.colors),
          mode: 'lines',
          depthTest: false,
          noClip: true,
        },
      );
    }
  }

  // ---- Angle handles: rotation rings and value arcs (on top; picked) ----------
  for (const handle of input.angleHandles ?? []) {
    const base = handle.color ?? input.colors.selection;
    const color = handle.hovered ? input.colors.hover : base;
    const u = normalize3(handle.ref);
    const v = normalize3(cross3(handle.axis, u));
    const at = (degrees: number): Vec3 => {
      const a = (degrees * Math.PI) / 180;
      return addScaled(
        handle.center,
        u,
        Math.cos(a) * handle.radius,
        v,
        Math.sin(a) * handle.radius,
      );
    };
    const arcSegments = (from: number, to: number): Float32Array => {
      const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 4));
      const out = new Float32Array(steps * 6);
      for (let i = 0; i < steps; i += 1) {
        const p = at(from + ((to - from) * i) / steps);
        const q = at(from + ((to - from) * (i + 1)) / steps);
        out.set([...p, ...q], i * 6);
      }
      return out;
    };
    const pushRibbon = (segments: Float32Array, widthPx: number, alpha: number) => {
      const ribbon = buildScreenRibbon(segments, eye, widthPx, worldPerPixel, 0);
      flat.push({
        positions: ribbon,
        colors: lineColors(ribbon.length / 3, color, alpha),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
    };
    const id = pickTable.add({ kind: 'toolHandle', handle: handle.handle });
    if (handle.ring) {
      const circle = arcSegments(0, 360);
      pushRibbon(circle, handle.hovered ? 3.5 : 2.5, 0.9);
      if (Math.abs(handle.value) > 1e-9) pushRibbon(arcSegments(0, handle.value), 5, 0.95);
      idBatches.push({
        positions: buildScreenRibbon(circle, eye, 14, worldPerPixel, 0),
        id,
        mode: 'triangles',
        onTop: true,
      });
    } else {
      const arc = arcSegments(0, handle.value);
      pushRibbon(arc, handle.hovered ? 4 : 3, 0.95);
      const spokes = new Float32Array([
        ...handle.center,
        ...at(0),
        ...handle.center,
        ...at(handle.value),
      ]);
      pushRibbon(spokes, 1.25, 0.7);
      const knob = at(handle.value);
      const knobRadius = worldPerPixel(Math.hypot(...sub3(eye, knob))) * (handle.hovered ? 7 : 6);
      const dot = { positions: [] as number[], colors: [] as number[] };
      pushBillboardQuad(dot, eye, knob, knobRadius, color, 0.95);
      flat.push({
        positions: new Float32Array(dot.positions),
        colors: new Float32Array(dot.colors),
        mode: 'triangles',
        depthTest: false,
        noClip: true,
      });
      const hit = { positions: [] as number[], colors: [] as number[] };
      pushBillboardQuad(hit, eye, knob, knobRadius * 1.8, color, 1);
      idBatches.push({
        positions: new Float32Array(hit.positions),
        id,
        mode: 'triangles',
        onTop: true,
      });
      idBatches.push({
        positions: buildScreenRibbon(arc, eye, 12, worldPerPixel, 0),
        id,
        mode: 'triangles',
        onTop: true,
      });
    }
  }

  // ---- Move/Rotate gizmo centre (pivot knob) --------------------------------------
  if (input.pivot) {
    const { point, hovered, pickable = true } = input.pivot;
    const radius = worldPerPixel(Math.hypot(...sub3(eye, point))) * (hovered ? 8 : 6.5);
    const knob = { positions: [] as number[], colors: [] as number[] };
    pushBillboardQuad(
      knob,
      eye,
      point,
      radius,
      hovered ? input.colors.hover : input.colors.selection,
      1,
    );
    pushBillboardQuad(knob, eye, point, radius * 0.45, input.colors.background, 1);
    flat.push({
      positions: new Float32Array(knob.positions),
      colors: new Float32Array(knob.colors),
      mode: 'triangles',
      depthTest: false,
      noClip: true,
    });
    if (pickable) {
      const hit = { positions: [] as number[], colors: [] as number[] };
      pushBillboardQuad(hit, eye, point, radius * 1.6, input.colors.selection, 1);
      idBatches.push({
        positions: new Float32Array(hit.positions),
        id: pickTable.add({ kind: 'toolHandle', handle: 'pivot' }),
        mode: 'triangles',
        onTop: true,
      });
    }
  }

  flat.push(...(input.extraOverlaysLast ?? []));

  // ---- Camera-dependent frame parameters ------------------------------------
  const handlePoints: Vec3[] = [];
  for (const h of input.axisHandles ?? []) {
    handlePoints.push(h.base, addScaled(h.base, h.dir, h.length, h.dir, 0));
  }
  for (const h of input.angleHandles ?? []) {
    handlePoints.push(
      addScaled(h.center, [1, 0, 0], h.radius, [0, 1, 0], h.radius),
      addScaled(h.center, [-1, 0, 0], h.radius, [0, -1, 0], h.radius),
      addScaled(h.center, [0, 0, 1], h.radius, [0, 0, 0], 0),
      addScaled(h.center, [0, 0, -1], h.radius, [0, 0, 0], 0),
    );
  }
  if (input.extrudeHandle) {
    const { origin, normal, distance } = input.extrudeHandle;
    handlePoints.push(
      origin,
      addScaled(
        origin,
        normal,
        Math.max(Math.abs(distance), 12) * Math.sign(distance || 1),
        normal,
        0,
      ),
    );
  }
  if (input.moveHandle) handlePoints.push(input.moveHandle.origin);
  for (const sketch of input.sketches) {
    for (const profile of sketch.profiles) handlePoints.push(...profile.outline);
    for (const curve of sketch.curves ?? []) handlePoints.push(...curve.points);
  }
  const depthBounds = padBounds(expandBounds(drawnBounds, handlePoints));
  const range = depthRange(
    input.pose,
    depthBounds,
    input.gridVisible || (input.axesVisible ?? true) ? gridExtent : null,
  );
  const viewProj = viewProjectionMatrix(input.pose, input.aspect, range);
  const orthographic = isOrthographic(input.pose);
  const basis = cameraBasis(input.pose);
  const lightDir = (r: number, u: number, b: number): Vec3 =>
    normalize3([
      basis.right[0] * r + basis.up[0] * u + basis.back[0] * b,
      basis.right[1] * r + basis.up[1] * u + basis.back[1] * b,
      basis.right[2] * r + basis.up[2] * u + basis.back[2] * b,
    ]);
  const light = input.colors.light;

  // Ground contact shadow: bodies resting on (or above) the grid plane, seen from above it.
  let shadow: GroundShadow | null = null;
  if (
    highQuality &&
    input.gridVisible &&
    // The removed half of a section would still cast a shadow: none while cutting.
    !sectionOn &&
    shadowCasters.length > 0 &&
    drawnBounds &&
    drawnBounds.min[2] >= -1e-3 &&
    eyeOf(input.pose)[2] > 0
  ) {
    const b = unionBounds(shadowCasters)!;
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 1);
    const margin = Math.max(4, size * 0.3);
    shadow = {
      z: 0,
      min: [b.min[0] - margin, b.min[1] - margin],
      max: [b.max[0] + margin, b.max[1] + margin],
      top: Math.max(b.max[2], 1e-3),
      casters: shadowCasters.map((c) => ({ positions: c.mesh.positions, indices: c.mesh.indices })),
      key: shadowCasters.map((c) => arraySerial(c.mesh.positions)).join(','),
      strength: light ? 0.45 : 0.7,
      pool: light ? 0 : 0.07,
    };
  }

  const diagonal = drawnBounds ? Math.hypot(...sub3(drawnBounds.max, drawnBounds.min)) : 100;
  const frame: SceneFrame = {
    viewProj,
    cameraPosition: eye,
    background: input.colors.background,
    lit,
    underlay,
    flat,
    clip,
    pxScale: dpr,
    depth: {
      near: range.near,
      far: range.far,
      orthographic,
      worldPerPxAt1: orthographic
        ? viewHeightAt(input.pose, input.pose.distance) / cssHeight
        : viewHeightAt(input.pose, 1) / cssHeight,
      // Lines are pulled towards the eye by 0.05 % of their depth (perspective)
      // or of the orbit distance (orthographic): more than the tessellation's
      // chordal error, far less than any wall thickness.
      lineBias: orthographic
        ? (2 * LINE_DEPTH_BIAS * input.pose.distance) / (range.far - range.near)
        : (2 * LINE_DEPTH_BIAS * range.near * range.far) / (range.far - range.near),
    },
    lighting: {
      keyDir: lightDir(-0.45, 0.65, 0.6),
      fillDir: lightDir(0.75, -0.2, 0.45),
      right: basis.right,
      up: basis.up,
      sky: light ? [0.9, 0.92, 0.96] : [0.8, 0.84, 0.9],
      ground: light ? [0.5, 0.48, 0.46] : [0.36, 0.34, 0.32],
    },
    ao: highQuality && !isWireframe && !sectionOnly ? { radiusPx: 14, strength: 0.7 } : null,
    shadow,
    caps: caps && caps.bodies.length > 0 ? caps : null,
    curvatureRange: curvatureRange(diagonal),
    zebraStripes: 14,
  };

  return { frame, idBatches, pickTable };
}

/** Cut-face colour of a body: its colour, a little darker (the hatch darkens it further). */
function capColor(rgb: RGB): RGB {
  return [rgb[0] * 0.82, rgb[1] * 0.82, rgb[2] * 0.82];
}

/** Fixed length (mm) of the move tool's axis arrows, matching `Viewport.tsx`'s `HANDLE_LENGTH_MM`. */
const MOVE_HANDLE_LENGTH_MM = 40;

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function pushFlatTri(
  target: { positions: number[]; colors: number[] },
  a: Vec3,
  b: Vec3,
  c: Vec3,
  color: readonly [number, number, number],
  alpha: number,
): void {
  target.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let i = 0; i < 3; i += 1) target.colors.push(color[0], color[1], color[2], alpha);
}

/** Two vectors perpendicular to `dir` (unit), used to build cone/quad cross-sections. */
function arrowBasis(dir: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize3(cross3(ref, dir));
  const v = normalize3(cross3(dir, u));
  return { u, v };
}

/**
 * Draws one drag-handle arrow (shaft line + pyramid arrowhead), on top of
 * everything (`depthTest: false`) in `color`, from `origin` along unit `dir`
 * for `length` world units. Also registers a fat hit-test ribbon in the
 * picking id table/buffer (not just proximity to a screen-space label) so
 * `Viewport.tsx` can hit-test drags against the actual rendered arrow.
 */
function pushArrow(
  flat: DrawBatch[],
  idBatches: IdBatch[],
  pickTable: PickTable,
  pickTarget: PickTarget,
  origin: Vec3,
  dir: Vec3,
  length: number,
  color: readonly [number, number, number],
  eye: Vec3,
  hitWidthWorld: number,
): void {
  if (length <= 1e-4) return;
  const headLength = Math.min(length * 0.35, 6);
  const headRadius = headLength * 0.45;
  const tip = addScaled(origin, dir, length, dir, 0);
  const baseCenter = addScaled(origin, dir, length - headLength, dir, 0);
  const { u, v } = arrowBasis(dir);

  // The shaft is a thin camera-facing quad (a fraction of the hit width) so
  // it reads at every zoom level, unlike a 1 px GL line.
  const shaftRibbon = buildEdgeRibbon(origin, baseCenter, eye, hitWidthWorld * 0.14);
  flat.push({
    positions: shaftRibbon.positions,
    colors: lineColors(6, color, 0.95),
    mode: 'triangles',
    depthTest: false,
    noClip: true,
  });

  const headCorners: Vec3[] = [0, 1, 2, 3].map((i) => {
    const angle = (Math.PI / 2) * i;
    return addScaled(baseCenter, u, Math.cos(angle) * headRadius, v, Math.sin(angle) * headRadius);
  });
  const head = { positions: [] as number[], colors: [] as number[] };
  for (let i = 0; i < 4; i += 1) {
    pushFlatTri(head, tip, headCorners[i]!, headCorners[(i + 1) % 4]!, color, 0.95);
  }
  pushFlatTri(head, headCorners[0]!, headCorners[2]!, headCorners[1]!, color, 0.95);
  pushFlatTri(head, headCorners[0]!, headCorners[3]!, headCorners[2]!, color, 0.95);
  flat.push({
    positions: new Float32Array(head.positions),
    colors: new Float32Array(head.colors),
    mode: 'triangles',
    depthTest: false,
    noClip: true,
  });

  const id = pickTable.add(pickTarget);
  const ribbon = buildEdgeRibbon(origin, tip, eye, hitWidthWorld);
  idBatches.push({ positions: ribbon.positions, id, mode: 'triangles', onTop: true });
}

/** Camera-facing quad centered on `center`, used for the sketch snap indicator dot. */
function pushBillboardQuad(
  target: { positions: number[]; colors: number[] },
  eye: Vec3,
  center: Vec3,
  radius: number,
  color: readonly [number, number, number],
  alpha: number,
): void {
  const toEye = normalize3(sub3(eye, center));
  const ref: Vec3 = Math.abs(toEye[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const right = normalize3(cross3(ref, toEye));
  const up = normalize3(cross3(toEye, right));
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    addScaled(center, right, -radius, up, -radius),
    addScaled(center, right, radius, up, -radius),
    addScaled(center, right, radius, up, radius),
    addScaled(center, right, -radius, up, radius),
  ];
  pushFlatQuad(target, corners, color, alpha);
}

function baseEdgeHitWidth(distance: number): number {
  // A rough constant-ish screen width: scale with camera distance so the
  // ribbon stays a small, roughly fixed number of pixels wide regardless of zoom.
  return Math.max(0.15, distance * 0.006);
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function addScaled(base: Vec3, a: Vec3, sa: number, b: Vec3, sb: number): Vec3 {
  return [
    base[0] + a[0] * sa + b[0] * sb,
    base[1] + a[1] * sa + b[1] * sb,
    base[2] + a[2] * sa + b[2] * sb,
  ];
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return [0.6, 0.6, 0.6];
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}
