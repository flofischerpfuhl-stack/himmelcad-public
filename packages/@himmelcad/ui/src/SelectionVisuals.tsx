import styles from './SelectionVisuals.module.css';

export interface SelectionVisualsProps {
  readonly supportVisible?: boolean;
  readonly directionArrowSize?: number;
  readonly className?: string;
}

/** Semantic viewport fixture/overlay: every class has a shape cue in addition to color. */
export function SelectionVisuals({
  supportVisible = true,
  directionArrowSize = 8,
  className,
}: SelectionVisualsProps): JSX.Element {
  return (
    <svg
      className={`${styles.root} ${className ?? ''}`.trim()}
      viewBox="0 0 480 220"
      role="img"
      aria-label="Selected directed polyline, selected point anchor, and support geometry"
      data-hover-pickable-only="true"
    >
      <path className={styles.contextLine} d="M38 178 L116 122 L204 156 L292 82 L438 126" />
      {supportVisible ? (
        <g className={styles.support} data-support-geometry="visible">
          <path d="M116 122 L116 188 M292 82 L292 188" />
          <circle cx="116" cy="122" r="4" />
          <circle cx="292" cy="82" r="4" />
          <circle cx="292" cy="188" r="4" />
        </g>
      ) : null}
      <path className={styles.selectedLine} d="M38 178 L116 122 L204 156 L292 82 L438 126" />
      <path
        className={styles.direction}
        d="M438 126 L424 118 M438 126 L423 132"
        style={{ strokeWidth: Math.max(2, directionArrowSize / 3) }}
        data-direction-arrow-size={directionArrowSize}
      />
      <rect className={styles.selectedPoint} x="199" y="151" width="10" height="10" />
      <g className={styles.symbolPoint} aria-label="Symbol point with anchor-only selection">
        <path className={styles.symbol} d="M355 78 l10 -18 l10 18 l-20 0 m10 -18 v-12" />
        <rect className={styles.anchor} x="361" y="74" width="8" height="8" />
      </g>
    </svg>
  );
}
