/**
 * Transient view state around the mounted viewport: the "pick a face for the
 * section plane" prompt, the grid resolution it draws, and the image renderer
 * it registers (image export, project thumbnails). Session-only; nothing here
 * is saved.
 */
import { create } from 'zustand';

import { publishLiveGridStep } from './liveGrid.js';

export interface ImageRenderRequest {
  width: number;
  height: number;
  transparent: boolean;
  grid: boolean;
}

export interface RenderedImage {
  png: Blob;
  width: number;
  height: number;
}

type ImageRenderer = (request: ImageRenderRequest) => Promise<RenderedImage>;
let imageRenderer: ImageRenderer | null = null;
let viewportSize: (() => { width: number; height: number; dpr: number }) | null = null;

/** Registered by the mounted viewport. */
export function setImageRenderer(
  renderer: ImageRenderer | null,
  size: (() => { width: number; height: number; dpr: number }) | null,
): void {
  imageRenderer = renderer;
  viewportSize = size;
}

export function renderViewportImage(request: ImageRenderRequest): Promise<RenderedImage> {
  if (!imageRenderer) return Promise.reject(new Error('The 3D view is not available.'));
  return imageRenderer(request);
}

/** The viewport's size in CSS pixels (and its device pixel ratio). */
export function currentViewportSize(): { width: number; height: number; dpr: number } | null {
  return viewportSize?.() ?? null;
}

export interface ViewportUiState {
  /** Section > Face: the next click on a planar face sets the section plane. */
  sectionFacePick: boolean;
  setSectionFacePick: (on: boolean) => void;
  /**
   * The zoom-dependent grid resolution the viewport currently draws (mm),
   * `null` before the first frame. Read-out and sketch snapping use it while
   * the grid is not locked (`model/gridResolution.ts`).
   */
  liveGridStep: number | null;
  setLiveGridStep: (step: number) => void;
}

export const useViewportUi = create<ViewportUiState>((set, get) => ({
  sectionFacePick: false,
  setSectionFacePick: (on) => set({ sectionFacePick: on }),
  liveGridStep: null,
  setLiveGridStep: (step) => {
    // Also published below the domain modules (`platform/viewport/liveGrid.ts`) for sketch snapping.
    publishLiveGridStep(step);
    if (get().liveGridStep !== step) set({ liveGridStep: step });
  },
}));
