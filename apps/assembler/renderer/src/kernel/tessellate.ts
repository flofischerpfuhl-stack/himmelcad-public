/**
 * Incremental tessellation of B-rep bodies, per face.
 *
 * OCCT stores a face's triangulation on the face itself, and faces a
 * modelling operation did not touch are shared between its input and its
 * result. So after an edit only the new faces need meshing:
 * `BRepMesh_IncrementalMesh` keeps every face whose triangulation already
 * meets the deflection, and a JS-side cache keeps the extracted arrays of
 * every face (keyed by the face itself: TShape, location, orientation, plus
 * a fingerprint of its triangulation), so unchanged faces are neither
 * meshed nor copied out of the wasm heap again.
 *
 * When most faces are new (first tessellation, big edits) the whole body
 * goes through replicad's C++ mesh extractor instead — it re-meshes every
 * face but extracts in one pass, much faster than per-node JS access — and
 * its output seeds the face cache.
 */
import type * as R from 'replicad';

import type { OpenCascade, RawShape, Shape3D, Topology } from './occt.js';
import { meshShape, shapeHash, type RawMesh } from './occt.js';

interface FaceMesh {
  face: RawShape;
  reversed: boolean;
  fingerprint: string;
  positions: Float32Array;
  normals: Float32Array;
  /** Triangle vertex indices, local to this face. */
  indices: Uint32Array;
  bytes: number;
  lastUsed: number;
}

export interface BodyMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** First triangle and triangle count per topology face. */
  faceRanges: { start: number; count: number }[];
  /** Faces meshed/extracted now vs reused from the cache. */
  facesMeshed: number;
  facesReused: number;
}

/** Fraction of unknown faces above which the whole body goes through the C++ extractor. */
const BULK_FRACTION = 0.5;

export class FaceMeshCache {
  private readonly entries = new Map<number, FaceMesh[]>();
  private bytes = 0;
  private clock = 0;

  constructor(
    private readonly oc: OpenCascade,
    private readonly budgetBytes: number,
  ) {}

  get size(): number {
    let n = 0;
    for (const list of this.entries.values()) n += list.length;
    return n;
  }

  get byteSize(): number {
    return this.bytes;
  }

  private reversedOf(face: RawShape): boolean {
    return face.Orientation() === this.oc.TopAbs_Orientation.TopAbs_REVERSED;
  }

  private find(face: RawShape, hash: number): FaceMesh | undefined {
    const reversed = this.reversedOf(face);
    return this.entries
      .get(hash)
      ?.find((e) => e.reversed === reversed && e.face.IsSame(face as never));
  }

  /** Fingerprint of the triangulation currently stored on `face` (`null`: none). */
  private fingerprint(face: RawShape): string | null {
    const oc = this.oc;
    const location = new oc.TopLoc_Location();
    try {
      const tri = oc.BRep_Tool.Triangulation(face as never, location, 0) as unknown as {
        NbNodes(): number;
        NbTriangles(): number;
        Deflection(): number;
        delete(): void;
        isNull?(): boolean;
      } | null;
      if (!tri || tri.isNull?.()) return null;
      try {
        return `${tri.NbNodes()}/${tri.NbTriangles()}/${tri.Deflection()}`;
      } finally {
        tri.delete();
      }
    } catch {
      return null;
    } finally {
      location.delete();
    }
  }

  private store(
    face: RawShape,
    hash: number,
    data: Omit<FaceMesh, 'face' | 'reversed' | 'bytes' | 'lastUsed'>,
  ): FaceMesh {
    const existing = this.find(face, hash);
    if (existing) this.remove(hash, existing);
    const entry: FaceMesh = {
      ...data,
      // Own a handle of the face: equality checks must survive the body shape.
      face: this.oc.TopoDS.Face(face as never) as unknown as RawShape,
      reversed: this.reversedOf(face),
      bytes: data.positions.byteLength + data.normals.byteLength + data.indices.byteLength + 96,
      lastUsed: ++this.clock,
    };
    const list = this.entries.get(hash);
    if (list) list.push(entry);
    else this.entries.set(hash, [entry]);
    this.bytes += entry.bytes;
    return entry;
  }

  private remove(hash: number, entry: FaceMesh): void {
    const list = this.entries.get(hash);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.entries.delete(hash);
    this.bytes -= entry.bytes;
    entry.face.delete();
  }

  /** Evicts least recently used faces beyond the byte budget. */
  evict(): void {
    if (this.bytes <= this.budgetBytes) return;
    const all: [number, FaceMesh][] = [];
    for (const [hash, list] of this.entries) for (const e of list) all.push([hash, e]);
    all.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [hash, entry] of all) {
      if (this.bytes <= this.budgetBytes * 0.8) break;
      this.remove(hash, entry);
    }
  }

  clear(): void {
    for (const [hash, list] of [...this.entries]) for (const e of [...list]) this.remove(hash, e);
  }

  /** Triangulates `shape` (faces in `topology` order), reusing every unchanged face. */
  tessellate(
    shape: Shape3D,
    topology: Topology,
    tolerance: number,
    angularTolerance: number,
  ): BodyMeshData {
    const oc = this.oc;
    const faces = topology.faces.map((f) => f.wrapped as RawShape);
    const hashes = faces.map((f) => shapeHash(oc, f));
    const known = faces.map((f, i) => this.find(f, hashes[i]!));
    const unknown = known.filter((k) => !k).length;
    if (faces.length > 0 && unknown > BULK_FRACTION * faces.length) {
      const mesh = meshShape(oc, shape, tolerance, angularTolerance);
      const ranges = this.seed(mesh, faces, hashes);
      return {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        faceRanges: ranges,
        facesMeshed: faces.length,
        facesReused: 0,
      };
    }
    // Faces whose cached arrays still match their triangulation are done; mesh only the others.
    const fresh = faces.map((face, i) => {
      const cached = known[i];
      if (!cached) return false;
      const fingerprint = this.fingerprint(face);
      return (
        fingerprint !== null &&
        cached.fingerprint === fingerprint &&
        deflectionOf(fingerprint) <= tolerance * 1.001
      );
    });
    const staleIndices = faces.map((_, i) => i).filter((i) => !fresh[i]);
    if (staleIndices.length > 0) {
      const stale = staleIndices.map((i) => faces[i]!);
      const compound = compoundOf(oc, stale);
      try {
        const mesh = meshShape(
          oc,
          { wrapped: compound } as unknown as Shape3D,
          tolerance,
          angularTolerance,
        );
        this.seed(
          mesh,
          stale,
          staleIndices.map((i) => hashes[i]!),
        );
      } finally {
        compound.delete();
      }
    }
    const parts = faces.map((face, i) => {
      const cached = fresh[i] ? known[i] : this.find(face, hashes[i]!);
      if (cached && (fresh[i] || staleIndices.includes(i))) {
        cached.lastUsed = ++this.clock;
        return cached;
      }
      // The extractor output could not be split per face: copy this face out directly.
      const data = extractFace(oc, topology.faces[i]!);
      return this.store(face, hashes[i]!, { ...data, fingerprint: this.fingerprint(face) ?? '' });
    });
    return {
      ...concat(parts),
      facesMeshed: staleIndices.length,
      facesReused: faces.length - staleIndices.length,
    };
  }

  /**
   * Splits an extractor result into per-face cache entries (a face's
   * vertices are one contiguous block of the output) and returns each
   * face's triangle range.
   */
  private seed(
    mesh: RawMesh,
    faces: RawShape[],
    hashes: number[],
  ): { start: number; count: number }[] {
    const byHash = new Map<number, number[]>();
    hashes.forEach((hash, i) => {
      const list = byHash.get(hash);
      if (list) list.push(i);
      else byHash.set(hash, [i]);
    });
    const used = new Set<number>();
    const ranges: { start: number; count: number }[] = faces.map(() => ({ start: 0, count: 0 }));
    for (let g = 0; g + 2 < mesh.faceGroups.length; g += 3) {
      const candidates = byHash.get(mesh.faceGroups[g + 2]!) ?? [];
      const faceIndex = candidates.find((c) => !used.has(c));
      if (faceIndex === undefined) continue;
      used.add(faceIndex);
      const start = mesh.faceGroups[g]! / 3;
      const count = mesh.faceGroups[g + 1]! / 3;
      ranges[faceIndex] = { start, count };
      let lo = Infinity;
      let hi = -1;
      for (let k = start * 3; k < (start + count) * 3; k += 1) {
        const v = mesh.indices[k]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const face = faces[faceIndex]!;
      const fingerprint = this.fingerprint(face);
      if (count > 0 && fingerprint !== null && hi - lo + 1 === countOf(fingerprint)) {
        const indices = mesh.indices.slice(start * 3, (start + count) * 3);
        for (let k = 0; k < indices.length; k += 1) indices[k] = indices[k]! - lo;
        this.store(face, hashes[faceIndex]!, {
          fingerprint,
          positions: mesh.positions.slice(lo * 3, (hi + 1) * 3),
          normals: mesh.normals.slice(lo * 3, (hi + 1) * 3),
          indices,
        });
      }
    }
    return ranges;
  }
}

/** A compound of `faces` (the caller deletes it). */
function compoundOf(oc: OpenCascade, faces: RawShape[]): RawShape {
  const compound = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  try {
    builder.MakeCompound(compound);
    for (const face of faces) builder.Add(compound, face as never);
  } finally {
    builder.delete();
  }
  return compound as unknown as RawShape;
}
function countOf(fingerprint: string): number {
  return Number(fingerprint.split('/')[0]);
}

function deflectionOf(fingerprint: string): number {
  return Number(fingerprint.split('/')[2]);
}

function concat(parts: FaceMesh[]): Omit<BodyMeshData, 'facesMeshed' | 'facesReused'> {
  let vertices = 0;
  let indexCount = 0;
  for (const p of parts) {
    vertices += p.positions.length / 3;
    indexCount += p.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const indices = new Uint32Array(indexCount);
  const faceRanges: { start: number; count: number }[] = [];
  let v = 0;
  let t = 0;
  for (const p of parts) {
    positions.set(p.positions, v * 3);
    normals.set(p.normals, v * 3);
    for (let k = 0; k < p.indices.length; k += 1) indices[t * 3 + k] = p.indices[k]! + v;
    const count = p.indices.length / 3;
    faceRanges.push({ start: t, count });
    v += p.positions.length / 3;
    t += count;
  }
  return { positions, normals, indices, faceRanges };
}

/**
 * Copies one face's triangulation out of OCCT (nodes in world space with
 * the face location applied, surface normals, triangles wound by the face
 * orientation) — the same arrays replicad's extractor produces.
 */
function extractFace(
  oc: OpenCascade,
  faceWrapper: R.Face,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const face = faceWrapper.wrapped as RawShape;
  const location = new oc.TopLoc_Location();
  const empty = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  };
  type Tri = {
    NbNodes(): number;
    NbTriangles(): number;
    HasNormals(): boolean;
    Node(i: number): { X(): number; Y(): number; Z(): number; delete(): void };
    Normal(i: number): { X(): number; Y(): number; Z(): number; delete(): void };
    Triangle(i: number): { Value(k: number): number; delete(): void };
    delete(): void;
    isNull?(): boolean;
  };
  let tri: Tri | null = null;
  try {
    tri = oc.BRep_Tool.Triangulation(face as never, location, 0) as unknown as Tri | null;
    if (!tri || tri.isNull?.()) return empty;
    if (!tri.HasNormals()) {
      oc.BRepLib_ToolTriangulatedShape.ComputeNormals(face as never, tri as never);
    }
    const n = tri.NbNodes();
    const t = tri.NbTriangles();
    let m: number[] | null = null;
    if (!location.IsIdentity()) {
      const trsf = location.Transformation();
      m = [];
      for (let r = 1; r <= 3; r += 1) for (let c = 1; c <= 4; c += 1) m.push(trsf.Value(r, c));
      trsf.delete();
    }
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const sign = reversed ? -1 : 1;
    for (let i = 1; i <= n; i += 1) {
      const p = tri.Node(i);
      let x = p.X();
      let y = p.Y();
      let z = p.Z();
      p.delete();
      const d = tri.Normal(i);
      let nx = d.X();
      let ny = d.Y();
      let nz = d.Z();
      d.delete();
      if (m) {
        const px = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
        const py = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
        const pz = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
        x = px;
        y = py;
        z = pz;
        const qx = m[0]! * nx + m[1]! * ny + m[2]! * nz;
        const qy = m[4]! * nx + m[5]! * ny + m[6]! * nz;
        const qz = m[8]! * nx + m[9]! * ny + m[10]! * nz;
        nx = qx;
        ny = qy;
        nz = qz;
      }
      const o = (i - 1) * 3;
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
      normals[o] = sign * nx;
      normals[o + 1] = sign * ny;
      normals[o + 2] = sign * nz;
    }
    const indices = new Uint32Array(t * 3);
    for (let i = 1; i <= t; i += 1) {
      const triangle = tri.Triangle(i);
      const a = triangle.Value(1) - 1;
      const b = triangle.Value(2) - 1;
      const c = triangle.Value(3) - 1;
      triangle.delete();
      const o = (i - 1) * 3;
      indices[o] = a;
      indices[o + 1] = reversed ? c : b;
      indices[o + 2] = reversed ? b : c;
    }
    return { positions, normals, indices };
  } finally {
    tri?.delete();
    location.delete();
  }
}
