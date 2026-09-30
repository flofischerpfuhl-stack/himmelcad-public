/**
 * Measure panel (interaction research §5: "Measure öffnet ein verschiebbares
 * Panel für aktuelle und angeheftete Maße"): a movable island shown while
 * Measure is on. "Current" measures the selection — or two points picked
 * with the Points tool (snapped to vertices, midpoints and circle centres) —
 * and can be pinned; pinned measurements stay listed (re-measured on every
 * change, saved with the project) with their dimension overlay in the
 * viewport, which each can hide. Every value and measurement can be copied.
 * Exact values come from the kernel's B-rep; mesh estimates say "approx.".
 */
import { Copy, Crosshair, Eye, EyeOff, GripHorizontal, Pin, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import { Spinner, Tooltip, registerEscapeRung } from '@himmelcad/ui';

import type { Measurement } from '../model/measure.js';
import {
  formatMeasureValue,
  measurementText,
  useDisplayUnit,
  useLiveMeasurements,
} from '../model/measureLive.js';
import { useMeasureStore } from '../model/measureStore.js';
import type { LengthUnit } from '../model/preferences.js';
import type { AssemblerState } from '../model/store.js';
import { useWorkspaceStore } from '../model/workspace.js';
import styles from './MeasurePanel.module.css';

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useWorkspaceStore.getState().notify('Copied to the clipboard');
  } catch {
    useWorkspaceStore.getState().notify('Could not copy to the clipboard', 'warning');
  }
}

function Values({ m, unit }: { m: Measurement; unit: LengthUnit }): JSX.Element {
  return (
    <dl className={styles.values}>
      {m.values.map((v) => {
        const text = formatMeasureValue(v, unit);
        return (
          <div
            key={v.label}
            className={`${styles.valueRow} ${v.secondary ? styles.secondary : ''}`}
          >
            <dt className={styles.valueLabel}>
              {v.label}
              {v.approx ? <span className={styles.approx}>approx.</span> : null}
            </dt>
            <dd className={styles.value}>{text}</dd>
            <button
              type="button"
              className={styles.rowButton}
              aria-label={`Copy ${v.label}`}
              title={`Copy ${v.label}`}
              onClick={() => void copyText(text)}
            >
              <Copy size={12} />
            </button>
          </div>
        );
      })}
    </dl>
  );
}

export function MeasurePanel({ state }: { state: AssemblerState }): JSX.Element | null {
  const unit = useDisplayUnit();
  const live = useLiveMeasurements();
  const pointMode = useMeasureStore((s) => s.pointMode);
  const points = useMeasureStore((s) => s.points);
  const position = useMeasureStore((s) => s.panelPosition);
  const rootRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const onGripDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || (event.target as HTMLElement).closest('button')) return;
    const rect = root.getBoundingClientRect();
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const onGripMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const host = root?.offsetParent as HTMLElement | null;
    if (!drag.current || !root || !host) return;
    const hostRect = host.getBoundingClientRect();
    const x = Math.min(
      Math.max(0, event.clientX - hostRect.left - drag.current.dx),
      hostRect.width - root.offsetWidth,
    );
    const y = Math.min(
      Math.max(0, event.clientY - hostRect.top - drag.current.dy),
      hostRect.height - root.offsetHeight,
    );
    useMeasureStore.getState().setPanelPosition({ x, y });
  }, []);
  const onGripUp = useCallback(() => {
    drag.current = null;
  }, []);
  // Escape leaves the Points tool (before it would clear the selection).
  useEffect(() => {
    if (!pointMode) return;
    return registerEscapeRung('tool', () => {
      useMeasureStore.getState().setPointMode(false);
      return true;
    });
  }, [pointMode]);

  if (!state.viewState.measureEnabled) return null;
  const measure = useMeasureStore.getState();
  const current = live.current;
  const canPin = current !== null && current.measurement.values.length > 0;

  return (
    <section
      ref={rootRef}
      className={styles.root}
      aria-label="Measure"
      style={
        position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined
      }
    >
      <div
        className={styles.header}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onDoubleClick={() => measure.setPanelPosition(null)}
        title="Drag to move; double-click to dock"
      >
        <GripHorizontal size={14} className={styles.grip} aria-hidden />
        <span className={styles.title}>Measure</span>
        <span className={styles.spacer} />
        <Tooltip
          content={
            pointMode ? 'Points: on — click geometry to place points' : 'Measure between points'
          }
        >
          <button
            type="button"
            className={`${styles.headerButton} ${pointMode ? styles.headerButtonActive : ''}`}
            aria-pressed={pointMode}
            aria-label="Points"
            onClick={() => measure.setPointMode(!pointMode)}
          >
            <Crosshair size={14} />
            <span>Points</span>
          </button>
        </Tooltip>
        <Tooltip content="Turn Measure off">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Turn Measure off"
            onClick={() => {
              measure.setPointMode(false);
              state.setMeasureEnabled(false);
            }}
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      <div className={styles.body}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Current</span>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.textButton}
            disabled={!canPin}
            onClick={() => current && measure.pin(current.refs)}
          >
            <Pin size={12} /> Pin
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={!canPin}
            aria-label="Copy current measurement"
            onClick={() => current && void copyText(measurementText(current.measurement, unit))}
          >
            <Copy size={12} /> Copy
          </button>
        </div>
        {current ? (
          <div className={styles.card} aria-live="polite">
            <div className={styles.cardTitle}>
              {current.measurement.title}
              {current.measurement.pending ? (
                <span className={styles.pending}>
                  <Spinner size="small" /> exact distance…
                </span>
              ) : null}
            </div>
            {current.measurement.subject ? (
              <div className={styles.subject}>{current.measurement.subject}</div>
            ) : null}
            {current.measurement.note ? (
              <p className={styles.note}>{current.measurement.note}</p>
            ) : (
              <Values m={current.measurement} unit={unit} />
            )}
          </div>
        ) : (
          <p className={styles.empty}>
            {pointMode
              ? points.length === 1
                ? 'Click a second point.'
                : 'Click a vertex, edge midpoint, circle centre or face to place a point.'
              : 'Select a body, face or edge — or two items for distance and angle — or use Points.'}
          </p>
        )}

        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Pinned</span>
          <span className={styles.count}>{live.pinned.length}</span>
          <span className={styles.spacer} />
          {live.pinned.length > 0 ? (
            <button type="button" className={styles.textButton} onClick={() => measure.clearPins()}>
              Clear all
            </button>
          ) : null}
        </div>
        {live.pinned.length === 0 ? (
          <p className={styles.empty}>Pinned measurements stay here and in the view.</p>
        ) : (
          <ul className={styles.pins}>
            {live.pinned.map(({ pin, measurement }) => (
              <li key={pin.id} className={styles.card}>
                <div className={styles.pinHead}>
                  <span className={styles.cardTitle}>{measurement.title}</span>
                  <span className={styles.spacer} />
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-pressed={pin.showInViewport}
                    aria-label={pin.showInViewport ? 'Hide in view' : 'Show in view'}
                    title={pin.showInViewport ? 'Hide in view' : 'Show in view'}
                    onClick={() => measure.toggleOverlay(pin.id)}
                  >
                    {pin.showInViewport ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Copy measurement"
                    title="Copy"
                    onClick={() => void copyText(measurementText(measurement, unit))}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Unpin measurement"
                    title="Unpin"
                    onClick={() => measure.unpin(pin.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {measurement.subject ? (
                  <div className={styles.subject}>{measurement.subject}</div>
                ) : null}
                {measurement.note ? (
                  <p className={styles.note}>{measurement.note}</p>
                ) : (
                  <Values
                    m={{ ...measurement, values: measurement.values.filter((v) => !v.secondary) }}
                    unit={unit}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
