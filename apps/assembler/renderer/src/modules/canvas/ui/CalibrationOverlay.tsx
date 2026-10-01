/**
 * Calibrate Image (Shapr3D canvas calibration): while it runs, left clicks
 * in the viewport pick two points on the image's plane (other buttons still
 * orbit/pan/zoom); then the real distance between them is typed and
 * applied as one undo step (the picture scales about the first point).
 * Escape (the tool rung) or Cancel ends it without a change.
 */
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, NumberInput, registerEscapeRung } from '@himmelcad/ui';

import { notify } from '../../../foundation/commands/notices.js';
import { useAssemblerStore } from '../../../foundation/commands/store.js';
import type { ViewportDomOverlayProps } from '../../../platform/viewport/domOverlays.js';
import { imageFeature, useCanvasStore } from '../canvasStore.js';
import { imagePlaneFrame, planeCoordinates, planePoint } from '../referenceImage.js';
import styles from './CanvasUi.module.css';

export function CalibrationOverlay({ host, tick }: ViewportDomOverlayProps): JSX.Element | null {
  void tick;
  const calibration = useCanvasStore((s) => s.calibration);
  const state = useAssemblerStore();
  const [distance, setDistance] = useState<number | null>(null);
  const active = calibration !== null;

  useEffect(() => {
    if (!active) return;
    setDistance(null);
    return registerEscapeRung('tool', () => {
      useCanvasStore.getState().cancelCalibration();
      return true;
    });
  }, [active]);

  if (!calibration) return null;
  const feature = imageFeature(state, calibration.featureId);
  const frame = feature ? imagePlaneFrame(feature.plane, state.evaluation) : null;
  if (!feature || !frame) return null;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || calibration.points.length >= 2) return; // camera buttons pass through
    event.stopPropagation();
    const ray = host.rayAtClient(event.clientX, event.clientY);
    if (!ray) return;
    const n = frame.normal;
    const denom = n[0] * ray.direction[0] + n[1] * ray.direction[1] + n[2] * ray.direction[2];
    if (Math.abs(denom) < 1e-9) {
      notify('The image plane is edge-on: turn the view to pick on it.');
      return;
    }
    const t =
      (n[0] * (frame.origin[0] - ray.origin[0]) +
        n[1] * (frame.origin[1] - ray.origin[1]) +
        n[2] * (frame.origin[2] - ray.origin[2])) /
      denom;
    const hit: [number, number, number] = [
      ray.origin[0] + ray.direction[0] * t,
      ray.origin[1] + ray.direction[1] * t,
      ray.origin[2] + ray.direction[2] * t,
    ];
    useCanvasStore.getState().addCalibrationPoint(planeCoordinates(frame, hit));
  };

  const screen = calibration.points.map((uv) => host.project(planePoint(frame, uv[0], uv[1])));
  const measured =
    calibration.points.length === 2
      ? Math.hypot(
          calibration.points[1]![0] - calibration.points[0]![0],
          calibration.points[1]![1] - calibration.points[0]![1],
        )
      : null;
  const apply = (value = distance ?? measured ?? 0) => {
    const reason = useCanvasStore.getState().applyCalibration(value);
    if (reason) notify(reason, 'warning');
  };
  const prompt =
    calibration.points.length === 0
      ? 'Click the first of two points on the image whose real distance you know.'
      : calibration.points.length === 1
        ? 'Click the second point.'
        : 'Type the real distance between the points, then Apply.';
  return (
    <div
      className={`${styles.capture} ${calibration.points.length < 2 ? styles.capturing : ''}`}
      onPointerDown={onPointerDown}
      data-canvas-calibration=""
    >
      <div className={styles.pill} role="status" onPointerDown={(e) => e.stopPropagation()}>
        <span className={styles.pillTitle}>Calibrate {feature.name}</span>
        <span className={styles.pillPrompt}>{prompt}</span>
        {measured !== null ? (
          <>
            <span className={styles.field}>
              <NumberInput
                aria-label="Real distance"
                value={distance ?? Math.round(measured * 100) / 100}
                min={0.001}
                step={1}
                unit="mm"
                autoFocus
                commitOnBlur={false}
                onValueChange={(n) => setDistance(n)}
                onCommit={(n) => apply(n)}
              />
            </span>
            <Button
              variant="primary"
              size="small"
              icon={<Check size={13} />}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </>
        ) : null}
        <Button
          variant="secondary"
          size="small"
          icon={<X size={13} />}
          onClick={() => useCanvasStore.getState().cancelCalibration()}
        >
          Cancel
        </Button>
      </div>
      <svg className={styles.svg} aria-hidden>
        {screen[0] && screen[1] ? (
          <line
            x1={screen[0][0]}
            y1={screen[0][1]}
            x2={screen[1][0]}
            y2={screen[1][1]}
            className={styles.line}
          />
        ) : null}
        {screen.map((p, i) =>
          p ? <circle key={i} cx={p[0]} cy={p[1]} r={5} className={styles.marker} /> : null,
        )}
      </svg>
    </div>
  );
}
