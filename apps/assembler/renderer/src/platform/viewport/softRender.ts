/**
 * A small software rasterizer for `view.render` / `view.inspect` (assembler/
 * AGENT-API.md "View renders"): draws evaluated bodies into RGBA pixels
 * without WebGL, so a render works in the headless CLI, in tests and in the
 * app without touching the user's viewport. It reads the same camera math as
 * the viewport (`camera.ts`) and the same section clip (`section.ts`), so a
 * named view frames and cuts the model the way the app does.
 *
 * Look: shaded bodies (two lights), dark outlines where the visible B-rep
 * face changes (image-space, so silhouettes of curved faces are drawn too),
 * section cut surfaces in a darker shade, an axis triad in the lower left
 * corner (X red, Y green, Z blue). Pure and deterministic: equal input, equal
 * bytes.
 */
import type { BodyMesh } from '../../foundation/geometry-kernel/types.js';
import {
  cameraBasis,
  depthRange,
  eyeOf,
  isOrthographic,
  viewDirection,
  viewProjectionMatrix,
  type Bounds,
  type CameraPose,
} from './camera.js';
import type { Vec3 } from './math.js';

export type Rgb = readonly [number, number, number];
export type SoftRenderMode = 'shaded' | 'shadedEdges' | 'wireframe' | 'xray';
export type SoftBackground = 'light' | 'dark' | 'transparent';

export interface SoftRenderBody {
  id: string;
  /** sRGB hex (`#rrggbb`). */
  color: string;
  mesh: BodyMesh;
  edges: readonly { segments: Float32Array }[];
  /** Whole-body tint (highlight), mixed into the body colour. */
  tint?: { color: Rgb; amount: number } | null;
  /** Per-face tint by face index (findings, highlighted faces). */
  faceTints?: ReadonlyMap<number, { color: Rgb; amount: number }>;
  /** Edge indices drawn on top in the accent colour. */
  accentEdges?: readonly number[];
}

export interface SoftRenderOptions {
  width: number;
  height: number;
  pose: CameraPose;
  bodies: readonly SoftRenderBody[];
  mode: SoftRenderMode;
  background: SoftBackground;
  /** Material with `dot(p, normal) > offset` is cut away (`section.ts` `sectionClip`). */
  clip?: { normal: Vec3; offset: number } | null;
  /** Samples per pixel side (1–3); default: 2 up to one megapixel, else 1. */
  supersample?: number;
  /** Axis triad in the lower left corner; default `true`. */
  axes?: boolean;
}

/** The theme accent (`--hc-accent-base` #1597f2): highlights. */
export const ACCENT: Rgb = [0.082, 0.592, 0.949];
const BACKGROUNDS: Record<SoftBackground, readonly [number, number, number, number]> = {
  light: [244, 245, 247, 255],
  dark: [32, 34, 38, 255],
  transparent: [0, 0, 0, 0],
};
const OUTLINE: Rgb = [0.09, 0.1, 0.11];
const AXIS_COLORS: readonly Rgb[] = [
  [0.86, 0.2, 0.18],
  [0.2, 0.62, 0.25],
  [0.18, 0.4, 0.9],
];

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!m) return [0.62, 0.66, 0.72];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Union bounds of the bodies' meshes, or `null` without geometry. */
export function meshBounds(bodies: readonly { mesh: BodyMesh }[]): Bounds | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const body of bodies) {
    const p = body.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const v = p[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

interface Vertex {
  p: Vec3;
  n: Vec3;
}

/** Renders the bodies; returns straight-alpha RGBA pixels, top row first. */
export function softRender(options: SoftRenderOptions): Uint8Array {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const ss = Math.max(
    1,
    Math.min(3, Math.floor(options.supersample ?? (width * height <= 1_100_000 ? 2 : 1))),
  );
  const W = width * ss;
  const H = height * ss;
  const pose = options.pose;
  const bounds = meshBounds(options.bodies);
  const viewProj = viewProjectionMatrix(pose, W / H, depthRange(pose, bounds, null));
  const basis = cameraBasis(pose);
  const back = viewDirection(pose);
  const eye = eyeOf(pose);
  const ortho = isOrthographic(pose);
  const light = normalize([
    back[0] + basis.up[0] * 0.7 - basis.right[0] * 0.45,
    back[1] + basis.up[1] * 0.7 - basis.right[1] * 0.45,
    back[2] + basis.up[2] * 0.7 - basis.right[2] * 0.45,
  ]);

  const color = new Float32Array(W * H * 4);
  const depth = new Float32Array(W * H).fill(Infinity);
  const ids = new Int32Array(W * H);
  const bg = BACKGROUNDS[options.background];
  for (let i = 0; i < W * H; i += 1) {
    color[i * 4] = bg[0] / 255;
    color[i * 4 + 1] = bg[1] / 255;
    color[i * 4 + 2] = bg[2] / 255;
    color[i * 4 + 3] = bg[3] / 255;
  }

  const project = (p: Vec3): [number, number, number] | null => {
    const x = viewProj[0]! * p[0] + viewProj[4]! * p[1] + viewProj[8]! * p[2] + viewProj[12]!;
    const y = viewProj[1]! * p[0] + viewProj[5]! * p[1] + viewProj[9]! * p[2] + viewProj[13]!;
    const z = viewProj[2]! * p[0] + viewProj[6]! * p[1] + viewProj[10]! * p[2] + viewProj[14]!;
    const w = viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
    if (w <= 1e-9) return null;
    return [((x / w) * 0.5 + 0.5) * W, (1 - ((y / w) * 0.5 + 0.5)) * H, z / w];
  };
  const clip = options.clip ?? null;
  const cut = (p: Vec3): number =>
    clip ? p[0] * clip.normal[0] + p[1] * clip.normal[1] + p[2] * clip.normal[2] - clip.offset : -1;

  const xray = options.mode === 'xray';
  const fillSurfaces = options.mode !== 'wireframe';
  options.bodies.forEach((body, bodyIndex) => {
    if (!fillSurfaces) return;
    const base = hexToRgb(body.color);
    const mesh = body.mesh;
    const triangles = mesh.indices.length / 3;
    for (let t = 0; t < triangles; t += 1) {
      const face = mesh.triangleFaces[t] ?? 0;
      let rgb: Rgb = base;
      if (body.tint) rgb = mix(rgb, body.tint.color, body.tint.amount);
      const faceTint = body.faceTints?.get(face);
      if (faceTint) rgb = mix(rgb, faceTint.color, faceTint.amount);
      const verts: Vertex[] = [];
      for (let k = 0; k < 3; k += 1) {
        const v = mesh.indices[t * 3 + k]!;
        verts.push({
          p: [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!],
          n: [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!],
        });
      }
      const polygon = clip ? clipPolygon(verts, cut) : verts;
      for (let k = 1; k + 1 < polygon.length; k += 1) {
        rasterTriangle(
          polygon[0]!,
          polygon[k]!,
          polygon[k + 1]!,
          rgb,
          (bodyIndex + 1) * 65536 + face,
        );
      }
    }
  });

  function shade(v: Vertex, rgb: Rgb): [number, number, number, boolean] {
    const toEye = ortho ? back : normalize([eye[0] - v.p[0], eye[1] - v.p[1], eye[2] - v.p[2]]);
    const facing = dot(v.n, toEye);
    const n: Vec3 = facing < 0 ? [-v.n[0], -v.n[1], -v.n[2]] : v.n;
    const k = 0.34 + 0.56 * Math.max(0, dot(n, light)) + 0.14 * Math.max(0, dot(n, toEye));
    const f = facing < 0 ? 0.48 : 1;
    return [rgb[0] * k * f, rgb[1] * k * f, rgb[2] * k * f, facing < 0];
  }

  function rasterTriangle(a: Vertex, b: Vertex, c: Vertex, rgb: Rgb, id: number): void {
    const pa = project(a.p);
    const pb = project(b.p);
    const pc = project(c.p);
    if (!pa || !pb || !pc) return;
    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
    if (Math.abs(area) < 1e-12) return;
    const ca = shade(a, rgb);
    const cb = shade(b, rgb);
    const cc = shade(c, rgb);
    const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
    const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
        const w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
        const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
        const i = y * W + x;
        const r = w0 * ca[0] + w1 * cb[0] + w2 * cc[0];
        const g = w0 * ca[1] + w1 * cb[1] + w2 * cc[1];
        const bl = w0 * ca[2] + w1 * cb[2] + w2 * cc[2];
        if (xray) {
          // Translucent surfaces, order-independent enough for one colour per body.
          const alpha = 0.2;
          color[i * 4] = color[i * 4]! * (1 - alpha) + r * alpha;
          color[i * 4 + 1] = color[i * 4 + 1]! * (1 - alpha) + g * alpha;
          color[i * 4 + 2] = color[i * 4 + 2]! * (1 - alpha) + bl * alpha;
          color[i * 4 + 3] = Math.max(color[i * 4 + 3]!, 0.55);
          if (z < depth[i]!) {
            depth[i] = z;
            ids[i] = id;
          }
          continue;
        }
        // Near ties keep what was drawn first: coplanar faces of two bodies do not flicker.
        if (z >= depth[i]! - 1e-6) continue;
        depth[i] = z;
        ids[i] = id;
        color[i * 4] = r;
        color[i * 4 + 1] = g;
        color[i * 4 + 2] = bl;
        color[i * 4 + 3] = 1;
      }
    }
  }

  // Outlines where the visible face changes (B-rep edges, silhouettes).
  if (options.mode === 'shadedEdges' || xray) {
    const outline = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const id = ids[i]!;
        // Both sides of a change are marked: two samples, one output pixel at 2× supersampling.
        if (
          (x + 1 < W && ids[i + 1] !== id) ||
          (x > 0 && ids[i - 1] !== id) ||
          (y + 1 < H && ids[i + W] !== id) ||
          (y > 0 && ids[i - W] !== id)
        ) {
          outline[i] = 1;
        }
      }
    }
    for (let i = 0; i < W * H; i += 1) {
      if (!outline[i]) continue;
      color[i * 4] = OUTLINE[0];
      color[i * 4 + 1] = OUTLINE[1];
      color[i * 4 + 2] = OUTLINE[2];
      color[i * 4 + 3] = 1;
    }
  }

  // Wireframe: every B-rep edge, no hidden-line removal.
  const lineWidth = Math.max(1, Math.round(ss * 1.2));
  if (options.mode === 'wireframe') {
    const wire: Rgb = options.background === 'dark' ? [0.86, 0.88, 0.92] : OUTLINE;
    for (const body of options.bodies) {
      for (const edge of body.edges) drawSegments(edge.segments, wire, lineWidth, false);
    }
  }
  // Accent edges (highlighted), depth-tested.
  for (const body of options.bodies) {
    for (const index of body.accentEdges ?? []) {
      const edge = body.edges[index];
      if (edge) drawSegments(edge.segments, ACCENT, Math.max(2, ss * 3), true);
    }
  }

  function drawSegments(segments: Float32Array, rgb: Rgb, thickness: number, depthTest: boolean) {
    for (let s = 0; s + 5 < segments.length; s += 6) {
      let a: Vec3 = [segments[s]!, segments[s + 1]!, segments[s + 2]!];
      let b: Vec3 = [segments[s + 3]!, segments[s + 4]!, segments[s + 5]!];
      if (clip) {
        const da = cut(a);
        const db = cut(b);
        if (da > 0 && db > 0) continue;
        if (da > 0 || db > 0) {
          const t = da / (da - db);
          const m: Vec3 = [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
          ];
          if (da > 0) a = m;
          else b = m;
        }
      }
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) continue;
      const steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(pb[0] - pa[0]), Math.abs(pb[1] - pa[1]))),
      );
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        const x = pa[0] + (pb[0] - pa[0]) * t;
        const y = pa[1] + (pb[1] - pa[1]) * t;
        const z = pa[2] + (pb[2] - pa[2]) * t;
        plot(x, y, z, rgb, thickness, depthTest);
      }
    }
  }

  function plot(x: number, y: number, z: number, rgb: Rgb, size: number, depthTest: boolean) {
    const half = (size - 1) / 2;
    const x0 = Math.round(x - half);
    const y0 = Math.round(y - half);
    for (let dy = 0; dy < size; dy += 1) {
      for (let dx = 0; dx < size; dx += 1) {
        const px = x0 + dx;
        const py = y0 + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const i = py * W + px;
        if (depthTest && z > depth[i]! + 2e-3) continue;
        color[i * 4] = rgb[0];
        color[i * 4 + 1] = rgb[1];
        color[i * 4 + 2] = rgb[2];
        color[i * 4 + 3] = 1;
      }
    }
  }

  if (options.axes !== false) drawAxes();

  function drawAxes(): void {
    const size = 30 * ss;
    const origin: [number, number] = [14 * ss + size * 0.15, H - 14 * ss - size * 0.15];
    const axes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    // Draw the axis pointing away from the viewer first.
    const order = [0, 1, 2].sort((a, b) => dot(axes[a]!, back) - dot(axes[b]!, back));
    for (const index of order) {
      const axis = axes[index]!;
      const sx = dot(axis, basis.right);
      const sy = -dot(axis, basis.up);
      const end: [number, number] = [origin[0] + sx * size, origin[1] + sy * size];
      const steps = Math.max(1, Math.ceil(Math.hypot(end[0] - origin[0], end[1] - origin[1])));
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        plot(
          origin[0] + (end[0] - origin[0]) * t,
          origin[1] + (end[1] - origin[1]) * t,
          0,
          AXIS_COLORS[index]!,
          Math.max(2, ss * 2),
          false,
        );
      }
      const length = Math.hypot(sx, sy);
      if (length > 0.2) {
        const lx = origin[0] + sx * (size + 7 * ss) - 2.5 * ss;
        const ly = origin[1] + sy * (size + 7 * ss) - 3.5 * ss;
        drawGlyph(index, lx, ly, AXIS_COLORS[index]!);
      }
    }
  }

  function drawGlyph(index: number, x: number, y: number, rgb: Rgb): void {
    const rows = GLYPHS[index]!;
    for (let r = 0; r < rows.length; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        if (rows[r]![c] !== '#') continue;
        for (let dy = 0; dy < ss; dy += 1) {
          for (let dx = 0; dx < ss; dx += 1) {
            const px = Math.round(x + c * ss + dx);
            const py = Math.round(y + r * ss + dy);
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const i = py * W + px;
            color[i * 4] = rgb[0];
            color[i * 4 + 1] = rgb[1];
            color[i * 4 + 2] = rgb[2];
            color[i * 4 + 3] = 1;
          }
        }
      }
    }
  }

  // Box-filter the samples down (premultiplied, so transparent edges stay clean).
  const out = new Uint8Array(width * height * 4);
  const samples = ss * ss;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * W + x * ss + sx) * 4;
          const alpha = color[i + 3]!;
          r += color[i]! * alpha;
          g += color[i + 1]! * alpha;
          b += color[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(Math.min(1, srgb(r / a)) * 255);
        out[o + 1] = Math.round(Math.min(1, srgb(g / a)) * 255);
        out[o + 2] = Math.round(Math.min(1, srgb(b / a)) * 255);
      }
      out[o + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

/** Colours are mixed in sRGB-ish space already; only clamps (kept as a hook for a later tone curve). */
function srgb(value: number): number {
  return value < 0 ? 0 : value;
}

/** Sutherland–Hodgman against one plane: keeps vertices with `distance(p) <= 0`. */
function clipPolygon(polygon: readonly Vertex[], distance: (p: Vec3) => number): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const da = distance(a.p);
    const db = distance(b.p);
    if (da <= 0) out.push(a);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push({
        p: [
          a.p[0] + (b.p[0] - a.p[0]) * t,
          a.p[1] + (b.p[1] - a.p[1]) * t,
          a.p[2] + (b.p[2] - a.p[2]) * t,
        ],
        n: normalize([
          a.n[0] + (b.n[0] - a.n[0]) * t,
          a.n[1] + (b.n[1] - a.n[1]) * t,
          a.n[2] + (b.n[2] - a.n[2]) * t,
        ]),
      });
    }
  }
  return out;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

const GLYPHS: readonly (readonly string[])[] = [
  ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
];
