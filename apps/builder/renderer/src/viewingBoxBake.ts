import type { KernelViewingBoxState, KernelWorldPoint } from '@himmelcad/viewer/kernel';

const POTREE_NODE_BYTES = 22;
const HIERARCHY_WINDOW_BYTES = 1024 * 1024;
const MAX_HIERARCHY_WINDOWS = 4;
const FILTER_YIELD_RECORDS = 65_536;

interface PotreeAttribute {
  readonly name: string;
  readonly size: number;
  readonly numElements?: number;
  readonly elementSize?: number;
  readonly type?: string;
}

interface PotreeMetadata {
  readonly version: string;
  readonly name?: string;
  readonly description?: string;
  readonly points: number;
  readonly projection?: string;
  readonly hierarchy: {
    readonly firstChunkSize: number;
    readonly stepSize: number;
    readonly depth: number;
  };
  readonly offset: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly spacing: number;
  readonly boundingBox: PotreeBounds;
  readonly encoding: string;
  readonly attributes: readonly PotreeAttribute[];
  readonly [key: string]: unknown;
}

interface PotreeBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

interface SourceNode {
  readonly id: string;
  readonly bounds: PotreeBounds;
  readonly children: readonly string[];
  readonly pointCount: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly childPage: { readonly byteOffset: number; readonly byteLength: number } | null;
}

interface BakedNode extends SourceNode {
  readonly bytes: Uint8Array;
}

export interface ViewingBoxPotreeBakeRequest {
  readonly metadataUrl: string;
  readonly box: KernelViewingBoxState;
  /** Exact canonical placement of the source dataset, column-major. */
  readonly placement?: readonly number[] | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, phase: string) => void | Promise<void>;
}

export interface ViewingBoxPotreeBake {
  readonly metadata: Uint8Array;
  readonly hierarchy: Uint8Array;
  readonly octree: Uint8Array;
  readonly pointCount: number;
  readonly sourcePointCount: number;
  readonly estimatedKeptShare: number;
}

/**
 * Bakes a Potree 2 source into another ordinary Potree 2 hierarchy. Reads and
 * filters one source node at a time; only the reduced result is accumulated.
 * Publication is deliberately left to the caller so cancellation cannot expose
 * a partial dataset.
 */
export async function bakePotreeViewingBox(
  request: ViewingBoxPotreeBakeRequest,
): Promise<ViewingBoxPotreeBake> {
  throwIfAborted(request.signal);
  await request.onProgress?.(0.01, 'Reading point-cloud metadata');
  throwIfAborted(request.signal);
  const metadataBytes = await fetchBytes(request.metadataUrl, request.signal);
  const metadata = parseMetadata(metadataBytes);
  if (!['DEFAULT', 'UNCOMPRESSED'].includes(metadata.encoding.toUpperCase())) {
    throw new Error(`Viewing-box bake does not support Potree encoding ${metadata.encoding}.`);
  }
  const stride = metadata.attributes.reduce((sum, attribute) => sum + attribute.size, 0);
  const positionOffset = positionByteOffset(metadata.attributes);
  const baseUrl = request.metadataUrl.slice(0, request.metadataUrl.lastIndexOf('/') + 1);
  const hierarchyUrl = `${baseUrl}hierarchy.bin`;
  const octreeUrl = `${baseUrl}octree.bin`;
  const readHierarchy = rangeWindowReader(
    hierarchyUrl,
    HIERARCHY_WINDOW_BYTES,
    MAX_HIERARCHY_WINDOWS,
    request.signal,
  );
  await request.onProgress?.(0.03, 'Reading intersecting hierarchy');
  throwIfAborted(request.signal);
  const firstPage = await readHierarchy(0, metadata.hierarchy.firstChunkSize);
  const nodes = new Map<string, SourceNode>();
  parseHierarchyPage(nodes, 'r', metadata.boundingBox, false, firstPage);
  const keepInside = (request.box.operation ?? 'keepInside') === 'keepInside';
  const boxBounds = keepInside ? viewingBoxWorldBounds(request.box) : null;
  const mayContribute = (node: SourceNode): boolean =>
    !boxBounds || worldBoundsIntersect(node.bounds, request.placement, boxBounds);
  const pageQueue = [...nodes.values()].filter(
    (node) => node.childPage !== null && mayContribute(node),
  );
  const loadedPages = new Set<string>();
  let publishedHierarchyProgress = 0.03;
  while (pageQueue.length > 0) {
    throwIfAborted(request.signal);
    const proxy = pageQueue.shift()!;
    if (!proxy.childPage || loadedPages.has(proxy.id)) continue;
    loadedPages.add(proxy.id);
    const before = new Set(nodes.keys());
    const page = await readHierarchy(proxy.childPage.byteOffset, proxy.childPage.byteLength);
    parseHierarchyPage(nodes, proxy.id, proxy.bounds, true, page);
    for (const node of nodes.values()) {
      if (!before.has(node.id) && node.childPage && mayContribute(node)) pageQueue.push(node);
    }
    const remaining = pageQueue.length;
    const progress =
      0.03 + Math.min(0.07, (loadedPages.size / (loadedPages.size + remaining)) * 0.07);
    if (remaining === 0 || progress - publishedHierarchyProgress >= 0.01) {
      await request.onProgress?.(progress, 'Reading intersecting hierarchy');
      publishedHierarchyProgress = progress;
    }
  }

  const ordered = breadthFirst(nodes).filter((node) => node.id === 'r' || mayContribute(node));
  const includedIds = new Set(ordered.map((node) => node.id));
  const candidatePoints = ordered.reduce(
    (sum, node) => sum + (mayContribute(node) ? node.pointCount : 0),
    0,
  );
  await request.onProgress?.(0.1, 'Filtering prepared points');
  throwIfAborted(request.signal);
  const baked: BakedNode[] = [];
  let visitedPoints = 0;
  let keptPoints = 0;
  let publishedFilterProgress = 0.1;
  for (const node of ordered) {
    throwIfAborted(request.signal);
    let kept: Uint8Array = new Uint8Array(0);
    const scanNode = mayContribute(node);
    if (scanNode && node.pointCount > 0 && node.byteLength > 0) {
      const source = await fetchRange(octreeUrl, node.byteOffset, node.byteLength, request.signal);
      if (source.byteLength !== node.pointCount * stride) {
        throw new Error(`Potree node ${node.id} byte count does not match its point layout.`);
      }
      kept = await filterNode(
        source,
        stride,
        positionOffset,
        metadata.scale,
        metadata.offset,
        request.box,
        request.placement,
        request.signal,
      );
      keptPoints += kept.byteLength / stride;
    }
    if (scanNode) visitedPoints += node.pointCount;
    baked.push({
      ...node,
      children: node.children.filter((child) => includedIds.has(child)),
      pointCount: kept.byteLength / stride,
      bytes: kept,
    });
    const progress =
      candidatePoints > 0 ? 0.1 + Math.min(0.8, (visitedPoints / candidatePoints) * 0.8) : 0.9;
    if (visitedPoints >= candidatePoints || progress - publishedFilterProgress >= 0.1) {
      await request.onProgress?.(progress, 'Filtering prepared points');
      publishedFilterProgress = progress;
    }
  }

  throwIfAborted(request.signal);
  const octree = concatenate(baked.map((node) => node.bytes));
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const node of baked) {
    offsets.set(node.id, offset);
    offset += node.bytes.byteLength;
  }
  const hierarchy = encodeHierarchy(baked, offsets);
  const nextMetadata: PotreeMetadata = {
    ...metadata,
    name: `${metadata.name ?? 'Point cloud'} — viewing box`,
    points: keptPoints,
    hierarchy: {
      ...metadata.hierarchy,
      firstChunkSize: hierarchy.byteLength,
      stepSize: Math.max(metadata.hierarchy.depth + 1, metadata.hierarchy.stepSize),
    },
  };
  await request.onProgress?.(0.98, 'Publishing reduced hierarchy');
  return Object.freeze({
    metadata: new TextEncoder().encode(JSON.stringify(nextMetadata)),
    hierarchy,
    octree,
    pointCount: keptPoints,
    sourcePointCount: metadata.points,
    estimatedKeptShare: metadata.points > 0 ? keptPoints / metadata.points : 0,
  });
}

export function viewingBoxBakeCacheKey(
  box: KernelViewingBoxState,
  sources: readonly {
    readonly entityId: string;
    readonly entityRevision: number;
    readonly placement: readonly number[] | null | undefined;
    readonly datasetId: string;
  }[],
): string {
  return JSON.stringify({
    box: {
      center: box.center,
      halfExtents: box.halfExtents,
      rotation: box.rotation,
      operation: box.operation ?? 'keepInside',
    },
    sources: [...sources].sort((left, right) => left.entityId.localeCompare(right.entityId)),
  });
}

function parseMetadata(bytes: Uint8Array): PotreeMetadata {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PotreeMetadata>;
  if (
    typeof value.version !== 'string' ||
    !Number.isSafeInteger(value.points) ||
    !value.hierarchy ||
    !Number.isSafeInteger(value.hierarchy.firstChunkSize) ||
    !Array.isArray(value.attributes) ||
    !Array.isArray(value.scale) ||
    !Array.isArray(value.offset) ||
    !value.boundingBox ||
    !Array.isArray(value.boundingBox.min) ||
    !Array.isArray(value.boundingBox.max) ||
    typeof value.encoding !== 'string'
  ) {
    throw new Error('Viewing-box bake received invalid Potree 2 metadata.');
  }
  return value as PotreeMetadata;
}

function positionByteOffset(attributes: readonly PotreeAttribute[]): number {
  let offset = 0;
  for (const attribute of attributes) {
    if (
      attribute.name.toLowerCase() === 'position' ||
      attribute.name.toUpperCase() === 'POSITION_CARTESIAN'
    ) {
      if (attribute.size !== 12) throw new Error('Potree position attribute must be int32 xyz.');
      return offset;
    }
    offset += attribute.size;
  }
  throw new Error('Potree metadata has no position attribute.');
}

function parseHierarchyPage(
  target: Map<string, SourceNode>,
  rootId: string,
  rootBounds: PotreeBounds,
  rootWasProxy: boolean,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength === 0 || bytes.byteLength % POTREE_NODE_BYTES !== 0) {
    throw new Error('Potree hierarchy page has an invalid byte length.');
  }
  const pending: { id: string; bounds: PotreeBounds; wasProxy: boolean }[] = [
    { id: rootId, bounds: rootBounds, wasProxy: rootWasProxy },
  ];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let recordOffset = 0; recordOffset < bytes.byteLength; recordOffset += POTREE_NODE_BYTES) {
    const current = pending.shift();
    if (!current) throw new Error('Potree hierarchy page contains unreachable records.');
    const nodeType = view.getUint8(recordOffset);
    const childMask = view.getUint8(recordOffset + 1);
    const pointCount = view.getUint32(recordOffset + 2, true);
    const byteOffset = safeUint64(view, recordOffset + 6);
    const byteLength = safeUint64(view, recordOffset + 14);
    const isProxy = nodeType === 2 && !current.wasProxy;
    const children: string[] = [];
    if (!isProxy) {
      for (let child = 0; child < 8; child += 1) {
        if ((childMask & (1 << child)) === 0) continue;
        const id = `${current.id}${child}`;
        children.push(id);
        pending.push({ id, bounds: childBounds(current.bounds, child), wasProxy: false });
      }
    }
    target.set(current.id, {
      id: current.id,
      bounds: current.bounds,
      children,
      pointCount,
      byteOffset,
      byteLength,
      childPage: isProxy ? { byteOffset, byteLength } : null,
    });
  }
  if (pending.length > 0) throw new Error('Potree hierarchy page ended before its children.');
}

function breadthFirst(nodes: ReadonlyMap<string, SourceNode>): SourceNode[] {
  const result: SourceNode[] = [];
  const pending = ['r'];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Potree hierarchy is missing node ${id}.`);
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

async function filterNode(
  source: Uint8Array,
  stride: number,
  positionOffset: number,
  scale: readonly [number, number, number],
  offset: readonly [number, number, number],
  box: KernelViewingBoxState,
  placement: readonly number[] | null | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const axes = viewingBoxAxes(box);
  const kept = new Uint8Array(source.byteLength);
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let write = 0;
  let recordIndex = 0;
  for (let record = 0; record < source.byteLength; record += stride, recordIndex += 1) {
    if (recordIndex > 0 && recordIndex % FILTER_YIELD_RECORDS === 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      throwIfAborted(signal);
    }
    const local = {
      x: sourceView.getInt32(record + positionOffset, true) * scale[0] + offset[0],
      y: sourceView.getInt32(record + positionOffset + 4, true) * scale[1] + offset[1],
      z: sourceView.getInt32(record + positionOffset + 8, true) * scale[2] + offset[2],
    };
    const world = transformPoint(local, placement);
    const relative = {
      x: world.x - box.center.x,
      y: world.y - box.center.y,
      z: world.z - box.center.z,
    };
    const inside =
      Math.abs(dot(relative, axes[0])) <= box.halfExtents.x &&
      Math.abs(dot(relative, axes[1])) <= box.halfExtents.y &&
      Math.abs(dot(relative, axes[2])) <= box.halfExtents.z;
    const keep = (box.operation ?? 'keepInside') === 'keepInside' ? inside : !inside;
    if (!keep) continue;
    kept.set(source.subarray(record, record + stride), write);
    write += stride;
  }
  return kept.slice(0, write);
}

function viewingBoxAxes(
  box: Pick<KernelViewingBoxState, 'rotation'>,
): readonly [KernelWorldPoint, KernelWorldPoint, KernelWorldPoint] {
  const length = Math.hypot(...box.rotation);
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new RangeError('Viewing-box bake requires a finite rotation.');
  }
  const [x, y, z, w] = box.rotation.map((component) => component / length) as [
    number,
    number,
    number,
    number,
  ];
  return [
    {
      x: 1 - 2 * (y * y + z * z),
      y: 2 * (x * y + z * w),
      z: 2 * (x * z - y * w),
    },
    {
      x: 2 * (x * y - z * w),
      y: 1 - 2 * (x * x + z * z),
      z: 2 * (y * z + x * w),
    },
    {
      x: 2 * (x * z + y * w),
      y: 2 * (y * z - x * w),
      z: 1 - 2 * (x * x + y * y),
    },
  ];
}

function viewingBoxWorldBounds(box: KernelViewingBoxState): PotreeBounds {
  const axes = viewingBoxAxes(box);
  const half = [box.halfExtents.x, box.halfExtents.y, box.halfExtents.z] as const;
  const extent = [0, 1, 2].map((worldAxis) =>
    axes.reduce(
      (sum, axis, boxAxis) => sum + Math.abs([axis.x, axis.y, axis.z][worldAxis]!) * half[boxAxis]!,
      0,
    ),
  );
  return {
    min: [box.center.x - extent[0]!, box.center.y - extent[1]!, box.center.z - extent[2]!],
    max: [box.center.x + extent[0]!, box.center.y + extent[1]!, box.center.z + extent[2]!],
  };
}

function worldBoundsIntersect(
  source: PotreeBounds,
  placement: readonly number[] | null | undefined,
  target: PotreeBounds,
): boolean {
  const transformed = transformedBounds(source, placement);
  return [0, 1, 2].every(
    (axis) =>
      transformed.max[axis]! >= target.min[axis]! && transformed.min[axis]! <= target.max[axis]!,
  );
}

function transformedBounds(
  bounds: PotreeBounds,
  placement: readonly number[] | null | undefined,
): PotreeBounds {
  if (!placement || placement.length !== 16) return bounds;
  const points: KernelWorldPoint[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        points.push(transformPoint({ x, y, z }, placement));
      }
    }
  }
  return {
    min: [
      Math.min(...points.map((point) => point.x)),
      Math.min(...points.map((point) => point.y)),
      Math.min(...points.map((point) => point.z)),
    ],
    max: [
      Math.max(...points.map((point) => point.x)),
      Math.max(...points.map((point) => point.y)),
      Math.max(...points.map((point) => point.z)),
    ],
  };
}

function encodeHierarchy(
  nodes: readonly BakedNode[],
  offsets: ReadonlyMap<string, number>,
): Uint8Array {
  const bytes = new Uint8Array(nodes.length * POTREE_NODE_BYTES);
  const view = new DataView(bytes.buffer);
  nodes.forEach((node, index) => {
    const at = index * POTREE_NODE_BYTES;
    view.setUint8(at, 0);
    let childMask = 0;
    for (const child of node.children) childMask |= 1 << Number(child.at(-1));
    view.setUint8(at + 1, childMask);
    view.setUint32(at + 2, node.pointCount, true);
    view.setBigUint64(at + 6, BigInt(offsets.get(node.id) ?? 0), true);
    view.setBigUint64(at + 14, BigInt(node.bytes.byteLength), true);
  });
  return bytes;
}

function childBounds(parent: PotreeBounds, child: number): PotreeBounds {
  const middle = [0, 1, 2].map(
    (axis) => parent.min[axis]! + (parent.max[axis]! - parent.min[axis]!) * 0.5,
  );
  const min = [0, 1, 2].map((axis) =>
    (child & (1 << (2 - axis))) === 0 ? parent.min[axis]! : middle[axis]!,
  ) as [number, number, number];
  const max = [0, 1, 2].map((axis) =>
    (child & (1 << (2 - axis))) === 0 ? middle[axis]! : parent.max[axis]!,
  ) as [number, number, number];
  return { min, max };
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Viewing-box bake could not read ${url}: ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchRange(
  url: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array(0);
  const response = await fetch(url, {
    ...(signal ? { signal } : {}),
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (!response.ok) throw new Error(`Viewing-box bake could not read ${url}: ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === length) return bytes;
  if (response.status === 200 && bytes.byteLength >= offset + length) {
    return bytes.slice(offset, offset + length);
  }
  throw new Error(`Viewing-box bake received a short range from ${url}.`);
}

function rangeWindowReader(
  url: string,
  windowBytes: number,
  maxWindows: number,
  signal?: AbortSignal,
): (offset: number, length: number) => Promise<Uint8Array> {
  const windows = new Map<number, Uint8Array>();
  return async (offset, length) => {
    if (length === 0) return new Uint8Array(0);
    const windowStart = Math.floor(offset / windowBytes) * windowBytes;
    if (length > windowBytes || offset + length > windowStart + windowBytes) {
      return await fetchRange(url, offset, length, signal);
    }
    let window = windows.get(windowStart);
    if (!window) {
      window = await fetchRangeAtMost(url, windowStart, windowBytes, signal);
      if (windows.size >= maxWindows) windows.delete(windows.keys().next().value!);
      windows.set(windowStart, window);
    } else {
      // Refresh insertion order for the small bounded LRU.
      windows.delete(windowStart);
      windows.set(windowStart, window);
    }
    const relative = offset - windowStart;
    if (relative + length > window.byteLength) {
      throw new Error(`Viewing-box bake received a short range from ${url}.`);
    }
    return window.slice(relative, relative + length);
  };
}

async function fetchRangeAtMost(
  url: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    ...(signal ? { signal } : {}),
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (!response.ok) throw new Error(`Viewing-box bake could not read ${url}: ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 200) {
    if (bytes.byteLength <= offset) return new Uint8Array(0);
    return bytes.slice(offset, Math.min(bytes.byteLength, offset + length));
  }
  if (bytes.byteLength === 0 || bytes.byteLength > length) {
    throw new Error(`Viewing-box bake received an invalid range from ${url}.`);
  }
  return bytes;
}

function safeUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Potree range exceeds JS precision.');
  return Number(value);
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function transformPoint(point: KernelWorldPoint, matrix: readonly number[] | null | undefined) {
  if (!matrix || matrix.length !== 16) return point;
  return {
    x: matrix[0]! * point.x + matrix[4]! * point.y + matrix[8]! * point.z + matrix[12]!,
    y: matrix[1]! * point.x + matrix[5]! * point.y + matrix[9]! * point.z + matrix[13]!,
    z: matrix[2]! * point.x + matrix[6]! * point.y + matrix[10]! * point.z + matrix[14]!,
  };
}

function dot(left: KernelWorldPoint, right: KernelWorldPoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}
