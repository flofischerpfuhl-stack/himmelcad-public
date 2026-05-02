/**
 * Shared budget across all visible TiledDatasets. Implementations must allocate
 * fairly when multiple data types compete (point cloud + mesh + splat), so the
 * user does not get starved frames just because one layer is greedy.
 */
export class RenderBudget {
  private maxPoints = 4_000_000;
  private maxTriangles = 6_000_000;
  private maxSplats = 2_000_000;

  configure(opts: { maxPoints?: number; maxTriangles?: number; maxSplats?: number }): void {
    if (opts.maxPoints !== undefined) this.maxPoints = opts.maxPoints;
    if (opts.maxTriangles !== undefined) this.maxTriangles = opts.maxTriangles;
    if (opts.maxSplats !== undefined) this.maxSplats = opts.maxSplats;
  }

  getMaxPoints(): number {
    return this.maxPoints;
  }

  getMaxTriangles(): number {
    return this.maxTriangles;
  }

  getMaxSplats(): number {
    return this.maxSplats;
  }
}
