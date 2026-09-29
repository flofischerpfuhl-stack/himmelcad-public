/**
 * Turns document/view/selection state into the flat GL batches `gl.ts`
 * draws, plus the picking id table for the same frame. Kept separate from
 * `Viewport.tsx` so the "what does the scene look like" logic is easy to
 * read without React/pointer-event noise. Not unit tested (feeds straight
 * into WebGL) but written as pure data-in/data-out.
 */
import type { Body, EvaluatedSketch, FaceSide } from '../model/mockDocument.js';
import type { DisplayMode, SectionAxis, SelectionItem } from '../model/store.js';
import { eyeOf, viewProjectionMatrix, type CameraPose } from './camera.js';
import { buildBoxEdges, buildBoxTriangles, buildEdgeRibbon } from './geometry.js';
import { PickTable, type PickTarget } from './picking.js';
import type { FlatBatch, IdBatch, SceneFrame, TriBatch } from './gl.js';
import type { ViewportColors } from './theme.js';
import type { Vec3 } from './math.js';

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  offset: number;
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

/** In-progress sketch-rectangle outline/fill + the grid snap indicator dot, drawn on top of everything. */
export interface SketchPreviewState {
  corners: readonly [Vec3, Vec3, Vec3, Vec3] | null;
  cursorPoint: Vec3 | null;
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
}

export interface BuiltScene {
  frame: SceneFrame;
  idBatches: IdBatch[];
  pickTable: PickTable;
}

const AXIS_VECTORS: Record<SectionAxis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

function isSelected(selection: readonly SelectionItem[], item: SelectionItem): boolean {
  return selection.some((s) => selectionEquals(s, item));
}

function selectionEquals(a: SelectionItem, b: SelectionItem): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'body':
      return b.kind === 'body' && a.bodyId === b.bodyId;
    case 'face':
      return b.kind === 'face' && a.bodyId === b.bodyId && a.side === b.side;
    case 'edge':
      return b.kind === 'edge' && a.bodyId === b.bodyId && a.edge === b.edge;
    case 'sketchProfile':
      return b.kind === 'sketchProfile' && a.featureId === b.featureId;
    case 'feature':
      return false;
  }
}

function translated(
  body: Body,
  delta: { dx: number; dy: number; dz: number } | null,
): { min: [number, number, number]; max: [number, number, number] } {
  if (!delta) return { min: body.min, max: body.max };
  return {
    min: [body.min[0] + delta.dx, body.min[1] + delta.dy, body.min[2] + delta.dz],
    max: [body.max[0] + delta.dx, body.max[1] + delta.dy, body.max[2] + delta.dz],
  };
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
      });
    }
    if (major.positions.length > 0) {
      flat.push({
        positions: new Float32Array(major.positions),
        colors: new Float32Array(major.colors),
        mode: 'lines',
        depthTest: true,
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
    });
  }

  // ---- Section clip -----------------------------------------------------
  const clip = {
    enabled: input.section.enabled,
    normal: AXIS_VECTORS[input.section.axis],
    offset: input.section.offset,
  };
  if (input.section.enabled) {
    const size = Math.max(100, input.pose.distance);
    const n = clip.normal;
    const u: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const right: Vec3 = normalize3([
      u[1] * n[2] - u[2] * n[1],
      u[2] * n[0] - u[0] * n[2],
      u[0] * n[1] - u[1] * n[0],
    ]);
    const up: Vec3 = [
      n[1] * right[2] - n[2] * right[1],
      n[2] * right[0] - n[0] * right[2],
      n[0] * right[1] - n[1] * right[0],
    ];
    const center: Vec3 = [
      n[0] * input.section.offset,
      n[1] * input.section.offset,
      n[2] * input.section.offset,
    ];
    const corners: Vec3[] = [
      addScaled(center, right, -size, up, -size),
      addScaled(center, right, size, up, -size),
      addScaled(center, right, size, up, size),
      addScaled(center, right, -size, up, size),
    ];
    const outline = { positions: [] as number[], colors: [] as number[] };
    for (let i = 0; i < 4; i += 1) {
      pushFlatLine(outline, corners[i]!, corners[(i + 1) % 4]!, input.colors.sketchOutline, 0.5);
    }
    flat.push({
      positions: new Float32Array(outline.positions),
      colors: new Float32Array(outline.colors),
      mode: 'lines',
      depthTest: false,
    });
  }

  // ---- Bodies ---------------------------------------------------------------
  for (const body of visibleBodies) {
    const isMovePreview = input.movePreview?.bodyId === body.id;
    const isExtrudePreview = input.extrudePreviewBodyId === body.id;
    const { min, max } = translated(body, isMovePreview ? input.movePreview!.delta : null);
    const rgb = hexToRgb01(body.color);

    if (!isWireframe) {
      const tri = buildBoxTriangles(min, max);
      const alpha = isXray ? 0.32 : isExtrudePreview ? 0.55 : 1;
      lit.push({
        positions: tri.positions,
        normals: tri.normals,
        color: rgb,
        alpha,
        depthTest: true,
        depthWrite: !isXray && !isExtrudePreview,
        polygonOffset: true,
      });
      // Per-face picking ids (6 groups of 6 vertices / 2 triangles each).
      for (let face = 0; face < 6; face += 1) {
        const side = tri.sides[face * 6]!;
        const id = pickTable.add({ kind: 'face', bodyId: body.id, side });
        idBatches.push({
          positions: tri.positions.slice(face * 18, face * 18 + 18),
          id,
          mode: 'triangles',
        });
      }
    } else {
      // Wireframe: still register face ids (invisible hit-test triangles) so face-click still works.
      const tri = buildBoxTriangles(min, max);
      for (let face = 0; face < 6; face += 1) {
        const side = tri.sides[face * 6]!;
        const id = pickTable.add({ kind: 'face', bodyId: body.id, side });
        idBatches.push({
          positions: tri.positions.slice(face * 18, face * 18 + 18),
          id,
          mode: 'triangles',
        });
      }
    }

    const edgeColor = isExtrudePreview ? input.colors.activePreview : input.colors.bodyEdge;
    const edges = buildBoxEdges(min, max);
    const edgeLine = { positions: [] as number[], colors: [] as number[] };
    for (const e of edges) {
      pushFlatLine(edgeLine, e.a, e.b, edgeColor, isXray ? 0.6 : 0.85);
      const ribbon = buildEdgeRibbon(e.a, e.b, eye, edgeHitWidth(input.pose.distance));
      const id = pickTable.add({ kind: 'edge', bodyId: body.id, edge: e.edge });
      idBatches.push({ positions: ribbon.positions, id, mode: 'triangles' });
    }
    flat.push({
      positions: new Float32Array(edgeLine.positions),
      colors: new Float32Array(edgeLine.colors),
      mode: 'lines',
      depthTest: true,
    });

    // Selection / hover highlight overlays (crisp + depth-test-off ghost pass).
    const bodyItem: SelectionItem = { kind: 'body', bodyId: body.id };
    if (isSelected(input.selection, bodyItem)) {
      addHighlightEdges(flat, edges, input.colors.selection);
    } else if (input.hover?.kind === 'body' && input.hover.bodyId === body.id) {
      addHighlightEdges(flat, edges, input.colors.hover);
    }
    for (const side of ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as FaceSide[]) {
      const faceItem: SelectionItem = { kind: 'face', bodyId: body.id, side };
      const selected = isSelected(input.selection, faceItem);
      const hovered =
        !selected &&
        input.hover?.kind === 'face' &&
        input.hover.bodyId === body.id &&
        input.hover.side === side;
      if (!selected && !hovered) continue;
      const tri = buildBoxTriangles(min, max);
      const faceIndex = (['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as FaceSide[]).indexOf(side);
      const facePositions = tri.positions.slice(faceIndex * 18, faceIndex * 18 + 18);
      // Selected faces get a strong tint (always the selection-orange
      // token, regardless of body appearance) so selection is unmistakable
      // on every palette color; hover is a visibly lighter tint.
      const color = selected ? input.colors.selection : input.colors.hover;
      const fillAlphaMain = selected ? 0.45 : 0.2;
      const fillAlphaGhost = selected ? 0.18 : 0.08;
      const colors = new Float32Array(6 * 4);
      for (let i = 0; i < 6; i += 1)
        colors.set([color[0], color[1], color[2], fillAlphaMain], i * 4);
      flat.push({ positions: facePositions, colors, mode: 'triangles', depthTest: true });
      flat.push({
        positions: facePositions,
        colors: fillAlpha(colors, fillAlphaGhost),
        mode: 'triangles',
        depthTest: false,
      });
      // Selected/hovered faces also get their own border in the same
      // color as the fill (selection orange / hover tint edge lines), not
      // just a translucent fill — the border reads correctly even in
      // wireframe/x-ray and against edge-ink-colored neighbouring faces.
      const faceEdges = edges.filter((e) => e.edge.split('|').includes(side));
      addHighlightEdges(flat, faceEdges, color);
    }
    for (const e of edges) {
      const edgeItem: SelectionItem = { kind: 'edge', bodyId: body.id, edge: e.edge };
      const selected = isSelected(input.selection, edgeItem);
      const hovered =
        !selected &&
        input.hover?.kind === 'edge' &&
        input.hover.bodyId === body.id &&
        input.hover.edge === e.edge;
      if (!selected && !hovered) continue;
      const color = selected ? input.colors.selection : input.colors.hover;
      const crisp = { positions: [] as number[], colors: [] as number[] };
      pushFlatLine(crisp, e.a, e.b, color, 1);
      flat.push({
        positions: new Float32Array(crisp.positions),
        colors: new Float32Array(crisp.colors),
        mode: 'lines',
        depthTest: true,
      });
      const ghost = { positions: [] as number[], colors: [] as number[] };
      pushFlatLine(ghost, e.a, e.b, color, 0.3);
      flat.push({
        positions: new Float32Array(ghost.positions),
        colors: new Float32Array(ghost.colors),
        mode: 'lines',
        depthTest: false,
      });
    }
  }

  // ---- Sketches ---------------------------------------------------------
  for (const sketch of input.sketches) {
    const corners = sketchCorners(sketch);
    const selected = isSelected(input.selection, {
      kind: 'sketchProfile',
      featureId: sketch.featureId,
    });
    const hovered =
      !selected &&
      input.hover?.kind === 'sketchProfile' &&
      input.hover.featureId === sketch.featureId;
    const outline = { positions: [] as number[], colors: [] as number[] };
    const color = selected
      ? input.colors.selection
      : hovered
        ? input.colors.hover
        : input.colors.sketchOutline;
    for (let i = 0; i < 4; i += 1)
      pushFlatLine(outline, corners[i]!, corners[(i + 1) % 4]!, color, 0.9);
    flat.push({
      positions: new Float32Array(outline.positions),
      colors: new Float32Array(outline.colors),
      mode: 'lines',
      depthTest: true,
    });

    const fillColor = selected || hovered ? color : input.colors.sketchOutline;
    const fillAlphaValue = selected ? 0.18 : hovered ? 0.12 : 0.06;
    const fill = { positions: [] as number[], colors: [] as number[] };
    pushFlatQuad(fill, corners, fillColor, fillAlphaValue);
    flat.push({
      positions: new Float32Array(fill.positions),
      colors: new Float32Array(fill.colors),
      mode: 'triangles',
      depthTest: true,
    });

    const id = pickTable.add({ kind: 'sketchProfile', featureId: sketch.featureId });
    const idPositions = new Float32Array(18);
    const tris: Vec3[] = [
      corners[0]!,
      corners[1]!,
      corners[2]!,
      corners[0]!,
      corners[2]!,
      corners[3]!,
    ];
    tris.forEach((p, i) => idPositions.set(p, i * 3));
    idBatches.push({ positions: idPositions, id, mode: 'triangles' });
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
    if (cursorPoint) {
      const dotRadius = Math.max(1.5, input.pose.distance * 0.006);
      const dot = { positions: [] as number[], colors: [] as number[] };
      pushBillboardQuad(dot, eye, cursorPoint, dotRadius, input.colors.sketchOutline, 0.9);
      flat.push({
        positions: new Float32Array(dot.positions),
        colors: new Float32Array(dot.colors),
        mode: 'triangles',
        depthTest: false,
      });
    }
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
  edges: { a: Vec3; b: Vec3 }[],
  color: readonly [number, number, number],
): void {
  const crisp = { positions: [] as number[], colors: [] as number[] };
  const ghost = { positions: [] as number[], colors: [] as number[] };
  for (const e of edges) {
    pushFlatLine(crisp, e.a, e.b, color, 0.95);
    pushFlatLine(ghost, e.a, e.b, color, 0.28);
  }
  flat.push({
    positions: new Float32Array(crisp.positions),
    colors: new Float32Array(crisp.colors),
    mode: 'lines',
    depthTest: true,
  });
  flat.push({
    positions: new Float32Array(ghost.positions),
    colors: new Float32Array(ghost.colors),
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

  const shaft = { positions: [] as number[], colors: [] as number[] };
  pushFlatLine(shaft, origin, baseCenter, color, 0.95);
  flat.push({
    positions: new Float32Array(shaft.positions),
    colors: new Float32Array(shaft.colors),
    mode: 'lines',
    depthTest: false,
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
  });

  const id = pickTable.add(pickTarget);
  const ribbon = buildEdgeRibbon(origin, tip, eye, hitWidthWorld);
  idBatches.push({ positions: ribbon.positions, id, mode: 'triangles' });
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

function sketchCorners(sketch: EvaluatedSketch): [Vec3, Vec3, Vec3, Vec3] {
  const { min, max, plane, offset } = sketch;
  const put = (u: number, v: number): Vec3 => {
    if (plane === 'XY') return [u, v, offset];
    if (plane === 'XZ') return [u, offset, v];
    return [offset, u, v];
  };
  return [put(min[0], min[1]), put(max[0], min[1]), put(max[0], max[1]), put(min[0], max[1])];
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
