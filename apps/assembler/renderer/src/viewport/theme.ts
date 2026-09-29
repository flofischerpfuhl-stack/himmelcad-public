/**
 * Reads the viewport's colors from `@himmelcad/theme`'s CSS custom
 * properties (`getComputedStyle`) so light/dark tokens apply without
 * hardcoding any hex value here. Read once per mount (theme switching is not
 * expected mid-session for Phase 0); call {@link readViewportColors} again
 * from a `MutationObserver` on `documentElement` class if that ever changes.
 */

export interface ViewportColors {
  background: [number, number, number];
  gridMinor: [number, number, number];
  gridMajor: [number, number, number];
  axisX: [number, number, number];
  axisY: [number, number, number];
  axisZ: [number, number, number];
  bodyEdge: [number, number, number];
  selection: [number, number, number];
  support: [number, number, number];
  hover: [number, number, number];
  activePreview: [number, number, number];
  sketchOutline: [number, number, number];
  /** Geometry a feature error points at. Optional for older colour sets. */
  error?: [number, number, number];
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  if (clean.length !== 6) return [1, 1, 1];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function readVar(
  styles: CSSStyleDeclaration,
  name: string,
  fallbackHex: string,
): [number, number, number] {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw || !raw.startsWith('#')) return hexToRgb01(fallbackHex);
  return hexToRgb01(raw);
}

/** Reads the current theme's viewport-relevant colors from `document.documentElement`. */
export function readViewportColors(): ViewportColors {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: readVar(styles, '--hc-bg-void', '#101114'),
    gridMinor: readVar(styles, '--hc-fg-subtle', '#8c9098'),
    gridMajor: readVar(styles, '--hc-fg-muted', '#969aa2'),
    axisX: readVar(styles, '--hc-axis-x', '#ff6670'),
    axisY: readVar(styles, '--hc-axis-y', '#88d04f'),
    axisZ: readVar(styles, '--hc-axis-z', '#55a7ff'),
    bodyEdge: readVar(styles, '--hc-geometry-edge-ink', '#14161a'),
    selection: readVar(styles, '--hc-geometry-selection', '#ff9f1c'),
    support: readVar(styles, '--hc-geometry-support', '#43b9ff'),
    hover: readVar(styles, '--hc-geometry-hover', '#f0f1f3'),
    activePreview: readVar(styles, '--hc-geometry-active-preview', '#ffd166'),
    sketchOutline: readVar(styles, '--hc-accent-base', '#1597f2'),
    error: readVar(styles, '--hc-error', '#ff5c5c'),
  };
}
