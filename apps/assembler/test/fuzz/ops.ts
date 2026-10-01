/**
 * Fuzzer operations: an abstract, state-independent description of one
 * agent-API (or UI-store) action. Every op carries random choice numbers in
 * [0, 1) that are resolved against the document **when the op runs** (pick
 * the n-th body, a size between a and b, ...). Removing ops from a sequence
 * therefore always leaves a runnable sequence, which is what makes delta
 * debugging (`shrink.ts`) work.
 */

export const OP_KINDS = [
  'sketch',
  'sketchOnFace',
  'addProfile',
  'polyline',
  'setDimension',
  'setDimensionExpr',
  'addConstraint',
  'addDimension',
  'deleteSketchItems',
  'extrude',
  'extrudeExpr',
  'pushPull',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'boolean',
  'pattern',
  'mirror',
  'hole',
  'emboss',
  'transform',
  'paramCreate',
  'paramEdit',
  'paramDelete',
  'featureEdit',
  'suppress',
  'deleteFeature',
  'rename',
  'rollback',
  'reorder',
  'undo',
  'redo',
  'txBegin',
  'txPreview',
  'txCommit',
  'txCancel',
  'saveReopen',
  // Coverage extension (Block 6): more feature kinds, extents and exchange round trips.
  'sweep',
  'loft',
  'draft',
  'rib',
  'openPolyline',
  'thicken',
  'text',
  'constructionPlane',
  'sketchOnConstruction',
  'extrudeExtent',
  'exchangeStep',
  'exchangeIges',
  'exchangeDxf',
  // Block 8: primitives, Scale, Translate, Move Edge/Face, helical revolve, extrude taper.
  'primitive',
  'scale',
  'translate',
  'moveEdge',
  'moveFace',
  'helix',
  'taper',
] as const;

export type OpKind = (typeof OP_KINDS)[number];

/** One fuzzer step: the op kind and its random choices (resolved at run time). */
export interface Op {
  op: OpKind;
  r: number[];
}

/** Relative frequencies: modelling steps dominate, meta steps keep the history moving. */
const WEIGHTS: Record<OpKind, number> = {
  sketch: 10,
  sketchOnFace: 5,
  addProfile: 3,
  polyline: 2,
  setDimension: 5,
  setDimensionExpr: 2,
  addConstraint: 2,
  addDimension: 2,
  deleteSketchItems: 2,
  extrude: 12,
  extrudeExpr: 2,
  pushPull: 2,
  revolve: 3,
  fillet: 4,
  chamfer: 3,
  shell: 2,
  boolean: 3,
  pattern: 2,
  mirror: 2,
  hole: 3,
  emboss: 2,
  transform: 2,
  paramCreate: 2,
  paramEdit: 3,
  paramDelete: 1,
  featureEdit: 5,
  suppress: 3,
  deleteFeature: 2,
  rename: 1,
  rollback: 2,
  reorder: 2,
  undo: 4,
  redo: 3,
  txBegin: 1,
  txPreview: 1,
  txCommit: 3,
  txCancel: 2,
  saveReopen: 1,
  sweep: 2,
  loft: 2,
  draft: 2,
  rib: 2,
  openPolyline: 2,
  thicken: 2,
  text: 2,
  constructionPlane: 2,
  sketchOnConstruction: 2,
  extrudeExtent: 3,
  exchangeStep: 1,
  exchangeIges: 1,
  exchangeDxf: 1,
  primitive: 3,
  scale: 2,
  translate: 2,
  moveEdge: 2,
  moveFace: 2,
  helix: 1,
  taper: 2,
};

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed of sequence `index` of a run seeded `seed` (so any sequence regenerates on its own). */
export function sequenceSeed(seed: number, index: number): number {
  return (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0xc2b2ae35)) >>> 0;
}

const CHOICES = 8;

/** A random sequence of `length` ops, fully determined by `seed`. */
export function generateSequence(seed: number, length: number): Op[] {
  const next = rng(seed);
  const total = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    let pick = next() * total;
    let kind: OpKind = OP_KINDS[0];
    for (const k of OP_KINDS) {
      pick -= WEIGHTS[k];
      if (pick < 0) {
        kind = k;
        break;
      }
    }
    const r: number[] = [];
    for (let c = 0; c < CHOICES; c += 1) r.push(Math.round(next() * 1e4) / 1e4);
    ops.push({ op: kind, r });
  }
  return ops;
}

/** `list[floor(r * n)]` (undefined for an empty list). */
export function pick<T>(list: readonly T[], r: number | undefined): T | undefined {
  if (list.length === 0) return undefined;
  const i = Math.min(list.length - 1, Math.floor((r ?? 0) * list.length));
  return list[i];
}

/** A value in [lo, hi] rounded to `step`. */
export function between(r: number | undefined, lo: number, hi: number, step = 0.5): number {
  const v = lo + (r ?? 0) * (hi - lo);
  return Math.round(v / step) * step;
}
