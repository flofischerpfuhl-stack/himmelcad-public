/**
 * Shared budget across all visible TiledDatasets. Implementations must allocate
 * fairly when multiple data types compete (point cloud + mesh + splat), so the
 * user does not get starved frames just because one layer is greedy.
 */
export interface RenderResourceCost {
  readonly points?: number;
  readonly triangles?: number;
  readonly splats?: number;
  readonly textureBytes?: number;
  readonly gpuBytes?: number;
  readonly drawCalls?: number;
}

export interface RenderBudgetLimits {
  readonly maxPoints: number;
  readonly maxTriangles: number;
  readonly maxSplats: number;
  readonly maxTextureBytes: number;
  readonly maxGpuBytes: number;
  readonly maxDrawCalls: number;
}

export class RenderBudget {
  private maxPoints = 4_000_000;
  private maxTriangles = 6_000_000;
  private maxSplats = 2_000_000;
  private maxTextureBytes = 512 * 1024 * 1024;
  private maxGpuBytes = 1024 * 1024 * 1024;
  private maxDrawCalls = 2_000;

  configure(opts: Partial<RenderBudgetLimits>): void {
    if (opts.maxPoints !== undefined) this.maxPoints = opts.maxPoints;
    if (opts.maxTriangles !== undefined) this.maxTriangles = opts.maxTriangles;
    if (opts.maxSplats !== undefined) this.maxSplats = opts.maxSplats;
    if (opts.maxTextureBytes !== undefined) this.maxTextureBytes = opts.maxTextureBytes;
    if (opts.maxGpuBytes !== undefined) this.maxGpuBytes = opts.maxGpuBytes;
    if (opts.maxDrawCalls !== undefined) this.maxDrawCalls = opts.maxDrawCalls;
  }

  getLimits(): RenderBudgetLimits {
    return {
      maxPoints: this.maxPoints,
      maxTriangles: this.maxTriangles,
      maxSplats: this.maxSplats,
      maxTextureBytes: this.maxTextureBytes,
      maxGpuBytes: this.maxGpuBytes,
      maxDrawCalls: this.maxDrawCalls,
    };
  }

  fits(cost: RenderResourceCost): boolean {
    return this.pressure(cost) <= 1;
  }

  /**
   * Returns the highest resource pressure of a candidate tile. A value > 1
   * means this tile alone exceeds at least one configured budget and should
   * be rejected or loaded only in a degraded mode.
   */
  pressure(cost: RenderResourceCost): number {
    return Math.max(
      ratio(cost.points, this.maxPoints),
      ratio(cost.triangles, this.maxTriangles),
      ratio(cost.splats, this.maxSplats),
      ratio(cost.textureBytes, this.maxTextureBytes),
      ratio(cost.gpuBytes, this.maxGpuBytes),
      ratio(cost.drawCalls, this.maxDrawCalls),
    );
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

function ratio(value: number | undefined, limit: number): number {
  if (value === undefined || value <= 0) return 0;
  if (limit <= 0) return Number.POSITIVE_INFINITY;
  return value / limit;
}
