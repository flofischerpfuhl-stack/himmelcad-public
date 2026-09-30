/**
 * Minimal ZIP reader (APPNOTE.TXT 6.3.x: end of central directory, central
 * directory, local file headers) for 3MF packages. Methods: stored (0) and
 * deflate (8, through the platform's `DecompressionStream('deflate-raw')` —
 * Chromium/Electron and Node ≥ 18, so no inflate library is added).
 * ZIP64 and encrypted entries are refused with a clear message.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Entries of a ZIP archive, by name (names as stored, `/`-separated, no leading slash). */
export function listZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || view.getUint32(0, true) !== LOCAL) {
    throw new ZipError('Not a ZIP package');
  }
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('ZIP package is truncated (no central directory)');
  const count = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) {
    throw new ZipError('ZIP64 packages are not supported');
  }
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder('utf-8');
  let p = dirOffset;
  for (let k = 0; k < count; k += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) {
      throw new ZipError('ZIP central directory is damaged');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)).replace(/^\/+/, '');
    if (flags & 1) throw new ZipError(`"${name}" is encrypted`);
    entries.set(name, { name, method, compressedSize, size, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Stream = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Stream) throw new ZipError('This runtime cannot decompress ZIP data');
  const stream = new Blob([data.slice()]).stream().pipeThrough(new Stream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes of one entry (decompressed). */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LOCAL)
    throw new ZipError(`"${entry.name}" is damaged`);
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipError(`"${entry.name}" is truncated`);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const out = await inflateRaw(data);
    if (out.length !== entry.size)
      throw new ZipError(`"${entry.name}" did not decompress to its size`);
    return out;
  }
  throw new ZipError(`"${entry.name}" uses an unsupported compression method (${entry.method})`);
}
