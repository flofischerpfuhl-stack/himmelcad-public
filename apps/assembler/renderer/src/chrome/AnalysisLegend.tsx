/**
 * Legend for the analysis display modes: the curvature map's colour scale
 * (radius in the display unit, convex warm / concave cool) and what zebra
 * stripes show. States the approximation: curvature is estimated from the
 * mesh (vertex normals), not from the kernel's exact surfaces.
 */
import { visibleBounds } from '../modules/modeling/modeling.js';
import { formatLength, usePreferences } from '../platform/input/preferences.js';
import type { AssemblerState } from '../foundation/commands/store.js';
import { curvatureColor, curvatureRange } from '../platform/viewport/displayModes.js';
import styles from './AnalysisLegend.module.css';

function css(rgb: [number, number, number]): string {
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`;
}

export function AnalysisLegend({ state }: { state: AssemblerState }): JSX.Element | null {
  const unit = usePreferences((p) => p.units);
  const mode = state.viewState.displayMode;
  if (mode !== 'curvature' && mode !== 'zebra') return null;
  if (mode === 'zebra') {
    return (
      <div className={styles.root} role="note" aria-label="Zebra stripes legend">
        <div className={styles.title}>Zebra stripes</div>
        <p className={styles.note}>
          Reflections of parallel light bars. Stripes that stay continuous across an edge mean a
          smooth (tangent) transition; kinks or jumps show a crease.
        </p>
      </div>
    );
  }
  const bounds = visibleBounds(state.evaluation.bodies, state.hiddenBodyIds, state.isolatedBodyIds);
  const diagonal = bounds
    ? Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      )
    : 100;
  const range = curvatureRange(diagonal);
  const stops = [-1, -0.5, 0, 0.5, 1].map((t) => {
    // t: −1 strongly concave … 0 flat … 1 strongly convex.
    const radius = Math.pow(
      10,
      Math.log10(range.max) - Math.abs(t) * (Math.log10(range.max) - Math.log10(range.min)),
    );
    const k = t === 0 ? 0 : Math.sign(t) / radius;
    return { t, color: css(curvatureColor(k, range)) };
  });
  const gradient = `linear-gradient(to right, ${stops.map((s) => s.color).join(', ')})`;
  return (
    <div className={styles.root} role="note" aria-label="Curvature map legend">
      <div className={styles.title}>Curvature map</div>
      <div className={styles.bar} style={{ background: gradient }} aria-hidden />
      <div className={styles.scale}>
        <span>Concave R ≤ {formatLength(range.min, unit)}</span>
        <span>Flat</span>
        <span>Convex R ≤ {formatLength(range.min, unit)}</span>
      </div>
      <p className={styles.note}>
        Radius scale {formatLength(range.min, unit)} – {formatLength(range.max, unit)}. Estimated
        from the display mesh (approx.).
      </p>
    </div>
  );
}
