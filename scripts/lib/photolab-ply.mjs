import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

// PhotoLab headers are a few hundred bytes; 1 MiB bounds malformed inputs while
// leaving ample room for additional scalar properties and comments.
const HEADER_LIMIT_BYTES = 1024 * 1024;
const TYPE_READERS = {
  char: [1, 'readInt8'],
  int8: [1, 'readInt8'],
  uchar: [1, 'readUInt8'],
  uint8: [1, 'readUInt8'],
  short: [2, 'readInt16LE'],
  int16: [2, 'readInt16LE'],
  ushort: [2, 'readUInt16LE'],
  uint16: [2, 'readUInt16LE'],
  int: [4, 'readInt32LE'],
  int32: [4, 'readInt32LE'],
  uint: [4, 'readUInt32LE'],
  uint32: [4, 'readUInt32LE'],
  float: [4, 'readFloatLE'],
  float32: [4, 'readFloatLE'],
  double: [8, 'readDoubleLE'],
  float64: [8, 'readDoubleLE'],
};

export function parsePlyHeader(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const marker = Buffer.from('end_header');
  const markerOffset = bytes.indexOf(marker);
  if (markerOffset < 0) {
    throw new Error('PLY header does not contain end_header');
  }

  let dataOffset = markerOffset + marker.length;
  if (bytes[dataOffset] === 13) dataOffset += 1;
  if (bytes[dataOffset] !== 10) {
    throw new Error('PLY end_header must end with a newline');
  }
  dataOffset += 1;

  const lines = bytes.subarray(0, markerOffset).toString('ascii').split(/\r?\n/);
  if (lines[0] !== 'ply') throw new Error('Not a PLY file');
  const format = lines.find((line) => line.startsWith('format '))?.split(/\s+/)[1];
  if (format !== 'binary_little_endian') {
    throw new Error(`Unsupported PLY format: ${format ?? 'missing'}`);
  }

  let currentElement = null;
  let vertexCount = null;
  const properties = [];
  let recordSize = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') {
      currentElement = parts[1];
      if (currentElement === 'vertex') {
        vertexCount = Number.parseInt(parts[2], 10);
        if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) {
          throw new Error(`Invalid PLY vertex count: ${parts[2]}`);
        }
      }
    } else if (parts[0] === 'property' && currentElement === 'vertex') {
      if (parts[1] === 'list') {
        throw new Error('List properties are not supported on PLY vertices');
      }
      const [size, reader] = TYPE_READERS[parts[1]] ?? [];
      if (!size) throw new Error(`Unsupported PLY property type: ${parts[1]}`);
      properties.push({ name: parts[2], type: parts[1], offset: recordSize, size, reader });
      recordSize += size;
    }
  }
  if (vertexCount === null) throw new Error('PLY header has no vertex element');
  for (const coordinate of ['x', 'y', 'z']) {
    if (!properties.some((property) => property.name === coordinate)) {
      throw new Error(`PLY vertex has no ${coordinate} property`);
    }
  }

  return { format, vertexCount, properties, recordSize, dataOffset };
}

export async function readPlyHeader(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_LIMIT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parsePlyHeader(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function oracleSampleIndices(vertexCount) {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) {
    throw new Error('vertexCount must be a non-negative safe integer');
  }
  if (vertexCount === 0) return [];
  return [
    0,
    Math.floor(vertexCount / 8),
    Math.floor(vertexCount / 4),
    Math.floor(vertexCount / 2),
    Math.floor((3 * vertexCount) / 4),
    Math.floor((7 * vertexCount) / 8),
    vertexCount - 1,
  ].filter((index, position, indices) => position === 0 || index !== indices[position - 1]);
}

export function deterministicStrideIndices(vertexCount, limit = 10_000) {
  if (
    !Number.isSafeInteger(vertexCount) ||
    vertexCount < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error('vertexCount and limit must be valid non-negative/positive integers');
  }
  const count = Math.min(vertexCount, limit);
  if (count === 0) return [];
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.floor((index * (vertexCount - 1)) / (count - 1)),
  );
}

function decodeVertex(record, header, index) {
  const values = {};
  for (const property of header.properties) {
    values[property.name] = record[property.reader](property.offset);
  }
  const red = values.red ?? values.r ?? null;
  const green = values.green ?? values.g ?? null;
  const blue = values.blue ?? values.b ?? null;
  return {
    index,
    xyz: [values.x, values.y, values.z],
    rgb: red === null || green === null || blue === null ? null : [red, green, blue],
  };
}

export async function streamPlySamples(filePath, indices, suppliedHeader = null, options = {}) {
  const header = suppliedHeader ?? (await readPlyHeader(filePath));
  const ordered = [...new Set(indices)].sort((left, right) => left - right);
  if (
    ordered.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= header.vertexCount,
    )
  ) {
    throw new Error('PLY sample index is outside the vertex range');
  }
  if (ordered.length === 0) return [];

  const wanted = new Set(ordered);
  const samples = [];
  let pending = Buffer.alloc(0);
  let vertexIndex = 0;
  for await (const chunk of createReadStream(filePath, {
    start: header.dataOffset,
    signal: options.signal,
  })) {
    const bytes = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const completeBytes = bytes.length - (bytes.length % header.recordSize);
    for (let offset = 0; offset < completeBytes; offset += header.recordSize) {
      if (vertexIndex >= header.vertexCount) break;
      if (wanted.has(vertexIndex)) {
        samples.push(
          decodeVertex(bytes.subarray(offset, offset + header.recordSize), header, vertexIndex),
        );
      }
      vertexIndex += 1;
    }
    pending = bytes.subarray(completeBytes);
    if (vertexIndex >= header.vertexCount) break;
  }
  if (vertexIndex !== header.vertexCount) {
    throw new Error(`PLY ended after ${vertexIndex} of ${header.vertexCount} vertices`);
  }
  if (samples.length !== ordered.length)
    throw new Error('PLY did not contain every requested sample');
  return samples;
}

function buildKdTree(points, depth = 0) {
  if (points.length === 0) return null;
  const axis = depth % 3;
  points.sort((left, right) => left.xyz[axis] - right.xyz[axis] || left.id - right.id);
  const middle = Math.floor(points.length / 2);
  return {
    point: points[middle],
    axis,
    left: buildKdTree(points.slice(0, middle), depth + 1),
    right: buildKdTree(points.slice(middle + 1), depth + 1),
  };
}

function nearestDistanceSquared(node, target, best = Number.POSITIVE_INFINITY) {
  if (!node) return best;
  const dx = node.point.xyz[0] - target.xyz[0];
  const dy = node.point.xyz[1] - target.xyz[1];
  const dz = node.point.xyz[2] - target.xyz[2];
  if (node.point.id !== target.id) best = Math.min(best, dx * dx + dy * dy + dz * dz);
  const delta = target.xyz[node.axis] - node.point.xyz[node.axis];
  const first = delta <= 0 ? node.left : node.right;
  const second = delta <= 0 ? node.right : node.left;
  best = nearestDistanceSquared(first, target, best);
  if (delta * delta < best) best = nearestDistanceSquared(second, target, best);
  return best;
}

export function meanNearestNeighbourSpacing(samples) {
  if (samples.length < 2) return null;
  const points = samples.map((sample, id) => ({ id, xyz: sample.xyz }));
  const tree = buildKdTree([...points]);
  let total = 0;
  for (const point of points) total += Math.sqrt(nearestDistanceSquared(tree, point));
  return total / points.length;
}
