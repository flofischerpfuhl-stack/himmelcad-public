import type { ScreenSpaceErrorContext, TiledDataset } from './TiledDataset.js';
import type { RenderBudget } from './RenderBudget.js';

/**
 * Skeleton implementation. The full streaming logic (frustum cull, SSE walk,
 * load/unload prioritisation, eviction) lands during MVP Workstream 8. Kept
 * here as the agreed shared entry point.
 */
export class TileStreamingService {
  readonly budget: RenderBudget;
  private datasets = new Set<TiledDataset>();

  constructor(budget: RenderBudget) {
    this.budget = budget;
  }

  register(dataset: TiledDataset): void {
    this.datasets.add(dataset);
  }

  unregister(dataset: TiledDataset): void {
    this.datasets.delete(dataset);
  }

  update(_ctx: ScreenSpaceErrorContext): void {
    // PERF: replaced with frustum + SSE walk + load/unload scheduling later.
    // Stays a no-op until concrete TiledDataset implementations exist.
    void this.datasets.size;
  }
}
