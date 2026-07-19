import { Ban, Crosshair, Link2, Trash2, Unlock } from 'lucide-react';
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import styles from './GcpImageMarkerOverlay.module.css';

export type GcpMarkerState = 'predictedBlue' | 'manualGreen' | 'automaticOrange' | 'blockedMuted';

export interface GcpImageCoordinate {
  xPixels: number;
  yPixels: number;
}

export interface GcpImageMarker {
  pointId: string;
  pointName: string;
  imageId: number;
  coordinate: GcpImageCoordinate;
  state: GcpMarkerState;
  confidencePerMille?: number;
  uncertainty?: {
    semiMajorPixels: number;
    semiMinorPixels: number;
    angleDegrees: number;
  };
  blockedReason?: string;
}

export interface GcpManualMeasurement {
  pointId: string;
  imageId: number;
  state: 'manual';
  coordinate: GcpImageCoordinate;
}

export interface GcpImageMarkerOverlayProps {
  imageWidthPixels: number;
  imageHeightPixels: number;
  viewScale?: number;
  imageOffsetX?: number;
  imageOffsetY?: number;
  markers: readonly GcpImageMarker[];
  selectedPointId?: string;
  disabled?: boolean;
  onSelectPoint?: (pointId: string) => void;
  onCommitMeasurement: (measurement: GcpManualMeasurement) => void;
  onEditObservation?: (marker: GcpImageMarker, action: 'block' | 'unblock' | 'remove') => void;
}

interface DragState {
  pointerId: number;
  marker: GcpImageMarker;
  coordinate: GcpImageCoordinate;
  axis: 'horizontal' | 'vertical' | 'both';
  grabOffset: GcpImageCoordinate;
}

/**
 * Pixel-exact overlay for GCP projections. It must be mounted over the actual
 * image content box, not over a letterboxed viewport wrapper.
 */
export function GcpImageMarkerOverlay({
  imageWidthPixels,
  imageHeightPixels,
  viewScale = 1,
  imageOffsetX = 0,
  imageOffsetY = 0,
  markers,
  selectedPointId,
  disabled = false,
  onSelectPoint,
  onCommitMeasurement,
  onEditObservation,
}: GcpImageMarkerOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const visibleMarkers = useMemo(
    () =>
      markers.filter(
        (marker) =>
          Number.isFinite(marker.coordinate.xPixels) &&
          Number.isFinite(marker.coordinate.yPixels) &&
          marker.coordinate.xPixels >= 0 &&
          marker.coordinate.yPixels >= 0 &&
          marker.coordinate.xPixels < imageWidthPixels &&
          marker.coordinate.yPixels < imageHeightPixels,
      ),
    [imageHeightPixels, imageWidthPixels, markers],
  );

  function coordinateFromPointer(event: ReactPointerEvent): GcpImageCoordinate | null {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      xPixels: Math.max(
        0,
        Math.min(
          imageWidthPixels - Number.EPSILON,
          (event.clientX - bounds.left - imageOffsetX) / viewScale,
        ),
      ),
      yPixels: Math.max(
        0,
        Math.min(
          imageHeightPixels - Number.EPSILON,
          (event.clientY - bounds.top - imageOffsetY) / viewScale,
        ),
      ),
    };
  }

  function startDrag(
    event: ReactPointerEvent,
    marker: GcpImageMarker,
    axis: DragState['axis'],
  ): void {
    if (disabled || marker.state === 'blockedMuted') return;
    const pointer = coordinateFromPointer(event);
    if (!pointer) return;
    rootRef.current?.setPointerCapture(event.pointerId);
    onSelectPoint?.(marker.pointId);
    setDrag({
      pointerId: event.pointerId,
      marker,
      coordinate: marker.coordinate,
      axis,
      grabOffset: {
        xPixels: marker.coordinate.xPixels - pointer.xPixels,
        yPixels: marker.coordinate.yPixels - pointer.yPixels,
      },
    });
  }

  function moveDrag(event: ReactPointerEvent): void {
    if (drag?.pointerId !== event.pointerId) return;
    const pointer = coordinateFromPointer(event);
    if (!pointer) return;
    const xPixels =
      drag.axis === 'horizontal'
        ? drag.coordinate.xPixels
        : pointer.xPixels + drag.grabOffset.xPixels;
    const yPixels =
      drag.axis === 'vertical'
        ? drag.coordinate.yPixels
        : pointer.yPixels + drag.grabOffset.yPixels;
    setDrag({
      ...drag,
      coordinate: {
        xPixels: Math.max(0, Math.min(imageWidthPixels - Number.EPSILON, xPixels)),
        yPixels: Math.max(0, Math.min(imageHeightPixels - Number.EPSILON, yPixels)),
      },
    });
  }

  function finishDrag(event: ReactPointerEvent): void {
    if (drag?.pointerId !== event.pointerId) return;
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId);
    }
    onCommitMeasurement({
      pointId: drag.marker.pointId,
      imageId: drag.marker.imageId,
      state: 'manual',
      coordinate: drag.coordinate,
    });
    setDrag(null);
  }

  function cancelDrag(): void {
    setDrag(null);
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      aria-label="GCP measurement markers"
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
    >
      <svg
        className={styles.ellipses}
        aria-hidden="true"
      >
        {visibleMarkers.map((marker) => {
          if (!marker.uncertainty || marker.state !== 'predictedBlue') return null;
          return (
            <ellipse
              key={`${marker.pointId}:${marker.imageId}`}
              className={styles.predictionEllipse}
              cx={imageOffsetX + marker.coordinate.xPixels * viewScale}
              cy={imageOffsetY + marker.coordinate.yPixels * viewScale}
              rx={marker.uncertainty.semiMajorPixels * viewScale}
              ry={marker.uncertainty.semiMinorPixels * viewScale}
              transform={`rotate(${marker.uncertainty.angleDegrees} ${imageOffsetX + marker.coordinate.xPixels * viewScale} ${imageOffsetY + marker.coordinate.yPixels * viewScale})`}
            />
          );
        })}
      </svg>
      {visibleMarkers.map((marker) => {
        const coordinate =
          drag?.marker.pointId === marker.pointId && drag.marker.imageId === marker.imageId
            ? drag.coordinate
            : marker.coordinate;
        const effectiveState = drag?.marker === marker ? 'manualGreen' : marker.state;
        const fullCrosshair = selectedPointId === marker.pointId;
        return (
          <button
            key={`${marker.pointId}:${marker.imageId}`}
            type="button"
            className={`${styles.marker} ${
              fullCrosshair ? styles.fullMarker : styles.compactMarker
            } ${styles[effectiveState]} ${fullCrosshair ? styles.selected : ''}`}
            style={{
              '--gcp-x': `${imageOffsetX + coordinate.xPixels * viewScale}px`,
              '--gcp-y': `${imageOffsetY + coordinate.yPixels * viewScale}px`,
            } as CSSProperties}
            disabled={disabled || marker.state === 'blockedMuted'}
            aria-label={`${marker.pointName}, ${stateLabel(effectiveState)}`}
            title={markerTitle(marker)}
            onPointerDown={
              fullCrosshair ? undefined : (event) => startDrag(event, marker, 'both')
            }
            onDoubleClick={() =>
              onCommitMeasurement({
                pointId: marker.pointId,
                imageId: marker.imageId,
                state: 'manual',
                coordinate,
              })
            }
          >
            {fullCrosshair ? (
              <svg
                className={styles.fullCrosshair}
                aria-hidden="true"
              >
                <line
                  className={styles.axisVisual}
                  x1={imageOffsetX}
                  y1={imageOffsetY + coordinate.yPixels * viewScale}
                  x2={imageOffsetX + imageWidthPixels * viewScale}
                  y2={imageOffsetY + coordinate.yPixels * viewScale}
                />
                <line
                  className={`${styles.axisHit} ${styles.horizontalHit}`}
                  x1={imageOffsetX}
                  y1={imageOffsetY + coordinate.yPixels * viewScale}
                  x2={imageOffsetX + imageWidthPixels * viewScale}
                  y2={imageOffsetY + coordinate.yPixels * viewScale}
                  onPointerDown={(event) => startDrag(event, marker, 'horizontal')}
                />
                <line
                  className={styles.axisVisual}
                  x1={imageOffsetX + coordinate.xPixels * viewScale}
                  y1={imageOffsetY}
                  x2={imageOffsetX + coordinate.xPixels * viewScale}
                  y2={imageOffsetY + imageHeightPixels * viewScale}
                />
                <line
                  className={`${styles.axisHit} ${styles.verticalHit}`}
                  x1={imageOffsetX + coordinate.xPixels * viewScale}
                  y1={imageOffsetY}
                  x2={imageOffsetX + coordinate.xPixels * viewScale}
                  y2={imageOffsetY + imageHeightPixels * viewScale}
                  onPointerDown={(event) => startDrag(event, marker, 'vertical')}
                />
                <circle
                  className={styles.intersection}
                  cx={imageOffsetX + coordinate.xPixels * viewScale}
                  cy={imageOffsetY + coordinate.yPixels * viewScale}
                  r={6}
                />
              </svg>
            ) : (
              <span className={styles.compactCrosshair} aria-hidden="true" />
            )}
            <span className={styles.markerLabel}>{marker.pointName}</span>
          </button>
        );
      })}
      {selectedPointId &&
        onEditObservation &&
        (() => {
          const marker = visibleMarkers.find((candidate) => candidate.pointId === selectedPointId);
          if (!marker) return null;
          return (
            <div className={styles.observationActions}>
              <button
                type="button"
                className={styles.blockButton}
                disabled={disabled}
                onClick={() =>
                  onEditObservation(marker, marker.state === 'blockedMuted' ? 'unblock' : 'block')
                }
              >
                {marker.state === 'blockedMuted' ? <Unlock size={13} /> : <Ban size={13} />}
                {marker.state === 'blockedMuted' ? 'Unblock projection' : 'Block projection'}
              </button>
              <button
                type="button"
                className={styles.blockButton}
                disabled={disabled || marker.state === 'predictedBlue'}
                onClick={() => onEditObservation(marker, 'remove')}
              >
                <Trash2 size={13} />
                Remove measurement
              </button>
            </div>
          );
        })()}
      <div className={styles.legend} aria-label="GCP marker color status">
        <Legend state="predictedBlue" label="Predicted" icon={<Crosshair size={11} />} />
        <Legend state="manualGreen" label="Manual" icon={<Crosshair size={11} />} />
        <Legend state="automaticOrange" label="Tie Point" icon={<Link2 size={11} />} />
      </div>
    </div>
  );
}

function Legend({
  state,
  label,
  icon,
}: {
  state: Exclude<GcpMarkerState, 'blockedMuted'>;
  label: string;
  icon: JSX.Element;
}): JSX.Element {
  return (
    <span className={`${styles.legendItem} ${styles[state]}`}>
      {icon}
      {label}
    </span>
  );
}

function stateLabel(state: GcpMarkerState): string {
  if (state === 'manualGreen') return 'measured manually';
  if (state === 'automaticOrange') return 'updated through tie point';
  if (state === 'blockedMuted') return 'blocked';
  return 'predicted';
}

function markerTitle(marker: GcpImageMarker): string {
  const confidence =
    marker.confidencePerMille == null
      ? ''
      : ` · ${(marker.confidencePerMille / 10).toLocaleString('en-US')} %`;
  const reason = marker.blockedReason ? ` · ${marker.blockedReason}` : '';
  return `${marker.pointName} · ${stateLabel(marker.state)}${confidence}${reason}`;
}
