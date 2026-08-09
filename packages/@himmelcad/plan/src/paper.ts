/** Fixed paper formats (mm). Not infinite canvas. */

export type PaperOrientation = 'portrait' | 'landscape';

export interface PaperSizeMm {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
}

/** ISO A-series + letter/tabloid + free custom. */
export const STANDARD_PAPERS: readonly PaperSizeMm[] = [
  { id: 'a4', name: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a3', name: 'A3', widthMm: 297, heightMm: 420 },
  { id: 'a2', name: 'A2', widthMm: 420, heightMm: 594 },
  { id: 'a1', name: 'A1', widthMm: 594, heightMm: 841 },
  { id: 'a0', name: 'A0', widthMm: 841, heightMm: 1189 },
  { id: 'letter', name: 'Letter', widthMm: 216, heightMm: 279 },
  { id: 'tabloid', name: 'Tabloid', widthMm: 279, heightMm: 432 },
] as const;

export interface PaperConfig {
  sizeId: string;
  orientation: PaperOrientation;
  /** Used when sizeId === 'custom'. */
  customWidthMm?: number;
  customHeightMm?: number;
  marginMm: number;
}

/** Excalidraw coordinates remain screen-friendly while paper remains physical. */
export const PLAN_SCENE_UNITS_PER_MM = 4;

export interface SheetTransform {
  sceneUnitsPerMm: number;
  paperWidthMm: number;
  paperHeightMm: number;
}

export function validatePaperConfig(config: PaperConfig): string | null {
  const { widthMm, heightMm } = resolvePaperMm(config);
  if (
    !Number.isFinite(widthMm) ||
    !Number.isFinite(heightMm) ||
    widthMm < 50 ||
    heightMm < 50 ||
    widthMm > 2_000 ||
    heightMm > 2_000
  ) {
    return 'Paper dimensions must be between 50 and 2000 mm.';
  }
  if (
    !Number.isFinite(config.marginMm) ||
    config.marginMm < 0 ||
    config.marginMm * 2 >= Math.min(widthMm, heightMm)
  ) {
    return 'Paper margin is outside the printable sheet.';
  }
  return null;
}

export function sheetTransform(config: PaperConfig): SheetTransform {
  const paper = resolvePaperMm(config);
  return {
    sceneUnitsPerMm: PLAN_SCENE_UNITS_PER_MM,
    paperWidthMm: paper.widthMm,
    paperHeightMm: paper.heightMm,
  };
}

export function mmToScene(valueMm: number, transform: SheetTransform): number {
  return valueMm * transform.sceneUnitsPerMm;
}

export function sceneToMm(value: number, transform: SheetTransform): number {
  return value / transform.sceneUnitsPerMm;
}

export function mmPointToScene(
  point: { x: number; y: number },
  transform: SheetTransform,
): { x: number; y: number } {
  return { x: mmToScene(point.x, transform), y: mmToScene(point.y, transform) };
}

export function sceneRectToMm(
  rect: { x: number; y: number; width: number; height: number },
  transform: SheetTransform,
): { x: number; y: number; width: number; height: number } {
  return {
    x: sceneToMm(rect.x, transform),
    y: sceneToMm(rect.y, transform),
    width: sceneToMm(rect.width, transform),
    height: sceneToMm(rect.height, transform),
  };
}

export function sheetSceneBounds(config: PaperConfig): readonly [number, number, number, number] {
  const transform = sheetTransform(config);
  return [
    0,
    0,
    mmToScene(transform.paperWidthMm, transform),
    mmToScene(transform.paperHeightMm, transform),
  ];
}

/** World metres to plotted paper millimetres at a conventional 1:n scale. */
export function worldMetersToPaperMm(worldMeters: number, scaleDenominator: number): number {
  if (!Number.isFinite(scaleDenominator) || scaleDenominator <= 0) {
    throw new Error('Scale denominator must be positive.');
  }
  return (worldMeters * 1_000) / scaleDenominator;
}

export function resolvePaperMm(config: PaperConfig): { widthMm: number; heightMm: number } {
  if (config.sizeId === 'custom') {
    const w = config.customWidthMm ?? 210;
    const h = config.customHeightMm ?? 297;
    return config.orientation === 'landscape'
      ? { widthMm: Math.max(w, h), heightMm: Math.min(w, h) }
      : { widthMm: Math.min(w, h), heightMm: Math.max(w, h) };
  }
  const base = STANDARD_PAPERS.find((p) => p.id === config.sizeId) ?? STANDARD_PAPERS[0]!;
  const { widthMm, heightMm } = base;
  if (config.orientation === 'landscape') {
    return { widthMm: Math.max(widthMm, heightMm), heightMm: Math.min(widthMm, heightMm) };
  }
  return { widthMm: Math.min(widthMm, heightMm), heightMm: Math.max(widthMm, heightMm) };
}

/** CSS pixel size at 96 DPI for on-screen paper preview. */
export function paperCssPixels(
  config: PaperConfig,
  maxWidthPx: number,
  maxHeightPx: number,
): { widthPx: number; heightPx: number; scale: number } {
  const { widthMm, heightMm } = resolvePaperMm(config);
  const pxPerMm = 96 / 25.4;
  const naturalW = widthMm * pxPerMm;
  const naturalH = heightMm * pxPerMm;
  const scale = Math.min(maxWidthPx / naturalW, maxHeightPx / naturalH, 1);
  return {
    widthPx: Math.round(naturalW * scale),
    heightPx: Math.round(naturalH * scale),
    scale,
  };
}
