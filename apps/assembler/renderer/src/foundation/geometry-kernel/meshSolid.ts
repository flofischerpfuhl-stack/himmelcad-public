/**
 * Mesh → B-rep solid in OCCT (the `meshSolid` feature). The mesh is
 * already welded, closed, manifold and outward-oriented
 * (`interop/meshSolid.ts#prepareSolidMesh`). Topology is shared from the
 * start — one `TopoDS_Vertex` per mesh vertex, one `TopoDS_Edge` per mesh
 * edge — so no sewing pass is needed (measured in this wasm build: sewing
 * 19 k separate triangles took 34 s, the shared build ~10 s; a
 * planar-merged CAD mesh is a small fraction of that). Each coplanar region
 * becomes one planar face with its holes; a region whose boundary is
 * ambiguous, or whose merged face OCCT rejects, falls back to one face per
 * triangle. `ShapeUpgrade_UnifySameDomain` then merges collinear edges and
 * any remaining coplanar faces (skipped above {@link UNIFY_MAX_FACES}
 * faces: its cost grows quickly). The result must pass `BRepCheck`; if the
 * merged build does not, the per-triangle build is tried once more, and a
 * second failure is reported, never returned as a body.
 */
import './occtArena.js';
import * as R from 'replicad';

import { planarRegions, type WeldedMesh } from './meshSolidPayload.js';

type OpenCascade = ReturnType<typeof R.getOC>;
type RawShape = R.Shape3D['wrapped'];

const UNIFY_MAX_FACES = 3000;

export interface MeshSolidStats {
  faces: number;
  triangles: number;
  /** Triangles that ended up inside merged planar faces. */
  merged: number;
}

interface Owned {
  delete(): void;
}

function build(
  oc: OpenCascade,
  mesh: WeldedMesh,
  merge: boolean,
): { solid: RawShape; faces: number; merged: number } {
  const owned: Owned[] = [];
  const own = <T extends Owned>(o: T): T => {
    owned.push(o);
    return o;
  };
  try {
    const p = mesh.positions;
    const t = mesh.indices;
    const n = p.length / 3;
    const vertices: RawShape[] = [];
    for (let i = 0; i < n; i += 1) {
      const pnt = new oc.gp_Pnt(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
      const make = new oc.BRepBuilderAPI_MakeVertex(pnt);
      vertices.push(own(make.Vertex() as RawShape));
      make.delete();
      pnt.delete();
    }
    const edges = new Map<number, RawShape>();
    const reversed = new Map<number, RawShape>();
    /** The edge a→b, oriented from a to b. */
    const edge = (a: number, b: number): RawShape => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * n + hi;
      let e = edges.get(key);
      if (!e) {
        const make = new oc.BRepBuilderAPI_MakeEdge(vertices[lo] as never, vertices[hi] as never);
        if (!make.IsDone()) {
          make.delete();
          throw new Error('A mesh edge is too short for the kernel');
        }
        e = own(make.Edge() as RawShape);
        make.delete();
        edges.set(key, e);
      }
      if (a === lo) return e;
      let r = reversed.get(key);
      if (!r) {
        r = own(e.Reversed() as RawShape);
        reversed.set(key, r);
      }
      return r;
    };
    const wireOf = (loop: number[]): RawShape | null => {
      // `Add(list)` is the single-argument overload this build binds.
      const list = new oc.NCollection_List_TopoDS_Shape();
      const make = new oc.BRepBuilderAPI_MakeWire();
      try {
        for (let i = 0; i < loop.length; i += 1) {
          list.Append(edge(loop[i]!, loop[(i + 1) % loop.length]!) as never);
        }
        make.Add(list);
        if (!make.IsDone()) return null;
        return own(make.Wire() as RawShape);
      } finally {
        make.delete();
        list.delete();
      }
    };
    const loopArea = (loop: number[], normal: [number, number, number]): number => {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let i = 0; i < loop.length; i += 1) {
        const a = loop[i]! * 3;
        const b = loop[(i + 1) % loop.length]! * 3;
        sx += p[a + 1]! * p[b + 2]! - p[a + 2]! * p[b + 1]!;
        sy += p[a + 2]! * p[b]! - p[a]! * p[b + 2]!;
        sz += p[a]! * p[b + 1]! - p[a + 1]! * p[b]!;
      }
      return (sx * normal[0] + sy * normal[1] + sz * normal[2]) / 2;
    };
    const makePlanarFace = (
      loops: number[][],
      normal: [number, number, number],
    ): RawShape | null => {
      const areas = loops.map((loop) => loopArea(loop, normal));
      const outerIndex = areas.indexOf(Math.max(...areas));
      if (outerIndex < 0 || !(areas[outerIndex]! > 0)) return null;
      const outer = wireOf(loops[outerIndex]!);
      if (!outer) return null;
      const origin = loops[outerIndex]![0]! * 3;
      const pnt = own(new oc.gp_Pnt(p[origin]!, p[origin + 1]!, p[origin + 2]!));
      const dir = own(new oc.gp_Dir(normal[0], normal[1], normal[2]));
      const plane = own(new oc.gp_Pln(pnt, dir));
      const make = new oc.BRepBuilderAPI_MakeFace(plane, outer as never, true);
      try {
        for (let k = 0; k < loops.length; k += 1) {
          if (k === outerIndex) continue;
          const hole = wireOf(loops[k]!);
          if (!hole) return null;
          make.Add(hole as never);
        }
        if (!make.IsDone()) return null;
        return own(make.Face() as RawShape);
      } finally {
        make.delete();
      }
    };

    const shell = own(new oc.TopoDS_Shell());
    const builder = own(new oc.TopoDS_Builder());
    builder.MakeShell(shell);
    let faces = 0;
    let merged = 0;
    const addTriangle = (tri: number) => {
      const a = t[tri * 3]!;
      const b = t[tri * 3 + 1]!;
      const c = t[tri * 3 + 2]!;
      const ax = p[a * 3]!;
      const ay = p[a * 3 + 1]!;
      const az = p[a * 3 + 2]!;
      const u = [p[b * 3]! - ax, p[b * 3 + 1]! - ay, p[b * 3 + 2]! - az];
      const v = [p[c * 3]! - ax, p[c * 3 + 1]! - ay, p[c * 3 + 2]! - az];
      const nrm: [number, number, number] = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ];
      const len = Math.hypot(...nrm);
      const face = makePlanarFace([[a, b, c]], [nrm[0] / len, nrm[1] / len, nrm[2] / len]);
      if (!face) throw new Error('A mesh triangle could not be made into a face');
      builder.Add(shell as never, face as never);
      faces += 1;
    };
    const regions = merge
      ? planarRegions(mesh)
      : Array.from({ length: t.length / 3 }, (_, i) => ({
          triangles: [i],
          normal: [0, 0, 1] as [number, number, number],
          loops: null,
        }));
    for (const region of regions) {
      if (region.triangles.length === 1 || !region.loops) {
        for (const tri of region.triangles) addTriangle(tri);
        continue;
      }
      const face = makePlanarFace(region.loops, region.normal);
      if (!face) {
        for (const tri of region.triangles) addTriangle(tri);
        continue;
      }
      builder.Add(shell as never, face as never);
      faces += 1;
      merged += region.triangles.length;
    }
    const makeSolid = new oc.BRepBuilderAPI_MakeSolid();
    try {
      makeSolid.Add(own(oc.TopoDS.Shell(shell as never)));
      if (!makeSolid.IsDone()) throw new Error('The faces do not close into a solid');
      return { solid: makeSolid.Solid() as RawShape, faces, merged };
    } finally {
      makeSolid.delete();
    }
  } finally {
    for (const o of owned.reverse()) o.delete();
  }
}

function unify(oc: OpenCascade, solid: RawShape): RawShape {
  const tool = new oc.ShapeUpgrade_UnifySameDomain(solid as never, true, true, false);
  try {
    tool.Build();
    return tool.Shape() as RawShape;
  } finally {
    tool.delete();
  }
}

function isValid(oc: OpenCascade, shape: RawShape): boolean {
  const analyzer = new oc.BRepCheck_Analyzer(shape as never, true, false, false);
  try {
    return analyzer.IsValid();
  } finally {
    analyzer.delete();
  }
}

function countFaces(oc: OpenCascade, shape: RawShape): number {
  const e = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
  const explorer = new oc.TopExp_Explorer(
    shape as never,
    e.TopAbs_FACE as never,
    e.TopAbs_SHAPE as never,
  );
  let count = 0;
  try {
    for (; explorer.More(); explorer.Next()) count += 1;
  } finally {
    explorer.delete();
  }
  return count;
}

/** Builds the solid of a prepared mesh. Throws with the reason when OCCT cannot make a valid one. */
export function buildMeshSolid(
  oc: OpenCascade,
  mesh: WeldedMesh,
): { shape: R.Shape3D; stats: MeshSolidStats } {
  const triangles = mesh.indices.length / 3;
  for (const merge of [true, false]) {
    const built = build(oc, mesh, merge);
    let solid = built.solid;
    if (built.faces <= UNIFY_MAX_FACES) {
      const unified = unify(oc, solid);
      solid.delete();
      solid = unified;
    }
    if (isValid(oc, solid)) {
      const faces = countFaces(oc, solid);
      const shape = R.cast(solid as never) as R.Shape3D;
      solid.delete();
      return { shape, stats: { faces, triangles, merged: built.merged } };
    }
    solid.delete();
  }
  throw new Error('OCCT could not build a valid solid from this mesh (BRepCheck failed)');
}
