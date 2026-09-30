/**
 * Minimal store-only (uncompressed, method 0) ZIP writer, used to build 3MF
 * packages without pulling in `jszip` (not in the workspace lockfile — see
 * `docs/DEPENDENCY-POLICY.md`). Produces a plain, spec-valid ZIP: local file
 * headers, no data descriptors, a central directory and an
 * end-of-central-directory record. Good enough for the small, few-entry 3MF
 * packages this app writes (a model XML, content types and relationships);
 * not a general-purpose ZIP library (no compression, no ZIP64, no streaming).
 */

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (ZIP/PNG polynomial) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  /** Forward-slash relative path inside the archive, e.g. `"3D/3dmodel.model"`. */
  path: string;
  data: Uint8Array;
}

interface WrittenEntry {
  path: string;
  data: Uint8Array;
  crc: number;
  localHeaderOffset: number;
}

const textEncoder = new TextEncoder();

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Builds a valid ZIP archive (store method only) from `entries`, in order.
 * Paths are written as UTF-8 with the UTF-8 filename flag set, DOS
 * date/time fixed to a deterministic epoch (2000-01-01) so exports are
 * byte-reproducible given identical content.
 */
export function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const written: WrittenEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1; // 2000-01-01

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.path);
    const crc = crc32(entry.data);
    const localHeader = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // general purpose flag: UTF-8 names
      u16(0), // method: store
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
    ]);
    written.push({ path: entry.path, data: entry.data, crc, localHeaderOffset: offset });
    chunks.push(localHeader, entry.data);
    offset += localHeader.length + entry.data.length;
  }

  const centralStart = offset;
  for (const entry of written) {
    const nameBytes = textEncoder.encode(entry.path);
    const central = concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800),
      u16(0),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(entry.crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0), // disk number
      u16(0), // internal attributes
      u32(0), // external attributes
      u32(entry.localHeaderOffset),
      nameBytes,
    ]);
    chunks.push(central);
    offset += central.length;
  }
  const centralSize = offset - centralStart;

  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(written.length),
    u16(written.length),
    u32(centralSize),
    u32(centralStart),
    u16(0), // comment length
  ]);
  chunks.push(eocd);

  return concat(chunks);
}
