/**
 * Stored text outlines (`SketchText.outline`): SVG path data with M, L, Q,
 * C and Z commands in normalized units (1 = the text's cap height, origin
 * at the start of the baseline, v up). Parsing turns them into closed
 * Bézier-chain contours; placing applies the entity's anchor, height and
 * rotation. Pure — the kernel and the solver never need the font.
 */
import type { BezierSegment } from '../spline.js';
import type { Vec2 } from '../types.js';

/** Closed contours of an outline, each a chain of Bézier segments (normalized units). */
export function parseOutline(path: string): BezierSegment[][] {
  const tokens = path.match(/[MLQCZmlqcz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const contours: BezierSegment[][] = [];
  let current: BezierSegment[] = [];
  let start: Vec2 | null = null;
  let pen: Vec2 | null = null;
  let i = 0;
  const num = (): number => {
    const v = Number(tokens[i]);
    i += 1;
    return v;
  };
  const point = (): Vec2 => [num(), num()];
  const close = () => {
    if (pen && start && (pen[0] !== start[0] || pen[1] !== start[1])) {
      current.push([pen, start]);
    }
    if (current.length > 0) contours.push(current);
    current = [];
    pen = start;
  };
  let command = '';
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/^[A-Za-z]$/.test(token)) {
      command = token.toUpperCase();
      i += 1;
      if (command === 'Z') {
        close();
        continue;
      }
    }
    if (command === 'M') {
      if (current.length > 0) close();
      start = point();
      pen = start;
      command = 'L'; // implicit lineto after moveto
    } else if (command === 'L') {
      const p = point();
      if (pen && (p[0] !== pen[0] || p[1] !== pen[1])) current.push([pen, p]);
      pen = p;
    } else if (command === 'Q') {
      const c = point();
      const p = point();
      if (pen) current.push([pen, c, p]);
      pen = p;
    } else if (command === 'C') {
      const c1 = point();
      const c2 = point();
      const p = point();
      if (pen) current.push([pen, c1, c2, p]);
      pen = p;
    } else {
      i += 1; // unknown token: skip
    }
    if (tokens.length > 0 && i > tokens.length) break;
  }
  if (current.length > 0) close();
  return contours.filter((c) => c.length > 0 && !contourDegenerate(c));
}

function contourDegenerate(contour: BezierSegment[]): boolean {
  let area = 0;
  for (const seg of contour) {
    for (let k = 0; k + 1 < seg.length; k += 1) {
      area += seg[k]![0] * seg[k + 1]![1] - seg[k + 1]![0] * seg[k]![1];
    }
  }
  return Math.abs(area) < 1e-9;
}

/** Places normalized contours: scale by `height`, rotate by `angle` degrees, move to `anchor`. */
export function placeContours(
  contours: readonly BezierSegment[][],
  anchor: Vec2,
  height: number,
  angle: number,
): BezierSegment[][] {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a) * height;
  const sin = Math.sin(a) * height;
  const map = (p: Vec2): Vec2 => [
    anchor[0] + p[0] * cos - p[1] * sin,
    anchor[1] + p[0] * sin + p[1] * cos,
  ];
  return contours.map((contour) => contour.map((seg) => seg.map(map)));
}

/** Formats a number for outline data (4 decimals of the cap height ≈ 1 µm at 10 mm). */
function fmt(v: number): string {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Path commands as opentype.js produces them (y already flipped to v up and normalized). */
export type OutlineCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

/** Serializes outline commands to stored path data. */
export function formatOutline(commands: readonly OutlineCommand[]): string {
  return commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          return `${c.type}${fmt(c.x)} ${fmt(c.y)}`;
        case 'Q':
          return `Q${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x)} ${fmt(c.y)}`;
        case 'C':
          return `C${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x2)} ${fmt(c.y2)} ${fmt(c.x)} ${fmt(c.y)}`;
        case 'Z':
          return 'Z';
      }
    })
    .join('');
}
