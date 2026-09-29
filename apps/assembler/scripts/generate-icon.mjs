#!/usr/bin/env node
/**
 * Generates a placeholder app icon for Himmel:CAD Assembler.
 *
 * DOCUMENTED PLACEHOLDER — no Assembler-specific vector mark exists yet in
 * `branding/` (only generic/other-product masters, and any change to a
 * vector master needs explicit product-owner approval per
 * `branding/README.md`). This script instead draws a simple, clean,
 * procedural mark reusing the app's own in-app brand identity: the dark
 * `--hc-bg-void` background (`#101114`) and accent blue
 * (`--hc-accent-base`, `#1597f2`) from `@himmelcad/theme`, with an isometric
 * box/cube silhouette — the same "Box" glyph already used as the brand mark
 * next to the wordmark in `chrome/TopBar.tsx` — rather than inventing new
 * brand geometry. Replace `build/icon.png`/`build/icon.ico` with an
 * owner-approved mark when one exists; until then this keeps the installer
 * buildable with a coherent, on-brand icon instead of Electron's default.
 *
 * Pure Node (no image-library dependency, per `docs/DEPENDENCY-POLICY.md`):
 * hand-rolled PNG/ICO encoders using only `zlib` for DEFLATE. The mark is
 * drawn as a handful of flat-shaded convex polygons, so it rasterizes
 * cleanly at any requested size (no upscaling artefacts).
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'build');

const BG = [0x10, 0x11, 0x14]; // --hc-bg-void
const TOP_FACE = [0x53, 0xb8, 0xff]; // lightest facet
const LEFT_FACE = [0x15, 0x97, 0xf2]; // --hc-accent-base
const RIGHT_FACE = [0x0d, 0x6c, 0xb3]; // darkest facet

/** @typedef {readonly [number, number]} Point */

/** Even-odd scanline fill of a convex polygon into an RGBA buffer. */
function fillPolygon(buffer, size, points, color) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(size - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y += 1) {
    const scanY = y + 0.5;
    const xs = [];
    for (let i = 0; i < points.length; i += 1) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % points.length];
      if ((ay <= scanY && by > scanY) || (by <= scanY && ay > scanY)) {
        const t = (scanY - ay) / (by - ay);
        xs.push(ax + t * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.round(xs[i]));
      const x1 = Math.min(size - 1, Math.round(xs[i + 1]));
      for (let x = x0; x <= x1; x += 1) {
        const idx = (y * size + x) * 4;
        buffer[idx] = color[0];
        buffer[idx + 1] = color[1];
        buffer[idx + 2] = color[2];
        buffer[idx + 3] = 255;
      }
    }
  }
}

function fillRoundedSquare(buffer, size, radius, color) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x < radius ? radius - x : x > size - radius ? x - (size - radius) : 0;
      const dy = y < radius ? radius - y : y > size - radius ? y - (size - radius) : 0;
      if (dx * dx + dy * dy > radius * radius) continue;
      const idx = (y * size + x) * 4;
      buffer[idx] = color[0];
      buffer[idx + 1] = color[1];
      buffer[idx + 2] = color[2];
      buffer[idx + 3] = 255;
    }
  }
}

/** Draws the isometric box mark centred in a `size`x`size` RGBA buffer. */
function drawIcon(size) {
  const buffer = new Uint8Array(size * size * 4);
  fillRoundedSquare(buffer, size, size * 0.22, BG);

  const cx = size * 0.5;
  const cy = size * 0.53;
  const w = size * 0.34; // half-width of the cube's footprint
  const hTop = size * 0.18; // top-face rhombus half-height
  const hSide = size * 0.24; // side-face height

  /** @type {Point} */ const top = [cx, cy - hSide];
  /** @type {Point} */ const left = [cx - w, cy - hSide + hTop];
  /** @type {Point} */ const right = [cx + w, cy - hSide + hTop];
  /** @type {Point} */ const bottom = [cx, cy - hSide + hTop * 2];
  /** @type {Point} */ const bottomLeft = [cx - w, cy - hSide + hTop + hSide];
  /** @type {Point} */ const bottomRight = [cx + w, cy - hSide + hTop + hSide];
  /** @type {Point} */ const bottomCenter = [cx, cy - hSide + hTop * 2 + hSide];

  fillPolygon(buffer, size, [top, right, bottom, left], TOP_FACE);
  fillPolygon(buffer, size, [left, bottom, bottomCenter, bottomLeft], LEFT_FACE);
  fillPolygon(buffer, size, [right, bottomRight, bottomCenter, bottom], RIGHT_FACE);

  return buffer;
}

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = makeCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes an RGBA `Uint8Array` as a minimal 8-bit truecolour-with-alpha PNG. */
function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // colour type: truecolour + alpha
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = chunk('IDAT', deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** Wraps a set of PNGs (Windows Vista+ ICO format allows PNG-compressed entries directly). */
function encodeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const images = [];
  let offset = 6 + count * 16;
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    images.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...images]);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const masterSize = 1024;
  const masterPng = encodePng(masterSize, drawIcon(masterSize));
  await writeFile(join(OUT_DIR, 'icon.png'), masterPng);

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoEntries = icoSizes.map((size) => ({ size, png: encodePng(size, drawIcon(size)) }));
  await writeFile(join(OUT_DIR, 'icon.ico'), encodeIco(icoEntries));

  console.log(`[generate-icon] wrote ${join(OUT_DIR, 'icon.png')} (${masterPng.length} bytes)`);
  console.log(`[generate-icon] wrote ${join(OUT_DIR, 'icon.ico')} (sizes: ${icoSizes.join(', ')})`);
}

await main();
