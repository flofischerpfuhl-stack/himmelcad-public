/**
 * Stable references ("topological naming") for the kernel spike.
 *
 * OCCT face/edge objects and explorer indices are regenerated on every
 * evaluation, so references must be names that the evaluator re-derives
 * from the modelling history on each replay. The scheme, kernel-neutral and
 * pure (no OCCT here):
 *
 * 1. **Generated names.** Every operation that creates faces names them by
 *    generating feature + role: `<featureId>:start:<p>` / `:end:<p>` for
 *    extrude caps of profile `p`, `:side:<p>:<segment>` for the side face
 *    swept by profile segment `segment`, `:round:<i>` / `:chamfer:<i>` for
 *    the blend face of the i-th referenced edge, `:inner:<key>` for a shell's
 *    offset of face `key`, `:new` otherwise.
 * 2. **Propagation by surface identity.** After a boolean, fillet, shell or
 *    move, a result face that lies on exactly the same underlying surface as
 *    an input face (plane: outward normal + offset; cylinder: axis line,
 *    radius, convexity; other: kind + centroid + area) inherits the input's
 *    key. Several matching inputs (coplanar faces merged by a fuse) → the key
 *    of the earliest feature wins, the others become aliases. One input
 *    surface split into several result faces → `#n` suffixes ordered by
 *    centroid; references match on the base key and disambiguate by
 *    signature.
 * 3. **Edges** are named by the (sorted) keys of their two faces, `~n`
 *    suffixed when several edges separate the same pair.
 * 4. **Resolution** of a stored reference: key/alias match first. Only if
 *    no face/edge carries the key, a strict geometric fallback may re-bind
 *    to a unique candidate of the same kind whose centroid/midpoint moved by
 *    at most 1% of the body diagonal and whose area/length changed by at
 *    most 5%; the result is flagged as re-bound. Everything else is a
 *    "Missing reference" error — never a silent re-bind to a different face.
 *
 * Known limits (see `assembler/KERNEL-SPIKE.md`): faces on free-form
 * surfaces only propagate while unchanged; a split face's `#n` order is
 * positional; a reference to one piece of a split face picks the nearest
 * piece; an edit that swaps which feature "owns" a merged coplanar face
 * changes its primary key (aliases still resolve it).
 */
import type {
  CurveKind,
  EdgeRef,
  EdgeSignature,
  FaceRef,
  FaceSignature,
  SurfaceKind,
  Vec3,
} from '../model/document.js';

/** Identity of the underlying surface of a face (not its trimmed extent). */
export type SurfaceId =
  | { type: 'plane'; normal: Vec3; offset: number }
  | { type: 'cylinder'; axis: Vec3; point: Vec3; radius: number; convex: boolean }
  | { type: 'other'; kind: SurfaceKind; centroid: Vec3; area: number };

/** Kernel-independent description of one face of a shape. */
export interface FaceGeom {
  surface: SurfaceKind;
  id: SurfaceId;
  /** Outward unit normal of planar faces, else `null`. */
  normal: Vec3 | null;
  centroid: Vec3;
  area: number;
}

export interface KeyedFace extends FaceGeom {
  key: string;
  aliases: string[];
}

/** Distances below this (mm) count as identical geometry. */
export const GEOMETRY_TOLERANCE = 1e-4;
const COS_TOLERANCE = 1e-7;

/** `key` without a split-face `#n` suffix. */
export function baseFaceKey(key: string): string {
  return key.replace(/#\d+$/, '');
}

/** `key` without an edge `~n` suffix. */
export function baseEdgeKey(key: string): string {
  return key.replace(/~\d+$/, '');
}

/** The feature id that generated a key (`"feature-extrude-1:end:0"` -> `"feature-extrude-1"`). */
export function keyFeatureId(key: string): string {
  const colon = key.indexOf(':');
  return colon < 0 ? key : key.slice(0, colon);
}

export function sameSurface(a: SurfaceId, b: SurfaceId, tol = GEOMETRY_TOLERANCE): boolean {
  if (a.type === 'plane' && b.type === 'plane') {
    return dot(a.normal, b.normal) > 1 - COS_TOLERANCE && Math.abs(a.offset - b.offset) < tol;
  }
  if (a.type === 'cylinder' && b.type === 'cylinder') {
    return (
      a.convex === b.convex &&
      Math.abs(a.radius - b.radius) < tol &&
      Math.abs(dot(a.axis, b.axis)) > 1 - COS_TOLERANCE &&
      distance(a.point, b.point) < tol
    );
  }
  if (a.type === 'other' && b.type === 'other') {
    return (
      a.kind === b.kind &&
      distance(a.centroid, b.centroid) < tol * 10 &&
      Math.abs(a.area - b.area) <= Math.max(tol, 1e-6 * Math.max(a.area, b.area))
    );
  }
  return false;
}

/** Canonical cylinder identity: unsigned axis with a positive leading component, axis point closest to the origin. */
export function cylinderId(axis: Vec3, point: Vec3, radius: number, convex: boolean): SurfaceId {
  let a = normalize(axis);
  const lead = Math.abs(a[0]) > 1e-9 ? a[0] : Math.abs(a[1]) > 1e-9 ? a[1] : a[2];
  if (lead < 0) a = [-a[0], -a[1], -a[2]];
  const k = dot(point, a);
  return {
    type: 'cylinder',
    axis: a,
    point: [point[0] - a[0] * k, point[1] - a[1] * k, point[2] - a[2] * k],
    radius,
    convex,
  };
}

/** The same face geometry after a translation. */
export function translateGeom<T extends FaceGeom>(face: T, delta: Vec3): T {
  const centroid = add(face.centroid, delta);
  let id: SurfaceId;
  if (face.id.type === 'plane') {
    id = { ...face.id, offset: face.id.offset + dot(face.id.normal, delta) };
  } else if (face.id.type === 'cylinder') {
    id = cylinderId(face.id.axis, add(face.id.point, delta), face.id.radius, face.id.convex);
  } else {
    id = { ...face.id, centroid: add(face.id.centroid, delta) };
  }
  return { ...face, centroid, id };
}

/** The face as seen from the other side (a cut tool's face that ends up in the result). */
export function reverseGeom<T extends FaceGeom>(face: T): T {
  let id: SurfaceId = face.id;
  if (face.id.type === 'plane') {
    id = { type: 'plane', normal: neg(face.id.normal), offset: -face.id.offset };
  } else if (face.id.type === 'cylinder') {
    id = { ...face.id, convex: !face.id.convex };
  }
  return { ...face, id, normal: face.normal ? neg(face.normal) : null };
}

/**
 * Assigns naming keys to the faces of an operation result.
 *
 * `inputs` are the keyed faces of all operands (already transformed/
 * reversed as needed). `nameNew(i, provisional)` names a face that matches
 * no input surface; `provisional[j]` holds the keys already inherited by
 * other result faces (`null` for other new faces), so generated names can
 * look at neighbours (e.g. a fillet face adjacent to both faces of its edge).
 */
export function assignFaceKeys(
  result: readonly FaceGeom[],
  inputs: readonly KeyedFace[],
  featureOrder: ReadonlyMap<string, number>,
  nameNew: (index: number, provisional: readonly (KeyedFaceKeys | null)[]) => string,
): KeyedFaceKeys[] {
  const provisional: (KeyedFaceKeys | null)[] = result.map((face) => {
    const keys = new Set<string>();
    for (const input of inputs) {
      if (!sameSurface(face.id, input.id)) continue;
      keys.add(baseFaceKey(input.key));
      for (const alias of input.aliases) keys.add(baseFaceKey(alias));
    }
    if (keys.size === 0) return null;
    const ordered = [...keys].sort((a, b) => compareKeys(a, b, featureOrder));
    return { key: ordered[0]!, aliases: ordered.slice(1) };
  });
  const named: KeyedFaceKeys[] = provisional.map(
    (entry, index) => entry ?? { key: nameNew(index, provisional), aliases: [] },
  );
  return disambiguate(named, result, '#');
}

export interface KeyedFaceKeys {
  key: string;
  aliases: string[];
}

/**
 * Where each result face came from according to the kernel's modelling
 * history (see `occt.ts#faceOrigins`); indices point into `inputs`.
 */
export interface FaceHistory {
  /** The input face that is the very same face, `-1` if none. */
  identical: readonly number[];
  /** Input faces the result face was modified from (split or merged). */
  modified: readonly (readonly number[])[];
  /** Generated names (e.g. `<fillet>:round:0`) of generators that produced the face. */
  generated: readonly (readonly string[])[];
}

/**
 * Reference scheme v2: assigns keys from the kernel's history first — an
 * identical face keeps its key, a modified face inherits the keys of the
 * faces it was modified from (several: earliest feature wins, the others
 * become aliases; one face split into several: `#n` pieces), a generated
 * face takes its generator's name. Only faces the history says nothing
 * about fall back to surface identity against `fallbackInputs` (v1), and
 * then to `nameNew`.
 */
export function assignFaceKeysFromHistory(
  result: readonly FaceGeom[],
  inputs: readonly KeyedFace[],
  history: FaceHistory,
  featureOrder: ReadonlyMap<string, number>,
  nameNew: (index: number, provisional: readonly (KeyedFaceKeys | null)[]) => string,
  fallbackInputs: readonly KeyedFace[] = inputs,
): KeyedFaceKeys[] {
  const order = (keys: Set<string>): KeyedFaceKeys | null => {
    if (keys.size === 0) return null;
    const ordered = [...keys].sort((a, b) => compareKeys(a, b, featureOrder));
    return { key: ordered[0]!, aliases: ordered.slice(1) };
  };
  const collect = (indices: readonly number[]): Set<string> => {
    const keys = new Set<string>();
    for (const i of indices) {
      const input = inputs[i];
      if (!input) continue;
      keys.add(baseFaceKey(input.key));
      for (const alias of input.aliases) keys.add(baseFaceKey(alias));
    }
    return keys;
  };
  const provisional: (KeyedFaceKeys | null)[] = result.map((face, j) => {
    const same = history.identical[j] ?? -1;
    if (same >= 0) return order(collect([same]));
    const modified = history.modified[j] ?? [];
    if (modified.length > 0) return order(collect(modified));
    const generated = history.generated[j] ?? [];
    if (generated.length > 0) return order(new Set(generated));
    const keys = new Set<string>();
    for (const input of fallbackInputs) {
      if (!sameSurface(face.id, input.id)) continue;
      keys.add(baseFaceKey(input.key));
      for (const alias of input.aliases) keys.add(baseFaceKey(alias));
    }
    return order(keys);
  });
  const named: KeyedFaceKeys[] = provisional.map(
    (entry, index) => entry ?? { key: nameNew(index, provisional), aliases: [] },
  );
  return disambiguate(named, result, '#');
}

function compareKeys(a: string, b: string, featureOrder: ReadonlyMap<string, number>): number {
  const oa = featureOrder.get(keyFeatureId(a)) ?? Number.MAX_SAFE_INTEGER;
  const ob = featureOrder.get(keyFeatureId(b)) ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Makes keys unique by suffixing `<sep>1..n` in centroid order where several entries share one key. */
function disambiguate<T extends { key: string }>(
  entries: T[],
  geometry: readonly { centroid: Vec3 }[],
  separator: string,
): T[] {
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const list = groups.get(entry.key) ?? [];
    list.push(index);
    groups.set(entry.key, list);
  });
  const out = entries.map((entry) => ({ ...entry }));
  for (const [key, indices] of groups) {
    if (indices.length < 2) continue;
    indices.sort((a, b) => compareVec(geometry[a]!.centroid, geometry[b]!.centroid));
    indices.forEach((index, n) => {
      out[index]!.key = `${key}${separator}${n + 1}`;
    });
  }
  return out;
}

function compareVec(a: Vec3, b: Vec3): number {
  for (let i = 0; i < 3; i += 1) {
    const d = Math.round(a[i]! * 1e4) - Math.round(b[i]! * 1e4);
    if (d !== 0) return d;
  }
  return 0;
}

/** Edge keys from the keys of each edge's adjacent faces. */
export function assignEdgeKeys(
  edges: readonly { faceIndices: readonly number[]; midpoint: Vec3 }[],
  faceKeys: readonly string[],
): string[] {
  const named = edges.map((edge) => {
    const keys = edge.faceIndices.map((i) => faceKeys[i] ?? '?');
    if (keys.length === 1) keys.push(keys[0]!);
    keys.sort();
    return { key: `${keys[0]}|${keys[1]}` };
  });
  return disambiguate(
    named,
    edges.map((e) => ({ centroid: e.midpoint })),
    '~',
  ).map((e) => e.key);
}

// ---- Resolution ---------------------------------------------------------------

export interface ResolvableFace {
  key: string;
  aliases: readonly string[];
  surface: SurfaceKind;
  normal: Vec3 | null;
  centroid: Vec3;
  area: number;
}

export interface ResolvableEdge {
  faceIndices: readonly number[];
  curve: CurveKind;
  midpoint: Vec3;
  length: number;
  direction: Vec3 | null;
}

export type Resolution =
  | {
      ok: true;
      index: number;
      rebound: boolean;
      /** Set when the referenced face/edge was split and one piece was chosen (shown as a warning). */
      note?: string;
    }
  | { ok: false; message: string };

/**
 * Distance of a point from candidate `index` (a face or an edge); used to
 * decide which piece of a split face/edge keeps a reference.
 */
export type DistanceProbe = (index: number, point: Vec3) => number;

/**
 * Split rule (reference scheme v2): when several pieces carry the
 * referenced (unsuffixed) key, the piece nearest to the point recorded in
 * the reference's signature keeps it — but only if that is unambiguous:
 * every other piece must be more than twice as far away and farther than
 * `tolerance`. Otherwise the reference is ambiguous.
 */
function suffixConfirmed(
  key: string,
  marker: string,
  index: number,
  point: Vec3,
  probe: DistanceProbe | undefined,
  diagonal: number,
): boolean {
  if (!probe || !key.includes(marker)) return true;
  return probe(index, point) <= REBIND_POSITION_FRACTION * Math.max(diagonal, 1);
}

function pickSplitPiece(
  candidates: readonly number[],
  point: Vec3,
  probe: DistanceProbe,
  tolerance: number,
): number | null {
  const scored = candidates
    .map((index) => ({ index, d: probe(index, point) }))
    .sort((a, b) => a.d - b.d);
  const [best, second] = scored;
  if (!best) return null;
  if (!second) return best.index;
  return second.d > Math.max(tolerance, 2 * best.d) ? best.index : null;
}

/** Relative thresholds of the geometric fallback (fractions of the body diagonal / of the size). */
export const REBIND_POSITION_FRACTION = 0.01;
export const REBIND_SIZE_FRACTION = 0.05;
/** A point this close to a split piece (fraction of the body diagonal) lies on it. */
export const SPLIT_TOLERANCE_FRACTION = 1e-6;

function faceHasKey(face: ResolvableFace, key: string): boolean {
  const base = baseFaceKey(key);
  return baseFaceKey(face.key) === base || face.aliases.some((a) => baseFaceKey(a) === base);
}

export function resolveFaceRef(
  ref: Pick<FaceRef, 'key' | 'signature'>,
  faces: readonly ResolvableFace[],
  diagonal: number,
  probe?: DistanceProbe,
): Resolution {
  const byKey = faces.map((f, i) => ({ f, i })).filter(({ f }) => faceHasKey(f, ref.key));
  if (byKey.length === 1) {
    const index = byKey[0]!.i;
    // A `#n` piece key that now names a single face: confirm by position (v1
    // files named coplanar faces of several features `<first>#n`; see
    // `suffixConfirmed`), else fall through to the geometric fallback.
    if (suffixConfirmed(ref.key, '#', index, ref.signature.centroid, probe, diagonal)) {
      return { ok: true, index, rebound: false };
    }
  } else if (byKey.length > 1) {
    const exact = byKey.filter(({ f }) => f.key === ref.key);
    if (exact.length === 1) return { ok: true, index: exact[0]!.i, rebound: false };
    if (probe) {
      const tolerance = SPLIT_TOLERANCE_FRACTION * Math.max(diagonal, 1);
      const index = pickSplitPiece(
        byKey.map(({ i }) => i),
        ref.signature.centroid,
        probe,
        tolerance,
      );
      if (index === null) {
        return {
          ok: false,
          message: `Ambiguous reference: face "${ref.key}" was split into ${byKey.length} faces — re-select the face`,
        };
      }
      return {
        ok: true,
        index,
        rebound: false,
        note: `Face "${ref.key}" was split into ${byKey.length} faces; the piece at its recorded position keeps the reference`,
      };
    }
    const pool = byKey;
    pool.sort(
      (a, b) =>
        distance(a.f.centroid, ref.signature.centroid) -
        distance(b.f.centroid, ref.signature.centroid),
    );
    return { ok: true, index: pool[0]!.i, rebound: false };
  }
  const index = rebindFace(ref.signature, faces, diagonal);
  if (index !== null) return { ok: true, index, rebound: true };
  return { ok: false, message: `Missing reference: face "${ref.key}"` };
}

function rebindFace(
  signature: FaceSignature,
  faces: readonly ResolvableFace[],
  diagonal: number,
): number | null {
  const maxMove = REBIND_POSITION_FRACTION * Math.max(diagonal, 1);
  const matches = faces
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => {
      if (f.surface !== signature.surface) return false;
      if (signature.normal && (!f.normal || dot(f.normal, signature.normal) < 1 - 1e-4)) {
        return false;
      }
      if (distance(f.centroid, signature.centroid) > maxMove) return false;
      return Math.abs(f.area / Math.max(signature.area, 1e-9) - 1) <= REBIND_SIZE_FRACTION;
    });
  return matches.length === 1 ? matches[0]!.i : null;
}

export function resolveEdgeRef(
  ref: Pick<EdgeRef, 'key' | 'signature'>,
  edges: readonly ResolvableEdge[],
  faces: readonly ResolvableFace[],
  diagonal: number,
  options: { edgeKeys?: readonly string[]; probe?: DistanceProbe } = {},
): Resolution {
  const [keyA, keyB] = splitEdgeKey(ref.key);
  const byKey: number[] = [];
  if (keyA !== null && keyB !== null) {
    edges.forEach((edge, index) => {
      const sides = edge.faceIndices.map((i) => faces[i]);
      if (sides.length === 1) sides.push(sides[0]);
      const [s0, s1] = sides;
      if (!s0 || !s1) return;
      if (
        (faceHasKey(s0, keyA) && faceHasKey(s1, keyB)) ||
        (faceHasKey(s0, keyB) && faceHasKey(s1, keyA))
      ) {
        byKey.push(index);
      }
    });
  }
  if (
    byKey.length === 1 &&
    suffixConfirmed(ref.key, '#', byKey[0]!, ref.signature.midpoint, options.probe, diagonal)
  ) {
    return { ok: true, index: byKey[0]!, rebound: false };
  }
  if (byKey.length > 1 && options.edgeKeys) {
    const exact = byKey.filter((i) => options.edgeKeys![i] === ref.key);
    if (exact.length === 1) return { ok: true, index: exact[0]!, rebound: false };
  }
  if (byKey.length > 1 && options.probe) {
    const tolerance = SPLIT_TOLERANCE_FRACTION * Math.max(diagonal, 1);
    const index = pickSplitPiece(byKey, ref.signature.midpoint, options.probe, tolerance);
    if (index === null) {
      return {
        ok: false,
        message: `Ambiguous reference: edge "${ref.key}" now matches ${byKey.length} edges — re-select the edge`,
      };
    }
    return {
      ok: true,
      index,
      rebound: false,
      note: `Edge "${ref.key}" now matches ${byKey.length} edges; the one at its recorded position keeps the reference`,
    };
  }
  if (byKey.length > 1) {
    byKey.sort(
      (a, b) =>
        distance(edges[a]!.midpoint, ref.signature.midpoint) -
        distance(edges[b]!.midpoint, ref.signature.midpoint),
    );
    return { ok: true, index: byKey[0]!, rebound: false };
  }
  const index = rebindEdge(ref.signature, edges, diagonal);
  if (index !== null) return { ok: true, index, rebound: true };
  return { ok: false, message: `Missing reference: edge "${ref.key}"` };
}

/** Splits `"A|B~n"` into its two face keys. */
export function splitEdgeKey(key: string): [string | null, string | null] {
  const base = baseEdgeKey(key);
  const bar = base.indexOf('|');
  if (bar < 0) return [null, null];
  return [base.slice(0, bar), base.slice(bar + 1)];
}

function rebindEdge(
  signature: EdgeSignature,
  edges: readonly ResolvableEdge[],
  diagonal: number,
): number | null {
  const maxMove = REBIND_POSITION_FRACTION * Math.max(diagonal, 1);
  const matches = edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      if (e.curve !== signature.curve) return false;
      if (signature.direction) {
        if (!e.direction || Math.abs(dot(e.direction, signature.direction)) < 1 - 1e-4) {
          return false;
        }
      }
      if (distance(e.midpoint, signature.midpoint) > maxMove) return false;
      return Math.abs(e.length / Math.max(signature.length, 1e-9) - 1) <= REBIND_SIZE_FRACTION;
    });
  return matches.length === 1 ? matches[0]!.i : null;
}

/** Signature of a face for storing in a new reference. */
export function faceSignatureOf(face: ResolvableFace & { adjacentFaces: number }): FaceSignature {
  return {
    surface: face.surface,
    normal: face.normal,
    centroid: face.centroid,
    area: face.area,
    adjacentFaces: face.adjacentFaces,
  };
}

export function edgeSignatureOf(edge: ResolvableEdge): EdgeSignature {
  return {
    curve: edge.curve,
    midpoint: edge.midpoint,
    length: edge.length,
    direction: edge.direction,
  };
}

// ---- small vector helpers -------------------------------------------------------

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function neg(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
