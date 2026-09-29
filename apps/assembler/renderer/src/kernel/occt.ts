/**
 * Leak-free OCCT primitives for the evaluator: sub-shape indexing,
 * topology (face/edge adjacency), operations that keep OCCT's modelling
 * history (booleans, fillet/chamfer, shell) and direct mesh extraction.
 *
 * Why not replicad's getters: `shape.faces`/`shape.edges` iterate with a
 * `TopExp_Explorer` and keep every visited raw `TopoDS_Shape` in an array
 * that is never deleted — each keeps its face's B-rep (and triangulation)
 * alive for the rest of the session. The helpers here delete every raw
 * handle they create; wrappers they hand out are replicad objects released
 * by the arena (`occtArena.ts`) or explicitly.
 */
import './occtArena.js';
import * as R from 'replicad';

import type { CurveKind, Vec3 } from '../model/document.js';
import { pin, release, unpin } from './occtArena.js';

export type OpenCascade = ReturnType<typeof R.getOC>;
export type Shape3D = R.Shape3D;
/** A raw OCCT `TopoDS_Shape` handle (embind object). */
export type RawShape = R.Face['wrapped'] | R.Edge['wrapped'] | Shape3D['wrapped'];

const HASH_MAX = 2147483647;

type SubKind = 'face' | 'edge' | 'vertex';

function topAbs(oc: OpenCascade, kind: SubKind | 'shape'): never {
  const e = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
  const name =
    kind === 'face'
      ? 'TopAbs_FACE'
      : kind === 'edge'
        ? 'TopAbs_EDGE'
        : kind === 'vertex'
          ? 'TopAbs_VERTEX'
          : 'TopAbs_SHAPE';
  return e[name] as never;
}

/**
 * Sub-shapes of one kind, deduplicated with `IsSame` (orientation ignored),
 * in `TopExp_Explorer` order — the same order as replicad's `shape.faces`.
 * Owns its raw handles; `dispose()` deletes them.
 */
export class SubShapeIndex {
  readonly items: RawShape[] = [];
  private readonly byHash = new Map<number, number[]>();

  constructor(
    private readonly oc: OpenCascade,
    shape: RawShape,
    kind: SubKind,
  ) {
    const explorer = new oc.TopExp_Explorer(shape as never, topAbs(oc, kind), topAbs(oc, 'shape'));
    try {
      for (; explorer.More(); explorer.Next()) {
        const current = explorer.Current() as RawShape;
        if (this.indexOf(current) >= 0) {
          current.delete();
          continue;
        }
        const hash = this.hash(current);
        const list = this.byHash.get(hash);
        if (list) list.push(this.items.length);
        else this.byHash.set(hash, [this.items.length]);
        this.items.push(current);
      }
    } finally {
      explorer.delete();
    }
  }

  get size(): number {
    return this.items.length;
  }

  private hash(shape: RawShape): number {
    return this.oc.ReplicadShapeHasher.HashCode(shape as never, HASH_MAX);
  }

  /** Index of the sub-shape that `IsSame` as `shape`, else -1. */
  indexOf(shape: RawShape): number {
    const candidates = this.byHash.get(this.hash(shape));
    if (!candidates) return -1;
    for (const i of candidates) if (this.items[i]!.IsSame(shape as never)) return i;
    return -1;
  }

  dispose(): void {
    for (const item of this.items) item.delete();
    this.items.length = 0;
    this.byHash.clear();
  }
}

export interface EdgeGeom {
  curve: CurveKind;
  midpoint: Vec3;
  length: number;
  direction: Vec3 | null;
  radius: number | null;
}

/** Faces, edges and their adjacency of one shape (replicad wrappers, explorer order). */
export interface Topology {
  faces: R.Face[];
  edges: R.Edge[];
  /** Edge indices per face. */
  faceEdges: number[][];
  /** Face indices per edge. */
  edgeFaces: number[][];
  edgeGeoms: EdgeGeom[];
  /** Index of the face that `IsSame` as `raw`, else -1. */
  faceIndexOf(raw: RawShape): number;
  edgeIndexOf(raw: RawShape): number;
}

export interface OwnedTopology extends Topology {
  /** Keeps the wrappers alive across arena closes (cached topologies). */
  pinAll(): void;
  dispose(): void;
}

export function curveKindOf(type: string): CurveKind {
  switch (type) {
    case 'LINE':
      return 'line';
    case 'CIRCLE':
      return 'circle';
    case 'ELLIPSE':
      return 'ellipse';
    default:
      return 'other';
  }
}

/**
 * Point of an edge at `t` in [0, 1] of its parameter range (replicad's
 * `edge.pointAt(t)`, without its leak of a raw `gp_Pnt` per call).
 */
export function edgePointAt(oc: OpenCascade, edge: R.Edge, t: number): Vec3 {
  const adaptor = new oc.BRepAdaptor_Curve(edge.wrapped as never);
  const p = new oc.gp_Pnt();
  try {
    const first = adaptor.FirstParameter();
    adaptor.D0(first + (adaptor.LastParameter() - first) * t, p);
    return [p.X(), p.Y(), p.Z()];
  } finally {
    p.delete();
    adaptor.delete();
  }
}

/**
 * Curve kind, midpoint, length, direction (lines) and radius (circles) of an
 * edge with one curve adaptor — the values replicad's `geomType`,
 * `pointAt(0.5)`, `tangentAt(0.5)` and `length` give, without the wasm heap
 * those getters leak (~2 KB per edge).
 */
function describeEdge(oc: OpenCascade, edge: R.Edge): EdgeGeom {
  const adaptor = new oc.BRepAdaptor_Curve(edge.wrapped as never);
  const p = new oc.gp_Pnt();
  const d = new oc.gp_Vec();
  const props = new oc.GProp_GProps();
  try {
    const types = oc.GeomAbs_CurveType as unknown as Record<string, unknown>;
    const type = adaptor.GetType() as unknown;
    const curve: CurveKind =
      type === types.GeomAbs_Line
        ? 'line'
        : type === types.GeomAbs_Circle
          ? 'circle'
          : type === types.GeomAbs_Ellipse
            ? 'ellipse'
            : 'other';
    const first = adaptor.FirstParameter();
    adaptor.D1(first + (adaptor.LastParameter() - first) * 0.5, p, d);
    const midpoint: Vec3 = [p.X(), p.Y(), p.Z()];
    const direction: Vec3 | null = curve === 'line' ? normalize([d.X(), d.Y(), d.Z()]) : null;
    let radius: number | null = null;
    if (curve === 'circle') {
      const circle = adaptor.Circle();
      radius = circle.Radius();
      circle.delete();
    }
    oc.BRepGProp.LinearProperties(edge.wrapped as never, props, true, false);
    return { curve, midpoint, length: props.Mass(), direction, radius };
  } finally {
    props.delete();
    d.delete();
    p.delete();
    adaptor.delete();
  }
}
/**
 * Builds the topology of `shape` (wrappers are arena-tracked unless
 * pinned). Edges that are identical (`IsSame`) to an edge of one of the
 * `reuse` topologies (an operation's inputs) copy its geometry description
 * instead of querying OCCT again.
 */
export function buildTopology(
  oc: OpenCascade,
  shape: Shape3D,
  reuse: readonly Topology[] = [],
): OwnedTopology {
  const faceIndex = new SubShapeIndex(oc, shape.wrapped, 'face');
  const edgeIndex = new SubShapeIndex(oc, shape.wrapped, 'edge');
  const faces = faceIndex.items.map((raw) => new R.Face(oc.TopoDS.Face(raw as never)));
  const edges = edgeIndex.items.map((raw) => new R.Edge(oc.TopoDS.Edge(raw as never)));
  const faceEdges: number[][] = faces.map(() => []);
  const edgeFaces: number[][] = edges.map(() => []);
  faceIndex.items.forEach((face, f) => {
    const explorer = new oc.TopExp_Explorer(face as never, topAbs(oc, 'edge'), topAbs(oc, 'shape'));
    try {
      for (; explorer.More(); explorer.Next()) {
        const current = explorer.Current() as RawShape;
        const e = edgeIndex.indexOf(current);
        current.delete();
        if (e < 0) continue;
        if (!faceEdges[f]!.includes(e)) faceEdges[f]!.push(e);
        if (!edgeFaces[e]!.includes(f)) edgeFaces[e]!.push(f);
      }
    } finally {
      explorer.delete();
    }
  });
  const edgeGeoms = edges.map((edge) => {
    for (const other of reuse) {
      const index = other.edgeIndexOf(edge.wrapped as RawShape);
      if (index >= 0) return other.edgeGeoms[index]!;
    }
    return describeEdge(oc, edge);
  });
  return {
    faces,
    edges,
    faceEdges,
    edgeFaces,
    edgeGeoms,
    faceIndexOf: (raw) => faceIndex.indexOf(raw),
    edgeIndexOf: (raw) => edgeIndex.indexOf(raw),
    pinAll() {
      for (const w of [...faces, ...edges]) pin(w.wrapped);
    },
    dispose() {
      for (const w of [...faces, ...edges]) {
        unpin((w as unknown as { _wrapped: object | null })._wrapped);
        release(w);
      }
      faceIndex.dispose();
      edgeIndex.dispose();
    },
  };
}

/** Faces of `shape` in explorer order, without leaking raw handles. */
export function facesOf(oc: OpenCascade, shape: { wrapped: RawShape }): R.Face[] {
  const index = new SubShapeIndex(oc, shape.wrapped, 'face');
  try {
    return index.items.map((raw) => new R.Face(oc.TopoDS.Face(raw as never)));
  } finally {
    index.dispose();
  }
}

/** Edges of `shape` in explorer order, without leaking raw handles. */
export function edgesOf(oc: OpenCascade, shape: { wrapped: RawShape }): R.Edge[] {
  const index = new SubShapeIndex(oc, shape.wrapped, 'edge');
  try {
    return index.items.map((raw) => new R.Edge(oc.TopoDS.Edge(raw as never)));
  } finally {
    index.dispose();
  }
}

/** Items of an OCCT shape list (deletes the list; the caller owns and must delete the items). */
export function takeList(oc: OpenCascade, list: { delete(): void }): RawShape[] {
  const copy = new oc.NCollection_List_TopoDS_Shape(list as never);
  const out: RawShape[] = [];
  try {
    while (copy.Size() > 0) {
      out.push(copy.First() as RawShape);
      copy.RemoveFirst();
    }
  } finally {
    copy.delete();
    list.delete();
  }
  return out;
}

// ---- modelling history ------------------------------------------------------------

/** What OCCT's history reports about a builder's result. */
export interface HistorySource {
  Modified(shape: never): { delete(): void };
  Generated(shape: never): { delete(): void };
}

/**
 * Where each face of an operation result came from, according to OCCT's
 * own history (`BRepBuilderAPI_MakeShape::Modified/Generated`):
 * - `identical[j]`: the input face (index into the operation's input face
 *   list) that is the very same face (`IsSame`), `-1` if none; `flipped[j]`
 *   when it appears with the opposite orientation (a cut tool's face).
 * - `modified[j]`: input faces the result face was modified from (split
 *   pieces share one input; merged coplanar faces list several).
 * - `generated[j]`: roles of the generators (edges, faces) that produced it.
 */
export interface FaceOrigins {
  identical: number[];
  flipped: boolean[];
  modified: number[][];
  generated: string[][];
}

export function faceOrigins(
  oc: OpenCascade,
  history: HistorySource | null,
  result: Topology,
  inputFaces: readonly RawShape[],
  generators: readonly { raw: RawShape; role: string }[] = [],
): FaceOrigins {
  const n = result.faces.length;
  const origins: FaceOrigins = {
    identical: new Array<number>(n).fill(-1),
    flipped: new Array<boolean>(n).fill(false),
    modified: Array.from({ length: n }, () => []),
    generated: Array.from({ length: n }, () => []),
  };
  inputFaces.forEach((input, i) => {
    const same = result.faceIndexOf(input);
    if (same >= 0) {
      if (origins.identical[same] === -1) {
        origins.identical[same] = i;
        origins.flipped[same] =
          (result.faces[same]!.wrapped as RawShape).Orientation() !== input.Orientation();
      }
      return;
    }
    if (!history) return;
    for (const item of takeList(oc, history.Modified(input as never))) {
      const j = result.faceIndexOf(item);
      item.delete();
      if (j >= 0 && !origins.modified[j]!.includes(i)) origins.modified[j]!.push(i);
    }
  });
  if (history) {
    for (const { raw, role } of generators) {
      for (const item of takeList(oc, history.Generated(raw as never))) {
        const j = result.faceIndexOf(item);
        item.delete();
        if (j >= 0 && !origins.generated[j]!.includes(role)) origins.generated[j]!.push(role);
      }
    }
  }
  return origins;
}

/** A modelling result together with the builder that knows its history (delete it after naming). */
export interface HistoryResult {
  shape: Shape3D;
  history: HistorySource & { delete(): void };
}

function castSolid(raw: RawShape, label: string): Shape3D {
  const shape = R.cast(raw as never);
  if (!R.isShape3D(shape)) {
    shape.delete();
    throw new Error(`${label} did not produce a 3D shape`);
  }
  return shape;
}

/**
 * Boolean operation with history. Non-destructive: OCCT must not change the
 * tolerances of its arguments in place, because the arguments are cached
 * checkpoint shapes that later edits start from again. Coplanar faces and
 * collinear edges are unified like replicad's own booleans.
 */
export function booleanWithHistory(
  oc: OpenCascade,
  operation: 'fuse' | 'cut' | 'common',
  target: Shape3D,
  tool: Shape3D,
): HistoryResult {
  const builder =
    operation === 'fuse'
      ? new oc.BRepAlgoAPI_Fuse()
      : operation === 'cut'
        ? new oc.BRepAlgoAPI_Cut()
        : new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  try {
    args.Append(target.wrapped as never);
    tools.Append(tool.wrapped as never);
    builder.SetArguments(args);
    builder.SetTools(tools);
    builder.SetNonDestructive(true);
    builder.Build();
    if (builder.HasErrors()) throw new Error(`Boolean ${operation} failed`);
    builder.SimplifyResult(true, true, 1e-3);
    const raw = builder.Shape() as RawShape;
    try {
      return { shape: castSolid(raw, `Boolean ${operation}`), history: builder as never };
    } finally {
      raw.delete();
    }
  } catch (error) {
    builder.delete();
    throw error;
  } finally {
    args.delete();
    tools.delete();
  }
}

/** Constant-radius fillet (or symmetric chamfer) of `edges` with history. */
export function blendWithHistory(
  oc: OpenCascade,
  kind: 'fillet' | 'chamfer',
  shape: Shape3D,
  edges: readonly R.Edge[],
  size: number,
): HistoryResult {
  const builder =
    kind === 'fillet'
      ? new oc.BRepFilletAPI_MakeFillet(
          shape.wrapped as never,
          oc.ChFi3d_FilletShape.ChFi3d_Rational as never,
        )
      : new oc.BRepFilletAPI_MakeChamfer(shape.wrapped as never);
  try {
    for (const edge of edges)
      (builder as { Add(r: number, e: never): void }).Add(size, edge.wrapped as never);
    builder.Build();
    if (!builder.IsDone())
      throw new Error(`${kind === 'fillet' ? 'Fillet' : 'Chamfer'} could not be built`);
    const raw = builder.Shape() as RawShape;
    try {
      return { shape: castSolid(raw, kind), history: builder as never };
    } finally {
      raw.delete();
    }
  } catch (error) {
    builder.delete();
    throw error;
  }
}

/** Hollows `shape` (walls of `thickness` inside), removing `openFaces`, with history. */
export function shellWithHistory(
  oc: OpenCascade,
  shape: Shape3D,
  openFaces: readonly R.Face[],
  thickness: number,
): HistoryResult {
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  const faces = new oc.NCollection_List_TopoDS_Shape();
  try {
    for (const face of openFaces) faces.Append(face.wrapped as never);
    builder.MakeThickSolidByJoin(
      shape.wrapped as never,
      faces,
      -thickness,
      1e-3,
      oc.BRepOffset_Mode.BRepOffset_Skin as never,
      false,
      false,
      oc.GeomAbs_JoinType.GeomAbs_Arc as never,
      false,
    );
    const raw = builder.Shape() as RawShape;
    try {
      return { shape: castSolid(raw, 'Shell'), history: builder as never };
    } finally {
      raw.delete();
    }
  } catch (error) {
    builder.delete();
    throw error;
  } finally {
    faces.delete();
  }
}

// ---- tessellation -----------------------------------------------------------------

export interface RawMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Triples (start index into `indices`, count of indices, face hash). */
  faceGroups: Int32Array;
}

export interface RawEdgeMesh {
  lines: Float32Array;
  /** Triples (start vertex, vertex count, edge hash). */
  edgeGroups: Int32Array;
}

function heapCopy<T extends Float32Array | Uint32Array | Int32Array>(
  Ctor: new (buffer: ArrayBuffer, offset: number, length: number) => T,
  buffer: ArrayBuffer,
  pointer: number,
  length: number,
): T {
  return (new Ctor(buffer, pointer >>> 0, length) as T).slice() as T;
}

/**
 * Triangulates `shape` (OCCT keeps each face's triangulation on the face
 * itself, so faces shared with an already meshed shape are not meshed
 * again) and copies the result straight out of the wasm heap.
 */
export function meshShape(
  oc: OpenCascade,
  shape: Shape3D,
  tolerance: number,
  angularTolerance: number,
): RawMesh {
  const raw = oc.ReplicadMeshExtractor.extract(
    shape.wrapped as never,
    tolerance,
    angularTolerance,
    false,
  );
  try {
    const buffer = (oc as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory
      .buffer as ArrayBuffer;
    return {
      positions: heapCopy(Float32Array, buffer, raw.getVerticesPtr(), raw.getVerticesSize()),
      normals: heapCopy(Float32Array, buffer, raw.getNormalsPtr(), raw.getNormalsSize()),
      indices: heapCopy(Uint32Array, buffer, raw.getTrianglesPtr(), raw.getTrianglesSize()),
      faceGroups: heapCopy(Int32Array, buffer, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize()),
    };
  } finally {
    raw.delete();
  }
}

export function meshShapeEdges(
  oc: OpenCascade,
  shape: Shape3D,
  tolerance: number,
  angularTolerance: number,
): RawEdgeMesh {
  const raw = oc.ReplicadEdgeMeshExtractor.extract(
    shape.wrapped as never,
    tolerance,
    angularTolerance,
  );
  try {
    const buffer = (oc as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory
      .buffer as ArrayBuffer;
    return {
      lines: heapCopy(Float32Array, buffer, raw.getLinesPtr(), raw.getLinesSize()),
      edgeGroups: heapCopy(Int32Array, buffer, raw.getEdgeGroupsPtr(), raw.getEdgeGroupsSize()),
    };
  } finally {
    raw.delete();
  }
}

/** `ReplicadShapeHasher` hash of a raw shape (what the mesh extractors report per group). */
export function shapeHash(oc: OpenCascade, raw: RawShape): number {
  return oc.ReplicadShapeHasher.HashCode(raw as never, HASH_MAX);
}

/**
 * A point of the face's surface (at the middle of its UV bounds) and the
 * outward unit normal there (face orientation applied). Replaces replicad's
 * `face.normalAt(point)`, which projects the point onto the surface and
 * leaks ~2.5 KB of wasm heap per call.
 */
export function surfaceSample(oc: OpenCascade, face: R.Face): { point: Vec3; normal: Vec3 } {
  const bounds = oc.BRepTools.UVBounds(face.wrapped as never, 0, 0, 0, 0);
  const u = 0.5 * (bounds.UMin + bounds.UMax);
  const v = 0.5 * (bounds.VMin + bounds.VMax);
  const props = new oc.BRepGProp_Face(face.wrapped as never, false);
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  try {
    props.Normal(u, v, p, n);
    return {
      point: [p.X(), p.Y(), p.Z()],
      normal: normalize([n.X(), n.Y(), n.Z()]),
    };
  } finally {
    n.delete();
    p.delete();
    props.delete();
  }
}

/** `BRepCheck_Analyzer` verdict. */
export function isValidShape(oc: OpenCascade, shape: Shape3D): boolean {
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped as never, true, false, false);
  try {
    return analyzer.IsValid();
  } finally {
    analyzer.delete();
  }
}

/** Minimum distance between a point and a shape (face/edge), via `BRepExtrema_DistShapeShape`. */
export function distanceToShape(
  oc: OpenCascade,
  point: Vec3,
  shape: { wrapped: RawShape },
): number {
  const vertex = R.makeVertex(point);
  const dist = new oc.BRepExtrema_DistShapeShape(
    vertex.wrapped as never,
    shape.wrapped as never,
    1e-7,
  );
  try {
    return dist.IsDone() ? dist.Value() : Infinity;
  } finally {
    dist.delete();
    vertex.delete();
  }
}

/** Current wasm heap size in bytes (a high-water mark: wasm memory never shrinks). */
export function heapBytes(oc: OpenCascade): number {
  const memory = (oc as unknown as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
  return memory ? memory.buffer.byteLength : 0;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
