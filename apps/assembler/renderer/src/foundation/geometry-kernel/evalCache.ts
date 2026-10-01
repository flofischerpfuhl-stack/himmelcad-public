/**
 * Prefix cache of the evaluator (incremental re-evaluation).
 *
 * After every feature the replay state (bodies with their B-rep shapes and
 * keyed faces, sketches, creation order, errors/warnings so far) is stored
 * as an immutable **checkpoint**, keyed by a hash of the feature prefix:
 * `h(i) = H(h(i-1), canonical JSON of feature i)`. A feature's result only
 * depends on its own parameters and on the state its predecessors left, so
 * equal prefix hashes mean equal states: an edit re-evaluates from the first
 * changed feature, a tool preview (`features + provisional`) only evaluates
 * the provisional feature, undo/redo to a known document costs nothing.
 *
 * Memory is bounded: checkpoints share unchanged shapes, shapes are
 * reference-counted across checkpoints (a shape is deleted from the wasm
 * heap — deterministically, not by the JS garbage collector — once no
 * checkpoint holds it) and the least recently used checkpoints are evicted
 * when the estimated B-rep bytes exceed the budget. Checkpoints of the
 * document evaluated last are never evicted by that evaluation.
 */

import type { SketchFeature } from '../sketch-solver/sketchFeature.js';
import type { SketchRegion } from '../sketch-solver/regions.js';
import type { KeyedFace } from './naming.js';
import type { Shape3D } from './occt.js';
import type { EvaluatedDatum, EvaluatedSketch, FeatureErrorRefs } from './types.js';

// ---- hashing ---------------------------------------------------------------------

const jsonMemo = new WeakMap<object, string>();

/** JSON with object keys sorted (so equal content hashes equally regardless of key order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value) ?? 'null';
  }
  const memo = jsonMemo.get(value);
  if (memo !== undefined) return memo;
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  jsonMemo.set(value, out);
  return out;
}

/** cyrb53 (public domain) with two seeds: a 106-bit hash as 28 hex characters. */
export function hashString(text: string): string {
  const one = (seed: number): string => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, '0');
  };
  return one(0x9e3779b9) + one(0x85ebca6b);
}

/** Prefix hashes `h(0..n-1)` of a feature list (see the module comment). */
export function prefixHashes(features: readonly unknown[], salt = ''): string[] {
  const out: string[] = [];
  let previous = hashString(`himmelcad-eval-v2|${salt}`);
  for (const feature of features) {
    previous = hashString(`${previous}|${canonicalJson(feature)}`);
    out.push(previous);
  }
  return out;
}

// ---- checkpoints -------------------------------------------------------------------

/** One body as stored in a checkpoint (never mutated). */
export interface BodySnapshot {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly createdBy: string;
  readonly shape: Shape3D;
  readonly faces: KeyedFace[];
  /** Assembly folder path of an imported part (`Body.itemPath`). */
  readonly itemPath?: readonly string[];
  /** The feature that last changed `shape` (absent: `createdBy`). */
  readonly changedBy?: string;
}

/** The replay state after feature `index` of a document whose prefix hashes to `hash`. */
export interface Checkpoint {
  readonly hash: string;
  readonly index: number;
  readonly bodies: ReadonlyMap<string, BodySnapshot>;
  readonly order: readonly string[];
  readonly creationOrder: readonly string[];
  readonly sketches: ReadonlyMap<string, EvaluatedSketch>;
  readonly sketchFeatures: ReadonlyMap<string, SketchFeature>;
  readonly sketchRegions: ReadonlyMap<string, SketchRegion[]>;
  /** Construction planes/axes evaluated so far. */
  readonly datums?: ReadonlyMap<string, EvaluatedDatum>;
  readonly createdCount: number;
  readonly errors: Readonly<Record<string, string>>;
  readonly warnings: Readonly<Record<string, string>>;
  /** Geometry a feature error points at (e.g. the edge a fillet failed on). */
  readonly errorRefs?: Readonly<Record<string, FeatureErrorRefs>>;
}

interface Entry {
  checkpoint: Checkpoint;
  lastUsed: number;
}

interface ShapeRecord {
  refs: number;
  bytes: number;
  faces: number;
}

export interface CheckpointCacheOptions {
  /** Estimated B-rep bytes the cache may hold before evicting (default 256 MiB). */
  budgetBytes?: number;
  /** Cap on the number of checkpoints (default 1000: ~16 versions of a 60-feature part). */
  maxEntries?: number;
  /** Estimated heap bytes of a shape (called once per shape). */
  estimateBytes: (shape: Shape3D, faces: readonly KeyedFace[]) => number;
  /** Called when no checkpoint holds `shape` any more: delete it. */
  onFree: (shape: Shape3D) => void;
}

export interface CheckpointCacheStats {
  entries: number;
  shapes: number;
  /** Faces of the shapes held (bounds the per-face caches). */
  faces: number;
  bytes: number;
  budgetBytes: number;
  evicted: number;
}

export class CheckpointCache {
  private readonly entries = new Map<string, Entry>();
  private readonly shapes = new Map<Shape3D, ShapeRecord>();
  private clock = 0;
  private bytes = 0;
  private faces = 0;
  private evictedTotal = 0;
  private readonly budgetBytes: number;
  private readonly maxEntries: number;

  constructor(private readonly options: CheckpointCacheOptions) {
    this.budgetBytes = options.budgetBytes ?? 256 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  /** The checkpoint for `hash` (marks it recently used). */
  get(hash: string): Checkpoint | undefined {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.checkpoint;
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  /** `true` while some checkpoint holds `shape` (it must not be deleted). */
  holds(shape: Shape3D): boolean {
    return this.shapes.has(shape);
  }

  put(checkpoint: Checkpoint): void {
    const existing = this.entries.get(checkpoint.hash);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return;
    }
    for (const body of distinctShapes(checkpoint)) {
      const record = this.shapes.get(body.shape);
      if (record) {
        record.refs += 1;
      } else {
        const bytes = this.options.estimateBytes(body.shape, body.faces);
        this.shapes.set(body.shape, { refs: 1, bytes, faces: body.faces.length });
        this.bytes += bytes;
        this.faces += body.faces.length;
      }
    }
    this.entries.set(checkpoint.hash, { checkpoint, lastUsed: ++this.clock });
  }

  /**
   * Evicts least recently used checkpoints until the estimated bytes and
   * the entry count are within budget. `protect` (hashes of the document
   * just evaluated) are kept even when that leaves the cache over budget.
   */
  evict(protect: ReadonlySet<string>): number {
    if (this.bytes <= this.budgetBytes && this.entries.size <= this.maxEntries) return 0;
    const candidates = [...this.entries.values()]
      .filter((e) => !protect.has(e.checkpoint.hash))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let evicted = 0;
    for (const entry of candidates) {
      if (this.bytes <= this.budgetBytes && this.entries.size <= this.maxEntries) break;
      this.remove(entry.checkpoint.hash);
      evicted += 1;
    }
    this.evictedTotal += evicted;
    return evicted;
  }

  /** Drops every checkpoint (and frees every shape they held). */
  clear(): void {
    for (const hash of [...this.entries.keys()]) this.remove(hash);
  }

  stats(): CheckpointCacheStats {
    return {
      entries: this.entries.size,
      shapes: this.shapes.size,
      faces: this.faces,
      bytes: this.bytes,
      budgetBytes: this.budgetBytes,
      evicted: this.evictedTotal,
    };
  }

  private remove(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) return;
    this.entries.delete(hash);
    for (const body of distinctShapes(entry.checkpoint)) {
      const record = this.shapes.get(body.shape);
      if (!record) continue;
      record.refs -= 1;
      if (record.refs > 0) continue;
      this.shapes.delete(body.shape);
      this.bytes -= record.bytes;
      this.faces -= record.faces;
      this.options.onFree(body.shape);
    }
  }
}

function distinctShapes(checkpoint: Checkpoint): BodySnapshot[] {
  const seen = new Set<Shape3D>();
  const out: BodySnapshot[] = [];
  for (const body of checkpoint.bodies.values()) {
    if (seen.has(body.shape)) continue;
    seen.add(body.shape);
    out.push(body);
  }
  return out;
}
