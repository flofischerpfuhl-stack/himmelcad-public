import { deflateSync } from 'node:zlib';

export const MESH_TILE_COUNT = 512;
export const MESH_TRIANGLES_PER_TILE = 8_192;
export const LOGICAL_MESH_TRIANGLES = MESH_TILE_COUNT * MESH_TRIANGLES_PER_TILE;
export const SPLAT_TILE_COUNT = 200;
export const SPLATS_PER_TILE = 10_000;
export const LOGICAL_SPLATS = SPLAT_TILE_COUNT * SPLATS_PER_TILE;
export const TEXTURE_EDGE = 256;
export const TEXTURE_BYTES_PER_TILE = TEXTURE_EDGE * TEXTURE_EDGE * 4;

const encoder = new TextEncoder();
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const meshGeometry = gridGeometry();

export function createSyntheticMixed(bounds) {
  const meshTiles = Array.from({ length: MESH_TILE_COUNT }, (_, index) => meshTile(index, bounds));
  const splatTiles = Array.from({ length: SPLAT_TILE_COUNT }, (_, index) =>
    splatTile(index, bounds),
  );
  const meshManifest = encodeJson({
    schemaVersion: 1,
    roots: meshTiles.map((tile) => tile.id),
    tiles: meshTiles,
  });
  const splatManifest = encodeJson({
    schemaVersion: 1,
    roots: splatTiles.map((tile) => tile.id),
    tiles: splatTiles,
  });
  return {
    meshManifest,
    splatManifest,
    meshPayload(index) {
      assertIndex(index, MESH_TILE_COUNT, 'mesh');
      return texturedGridGlb(index);
    },
    splatPayload(index) {
      assertIndex(index, SPLAT_TILE_COUNT, 'splat');
      return gaussianPly(index, bounds);
    },
  };
}

function meshTile(index, bounds) {
  const columns = 32;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const width = (bounds.max[0] - bounds.min[0]) / columns;
  const height = (bounds.max[1] - bounds.min[1]) / 16;
  const x = bounds.min[0] + column * width;
  const y = bounds.min[1] + row * height;
  const z = bounds.min[2] + 8;
  return {
    id: `m${index.toString(36).padStart(2, '0')}`,
    parent: null,
    children: [],
    bounds: {
      kind: 'axisAlignedBox',
      bounds: {
        min: { x, y, z: z - 4 },
        max: { x: x + width, y: y + height, z: z + 12 },
      },
    },
    contentTransform: translation(x, y, z),
    geometricError: 0,
    refinement: 'replace',
    contents: [
      {
        kind: 'gltf',
        uri: `${index}.glb`,
        byteOffset: null,
        byteLength: null,
        primitiveCount: MESH_TRIANGLES_PER_TILE,
        contentHash: null,
        decoderParameters: null,
      },
    ],
    childPage: null,
    providerMetadata: { scaleFixture: 'texturedDgm', tileIndex: index },
  };
}

function splatTile(index, bounds) {
  const columns = 20;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const width = (bounds.max[0] - bounds.min[0]) / columns;
  const height = (bounds.max[1] - bounds.min[1]) / 10;
  const x = bounds.min[0] + column * width;
  const y = bounds.min[1] + row * height;
  const z = bounds.min[2] + 24;
  return {
    id: `s${index.toString(36).padStart(2, '0')}`,
    parent: null,
    children: [],
    bounds: {
      kind: 'axisAlignedBox',
      bounds: {
        min: { x, y, z: z - 2 },
        max: { x: x + width, y: y + height, z: z + 6 },
      },
    },
    contentTransform: identity,
    geometricError: 0,
    refinement: 'replace',
    contents: [
      {
        kind: 'gaussianSplats',
        uri: `${index}.ply`,
        byteOffset: null,
        byteLength: null,
        primitiveCount: SPLATS_PER_TILE,
        contentHash: null,
        decoderParameters: null,
      },
    ],
    childPage: null,
    providerMetadata: { scaleFixture: 'gaussianSplats', tileIndex: index },
  };
}

function gridGeometry() {
  const columns = 64;
  const rows = 64;
  const vertexCount = (columns + 1) * (rows + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const textureCoordinates = new Float32Array(vertexCount * 2);
  let vertex = 0;
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const v = row / rows;
      positions.set([u * 156.25, v * 390.625, Math.sin(u * 12) * Math.cos(v * 9) * 3], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      textureCoordinates.set([u, v], vertex * 2);
      vertex += 1;
    }
  }
  const indices = new Uint32Array(columns * rows * 6);
  let target = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const lower = row * (columns + 1) + column;
      const upper = lower + columns + 1;
      indices.set([lower, lower + 1, upper + 1, lower, upper + 1, upper], target);
      target += 6;
    }
  }
  return { positions, normals, textureCoordinates, indices };
}

function texturedGridGlb(tileIndex) {
  const png = texturePng(tileIndex);
  const chunks = [
    bytes(meshGeometry.positions),
    bytes(meshGeometry.normals),
    bytes(meshGeometry.textureCoordinates),
    bytes(meshGeometry.indices),
    png,
  ];
  const offsets = [];
  let binaryLength = 0;
  for (const chunk of chunks) {
    binaryLength = align4(binaryLength);
    offsets.push(binaryLength);
    binaryLength += chunk.byteLength;
  }
  binaryLength = align4(binaryLength);
  const binary = new Uint8Array(binaryLength);
  chunks.forEach((chunk, index) => binary.set(chunk, offsets[index]));
  const document = {
    asset: { version: '2.0', generator: 'HimmelCAD mixed scale gate' },
    extensionsUsed: [],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: chunks[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: chunks[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: chunks[2].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: chunks[3].byteLength, target: 34963 },
      { buffer: 0, byteOffset: offsets[4], byteLength: chunks[4].byteLength },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: meshGeometry.positions.length / 3,
        type: 'VEC3',
        min: [0, 0, -3],
        max: [156.25, 390.625, 3],
      },
      { bufferView: 1, componentType: 5126, count: meshGeometry.normals.length / 3, type: 'VEC3' },
      {
        bufferView: 2,
        componentType: 5126,
        count: meshGeometry.textureCoordinates.length / 2,
        type: 'VEC2',
      },
      { bufferView: 3, componentType: 5125, count: meshGeometry.indices.length, type: 'SCALAR' },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 4, mimeType: 'image/png' }],
    textures: [{ sampler: 0, source: 0 }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0, texCoord: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return glb(document, binary);
}

function gaussianPly(tileIndex, bounds) {
  const columns = 20;
  const tileColumn = tileIndex % columns;
  const tileRow = Math.floor(tileIndex / columns);
  const width = (bounds.max[0] - bounds.min[0]) / columns;
  const height = (bounds.max[1] - bounds.min[1]) / 10;
  const originX = bounds.min[0] + tileColumn * width;
  const originY = bounds.min[1] + tileRow * height;
  const originZ = bounds.min[2] + 24;
  const header = `ply\nformat ascii 1.0\nelement vertex ${SPLATS_PER_TILE}\nproperty double x\nproperty double y\nproperty double z\nproperty float scale_x\nproperty float scale_y\nproperty float scale_z\nproperty float qx\nproperty float qy\nproperty float qz\nproperty float qw\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n`;
  const rows = new Array(SPLATS_PER_TILE);
  for (let index = 0; index < SPLATS_PER_TILE; index += 1) {
    const u = (index % 100) / 99;
    const v = Math.floor(index / 100) / 99;
    const z = originZ + Math.sin((u + tileIndex) * 7) * Math.cos(v * 11) * 2;
    rows[index] =
      `${originX + u * width} ${originY + v * height} ${z} 0.45 0.35 0.25 0 0 0 1 ${40 + (tileIndex % 180)} ${80 + (index % 160)} 255 150\n`;
  }
  return encoder.encode(header + rows.join(''));
}

function texturePng(tileIndex) {
  const stride = 1 + TEXTURE_EDGE * 4;
  const raw = new Uint8Array(stride * TEXTURE_EDGE);
  for (let y = 0; y < TEXTURE_EDGE; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < TEXTURE_EDGE; x += 1) {
      const offset = row + 1 + x * 4;
      raw[offset] = (x + tileIndex * 17) & 0xff;
      raw[offset + 1] = (y * 2 + tileIndex * 29) & 0xff;
      raw[offset + 2] = (x ^ y ^ tileIndex) & 0xff;
      raw[offset + 3] = 255;
    }
  }
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, TEXTURE_EDGE, false);
  header.setUint32(4, TEXTURE_EDGE, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

function pngChunk(type, data) {
  const typeBytes = encoder.encode(type);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength, false);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(concat([typeBytes, data])), false);
  return output;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function glb(document, binary) {
  const json = encoder.encode(JSON.stringify(document));
  const jsonLength = align4(json.byteLength);
  const binaryLength = align4(binary.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binaryLength;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  output.set(encoder.encode('glTF'), 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

function translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function encodeJson(value) {
  return encoder.encode(JSON.stringify(value));
}

function bytes(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function align4(value) {
  return (value + 3) & ~3;
}

function concat(parts) {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function assertIndex(index, count, label) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`unknown synthetic ${label} tile ${String(index)}`);
  }
}
