import type { SnapKind, SnapResult, SnapSource, SnapTargetMask } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

const KIND_PRIORITY: Record<SnapKind, number> = {
  Vertex: 0,
  Point: 1,
  Edge: 2,
  Face: 3,
  EstimatedSurface: 4,
  Grid: 5,
  Free: 6,
};

const SOURCE_PRIORITY: Record<NonNullable<SnapResult['source']>, number> = {
  cad: 0,
  mesh: 1,
  'textured-mesh': 2,
  surface: 3,
  dgm: 4,
  'point-cloud': 5,
  splat: 6,
  grid: 7,
  fallback: 8,
};

const DEFAULT_KIND_MASK: Record<SnapKind, boolean> = {
  Vertex: true,
  Point: true,
  Edge: true,
  Face: true,
  EstimatedSurface: true,
  Grid: true,
  Free: true,
};

const DEFAULT_SOURCE_MASK: Record<SnapSource, boolean> = {
  cad: true,
  mesh: true,
  'textured-mesh': true,
  surface: true,
  dgm: true,
  'point-cloud': true,
  splat: true,
  grid: true,
  fallback: true,
};

export interface SnapQueryResult {
  active: SnapResult | null;
  candidates: readonly SnapResult[];
  cycleIndex: number;
  hierarchyKey: string | null;
}

/**
 * Owns the cursor coordinate. Drawing tools, measurement tools and the
 * coordinate display in the status overlay must read from here, not from any
 * of the providers directly. This keeps a single canonical snap result per
 * pointer event.
 */
export class SnappingService {
  private providers = new Map<string, SnapProvider>();
  private latest: SnapResult | null = null;
  private latestStable: SnapResult | null = null;
  private candidates: SnapResult[] = [];
  private cycleIndex = 0;
  private hierarchyKey: string | null = null;
  private targetMask: SnapTargetMask = {
    kinds: { ...DEFAULT_KIND_MASK },
    sources: { ...DEFAULT_SOURCE_MASK },
  };

  register(provider: SnapProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  configureTargets(mask: SnapTargetMask): void {
    this.targetMask = {
      kinds: { ...this.targetMask.kinds, ...mask.kinds },
      sources: { ...this.targetMask.sources, ...mask.sources },
    };
    this.cycleIndex = 0;
    this.hierarchyKey = null;
  }

  getTargetMask(): SnapTargetMask {
    return {
      kinds: { ...this.targetMask.kinds },
      sources: { ...this.targetMask.sources },
    };
  }

  query(input: SnapQueryInput): SnapQueryResult {
    const all: SnapResult[] = [];
    const effectiveInput: SnapQueryInput = { ...input, targetMask: this.targetMask };
    for (const p of this.providers.values()) {
      all.push(...p.query(effectiveInput));
    }

    const enabled = all.filter((candidate) => isCandidateEnabled(candidate, this.targetMask));
    enabled.sort(compareCandidates);
    this.candidates = applyHysteresis(enabled, this.latest);
    const nextHierarchyKey = makeHierarchyKey(this.candidates);
    if (nextHierarchyKey !== this.hierarchyKey) {
      this.cycleIndex = 0;
      this.hierarchyKey = nextHierarchyKey;
    } else if (this.cycleIndex >= this.candidates.length) {
      this.cycleIndex = 0;
    }

    const active = this.candidates[this.cycleIndex] ?? null;
    this.latest = active;
    if (active?.stable) this.latestStable = active;
    return {
      active,
      candidates: this.candidates,
      cycleIndex: this.cycleIndex,
      hierarchyKey: this.hierarchyKey,
    };
  }

  cycleCandidate(direction: 1 | -1 = 1): SnapQueryResult {
    if (this.candidates.length > 1) {
      this.cycleIndex =
        (this.cycleIndex + direction + this.candidates.length) % this.candidates.length;
      this.latest = this.candidates[this.cycleIndex] ?? null;
      if (this.latest?.stable) this.latestStable = this.latest;
    }
    return {
      active: this.latest,
      candidates: this.candidates,
      cycleIndex: this.cycleIndex,
      hierarchyKey: this.hierarchyKey,
    };
  }

  getLatest(): SnapResult | null {
    return this.latest;
  }

  getLatestStable(): SnapResult | null {
    return this.latestStable;
  }

  candidateCount(): number {
    return this.candidates.length;
  }
}

function compareCandidates(a: SnapResult, b: SnapResult): number {
  const sourceA = sourceRank(a);
  const sourceB = sourceRank(b);
  if (sourceA !== sourceB) return sourceA - sourceB;

  const kindA = KIND_PRIORITY[a.kind] ?? 99;
  const kindB = KIND_PRIORITY[b.kind] ?? 99;
  if (kindA !== kindB) return kindA - kindB;

  const pxA = a.distancePx ?? Number.POSITIVE_INFINITY;
  const pxB = b.distancePx ?? Number.POSITIVE_INFINITY;
  if (Math.abs(pxA - pxB) > 1) return pxA - pxB;

  return b.confidence - a.confidence;
}

function sourceRank(snap: SnapResult): number {
  return snap.source ? SOURCE_PRIORITY[snap.source] : 99;
}

function isCandidateEnabled(candidate: SnapResult, mask: SnapTargetMask): boolean {
  const kindEnabled = mask.kinds?.[candidate.kind];
  if (kindEnabled === false) return false;
  if (candidate.source) {
    const sourceEnabled = mask.sources?.[candidate.source];
    if (sourceEnabled === false) return false;
  }
  return true;
}

function applyHysteresis(candidates: SnapResult[], previous: SnapResult | null): SnapResult[] {
  if (!previous?.candidateId || candidates.length < 2) return candidates;
  const prevIndex = candidates.findIndex((c) => c.candidateId === previous.candidateId);
  if (prevIndex <= 0) return candidates;
  const prev = candidates[prevIndex];
  const best = candidates[0];
  if (!prev || !best) return candidates;
  const prevPx = prev.distancePx ?? Number.POSITIVE_INFINITY;
  const bestPx = best.distancePx ?? Number.POSITIVE_INFINITY;
  const closeEnough = Math.abs(prevPx - bestPx) <= 4;
  const similarQuality = prev.confidence + 0.12 >= best.confidence;
  if (!closeEnough || !similarQuality) return candidates;
  const next = candidates.slice();
  next.splice(prevIndex, 1);
  next.unshift(prev);
  return next;
}

function makeHierarchyKey(candidates: readonly SnapResult[]): string | null {
  if (candidates.length === 0) return null;
  return candidates
    .slice(0, 8)
    .map((c) => c.candidateId ?? `${c.kind}:${c.source ?? 'unknown'}`)
    .join('|');
}
