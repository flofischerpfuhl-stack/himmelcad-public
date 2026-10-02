#!/usr/bin/env node
/**
 * Himmel:CAD Assembler app icons from the vector masters in
 * `branding/logos/source/himmelcad-assembler*.svg` (low-poly bolt in the
 * family's azure ramp, chosen by the owner 2026-10-02; `branding/README.md`,
 * `branding/logos/proposals/2026-10-02-assembler/`).
 *
 * Same conventions as the family's generated icons
 * (`scripts/generate-brand-assets.mjs`): the mark, trimmed and centred, on an
 * opaque black rounded-square card (radius 192/1024, mark in a 790/1024
 * box); the un-carded mark for in-product use. Sizes up to 32 px use the
 * `-small` master (the same bolt with three thread steps and a taller head).
 *
 * Pure Node (no image library, per `docs/DEPENDENCY-POLICY.md`; Inkscape
 * and ImageMagick are not needed): the masters are flat polygons, rendered
 * seam-free by supersampling (every polygon fills whole samples, painter's
 * order, then a box filter), encoded with hand-rolled PNG/ICO writers.
 *
 *   node scripts/generate-icon.mjs      writes build/icon.png, icon.ico, mark.png
 *
 * `apps/assembler-web` (manifest icons, favicons) and the desktop renderer's
 * favicon import `drawIcon`, `drawMark`, `encodePng`, `encodeIco` and the SVG helpers.
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'build');
export const MASTER_DIR = resolve(here, '../../../branding/logos/source');

/** Card colour and geometry of the family's app icons. */
export const CARD = { color: [0, 0, 0], radius: 192 / 1024, markBox: 790 / 1024 };

/** Sizes at or below this use the `-small` master. */
const SMALL_MAX = 32;

/** @typedef {{ color: [number, number, number], hex: string, pts: [number, number][] }} Polygon */

/** Parses a family master (`<polygon fill="#rrggbb" points="x y ..."/>` in a 256 viewBox). */
export function parseMaster(svg) {
  /** @type {Polygon[]} */
  const polys = [];
  for (const m of svg.matchAll(/<polygon\s+fill="#([0-9a-fA-F]{6})"\s+points="([^"]+)"\s*\/>/g)) {
    const n = m[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    const hex = `#${m[1].toUpperCase()}`;
    polys.push({ hex, color: [0, 2, 4].map((o) => parseInt(m[1].slice(o, o + 2), 16)), pts });
  }
  if (!polys.length) throw new Error('assembler icon master: no polygons');
  return polys;
}

const masters = new Map();
/** `variant`: '' (dark backgrounds), 'on-light'; `small`: the 16–32 px master. */
export function master({ small = false, onLight = false } = {}) {
  const name = `himmelcad-assembler${small ? '-small' : ''}${onLight ? '-on-light' : ''}.svg`;
  if (!masters.has(name))
    masters.set(name, parseMaster(readFileSync(join(MASTER_DIR, name), 'utf8')));
  return masters.get(name);
}

function bounds(polys) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys)
    for (const [x, y] of p.pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** A sample-resolution canvas: RGB + coverage per sample. */
function canvas(size, ss) {
  const n = size * ss;
  return { n, ss, size, rgb: new Uint8Array(n * n * 3), cov: new Uint8Array(n * n) };
}

/** Fills polygon `pts` (output pixel coordinates) into whole samples (even-odd, sample centres). */
function fill(c, pts, color) {
  const s = c.ss;
  const sp = pts.map(([x, y]) => [x * s, y * s]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of sp) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(c.n - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y += 1) {
    const sy = y + 0.5;
    const xs = [];
    for (let i = 0; i < sp.length; i += 1) {
      const [ax, ay] = sp[i];
      const [bx, by] = sp[(i + 1) % sp.length];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy))
        xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
      const xb = Math.min(c.n - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = xa; x <= xb; x += 1) {
        const k = y * c.n + x;
        c.rgb[k * 3] = color[0];
        c.rgb[k * 3 + 1] = color[1];
        c.rgb[k * 3 + 2] = color[2];
        c.cov[k] = 1;
      }
    }
  }
}

/** Fills a rounded square (whole canvas) of corner radius `r` (output pixels). */
function fillRoundedSquare(c, r, color) {
  const n = c.n;
  const rs = r * c.ss;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = px < rs ? rs - px : px > n - rs ? px - (n - rs) : 0;
      const dy = py < rs ? rs - py : py > n - rs ? py - (n - rs) : 0;
      if (dx * dx + dy * dy > rs * rs) continue;
      const k = y * n + x;
      c.rgb.set(color, k * 3);
      c.cov[k] = 1;
    }
  }
}

/** Box-filters the samples down to RGBA (straight alpha). */
function resolveCanvas(c) {
  const { size, ss, n } = c;
  const out = new Uint8Array(size * size * 4);
  const area = ss * ss;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = py * ss; y < (py + 1) * ss; y += 1) {
        for (let x = px * ss; x < (px + 1) * ss; x += 1) {
          const k = y * n + x;
          if (!c.cov[k]) continue;
          r += c.rgb[k * 3];
          g += c.rgb[k * 3 + 1];
          b += c.rgb[k * 3 + 2];
          a += 1;
        }
      }
      const o = (py * size + px) * 4;
      if (a) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((255 * a) / area);
      }
    }
  }
  return out;
}

const supersampling = (size) => (size >= 256 ? 4 : size >= 64 ? 8 : 16);

/** Draws `polys` scaled to fit a `box`-pixel square centred at (cx, cy). */
function drawPolys(c, polys, { cx, cy, box, maxRadius }) {
  const b = bounds(polys);
  let scale = box / Math.max(b.w, b.h);
  // maskable: every vertex of the mark stays inside the safe circle (a diagonal mark leaves
  // its bounding box's corners empty, so the box corners would be too strict)
  if (maxRadius) {
    const cx0 = (b.x0 + b.x1) / 2;
    const cy0 = (b.y0 + b.y1) / 2;
    let reach = 0;
    for (const p of polys)
      for (const [x, y] of p.pts) reach = Math.max(reach, Math.hypot(x - cx0, y - cy0));
    scale = Math.min(scale, maxRadius / reach);
  }
  const ox = cx - ((b.x0 + b.x1) / 2) * scale;
  const oy = cy - ((b.y0 + b.y1) / 2) * scale;
  for (const p of polys)
    fill(
      c,
      p.pts.map(([x, y]) => [ox + x * scale, oy + y * scale]),
      p.color,
    );
}

/**
 * The app icon: the mark on the black rounded card. `maskable`: a full-bleed
 * black square with the mark inside the central 80 % safe circle (web app
 * manifest `purpose: maskable`; the platform applies its own shape).
 */
export function drawIcon(
  size,
  { maskable = false, polys = master({ small: size <= SMALL_MAX }) } = {},
) {
  const c = canvas(size, supersampling(size));
  if (maskable) {
    fillRoundedSquare(c, 0, CARD.color);
    drawPolys(c, polys, { cx: size / 2, cy: size / 2, box: size * 0.72, maxRadius: size * 0.37 });
  } else {
    fillRoundedSquare(c, size * CARD.radius, CARD.color);
    drawPolys(c, polys, { cx: size / 2, cy: size / 2, box: size * CARD.markBox });
  }
  return resolveCanvas(c);
}

/** The mark alone on transparency, trimmed and centred (`onLight`: the variant for white backgrounds). */
export function drawMark(
  size,
  { onLight = false, polys = master({ small: size <= SMALL_MAX, onLight }) } = {},
) {
  const c = canvas(size, supersampling(size));
  drawPolys(c, polys, { cx: size / 2, cy: size / 2, box: size });
  return resolveCanvas(c);
}

/** The trimmed mark as SVG polygons in a square viewBox (`pad` in viewBox units). */
function markSvgBody(polys, { size = 256, pad = 0, classes = false } = {}) {
  const b = bounds(polys);
  const scale = (size - 2 * pad) / Math.max(b.w, b.h);
  const ox = size / 2 - ((b.x0 + b.x1) / 2) * scale;
  const oy = size / 2 - ((b.y0 + b.y1) / 2) * scale;
  const r = (v) => Math.round(v * 10) / 10;
  return polys
    .map(
      (p, i) =>
        `<polygon${classes ? ` class="p${i}"` : ''} fill="${p.hex}" points="${p.pts.map(([x, y]) => `${r(ox + x * scale)} ${r(oy + y * scale)}`).join(' ')}"/>`,
    )
    .join('');
}

/**
 * Favicon SVG: the un-carded small mark filling the square, with the
 * on-light colours under `prefers-color-scheme: light` (browsers apply the
 * media query inside SVG favicons), so it holds on light and dark tab strips.
 */
export function faviconSvg() {
  const dark = master({ small: true });
  const light = master({ small: true, onLight: true });
  if (dark.length !== light.length)
    throw new Error('assembler icon: small masters differ in polygon count');
  const rules = light
    .map((p, i) => (p.hex === dark[i].hex ? null : `.p${i}{fill:${p.hex}}`))
    .filter(Boolean)
    .join('');
  const body = markSvgBody(dark, { size: 256, pad: 4, classes: true });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><style>@media (prefers-color-scheme: light){${rules}}</style>${body}</svg>\n`;
}

/** The in-app mark (React/JSX-free): trimmed polygons in a 256 viewBox, for dark UI. */
export function markPolygons({ small = false } = {}) {
  const polys = master({ small });
  const b = bounds(polys);
  const scale = 256 / Math.max(b.w, b.h);
  const ox = 128 - ((b.x0 + b.x1) / 2) * scale;
  const oy = 128 - ((b.y0 + b.y1) / 2) * scale;
  const r = (v) => Math.round(v * 10) / 10;
  return polys.map((p) => ({
    fill: p.hex,
    points: p.pts.map(([x, y]) => `${r(ox + x * scale)} ${r(oy + y * scale)}`).join(' '),
  }));
}

function crc32(buf) {
  const table = crc32.table ?? (crc32.table = makeCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
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
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes an RGBA `Uint8Array` as an 8-bit truecolour-with-alpha PNG (no time chunks: deterministic). */
export function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // colour type: truecolour + alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A multi-size ICO of PNG entries (Windows Vista+ reads PNG-compressed entries). */
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dir.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

/** Windows/Electron sizes (shell: 16, 20, 24, 32, 40, 48, 64, 256). */
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

export const icoOf = (sizes, draw = drawIcon) =>
  encodeIco(sizes.map((size) => ({ size, png: encodePng(size, draw(size)) })));

/** The in-app mark's polygons (small master: the mark is shown at 16–24 px) as a TypeScript module. */
export function brandMarkModule() {
  const light = master({ small: true, onLight: true });
  const rows = markPolygons({ small: true }).map((p, i) => {
    const onLight = light[i].hex === p.fill ? '' : `, '${light[i].hex}'`;
    return `  ['${p.fill}', '${p.points}'${onLight}],`;
  });
  return `// Generated by apps/assembler/scripts/generate-icon.mjs from
// branding/logos/source/himmelcad-assembler-small{,-on-light}.svg (trimmed to a 256 viewBox).
// Do not edit. Entries: fill, points, fill on light themes (where it differs).
export const BRAND_MARK_POLYGONS: readonly (readonly [
  fill: string,
  points: string,
  onLight?: string,
])[] = [
${rows.join('\n')}
];
`;
}

export const BRAND_MARK_MODULE = join(
  here,
  '../renderer/src/interface/shell-ui/brandMarkPolygons.ts',
);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const icon = encodePng(1024, drawIcon(1024));
  await writeFile(join(OUT_DIR, 'icon.png'), icon);
  await writeFile(join(OUT_DIR, 'icon.ico'), icoOf(ICO_SIZES));
  await writeFile(join(OUT_DIR, 'mark.png'), encodePng(512, drawMark(512)));
  await writeFile(BRAND_MARK_MODULE, brandMarkModule());
  console.log(
    `[generate-icon] wrote build/icon.png (1024, ${icon.length} bytes), build/icon.ico (${ICO_SIZES.join(', ')}), build/mark.png (512), renderer brandMarkPolygons.ts`,
  );
}

// Run as a script (`pnpm icon`); apps/assembler-web and the desktop favicon import the helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
