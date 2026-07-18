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

export const PLAN_LIBRARY_KIND = 'himmelcadPlanLibrary' as const;
export const PLAN_LIBRARY_FORMAT = 1 as const;

/** Grouped drawing saved to local library (not model geometry). */
export interface PlanLibraryItem {
  id: string;
  name: string;
  /** Serialized Excalidraw elements JSON. */
  elementsJson: string;
  thumbnailDataUrl?: string;
  updatedAt: string;
}

export interface PlanLibrary {
  formatVersion: typeof PLAN_LIBRARY_FORMAT;
  kind: typeof PLAN_LIBRARY_KIND;
  items: PlanLibraryItem[];
}
