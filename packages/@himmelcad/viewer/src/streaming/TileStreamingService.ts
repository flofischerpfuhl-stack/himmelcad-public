import type { RenderResourceCost } from './RenderBudget.js';
import type { RenderBudget } from './RenderBudget.js';
import type { ScreenSpaceErrorContext, Tile, TiledDataset, TileId } from './TiledDataset.js';

export interface TileStreamingOptions {
  /** Refine a tile when its projected error is larger than this many pixels. */
  readonly maxScreenSpaceError: number;
  /** Global in-flight load cap shared by point, mesh, raster, and splat datasets. */
  readonly maxConcurrentLoads: number;
  /** Prevent a single frame from producing an I/O burst even on fast storage. */
  readonly maxNewLoadsPerUpdate: number;
  /** Keep recently visible tiles warm to avoid zoom/orbit thrashing. */
  readonly evictionGraceMs: number;
  /** The rAF caller may invoke update every frame; traversal runs at this interval. */
  readonly updateIntervalMs: number;
}

interface Candidate {
  dataset: TiledDataset;
  tile: Tile;
  error: number;
  key: string;
}

const DEFAULT_OPTIONS: TileStreamingOptions = {
  maxScreenSpaceError: 2,
  maxConcurrentLoads: 8,
  maxNewLoadsPerUpdate: 6,
  evictionGraceMs: 2_000,
  updateIntervalMs: 80,
};

/**
 * Shared budgeted tile scheduler.
 *
 * The hot rAF call is throttled and reuses traversal/candidate storage. Dataset
 * implementations own decoding and GPU objects; this service only decides which
 * common-contract tiles must be resident.
 */
export class TileStreamingService {
  readonly budget: RenderBudget;
  private readonly datasets = new Set<TiledDataset>();
  private readonly candidates: Candidate[] = [];
  private readonly traversalTiles: Tile[] = [];
  private readonly traversalDatasets: TiledDataset[] = [];
  private readonly selectedKeys = new Set<string>();
  private readonly lastTouchedMs = new Map<string, number>();
  private readonly pendingKeys = new Set<string>();
  private options: TileStreamingOptions;
  private lastUpdateMs = Number.NEGATIVE_INFINITY;

  constructor(budget: RenderBudget, options: Partial<TileStreamingOptions> = {}) {
    this.budget = budget;
    this.options = validatedOptions({ ...DEFAULT_OPTIONS, ...options });
  }

  configure(options: Partial<TileStreamingOptions>): void {
    this.options = validatedOptions({ ...this.options, ...options });
  }

  register(dataset: TiledDataset): void {
    this.datasets.add(dataset);
  }

  unregister(dataset: TiledDataset): void {
    this.datasets.delete(dataset);
    const prefix = `${dataset.id}\u0000`;
    for (const key of this.lastTouchedMs.keys()) {
      if (key.startsWith(prefix)) this.lastTouchedMs.delete(key);
    }
    for (const key of this.pendingKeys) {
      if (key.startsWith(prefix)) this.pendingKeys.delete(key);
    }
  }

  dispose(): void {
    for (const dataset of this.datasets) {
      for (const tileId of dataset.getLoadedTileIds()) dataset.unloadTile(tileId);
    }
    this.datasets.clear();
    this.candidates.length = 0;
    this.traversalTiles.length = 0;
    this.traversalDatasets.length = 0;
    this.selectedKeys.clear();
    this.lastTouchedMs.clear();
    this.pendingKeys.clear();
  }

  update(ctx: ScreenSpaceErrorContext, nowMs = performance.now()): void {
    if (nowMs - this.lastUpdateMs < this.options.updateIntervalMs) return;
    this.lastUpdateMs = nowMs;
    this.candidates.length = 0;
    this.traversalTiles.length = 0;
    this.traversalDatasets.length = 0;
    this.selectedKeys.clear();

    for (const dataset of this.datasets) {
      dataset.prepareFrame?.(ctx);
      this.collectDataset(dataset, ctx, nowMs);
    }
    this.candidates.sort(compareCandidates);

    const limits = this.budget.getLimits();
    let points = 0;
    let triangles = 0;
    let splats = 0;
    let textureBytes = 0;
    let gpuBytes = 0;
    let drawCalls = 0;
    let newLoads = 0;

    for (const candidate of this.candidates) {
      const content = candidate.tile.content;
      const nextPoints = points + (content.points ?? 0);
      const nextTriangles = triangles + (content.triangles ?? 0);
      const nextSplats = splats + (content.splats ?? 0);
      const nextTextureBytes = textureBytes + (content.textureBytes ?? 0);
      const nextGpuBytes = gpuBytes + (content.gpuBytes ?? 0);
      const nextDrawCalls = drawCalls + (content.drawCalls ?? 1);
      if (
        nextPoints > limits.maxPoints ||
        nextTriangles > limits.maxTriangles ||
        nextSplats > limits.maxSplats ||
        nextTextureBytes > limits.maxTextureBytes ||
        nextGpuBytes > limits.maxGpuBytes ||
        nextDrawCalls > limits.maxDrawCalls
      ) {
        continue;
      }

      points = nextPoints;
      triangles = nextTriangles;
      splats = nextSplats;
      textureBytes = nextTextureBytes;
      gpuBytes = nextGpuBytes;
      drawCalls = nextDrawCalls;
      this.selectedKeys.add(candidate.key);
      this.lastTouchedMs.set(candidate.key, nowMs);

      if (
        !candidate.dataset.isLoaded(candidate.tile.id) &&
        !this.pendingKeys.has(candidate.key) &&
        this.pendingKeys.size < this.options.maxConcurrentLoads &&
        newLoads < this.options.maxNewLoadsPerUpdate
      ) {
        newLoads += 1;
        this.pendingKeys.add(candidate.key);
        void candidate.dataset
          .loadTile(candidate.tile.id)
          .catch(() => undefined)
          .finally(() => {
            this.pendingKeys.delete(candidate.key);
          });
      }
    }

    this.evictColdTiles(nowMs);
    this.applySelectedVisibility(ctx);
  }

  getPendingLoadCount(): number {
    return this.pendingKeys.size;
  }

  getSelectedResourceCost(): RenderResourceCost {
    let points = 0;
    let triangles = 0;
    let splats = 0;
    let textureBytes = 0;
    let gpuBytes = 0;
    let drawCalls = 0;
    for (const candidate of this.candidates) {
      if (!this.selectedKeys.has(candidate.key)) continue;
      points += candidate.tile.content.points ?? 0;
      triangles += candidate.tile.content.triangles ?? 0;
      splats += candidate.tile.content.splats ?? 0;
      textureBytes += candidate.tile.content.textureBytes ?? 0;
      gpuBytes += candidate.tile.content.gpuBytes ?? 0;
      drawCalls += candidate.tile.content.drawCalls ?? 1;
    }
    return { points, triangles, splats, textureBytes, gpuBytes, drawCalls };
  }

  private collectDataset(dataset: TiledDataset, ctx: ScreenSpaceErrorContext, nowMs: number): void {
    const root = dataset.getTile(dataset.rootTile);
    if (!root) return;
    this.traversalTiles.push(root);
    this.traversalDatasets.push(dataset);

    while (this.traversalTiles.length > 0) {
      const tile = this.traversalTiles.pop();
      const owner = this.traversalDatasets.pop();
      if (!tile || !owner) continue;
      if (owner.isTileVisible && !owner.isTileVisible(tile, ctx)) continue;
      const error = finiteNonNegative(owner.computeScreenSpaceError(tile, ctx));
      const wantsChildren = error > this.options.maxScreenSpaceError && tile.children.length > 0;
      if (wantsChildren) {
        // Refine one resident level at a time. This bounds initial I/O and means
        // the first coarse tile is always a visible fallback on weak hardware.
        if (owner.isLoaded(tile.id)) {
          let childrenComplete = true;
          let visibleChildren = 0;
          for (const childId of tile.children) {
            const child = owner.getTile(childId);
            if (!child || (owner.isTileVisible && !owner.isTileVisible(child, ctx))) continue;
            visibleChildren += 1;
            this.traversalTiles.push(child);
            this.traversalDatasets.push(owner);
            if (!owner.isLoaded(childId)) childrenComplete = false;
          }
          // Keep a loaded parent selected until every visible child is resident.
          if (visibleChildren > 0 && childrenComplete) continue;
        }
      }
      const key = tileKey(owner.id, tile.id);
      this.candidates.push({ dataset: owner, tile, error, key });
      this.lastTouchedMs.set(key, nowMs);
    }
  }

  private applySelectedVisibility(ctx: ScreenSpaceErrorContext): void {
    for (const dataset of this.datasets) {
      dataset.updateForCamera?.(ctx);
      if (!dataset.setTileVisible) continue;
      for (const tileId of dataset.getLoadedTileIds()) {
        dataset.setTileVisible(tileId, this.selectedKeys.has(tileKey(dataset.id, tileId)));
      }
    }
  }

  private evictColdTiles(nowMs: number): void {
    for (const dataset of this.datasets) {
      const loaded = dataset.getLoadedTileIds();
      for (const tileId of loaded) {
        const key = tileKey(dataset.id, tileId);
        if (this.selectedKeys.has(key) || this.pendingKeys.has(key)) continue;
        const lastTouched = this.lastTouchedMs.get(key) ?? Number.NEGATIVE_INFINITY;
        if (nowMs - lastTouched < this.options.evictionGraceMs) continue;
        dataset.unloadTile(tileId);
        this.lastTouchedMs.delete(key);
      }
    }
  }
}

function tileKey(datasetId: string, tileId: TileId): string {
  return `${datasetId}\u0000${tileId}`;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const errorOrder = right.error - left.error;
  if (errorOrder !== 0) return errorOrder;
  const datasetOrder = left.dataset.id.localeCompare(right.dataset.id);
  if (datasetOrder !== 0) return datasetOrder;
  return String(left.tile.id).localeCompare(String(right.tile.id));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function validatedOptions(options: TileStreamingOptions): TileStreamingOptions {
  return {
    maxScreenSpaceError: positive(options.maxScreenSpaceError, 'maxScreenSpaceError'),
    maxConcurrentLoads: positiveInteger(options.maxConcurrentLoads, 'maxConcurrentLoads'),
    maxNewLoadsPerUpdate: positiveInteger(options.maxNewLoadsPerUpdate, 'maxNewLoadsPerUpdate'),
    evictionGraceMs: nonNegative(options.evictionGraceMs, 'evictionGraceMs'),
    updateIntervalMs: nonNegative(options.updateIntervalMs, 'updateIntervalMs'),
  };
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must not be negative`);
  return value;
}
