/** Host-owned paper viewport constraints for HimmelCAD Plan. */
export type HimmelCadPaperBounds = readonly [
  minimumX: number,
  minimumY: number,
  maximumX: number,
  maximumY: number,
];

export type HimmelCadPlanActionName =
  | "undo"
  | "redo"
  | "group"
  | "ungroup"
  | "alignTop"
  | "alignBottom"
  | "alignLeft"
  | "alignRight"
  | "alignVerticallyCentered"
  | "alignHorizontallyCentered"
  | "distributeHorizontally"
  | "distributeVertically"
  | "sendBackward"
  | "bringForward"
  | "sendToBack"
  | "bringToFront";

export interface HimmelCadPaperViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/**
 * Keeps the finite paper reachable without turning Excalidraw scene units into
 * physical authority. The host supplies the sheet bounds derived from mm.
 */
export const clampHimmelCadPaperViewport = (
  viewport: HimmelCadPaperViewport,
  paper: HimmelCadPaperBounds,
  editorSize: { width: number; height: number },
  options: { minimumZoom?: number; maximumZoom?: number; overscroll?: number } = {},
): HimmelCadPaperViewport => {
  const zoom = Math.min(
    options.maximumZoom ?? 8,
    Math.max(options.minimumZoom ?? 0.1, viewport.zoom),
  );
  const overscroll = options.overscroll ?? 80;
  const visibleWidth = editorSize.width / zoom;
  const visibleHeight = editorSize.height / zoom;
  const minimumScrollX = -(paper[2] + overscroll) + visibleWidth;
  const maximumScrollX = -paper[0] + overscroll;
  const minimumScrollY = -(paper[3] + overscroll) + visibleHeight;
  const maximumScrollY = -paper[1] + overscroll;
  return {
    scrollX: clamp(viewport.scrollX, minimumScrollX, maximumScrollX),
    scrollY: clamp(viewport.scrollY, minimumScrollY, maximumScrollY),
    zoom,
  };
};

/** CSS variables consumed by the maintained fork when hosted in HimmelCAD. */
export const HIMMELCAD_EXCALIDRAW_THEME_VARIABLES = {
  "--color-primary": "var(--hc-accent)",
  "--color-primary-darker": "var(--hc-accent-strong)",
  "--default-bg-color": "var(--hc-bg-island)",
  "--island-bg-color": "var(--hc-bg-island-hi)",
  "--popup-bg-color": "var(--hc-bg-island)",
} as const;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, Math.min(minimum, maximum)), Math.max(minimum, maximum));
