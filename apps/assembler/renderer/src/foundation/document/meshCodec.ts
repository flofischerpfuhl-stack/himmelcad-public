/**
 * Reference-mesh codec for the `.hcasm` format: gzip (via the standard
 * `CompressionStream`/`DecompressionStream` — available in both the
 * Chromium renderer and Node >= 18, so no compression dependency is added,
 * see `docs/DEPENDENCY-POLICY.md`) + base64, with an explicit decompressed
 * size limit so a corrupt or hostile "zip bomb" project file cannot exhaust
 * memory silently — {@link decompressMeshPayload} throws a clear,
 * catchable error instead of crashing.
 */

/** 50 MB decompressed, picked as "generous for a reference mesh, bounded for memory safety" per the deliverable. */
export const MAX_DECOMPRESSED_MESH_BYTES = 50 * 1024 * 1024;

export class MeshPayloadTooLargeError extends Error {
  constructor(public readonly decompressedBytes: number) {
    super(
      `This reference mesh is too large to open (${(decompressedBytes / (1024 * 1024)).toFixed(1)} MB decompressed; ` +
        `the limit is ${(MAX_DECOMPRESSED_MESH_BYTES / (1024 * 1024)).toFixed(0)} MB).`,
    );
    this.name = 'MeshPayloadTooLargeError';
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  // `Blob`'s `BlobPart` type wants an `ArrayBuffer`-backed view; `bytes` is
  // typed as the wider `ArrayBufferLike` (it may come from a `.slice()`/typed
  // array view chain), so copy into a fresh `ArrayBuffer`-backed array.
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompresses `bytes`, throwing {@link MeshPayloadTooLargeError} as soon as the output would exceed the limit (never buffers an unbounded amount first). */
async function gunzipBounded(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECOMPRESSED_MESH_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new MeshPayloadTooLargeError(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Packs positions/normals/indices into one buffer (lengths header + concatenated typed arrays), gzips it, and returns base64 text for the `.hcasm` file. */
export async function encodeMeshPayload(mesh: MeshBuffers): Promise<string> {
  const header = new Uint32Array([mesh.positions.length, mesh.normals.length, mesh.indices.length]);
  const total =
    header.byteLength +
    mesh.positions.byteLength +
    mesh.normals.byteLength +
    mesh.indices.byteLength;
  const buffer = new Uint8Array(total);
  let offset = 0;
  buffer.set(new Uint8Array(header.buffer), offset);
  offset += header.byteLength;
  buffer.set(
    new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
    offset,
  );
  offset += mesh.positions.byteLength;
  buffer.set(
    new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength),
    offset,
  );
  offset += mesh.normals.byteLength;
  buffer.set(
    new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
    offset,
  );
  const compressed = await gzip(buffer);
  return bytesToBase64(compressed);
}

/**
 * Inverse of {@link encodeMeshPayload}. Throws {@link MeshPayloadTooLargeError}
 * above {@link MAX_DECOMPRESSED_MESH_BYTES}, or a plain `Error` for malformed
 * payloads — both are meant to be caught and surfaced to the user (e.g. as
 * `loadError` in `projectStore.ts`), never left to crash the load.
 */
export async function decodeMeshPayload(base64: string): Promise<MeshBuffers> {
  const compressed = base64ToBytes(base64);
  const buffer = await gunzipBounded(compressed);
  if (buffer.byteLength < 12) throw new Error('Reference mesh data is corrupt (too short).');
  const header = new Uint32Array(buffer.buffer, buffer.byteOffset, 3);
  const [positionsLen, normalsLen, indicesLen] = header;
  let offset = 12;
  const expected = offset + positionsLen! * 4 + normalsLen! * 4 + indicesLen! * 4;
  if (expected !== buffer.byteLength) {
    throw new Error('Reference mesh data is corrupt (length mismatch).');
  }
  const positions = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset + offset, buffer.byteOffset + offset + positionsLen! * 4),
  );
  offset += positionsLen! * 4;
  const normals = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset + offset, buffer.byteOffset + offset + normalsLen! * 4),
  );
  offset += normalsLen! * 4;
  const indices = new Uint32Array(
    buffer.buffer.slice(buffer.byteOffset + offset, buffer.byteOffset + offset + indicesLen! * 4),
  );
  return { positions, normals, indices };
}
