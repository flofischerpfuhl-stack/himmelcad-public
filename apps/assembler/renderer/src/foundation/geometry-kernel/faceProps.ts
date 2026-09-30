/**
 * Per-face exact properties, cached across evaluations: bounding box,
 * volume contribution and geometric validity. A body's exact bounding box
 * is the union of its faces' optimal boxes and its volume the sum of its
 * faces' divergence-theorem contributions (`BRepGProp::VolumeProperties`
 * does exactly that sum), so after an edit only the new faces are measured
 * — on the 200-face bench plate the whole-body calls cost ~220 ms per edit.
 *
 * Validity: a body analysed from scratch (`full`) gets the complete
 * `BRepCheck_Analyzer`. Afterwards, an edited body is checked incrementally:
 * `BRepCheck_Analyzer` with geometric controls on every face not checked
 * before, plus closure of the solid (every edge bounds two faces, or is the
 * seam of one) — a whole-solid analysis costs ~26 ms on the bench plate even
 * without geometric controls.
 */
import type { Vec3 } from '../document/document.js';
import type { OpenCascade, RawShape, Shape3D, Topology } from './occt.js';
import { isValidShape, shapeHash } from './occt.js';

interface FaceProps {
  face: RawShape;
  min?: Vec3;
  max?: Vec3;
  /** Volume contribution per orientation (`f`orward/`r`eversed). */
  volume: { f?: number; r?: number };
  valid?: boolean;
  lastUsed: number;
}

export class FacePropsCache {
  private readonly entries = new Map<number, FaceProps[]>();
  private count = 0;
  private clock = 0;

  constructor(private readonly oc: OpenCascade) {}

  get size(): number {
    return this.count;
  }

  private plane: unknown = null;

  /** The plane z = 0 (created once, owned for the evaluator's lifetime). */
  private referencePlane(): never {
    if (!this.plane) {
      const oc = this.oc;
      const origin = new oc.gp_Pnt(0, 0, 0);
      const up = new oc.gp_Dir(0, 0, 1);
      this.plane = new oc.gp_Pln(origin, up);
      origin.delete();
      up.delete();
    }
    return this.plane as never;
  }

  private readonly perTopology = new WeakMap<Topology, FaceProps[]>();

  /** The entries of a topology's faces (one lookup per face and topology). */
  private entriesOf(topology: Topology): FaceProps[] {
    let list = this.perTopology.get(topology);
    if (!list) {
      list = topology.faces.map((f) => this.entry(f.wrapped as RawShape));
      this.perTopology.set(topology, list);
    } else {
      for (const e of list) e.lastUsed = ++this.clock;
    }
    return list;
  }

  private entry(face: RawShape): FaceProps {
    const hash = shapeHash(this.oc, face);
    const list = this.entries.get(hash);
    const found = list?.find((e) => e.face.IsSame(face as never));
    if (found) {
      found.lastUsed = ++this.clock;
      return found;
    }
    const created: FaceProps = {
      face: this.oc.TopoDS.Face(face as never) as unknown as RawShape,
      volume: {},
      lastUsed: ++this.clock,
    };
    if (list) list.push(created);
    else this.entries.set(hash, [created]);
    this.count += 1;
    return created;
  }

  /**
   * Exact axis-aligned bounding box of the faces of `topology`. Faces
   * measured before reuse their optimal box. A new face first gets a cheap
   * conservative box (`BRepBndLib::Add`); only if that sticks out of the
   * union of the exact boxes is its optimal box computed (slow for blends).
   */
  bounds(topology: Topology): [Vec3, Vec3] {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const grow = (lo: Vec3, hi: Vec3) => {
      for (let k = 0; k < 3; k += 1) {
        if (lo[k]! < min[k]!) min[k] = lo[k]!;
        if (hi[k]! > max[k]!) max[k] = hi[k]!;
      }
    };
    const entries = this.entriesOf(topology);
    const pending: FaceProps[] = [];
    for (const e of entries) {
      if (e.min && e.max) grow(e.min, e.max);
      else pending.push(e);
    }
    for (const e of pending) {
      const [lo, hi] = this.box(e.face, false);
      const inside = [0, 1, 2].every((k) => lo[k]! >= min[k]! && hi[k]! <= max[k]!);
      if (inside) continue; // cannot change the union; measure exactly only when needed
      [e.min, e.max] = this.box(e.face, true);
      grow(e.min, e.max);
    }
    return [min, max];
  }

  private box(face: RawShape, optimal: boolean): [Vec3, Vec3] {
    const oc = this.oc;
    const box = new oc.Bnd_Box();
    try {
      if (optimal) oc.BRepBndLib.AddOptimal(face as never, box, false, false);
      else oc.BRepBndLib.Add(face as never, box, false);
      if (box.IsVoid()) {
        return [
          [Infinity, Infinity, Infinity],
          [-Infinity, -Infinity, -Infinity],
        ];
      }
      const lo = box.CornerMin();
      const hi = box.CornerMax();
      try {
        return [
          [lo.X(), lo.Y(), lo.Z()],
          [hi.X(), hi.Y(), hi.Z()],
        ];
      } finally {
        lo.delete();
        hi.delete();
      }
    } finally {
      box.delete();
    }
  }
  /** Exact volume: the sum of the faces' contributions (as `BRepGProp::VolumeProperties`). */
  volume(topology: Topology): number {
    const oc = this.oc;
    let total = 0;
    const entries = this.entriesOf(topology);
    for (const [i, wrapper] of topology.faces.entries()) {
      const face = wrapper.wrapped as RawShape;
      const e = entries[i]!;
      const side = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? 'r' : 'f';
      let v = e.volume[side];
      if (v === undefined) {
        // The signed volume between the face and the fixed plane z = 0: these
        // contributions add up to the solid's volume. (`VolumeProperties` of a
        // lone face uses a reference point derived from that face, so its
        // per-face results do not add up.)
        const props = new oc.GProp_GProps();
        try {
          oc.BRepGProp.VolumePropertiesGK(
            face as never,
            props,
            this.referencePlane(),
            1e-9,
            false,
            true,
            false,
            false,
            false,
          );
          v = props.Mass();
        } finally {
          props.delete();
        }
        e.volume[side] = v;
      }
      total += v;
    }
    return total;
  }

  /**
   * Validity of `shape`: full `BRepCheck_Analyzer` (`full`), geometric checks of
   * unchecked faces plus closure (`faces`), or closure only (`closure`, previews:
   * `BRepCheck` leaks ~16 KB of wasm heap per face in this build). Else a
   * topology-only analysis of the solid plus a geometric check of every
   * face not checked before.
   */
  valid(shape: Shape3D, topology: Topology, mode: 'full' | 'faces' | 'closure'): boolean {
    const oc = this.oc;
    if (mode === 'full') {
      const ok = isValidShape(oc, shape);
      if (ok) for (const e of this.entriesOf(topology)) e.valid = true;
      // The closure test is part of every mode: `BRepCheck_Analyzer` accepts an edge shared by
      // three faces, the incremental modes did not, so the same body was valid after a reopen
      // and invalid while editing (fuzzer finding F4, `assembler/ROBUSTNESS.md`).
      return ok && this.closed(topology);
    }
    const entries = this.entriesOf(topology);
    for (const [i, wrapper] of topology.faces.entries()) {
      const e = entries[i]!;
      if (e.valid === undefined && mode === 'faces') {
        const analyzer = new oc.BRepCheck_Analyzer(wrapper.wrapped as never, true, false, false);
        try {
          e.valid = analyzer.IsValid();
        } finally {
          analyzer.delete();
        }
      }
      if (e.valid === false) return false;
    }
    return this.closed(topology);
  }

  /**
   * Closed, manifold solid: every edge bounds exactly two faces, or is the seam of one, or is
   * degenerated (the pole of a sphere or a blend corner patch).
   */
  private closed(topology: Topology): boolean {
    const oc = this.oc;
    for (const [edgeIndex, faces] of topology.edgeFaces.entries()) {
      if (faces.length === 2) continue;
      if (oc.BRep_Tool.Degenerated(topology.edges[edgeIndex]!.wrapped as never)) continue;
      if (faces.length !== 1) return false;
      const seam = oc.BRep_Tool.IsClosed(
        topology.edges[edgeIndex]!.wrapped as never,
        topology.faces[faces[0]!]!.wrapped as never,
      );
      if (!seam) return false;
    }
    return true;
  }
  /**
   * Drops least recently used faces beyond `maxFaces`. Entries own a handle
   * of their face, which keeps its B-rep (and triangulation) alive, so the
   * cap must follow the faces the checkpoint cache still holds.
   */
  evict(maxFaces: number): void {
    if (this.count <= maxFaces) return;
    const all: [number, FaceProps][] = [];
    for (const [hash, list] of this.entries) for (const e of list) all.push([hash, e]);
    all.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [hash, e] of all) {
      if (this.count <= maxFaces * 0.8) break;
      this.remove(hash, e);
    }
  }

  clear(): void {
    for (const [hash, list] of [...this.entries]) for (const e of [...list]) this.remove(hash, e);
  }

  private remove(hash: number, entry: FaceProps): void {
    const list = this.entries.get(hash);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.entries.delete(hash);
    this.count -= 1;
    entry.face.delete();
  }
}
