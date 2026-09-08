import type { KernelGlyphAtlasMetadata, KernelWorldPoint } from './WgpuKernelViewer.js';

export interface KernelOverlayLineStrip {
  readonly id: string;
  readonly points: readonly KernelWorldPoint[];
  readonly widthPixels: number;
  readonly color: readonly [number, number, number, number];
}

export interface KernelOverlayScreenQuad {
  readonly id: string;
  readonly anchor: KernelWorldPoint;
  readonly offsets: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  readonly color: readonly [number, number, number, number];
}

export interface KernelOverlayLabelChip {
  readonly id: string;
  readonly anchor: KernelWorldPoint;
  readonly pixelOffset: readonly [number, number];
  readonly text: string;
  readonly heightPixels: number;
  readonly textColor: readonly [number, number, number, number];
  readonly backgroundColor: readonly [number, number, number, number];
  readonly borderColor: readonly [number, number, number, number];
}

export interface KernelRendererOverlayPayload {
  readonly lines: readonly KernelOverlayLineStrip[];
  readonly quads: readonly KernelOverlayScreenQuad[];
  readonly labels: readonly KernelOverlayLabelChip[];
}

export type KernelSupportRole = 'helper_point' | 'defining_point' | 'defining_curve';

export const EMPTY_RENDERER_OVERLAY: KernelRendererOverlayPayload = Object.freeze({
  lines: Object.freeze([]),
  quads: Object.freeze([]),
  labels: Object.freeze([]),
});

export interface KernelOverlayGlyphAtlas {
  readonly hash: string;
  readonly metadata: KernelGlyphAtlasMetadata;
  readonly rgba8: Uint8Array;
}

/** Builds the bounded mono atlas used by renderer-native measurement chips. */
export function createKernelOverlayGlyphAtlas(document: Document): KernelOverlayGlyphAtlas {
  const characters = [
    ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)),
    'Δ',
  ];
  const cellWidth = 10;
  const cellHeight = 16;
  const columns = 16;
  const rows = Math.ceil(characters.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellWidth;
  canvas.height = rows * cellHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('renderer overlay glyph atlas needs a 2D canvas');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.font = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  const glyphs: Record<string, KernelGlyphAtlasMetadata['glyphs'][string]> = {};
  characters.forEach((character, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = column * cellWidth;
    const top = row * cellHeight;
    context.fillText(character, left + cellWidth / 2, top + 12);
    glyphs[character] = {
      atlasMin: [left, top],
      atlasMax: [left + cellWidth, top + cellHeight],
      planeMin: [-cellWidth / 2 / 12, -12 / 12],
      planeMax: [cellWidth / 2 / 12, 4 / 12],
      advance: cellWidth / 12,
    };
  });
  return {
    hash: 'hcad.renderer-overlay-mono@1',
    metadata: {
      width: canvas.width,
      height: canvas.height,
      lineHeight: cellHeight / 12,
      glyphs,
      fallback: '?',
    },
    rgba8: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data),
  };
}

/** Produces a six-pixel anchor square centered exactly on its projected point. */
export function overlayAnchorSquare(
  id: string,
  anchor: KernelWorldPoint,
  color: readonly [number, number, number, number],
  sizePixels = 6,
): KernelOverlayScreenQuad {
  if (!Number.isFinite(sizePixels) || sizePixels < 2 || sizePixels > 32) {
    throw new RangeError('overlay square size must be between 2 and 32 pixels');
  }
  const half = sizePixels / 2;
  return {
    id,
    anchor,
    offsets: [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ],
    color,
  };
}

/** Builds the support-blue point/line payload for an explicit canonical support role. */
export function overlaySupportRoleGeometry(
  id: string,
  role: KernelSupportRole,
  points: readonly KernelWorldPoint[],
  supportColor: readonly [number, number, number, number],
): KernelRendererOverlayPayload {
  if (id.length === 0 || points.length === 0) {
    throw new RangeError('support-role overlay needs a stable id and at least one point');
  }
  if (role === 'defining_curve' && points.length < 2) {
    throw new RangeError('defining-curve overlay needs at least two points');
  }
  return {
    lines:
      role === 'defining_curve'
        ? [{ id: `${id}:line`, points, widthPixels: 1.5, color: supportColor }]
        : [],
    quads: points.map((point, index) =>
      overlayAnchorSquare(`${id}:point:${index}`, point, supportColor, 6),
    ),
    labels: [],
  };
}

/** Matches the former DOM chip's first/last-anchor midpoint and vertical offset. */
export function overlayMidpointPixelOffset(
  firstScreen: readonly [number, number],
  lastScreen: readonly [number, number],
  verticalOffsetPixels = 12,
): readonly [number, number] {
  if (
    ![...firstScreen, ...lastScreen, verticalOffsetPixels].every(Number.isFinite) ||
    Math.abs(verticalOffsetPixels) > 128
  ) {
    throw new RangeError('overlay label midpoint needs finite bounded screen coordinates');
  }
  return [
    (lastScreen[0] - firstScreen[0]) / 2,
    (lastScreen[1] - firstScreen[1]) / 2 + verticalOffsetPixels,
  ];
}

/** Builds the two pixel-stable arms at the end of a selected directed line. */
export function overlayDirectionArrow(
  id: string,
  anchor: KernelWorldPoint,
  previousScreen: readonly [number, number],
  endScreen: readonly [number, number],
  color: readonly [number, number, number, number],
  sizePixels = 8,
): readonly [KernelOverlayScreenQuad, KernelOverlayScreenQuad] {
  const dx = endScreen[0] - previousScreen[0];
  const dy = endScreen[1] - previousScreen[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0) || !Number.isFinite(sizePixels) || sizePixels < 4 || sizePixels > 32) {
    throw new RangeError('overlay direction arrow needs a finite segment and 4–32 pixel size');
  }
  const backward: readonly [number, number] = [-dx / length, -dy / length];
  const normal: readonly [number, number] = [-backward[1], backward[0]];
  const arm = (sign: -1 | 1, suffix: string): KernelOverlayScreenQuad => {
    const tip: readonly [number, number] = [0, 0];
    const tail: readonly [number, number] = [
      backward[0] * sizePixels + normal[0] * sizePixels * 0.55 * sign,
      backward[1] * sizePixels + normal[1] * sizePixels * 0.55 * sign,
    ];
    const tx = tail[0] - tip[0];
    const ty = tail[1] - tip[1];
    const armLength = Math.hypot(tx, ty);
    const nx = (-ty / armLength) * Math.max(1, sizePixels / 8);
    const ny = (tx / armLength) * Math.max(1, sizePixels / 8);
    return {
      id: `${id}:${suffix}`,
      anchor,
      offsets: [
        [tip[0] - nx, tip[1] - ny],
        [tail[0] - nx, tail[1] - ny],
        [tail[0] + nx, tail[1] + ny],
        [tip[0] + nx, tip[1] + ny],
      ],
      color,
    };
  };
  return [arm(-1, 'left'), arm(1, 'right')];
}

/** Converts a CSS token color to the renderer's linear-light RGBA contract. */
export function cssColorToLinearRgba(css: string): readonly [number, number, number, number] {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css.trim());
  if (!match) throw new TypeError(`renderer overlay color must be #rrggbb or #rrggbbaa: ${css}`);
  const rgb = match[1]!;
  const channel = (offset: number): number =>
    Number.parseInt(rgb.slice(offset, offset + 2), 16) / 255;
  const linear = (value: number): number =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const alpha = match[2] ? Number.parseInt(match[2], 16) / 255 : 1;
  return [linear(channel(0)), linear(channel(2)), linear(channel(4)), alpha];
}
