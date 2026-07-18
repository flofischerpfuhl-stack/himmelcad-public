import assert from 'node:assert/strict';

export const AHN4_POINT_COUNT = 1_185_930_249;
export const OCTREE_DEPTH = 5;
export const OCTREE_NODE_COUNT = 37_449;
export const POTREE_RECORD_BYTES = 22;
export const POINT_STRIDE_BYTES = 12;
export const PROXY_LEVEL = 2;
export const SOURCE_BOUNDS = Object.freeze({
  min: Object.freeze([130_000, 450_000, -3.36]),
  max: Object.freeze([134_999.999, 456_249.999, 79.899]),
});
export const SOURCE_OFFSET = SOURCE_BOUNDS.min;
export const SOURCE_SCALE = Object.freeze([0.001, 0.001, 0.001]);

const textEncoder = new TextEncoder();

/**
 * Builds the complete Potree 2 hierarchy without allocating its virtual
 * 14.2-GB point payload. Records are breadth-first, exactly as the provider
 * consumes them. Every logical point belongs to exactly one node.
 */
export function createSyntheticPotree() {
  const nodeCount = completeOctreeNodeCount(OCTREE_DEPTH);
  assert.equal(nodeCount, OCTREE_NODE_COUNT);
  const basePoints = Math.floor(AHN4_POINT_COUNT / nodeCount);
  const highPointNodes = AHN4_POINT_COUNT % nodeCount;
  const nodes = [];
  const queue = [{ id: 'r', level: 0, bounds: cloneBounds(SOURCE_BOUNDS) }];
  let virtualOffset = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pending = queue[cursor];
    assert(pending);
    const index = nodes.length;
    const pointCount = basePoints + Number(index < highPointNodes);
    const byteLength = pointCount * POINT_STRIDE_BYTES;
    const childMask = pending.level < OCTREE_DEPTH ? 0xff : 0;
    const node = {
      ...pending,
      pointCount,
      byteOffset: virtualOffset,
      byteLength,
      childMask,
    };
    nodes.push(node);
    virtualOffset += byteLength;
    if (childMask !== 0) {
      for (let child = 0; child < 8; child += 1) {
        queue.push({
          id: `${pending.id}${String(child)}`,
          level: pending.level + 1,
          bounds: childBounds(pending.bounds, child),
        });
      }
    }
  }

  const byOffset = new Map();
  let logicalPoints = 0;
  for (const node of nodes) {
    byOffset.set(node.byteOffset, node);
    logicalPoints += node.pointCount;
  }

  // The initial chunk stops at level two. Its 64 level-two records are real
  // Potree proxies whose ranges address independent breadth-first subtrees.
  const initialNodes = nodes.filter((node) => node.level <= PROXY_LEVEL);
  const proxyRoots = nodes.filter((node) => node.level === PROXY_LEVEL);
  const initialHierarchy = new Uint8Array(initialNodes.length * POTREE_RECORD_BYTES);
  const hierarchyPages = [];
  let hierarchyPageOffset = initialHierarchy.byteLength;
  for (const proxy of proxyRoots) {
    const subtree = nodes.filter((node) => node.id.startsWith(proxy.id));
    const bytes = encodeHierarchyRecords(subtree);
    hierarchyPages.push({
      rootId: proxy.id,
      byteOffset: hierarchyPageOffset,
      byteLength: bytes.byteLength,
      bytes,
    });
    hierarchyPageOffset += bytes.byteLength;
  }
  const pageByOffset = new Map(hierarchyPages.map((page) => [page.byteOffset, page]));
  const initialView = new DataView(initialHierarchy.buffer);
  for (const [index, node] of initialNodes.entries()) {
    if (node.level === PROXY_LEVEL) {
      const page = hierarchyPages.find((candidate) => candidate.rootId === node.id);
      assert(page);
      writeHierarchyRecord(
        initialView,
        index * POTREE_RECORD_BYTES,
        node,
        2,
        page.byteOffset,
        page.byteLength,
      );
    } else {
      writeHierarchyRecord(
        initialView,
        index * POTREE_RECORD_BYTES,
        node,
        0,
        node.byteOffset,
        node.byteLength,
      );
    }
  }
  const hierarchy = new Uint8Array(hierarchyPageOffset);
  hierarchy.set(initialHierarchy);
  for (const page of hierarchyPages) hierarchy.set(page.bytes, page.byteOffset);

  assert.equal(nodes.length, OCTREE_NODE_COUNT);
  assert.equal(logicalPoints, AHN4_POINT_COUNT);
  assert.equal(virtualOffset, AHN4_POINT_COUNT * POINT_STRIDE_BYTES);
  assert(nodes.every((node) => node.pointCount <= 16_000_000));
  assert.deepEqual(nodes[0].bounds, SOURCE_BOUNDS);

  const metadataDocument = {
    version: '2.0',
    name: 'AHN4 C_31HZ1 logical-scale synthetic gate',
    description: 'Procedural hierarchy only; no authority source coordinates are rewritten.',
    points: AHN4_POINT_COUNT,
    projection: 'EPSG:7415',
    himmelcadScaleGate: {
      logicalNodeCount: OCTREE_NODE_COUNT,
      initialNodeCount: initialNodes.length,
      proxyPageCount: hierarchyPages.length,
    },
    hierarchy: {
      firstChunkSize: initialHierarchy.byteLength,
      stepSize: OCTREE_DEPTH - PROXY_LEVEL + 1,
      depth: OCTREE_DEPTH,
    },
    spacing: 5_000,
    boundingBox: SOURCE_BOUNDS,
    offset: SOURCE_OFFSET,
    scale: SOURCE_SCALE,
    encoding: 'DEFAULT',
    attributes: [{ name: 'position', size: POINT_STRIDE_BYTES, numElements: 3, type: 'int32' }],
  };
  const metadata = textEncoder.encode(JSON.stringify(metadataDocument));

  return Object.freeze({
    metadata,
    metadataDocument,
    hierarchy,
    initialHierarchy,
    hierarchyPages: Object.freeze(hierarchyPages),
    nodes: Object.freeze(nodes),
    logicalPoints,
    virtualOctreeBytes: virtualOffset,
    payloadForRange(start, length) {
      const node = byOffset.get(start);
      if (node === undefined || node.byteLength !== length) {
        throw new RangeError(
          `range ${String(start)}+${String(length)} is not one synthetic Potree node`,
        );
      }
      return pointPayload(node);
    },
    nodeForRange(start, length) {
      const node = byOffset.get(start);
      return node?.byteLength === length ? node : null;
    },
    hierarchyPageForRange(start, length) {
      const page = pageByOffset.get(start);
      return page?.byteLength === length ? page : null;
    },
  });
}

export function parseSingleRange(header) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? '');
  if (match === null)
    throw new RangeError(`expected one closed byte range, received ${String(header)}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`invalid byte range ${String(header)}`);
  }
  return { start, end, length: end - start + 1 };
}

function pointPayload(node) {
  const bytes = new Uint8Array(node.byteLength);
  const view = new DataView(bytes.buffer);
  const extent = [0, 1, 2].map((axis) => node.bounds.max[axis] - node.bounds.min[axis]);
  const nodeSeed = hashNodeId(node.id);
  for (let point = 0; point < node.pointCount; point += 1) {
    // A bijective 15-bit permutation assigns almost every point to a distinct
    // 32^3 Morton cell. Node-scrambled radical inverses jitter each cell without
    // ambient randomness or changing the byte-range contract.
    const morton = (Math.imul(point, 0x4d35) + nodeSeed) & 0x7fff;
    const sequence = (point + nodeSeed) >>> 0;
    const fractions = [
      (mortonAxis(morton, 0) + 0.1 + 0.8 * radicalInverse(sequence, 2)) / 32,
      (mortonAxis(morton, 1) + 0.1 + 0.8 * radicalInverse(sequence, 3)) / 32,
      (mortonAxis(morton, 2) + 0.1 + 0.8 * radicalInverse(sequence, 5)) / 32,
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      const world = node.bounds.min[axis] + extent[axis] * fractions[axis];
      const quantized = Math.round((world - SOURCE_OFFSET[axis]) / SOURCE_SCALE[axis]);
      assert(quantized >= -0x8000_0000 && quantized <= 0x7fff_ffff);
      view.setInt32(point * POINT_STRIDE_BYTES + axis * 4, quantized, true);
    }
  }
  return bytes;
}

function hashNodeId(id) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mortonAxis(code, axis) {
  let value = 0;
  for (let bit = 0; bit < 5; bit += 1) {
    value |= ((code >>> (bit * 3 + axis)) & 1) << bit;
  }
  return value;
}

function radicalInverse(value, base) {
  let inverse = 1 / base;
  let fraction = 0;
  let remaining = value;
  while (remaining > 0) {
    fraction += (remaining % base) * inverse;
    remaining = Math.floor(remaining / base);
    inverse /= base;
  }
  return fraction;
}

function encodeHierarchyRecords(nodes) {
  const bytes = new Uint8Array(nodes.length * POTREE_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  for (const [index, node] of nodes.entries()) {
    writeHierarchyRecord(
      view,
      index * POTREE_RECORD_BYTES,
      node,
      0,
      node.byteOffset,
      node.byteLength,
    );
  }
  return bytes;
}

function writeHierarchyRecord(view, offset, node, nodeType, byteOffset, byteLength) {
  view.setUint8(offset, nodeType);
  view.setUint8(offset + 1, node.childMask);
  view.setUint32(offset + 2, node.pointCount, true);
  view.setBigInt64(offset + 6, BigInt(byteOffset), true);
  view.setBigInt64(offset + 14, BigInt(byteLength), true);
}

function completeOctreeNodeCount(depth) {
  let total = 0;
  for (let level = 0; level <= depth; level += 1) total += 8 ** level;
  return total;
}

function cloneBounds(bounds) {
  return { min: [...bounds.min], max: [...bounds.max] };
}

function childBounds(parent, index) {
  const middle = [0, 1, 2].map((axis) => (parent.min[axis] + parent.max[axis]) * 0.5);
  return {
    min: [
      index & 0b100 ? middle[0] : parent.min[0],
      index & 0b010 ? middle[1] : parent.min[1],
      index & 0b001 ? middle[2] : parent.min[2],
    ],
    max: [
      index & 0b100 ? parent.max[0] : middle[0],
      index & 0b010 ? parent.max[1] : middle[1],
      index & 0b001 ? parent.max[2] : middle[2],
    ],
  };
}
