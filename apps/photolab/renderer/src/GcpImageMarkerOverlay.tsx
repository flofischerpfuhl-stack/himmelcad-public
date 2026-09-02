import { Ban, Crosshair, Link2, Trash2, Unlock } from 'lucide-react';
import { registerEscapeRung } from '@himmelcad/ui';
import {
  useEffect,
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
  onCommitMeasurement: (measurement: GcpManualMeasurement) => Promise<boolean>;
  onEditObservation?: (marker: GcpImageMarker, action: 'block' | 'unblock' | 'remove') => void;
}

interface DragState {
  pointerId: number;
  marker: GcpImageMarker;
  coordinate: GcpImageCoordinate;
  grabOffset: GcpImageCoordinate;
}

interface OptimisticCoordinate {
  coordinate: GcpImageCoordinate;
  revision: number;
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
  const dragRef = useRef<DragState | null>(null);
  const optimisticRevisionRef = useRef(0);
  const [optimisticCoordinates, setOptimisticCoordinates] = useState(
    () => new Map<string, OptimisticCoordinate>(),
  );
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

  useEffect(() => {
    setOptimisticCoordinates((current) => {
      let next: Map<string, OptimisticCoordinate> | null = null;
      for (const marker of markers) {
        const key = markerKey(marker);
        const optimistic = current.get(key);
        if (!optimistic || !coordinatesMatch(marker.coordinate, optimistic.coordinate)) continue;
        next ??= new Map(current);
        next.delete(key);
      }
      return next ?? current;
    });
  }, [markers]);

  useEffect(
    () =>
      registerEscapeRung('drag', () => {
        const current = dragRef.current;
        if (!current) return false;
        dragRef.current = null;
        if (rootRef.current?.hasPointerCapture(current.pointerId)) {
          rootRef.current.releasePointerCapture(current.pointerId);
        }
        setDrag(null);
        return true;
      }),
    [],
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

  function startDrag(event: ReactPointerEvent, marker: GcpImageMarker): void {
    if (disabled || marker.state === 'blockedMuted') return;
    event.preventDefault();
    event.stopPropagation();
    const pointer = coordinateFromPointer(event);
    if (!pointer) return;
    rootRef.current?.setPointerCapture(event.pointerId);
    onSelectPoint?.(marker.pointId);
    const coordinate =
      optimisticCoordinates.get(markerKey(marker))?.coordinate ?? marker.coordinate;
    const next: DragState = {
      pointerId: event.pointerId,
      marker,
      coordinate,
      grabOffset: {
        xPixels: coordinate.xPixels - pointer.xPixels,
        yPixels: coordinate.yPixels - pointer.yPixels,
      },
    };
    dragRef.current = next;
    setDrag(next);
  }

  function moveDrag(event: ReactPointerEvent): void {
    const current = dragRef.current;
    if (current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const pointer = coordinateFromPointer(event);
    if (!pointer) return;
    const xPixels = pointer.xPixels + current.grabOffset.xPixels;
    const yPixels = pointer.yPixels + current.grabOffset.yPixels;
    const next: DragState = {
      ...current,
      coordinate: {
        xPixels: Math.max(0, Math.min(imageWidthPixels - Number.EPSILON, xPixels)),
        yPixels: Math.max(0, Math.min(imageHeightPixels - Number.EPSILON, yPixels)),
      },
    };
    dragRef.current = next;
    setDrag(next);
  }

  function finishDrag(event: ReactPointerEvent): void {
    const completed = dragRef.current;
    if (completed?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId);
    }
    const key = markerKey(completed.marker);
    const revision = ++optimisticRevisionRef.current;
    setOptimisticCoordinates((current) => {
      const next = new Map(current);
      next.set(key, { coordinate: completed.coordinate, revision });
      return next;
    });
    dragRef.current = null;
    setDrag(null);
    void onCommitMeasurement({
      pointId: completed.marker.pointId,
      imageId: completed.marker.imageId,
      state: 'manual',
      coordinate: completed.coordinate,
    }).then((saved) => {
      if (saved) return;
      setOptimisticCoordinates((current) => {
        if (current.get(key)?.revision !== revision) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    });
  }

  function cancelDrag(event: ReactPointerEvent): void {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
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
      <svg className={styles.ellipses} aria-hidden="true">
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
            : (optimisticCoordinates.get(markerKey(marker))?.coordinate ?? marker.coordinate);
        const effectiveState =
          (drag?.marker.pointId === marker.pointId && drag.marker.imageId === marker.imageId) ||
          optimisticCoordinates.has(markerKey(marker))
            ? 'manualGreen'
            : marker.state;
        const fullCrosshair = selectedPointId === marker.pointId;
        return (
          <button
            key={`${marker.pointId}:${marker.imageId}`}
            type="button"
            className={`${styles.marker} ${
              fullCrosshair ? styles.fullMarker : styles.compactMarker
            } ${styles[effectiveState]} ${fullCrosshair ? styles.selected : ''}`}
            style={
              {
                '--gcp-x': `${imageOffsetX + coordinate.xPixels * viewScale}px`,
                '--gcp-y': `${imageOffsetY + coordinate.yPixels * viewScale}px`,
              } as CSSProperties
            }
            disabled={disabled || marker.state === 'blockedMuted'}
            aria-label={`${marker.pointName}, ${stateLabel(effectiveState)}`}
            title={markerTitle(marker)}
            onPointerDown={fullCrosshair ? undefined : (event) => startDrag(event, marker)}
            onDoubleClick={() =>
              void onCommitMeasurement({
                pointId: marker.pointId,
                imageId: marker.imageId,
                state: 'manual',
                coordinate,
              })
            }
          >
            {fullCrosshair ? (
              <svg className={styles.fullCrosshair} aria-hidden="true">
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
                  onPointerDown={(event) => startDrag(event, marker)}
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
                  onPointerDown={(event) => startDrag(event, marker)}
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

function markerKey(marker: Pick<GcpImageMarker, 'pointId' | 'imageId'>): string {
  return `${marker.pointId}:${marker.imageId}`;
}

function coordinatesMatch(left: GcpImageCoordinate, right: GcpImageCoordinate): boolean {
  return (
    Math.abs(left.xPixels - right.xPixels) <= 1e-4 && Math.abs(left.yPixels - right.yPixels) <= 1e-4
  );
}
