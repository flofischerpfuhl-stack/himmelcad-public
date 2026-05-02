import type { SnapKind, SnapResult } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

const PRIORITY: SnapKind[] = [
  'Point',
  'Vertex',
  'Edge',
  'Face',
  'Grid',
  'EstimatedSurface',
  'Free',
];

/**
 * Owns the cursor coordinate. Drawing tools, measurement tools and the
 * coordinate display in the status overlay must read from here, not from any
 * of the providers directly. This keeps a single canonical snap result per
 * pointer event.
 */
export class SnappingService {
  private providers = new Map<string, SnapProvider>();
  private latest: SnapResult | null = null;

  register(provider: SnapProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  query(input: SnapQueryInput): SnapResult | null {
    let best: SnapResult | null = null;
    let bestRank = PRIORITY.length;
    for (const p of this.providers.values()) {
      const r = p.query(input);
      if (!r) continue;
      const rank = PRIORITY.indexOf(r.kind);
      if (rank === -1) continue;
      if (rank < bestRank || (rank === bestRank && (best === null || r.confidence > best.confidence))) {
        best = r;
        bestRank = rank;
      }
    }
    this.latest = best;
    return best;
  }

  getLatest(): SnapResult | null {
    return this.latest;
  }
}
