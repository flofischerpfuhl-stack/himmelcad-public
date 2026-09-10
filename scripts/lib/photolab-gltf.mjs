import path from 'node:path';
import { readFile } from 'node:fs/promises';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BINARY_CHUNK = 0x004e4942;
const FLOAT_COMPONENT_TYPE = 5126;
const VEC3_BYTE_LENGTH = 3 * Float32Array.BYTES_PER_ELEMENT;

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(left, right) {
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
      }
    }
  }
  return result;
}

function finiteVector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new Error(`${label} must contain ${length} finite numbers`);
  }
  return value;
}

function nodeMatrix(node) {
  if (node.matrix !== undefined) {
    return [...finiteVector(node.matrix, 16, 'glTF node matrix')];
  }
  const [x, y, z, w] = finiteVector(node.rotation ?? [0, 0, 0, 1], 4, 'glTF node rotation');
  const [sx, sy, sz] = finiteVector(node.scale ?? [1, 1, 1], 3, 'glTF node scale');
  const [tx, ty, tz] = finiteVector(node.translation ?? [0, 0, 0], 3, 'glTF node translation');
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const transformed = [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
  const transformedW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (transformedW === 0) throw new Error('glTF transform maps a POSITION to w = 0');
  return transformedW === 1 ? transformed : transformed.map((value) => value / transformedW);
}

function parseGlb(bytes) {
  if (bytes.length < 12 || bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (version !== 2) throw new Error(`Unsupported GLB version: ${version}`);
  if (declaredLength !== bytes.length)
    throw new Error('GLB declared length does not match file size');
  let json = null;
  let binary = null;
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length) throw new Error('Truncated GLB chunk header');
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) throw new Error('Truncated GLB chunk payload');
    const chunk = bytes.subarray(offset + 8, end);
    if (type === GLB_JSON_CHUNK && json === null) {
      json = JSON.parse(chunk.toString('utf8').replace(/[\u0000 ]+$/u, ''));
    } else if (type === GLB_BINARY_CHUNK && binary === null) {
      binary = chunk;
    }
    offset = end;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, binary };
}

async function readDocument(filePath) {
  const bytes = await readFile(filePath);
  const glb = parseGlb(bytes);
  if (glb) return glb;
  return { json: JSON.parse(bytes.toString('utf8')), binary: null };
}

function positionPrimitive(document) {
  for (let meshIndex = 0; meshIndex < (document.meshes?.length ?? 0); meshIndex += 1) {
    const primitives = document.meshes[meshIndex]?.primitives ?? [];
    for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
      const accessorIndex = primitives[primitiveIndex]?.attributes?.POSITION;
      if (Number.isSafeInteger(accessorIndex)) return { meshIndex, primitiveIndex, accessorIndex };
    }
  }
  throw new Error('glTF has no mesh primitive with a POSITION accessor');
}

function nodeWorldMatrix(document, meshIndex) {
  const nodes = document.nodes ?? [];
  if (nodes.length === 0) throw new Error('glTF mesh has no node instance');
  const sceneIndex = document.scene ?? 0;
  const roots = document.scenes?.[sceneIndex]?.nodes ?? nodes.map((_, index) => index);
  let match = null;
  function visit(nodeIndex, parentMatrix, ancestry) {
    if (ancestry.has(nodeIndex)) throw new Error('glTF node graph contains a cycle');
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`glTF references missing node ${nodeIndex}`);
    const world = multiplyMatrices(parentMatrix, nodeMatrix(node));
    if (node.mesh === meshIndex && match === null) match = { nodeIndex, matrix: world };
    const nextAncestry = new Set(ancestry).add(nodeIndex);
    for (const child of node.children ?? []) visit(child, world, nextAncestry);
  }
  for (const root of roots) visit(root, identityMatrix(), new Set());
  if (!match) throw new Error('glTF POSITION mesh is not instantiated in the active scene');
  return match;
}

async function accessorBuffer(filePath, document, glbBinary, accessor) {
  const bufferView = document.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error('glTF POSITION accessor references a missing bufferView');
  const buffer = document.buffers?.[bufferView.buffer];
  if (!buffer) throw new Error('glTF POSITION bufferView references a missing buffer');
  let bytes;
  if (buffer.uri === undefined) {
    if (!glbBinary) throw new Error('glTF buffer without a URI requires a GLB binary chunk');
    bytes = glbBinary;
  } else {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(buffer.uri)) {
      throw new Error('Only relative external glTF buffers are supported');
    }
    const directory = path.dirname(path.resolve(filePath));
    const externalPath = path.resolve(directory, decodeURIComponent(buffer.uri));
    if (externalPath !== directory && !externalPath.startsWith(`${directory}${path.sep}`)) {
      throw new Error('glTF buffer URI escapes the tile directory');
    }
    bytes = await readFile(externalPath);
  }
  if (bytes.length < buffer.byteLength) throw new Error('glTF buffer is shorter than byteLength');
  return { bytes, bufferView };
}

export async function readGltfPositionSamples(filePath, options = {}) {
  const { json: document, binary } = await readDocument(filePath);
  const primitive = positionPrimitive(document);
  const accessor = document.accessors?.[primitive.accessorIndex];
  if (!accessor) throw new Error('glTF POSITION accessor is missing');
  if (accessor.componentType !== FLOAT_COMPONENT_TYPE || accessor.type !== 'VEC3') {
    throw new Error('glTF POSITION accessor must use componentType FLOAT and type VEC3');
  }
  if (accessor.sparse) throw new Error('Sparse glTF POSITION accessors are not supported');
  if (!Number.isSafeInteger(accessor.count) || accessor.count < 1) {
    throw new Error('glTF POSITION accessor count must be a positive safe integer');
  }
  const { bytes, bufferView } = await accessorBuffer(filePath, document, binary, accessor);
  const stride = bufferView.byteStride ?? VEC3_BYTE_LENGTH;
  if (!Number.isSafeInteger(stride) || stride < VEC3_BYTE_LENGTH) {
    throw new Error('glTF POSITION bufferView has an invalid byteStride');
  }
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const lastByte = start + (accessor.count - 1) * stride + VEC3_BYTE_LENGTH;
  const viewEnd = (bufferView.byteOffset ?? 0) + bufferView.byteLength;
  if (lastByte > bytes.length || lastByte > viewEnd) {
    throw new Error('glTF POSITION accessor exceeds its bufferView');
  }

  const node = nodeWorldMatrix(document, primitive.meshIndex);
  const tileMatrix = options.tileTransform ?? identityMatrix();
  finiteVector(tileMatrix, 16, 'Tile transform');
  const combined = multiplyMatrices(tileMatrix, node.matrix);
  const indices = [0, Math.floor(accessor.count / 2), accessor.count - 1].filter(
    (index, position, values) => position === 0 || index !== values[position - 1],
  );
  const samples = indices.map((index) => {
    const offset = start + index * stride;
    const local = [
      bytes.readFloatLE(offset),
      bytes.readFloatLE(offset + 4),
      bytes.readFloatLE(offset + 8),
    ];
    return { index, local_xyz: local, xyz: transformPoint(combined, local) };
  });
  return {
    vertex_count: accessor.count,
    samples,
    transform: {
      order: 'kernel tile contentTransform × glTF node world transform',
      tile: [...tileMatrix],
      node_index: node.nodeIndex,
      node: node.matrix,
      combined,
    },
  };
}
