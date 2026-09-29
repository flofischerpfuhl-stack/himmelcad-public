/**
 * Turns document/view/selection state into the flat GL batches `gl.ts`
 * draws, plus the picking id table for the same frame. Kept separate from
 * `Viewport.tsx` so the "what does the scene look like" logic is easy to
 * read without React/pointer-event noise. Not unit tested (feeds straight
 * into WebGL) but written as pure data-in/data-out.
 */
import type { Body, EvaluatedSketch } from '../kernel/types.js';
import type { Bounds3 } from '../model/modeling.js';
import type { DisplayMode, SectionAxis, SelectionItem } from '../model/store.js';
import { FOV_Y_RADIANS, eyeOf, viewProjectionMatrix, type CameraPose } from './camera.js';
import {
  buildEdgeRibbon,
  buildPolylineRibbon,
  buildScreenRibbon,
  expandBody,
  translatePositions,
} from './geometry.js';
import { sectionNormal, sectionOutline, type AxisHandle } from './toolAnchors.js';
import { PickTable, type PickTarget } from './picking.js';
import type { FlatBatch, IdBatch, SceneFrame, TriBatch } from './gl.js';
import type { ViewportColors } from './theme.js';
import type { Vec3 } from './math.js';

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
  /** Visible model bounds: the plane outline is limited to them (+ margin). */
  bounds: Bounds3 | null;
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
}

export interface BuiltScene {
  frame: SceneFrame;
  idBatches: IdBatch[];
  pickTable: PickTable;
}

/** Width of selected/hovered edges, CSS pixels. */
const HIGHLIGHT_EDGE_PX = 3;

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
      return b.kind === 'sketchProfile' && a.featureId === b.featureId;
    case 'feature':
      return false;
  }
}

/** Concatenates line-segment lists (xyz pairs) into one array, optionally translated. */
function concatSegments(
  lists: readonly Float32Array[],
  delta: readonly [number, number, number] | null,
): Float32Array {
  let length = 0;
  for (const list of lists) length += list.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const list of lists) {
    out.set(list, offset);
    offset += list.length;
  }
  return delta ? translatePositions(out, delta) : out;
}

function lineColors(vertexCount: number, color: readonly [number, number, number], alpha: number) {
  const colors = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i += 1) colors.set([color[0], color[1], color[2], alpha], i * 4);
  return colors;
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

/** Builds the full frame of GL batches plus the picking table for one render. */
export function buildScene(input: SceneInput): BuiltScene {
  const pickTable = new PickTable();
  const viewProj = viewProjectionMatrix(input.pose, input.aspect);
  const eye = eyeOf(input.pose);

  const lit: TriBatch[] = [];
  const flat: FlatBatch[] = [];
  const idBatches: IdBatch[] = [];
  /** Highlights drawn after all bodies, so no later body pass paints over them. */
  const overlays: FlatBatch[] = [];

  const dpr = input.dpr ?? 1;
  const cssHeight = Math.max(1, input.viewportHeightPx / dpr);
  const worldPerPixel = (distance: number): number =>
    (2 * distance * Math.tan(FOV_Y_RADIANS / 2)) / cssHeight;
  const thickEdges = (
    segments: Float32Array,
    color: readonly [number, number, number],
    widthPx = HIGHLIGHT_EDGE_PX,
  ): void => {
    if (segments.length === 0) return;
    const ribbon = buildScreenRibbon(segments, eye, widthPx, worldPerPixel);
    const vertexCount = ribbon.length / 3;
    overlays.push({
      positions: ribbon,
      colors: lineColors(vertexCount, color, 1),
      mode: 'triangles',
      depthTest: true,
    });
    // "On top" ghost: the hidden part of a selected edge stays readable.
    overlays.push({
      positions: ribbon,
      colors: lineColors(vertexCount, color, 0.4),
      mode: 'triangles',
      depthTest: false,
    });
  };
  const accentBodies = new Set(input.previewAccentBodyIds ?? []);

  const hiddenSet = new Set(input.hiddenBodyIds);
  const isolatedSet = input.isolatedBodyIds ? new Set(input.isolatedBodyIds) : null;
  const visibleBodies = input.bodies.filter((b) => {
    if (hiddenSet.has(b.id)) return false;
    if (isolatedSet && !isolatedSet.has(b.id)) return false;
    return true;
  });

  const isWireframe = input.displayMode === 'wireframe';
  const isXray = input.displayMode === 'xray';

  // ---- Grid (XY plane, z = 0) ----------------------------------------------
  if (input.gridVisible) {
    const step = Math.max(0.001, input.gridStep);
    const extent = Math.min(20000, Math.max(200, input.pose.distance * 6));
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
      const vA: Vec3 = [coord, -extent, 0];
      const vB: Vec3 = [coord, extent, 0];
      pushFlatLine(
        target,
        vA,
        vB,
        color,
        Math.min(fadeAt(coord, -extent), fadeAt(coord, extent)) || 0.05,
      );
      const hA: Vec3 = [-extent, coord, 0];
      const hB: Vec3 = [extent, coord, 0];
      pushFlatLine(
        target,
        hA,
        hB,
        color,
        Math.min(fadeAt(-extent, coord), fadeAt(extent, coord)) || 0.05,
      );
    }
    if (minor.positions.length > 0) {
      flat.push({
        positions: new Float32Array(minor.positions),
        colors: new Float32Array(minor.colors),
        mode: 'lines',
        depthTest: true,
        noClip: true,
      });
    }
    if (major.positions.length > 0) {
      flat.push({
        positions: new Float32Array(major.positions),
        colors: new Float32Array(major.colors),
        mode: 'lines',
        depthTest: true,
        noClip: true,
      });
    }
  }

  // ---- World axes (Shapr3D-style red/green/blue) ---------------------------
  {
    const axisLen = Math.max(50, input.pose.distance * 0.6);
    const axes: { color: readonly [number, number, number]; to: Vec3 }[] = [
      { color: input.colors.axisX, to: [axisLen, 0, 0] },
      { color: input.colors.axisY, to: [0, axisLen, 0] },
      { color: input.colors.axisZ, to: [0, 0, axisLen] },
    ];
    const positions: number[] = [];
    const colors: number[] = [];
    for (const axis of axes) {
      positions.push(0, 0, 0, axis.to[0], axis.to[1], axis.to[2]);
      colors.push(
        axis.color[0],
        axis.color[1],
        axis.color[2],
        0.9,
        axis.color[0],
        axis.color[1],
        axis.color[2],
        0.9,
      );
    }
    flat.push({
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      mode: 'lines',
      depthTest: true,
      noClip: true,
    });
  }

  // ---- Section clip -----------------------------------------------------
  // Material on the positive side of `normal` (offset along it) is cut away;
  // Flip reverses the normal. The plane's outline covers the visible model's
  // extent plus a margin, not the whole screen.
  const clipNormal = sectionNormal(input.section);
  const flipSign = input.section.flipped ? -1 : 1;
  const clip = {
    enabled: input.section.enabled,
    normal: clipNormal,
    offset: input.section.offset * flipSign,
  };
  const sectionPlaneBatches: FlatBatch[] = [];
  if (input.section.enabled) {
    const corners = sectionOutline(input.section, input.section.bounds);
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

  // ---- Bodies ---------------------------------------------------------------
  for (const body of visibleBodies) {
    const isMovePreview = input.movePreview?.bodyId === body.id;
    const isExtrudePreview = input.extrudePreviewBodyId === body.id;
    const delta: [number, number, number] | null =
      isMovePreview && input.movePreview
        ? [input.movePreview.delta.dx, input.movePreview.delta.dy, input.movePreview.delta.dz]
        : null;
    const expanded = expandBody(body);
    const positions = delta ? translatePositions(expanded.positions, delta) : expanded.positions;
    const facePositions = (faceIndex: number): Float32Array => {
      const face = body.faces[faceIndex]!;
      return positions.subarray(
        face.triangleStart * 9,
        (face.triangleStart + face.triangleCount) * 9,
      );
    };
    const edgeSegments = (edgeIndex: number): Float32Array => {
      const segments = body.edges[edgeIndex]!.segments;
      return delta ? translatePositions(segments, delta) : segments;
    };
    const rgb = hexToRgb01(body.color);

    if (!isWireframe) {
      const alpha = isXray ? 0.32 : isExtrudePreview ? 0.55 : 1;
      lit.push({
        positions,
        normals: expanded.normals,
        color: rgb,
        alpha,
        depthTest: true,
        depthWrite: !isXray && !isExtrudePreview,
        polygonOffset: true,
      });
    }
    // Per-face picking ids by naming key. In wireframe the triangles are
    // invisible hit targets so face-click still works.
    body.faces.forEach((face, faceIndex) => {
      if (face.triangleCount === 0) return;
      const id = pickTable.add({ kind: 'face', bodyId: body.id, faceKey: face.key });
      idBatches.push({ positions: facePositions(faceIndex), id, mode: 'triangles' });
    });

    const isAccentPreview = accentBodies.has(body.id);
    const edgeColor = isExtrudePreview ? input.colors.activePreview : input.colors.bodyEdge;
    // Faces the provisional feature created (fillet round, chamfer, shell walls)
    // get an accent tint and accent borders; the rest of the body stays as is.
    const prefix = input.previewFaceKeyPrefix;
    if (prefix && isAccentPreview) {
      body.faces.forEach((face, faceIndex) => {
        if (!face.key.startsWith(prefix)) return;
        const tris = facePositions(faceIndex);
        overlays.push({
          positions: tris,
          colors: lineColors(tris.length / 3, input.colors.activePreview, 0.42),
          mode: 'triangles',
          depthTest: true,
        });
        const border = concatSegments(face.edgeIndices.map(edgeSegments), null);
        overlays.push({
          positions: border,
          colors: lineColors(border.length / 3, input.colors.activePreview, 0.95),
          mode: 'lines',
          depthTest: true,
        });
      });
    }
    const allEdges = concatSegments(
      body.edges.map((edge) => edge.segments),
      delta,
    );
    flat.push({
      positions: allEdges,
      colors: lineColors(allEdges.length / 3, edgeColor, isXray ? 0.6 : 0.85),
      mode: 'lines',
      depthTest: true,
    });
    const hitWidth = edgeHitWidth(input.pose.distance);
    body.edges.forEach((edge, edgeIndex) => {
      if (edge.segments.length === 0) return;
      const id = pickTable.add({ kind: 'edge', bodyId: body.id, edgeKey: edge.key });
      idBatches.push({
        positions: buildPolylineRibbon(edgeSegments(edgeIndex), eye, hitWidth),
        id,
        mode: 'triangles',
      });
    });

    // Selection / hover highlight overlays (crisp + depth-test-off ghost pass).
    const bodyItem: SelectionItem = { kind: 'body', bodyId: body.id };
    if (isSelected(input.selection, bodyItem)) {
      addHighlightEdges(flat, allEdges, input.colors.selection);
    } else if (input.hover?.kind === 'body' && input.hover.bodyId === body.id) {
      addHighlightEdges(flat, allEdges, input.colors.hover);
    }
    body.faces.forEach((face, faceIndex) => {
      const faceItem: SelectionItem = { kind: 'face', bodyId: body.id, faceKey: face.key };
      const selected = isSelected(input.selection, faceItem);
      const hovered =
        !selected &&
        input.hover?.kind === 'face' &&
        input.hover.bodyId === body.id &&
        input.hover.faceKey === face.key;
      if (!selected && !hovered) return;
      const tris = facePositions(faceIndex);
      // Selected faces get a strong tint (always the selection-orange
      // token, regardless of body appearance) so selection is unmistakable
      // on every palette color; hover is a visibly lighter tint.
      const color = selected ? input.colors.selection : input.colors.hover;
      const fillAlphaMain = selected ? 0.45 : 0.2;
      const fillAlphaGhost = selected ? 0.18 : 0.08;
      const colors = lineColors(tris.length / 3, color, fillAlphaMain);
      flat.push({ positions: tris, colors, mode: 'triangles', depthTest: true });
      flat.push({
        positions: tris,
        colors: fillAlpha(colors, fillAlphaGhost),
        mode: 'triangles',
        depthTest: false,
      });
      // Selected/hovered faces also get their own border in the same
      // color as the fill, not just a translucent fill — the border reads
      // correctly even in wireframe/x-ray and against edge-ink neighbours.
      addHighlightEdges(flat, concatSegments(face.edgeIndices.map(edgeSegments), null), color);
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
      thickEdges(edgeSegments(edgeIndex), color);
    });
  }

  // ---- Ghosts (e.g. boolean tool bodies being consumed) ------------------
  for (const ghost of input.ghostBodies ?? []) {
    const segments = concatSegments(
      ghost.edges.map((edge) => edge.segments),
      null,
    );
    overlays.push({
      positions: segments,
      colors: lineColors(segments.length / 3, input.colors.support, 0.55),
      mode: 'lines',
      depthTest: false,
    });
  }

  flat.push(...overlays, ...sectionPlaneBatches);

  // ---- Sketches ---------------------------------------------------------
  for (const sketch of input.sketches) {
    const selected = isSelected(input.selection, {
      kind: 'sketchProfile',
      featureId: sketch.featureId,
    });
    const hovered =
      !selected &&
      input.hover?.kind === 'sketchProfile' &&
      input.hover.featureId === sketch.featureId;
    const color = selected
      ? input.colors.selection
      : hovered
        ? input.colors.hover
        : input.colors.sketchOutline;
    const fillColor = selected || hovered ? color : input.colors.sketchOutline;
    const fillAlphaValue = selected ? 0.18 : hovered ? 0.12 : 0.06;
    const outline = { positions: [] as number[], colors: [] as number[] };
    const fill = { positions: [] as number[], colors: [] as number[] };
    const hit: number[] = [];
    for (const profile of sketch.profiles) {
      const points = profile.outline;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        pushFlatLine(outline, a, b, color, 0.9);
        // Profiles are convex (rectangle, circle): a fan from the centre fills them.
        pushFlatTri(fill, profile.center, a, b, fillColor, fillAlphaValue);
        hit.push(...profile.center, ...a, ...b);
      }
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
    const id = pickTable.add({ kind: 'sketchProfile', featureId: sketch.featureId });
    idBatches.push({ positions: new Float32Array(hit), id, mode: 'triangles' });
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
    const axes: { axis: 0 | 1 | 2; dir: Vec3; color: readonly [number, number, number] }[] = [
      { axis: 0, dir: [1, 0, 0], color: input.colors.axisX },
      { axis: 1, dir: [0, 1, 0], color: input.colors.axisY },
      { axis: 2, dir: [0, 0, 1], color: input.colors.axisZ },
    ];
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

  const frame: SceneFrame = {
    viewProj,
    cameraPosition: eye,
    background: input.colors.background,
    lit,
    flat,
    clip,
  };

  return { frame, idBatches, pickTable };
}

function addHighlightEdges(
  flat: FlatBatch[],
  segments: Float32Array,
  color: readonly [number, number, number],
): void {
  if (segments.length === 0) return;
  const vertexCount = segments.length / 3;
  flat.push({
    positions: segments,
    colors: lineColors(vertexCount, color, 0.95),
    mode: 'lines',
    depthTest: true,
  });
  flat.push({
    positions: segments,
    colors: lineColors(vertexCount, color, 0.28),
    mode: 'lines',
    depthTest: false,
  });
}

function fillAlpha(colors: Float32Array, alpha: number): Float32Array {
  const out = new Float32Array(colors.length);
  for (let i = 0; i < colors.length; i += 4) {
    out[i] = colors[i]!;
    out[i + 1] = colors[i + 1]!;
    out[i + 2] = colors[i + 2]!;
    out[i + 3] = alpha;
  }
  return out;
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
  flat: FlatBatch[],
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

function edgeHitWidth(distance: number): number {
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
