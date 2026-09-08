import type { CSSProperties } from 'react';

import styles from './MeasurementVisuals.module.css';

export interface MeasurementScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface MeasurementGraphicItem {
  readonly id: string;
  readonly anchors: readonly MeasurementScreenPoint[];
  readonly label: string;
  readonly selected?: boolean;
  readonly preview?: boolean;
}

export interface MeasurementGraphicsProps {
  readonly items: readonly MeasurementGraphicItem[];
  readonly className?: string;
  readonly onSelect?: (id: string) => void;
}

/** DOM measurement pass used until the renderer exposes V-05 label/glyph payloads. */
export function MeasurementGraphics({
  items,
  className,
  onSelect,
}: MeasurementGraphicsProps): JSX.Element {
  return (
    <div
      className={`${styles.graphics} ${className ?? ''}`.trim()}
      aria-label="Measurement graphics"
      data-render-dependency="V-05"
    >
      <svg className={styles.lines} aria-hidden>
        {items.flatMap((item) =>
          item.anchors.slice(1).map((anchor, index) => {
            const previous = item.anchors[index]!;
            return (
              <line
                key={`${item.id}:${index}`}
                className={`${styles.line} ${item.selected ? styles.selectedLine : ''} ${item.preview ? styles.previewLine : ''}`}
                x1={previous.x}
                y1={previous.y}
                x2={anchor.x}
                y2={anchor.y}
              />
            );
          }),
        )}
      </svg>
      {items.flatMap((item) => {
        const midpoint = graphicMidpoint(item.anchors);
        const controls = item.anchors.map((anchor, index) => (
          <span
            key={`${item.id}:anchor:${index}`}
            className={`${styles.anchor} ${item.selected ? styles.selectedAnchor : ''}`}
            style={at(anchor)}
            aria-hidden
          />
        ));
        if (!midpoint) return controls;
        return [
          ...controls,
          <button
            key={`${item.id}:label`}
            type="button"
            className={`${styles.label} ${item.selected ? styles.selectedLabel : ''}`}
            style={at({ x: midpoint.x, y: midpoint.y + 12 })}
            onClick={() => onSelect?.(item.id)}
            tabIndex={onSelect ? 0 : -1}
            aria-label={`${item.label}${item.selected ? ', selected' : ''}`}
          >
            {item.label}
          </button>,
        ];
      })}
    </div>
  );
}

export interface MeasurementLiveReadoutProps {
  readonly value: string;
  readonly prompt?: string;
  readonly exact?: boolean;
}

export function MeasurementLiveReadout({
  value,
  prompt,
  exact = true,
}: MeasurementLiveReadoutProps): JSX.Element {
  return (
    <div className={styles.readout} aria-live="polite" aria-atomic="true">
      {prompt ? <div className={styles.prompt}>{prompt}</div> : null}
      <output className={styles.value}>{value}</output>
      <span className={styles.exactness}>{exact ? 'Exact' : 'Rendered surface estimate'}</span>
    </div>
  );
}

function graphicMidpoint(points: readonly MeasurementScreenPoint[]): MeasurementScreenPoint | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!;
  return {
    x: (points[0]!.x + points.at(-1)!.x) / 2,
    y: (points[0]!.y + points.at(-1)!.y) / 2,
  };
}

function at(point: MeasurementScreenPoint): CSSProperties {
  return { left: point.x, top: point.y };
}
