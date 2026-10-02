import type { CSSProperties } from 'react';

import { BRAND_MARK_POLYGONS } from './brandMarkPolygons.js';
import { isPreviewRelease } from './releaseChannel.js';
import styles from './BrandMark.module.css';

/** "Preview" next to the product name (Home, About) while the build is a preview release. */
export function PreviewBadge() {
  if (!isPreviewRelease()) return null;
  return (
    <span className={styles.preview} data-preview-badge>
      Preview
    </span>
  );
}

/**
 * The Assembler mark (low-poly bolt, `branding/logos/source/himmelcad-assembler-small.svg`)
 * next to the wordmark in the top bar, on Home and in About. Inline SVG: no request, no CSP
 * exception. In the light theme the very light outline facets take their `-on-light` tones.
 */
export function BrandMark({ size, className }: { size: number; className?: string | undefined }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className}
      aria-hidden
      focusable="false"
      data-brand-mark
    >
      {BRAND_MARK_POLYGONS.map(([fill, points, onLight], index) => (
        <polygon
          key={index}
          fill={fill}
          points={points}
          className={onLight ? styles.toned : undefined}
          style={onLight ? ({ '--hc-mark-on-light': onLight } as CSSProperties) : undefined}
        />
      ))}
    </svg>
  );
}
