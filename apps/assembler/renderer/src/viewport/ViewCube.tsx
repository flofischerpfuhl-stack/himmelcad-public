import { useRef } from 'react';

import type { CameraPresetName } from './camera.js';
import styles from './ViewCube.module.css';

const DRAG_THRESHOLD_PX = 4;

export interface ViewCubeProps {
  yawRadians: number;
  pitchRadians: number;
  onPreset: (preset: CameraPresetName | 'iso') => void;
  onOrbitDrag: (dxPixels: number, dyPixels: number) => void;
}

/**
 * Top-right orientation cube (CSS-3D), Shapr3D-style: click a face for that
 * planar preset, click an edge/corner for the nearest iso, drag to orbit,
 * double-click for iso. Faces are labelled with the world direction the
 * camera would be looking from for that preset (see `camera.ts`'s
 * `PRESET_ANGLES`: Right = +X, Left = -X, Back = +Y, Front = -Y, Top = +Z,
 * Bottom = -Z).
 */
export function ViewCube(props: ViewCubeProps): JSX.Element {
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    // Stop the 3D viewport's own pointer handling (orbit/pick) from also
    // reacting to clicks/drags on the cube overlay.
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = { startX: event.clientX, startY: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    event.stopPropagation();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    props.onOrbitDrag(event.movementX, event.movementY);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>, preset: CameraPresetName) => {
    event.stopPropagation();
    const drag = dragState.current;
    dragState.current = null;
    if (!drag || drag.moved) return;
    props.onPreset(preset);
  };

  const edgePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const drag = dragState.current;
    dragState.current = null;
    if (!drag || drag.moved) return;
    props.onPreset('iso');
  };

  const cubeTransform = `rotateX(${(-props.pitchRadians * 180) / Math.PI}deg) rotateY(${(props.yawRadians * 180) / Math.PI}deg)`;

  const faces: Array<{ className: string; label: string; preset: CameraPresetName }> = [
    { className: styles.faceFront!, label: 'Front', preset: 'front' },
    { className: styles.faceBack!, label: 'Back', preset: 'back' },
    { className: styles.faceRight!, label: 'Right', preset: 'right' },
    { className: styles.faceLeft!, label: 'Left', preset: 'left' },
    { className: styles.faceTop!, label: 'Top', preset: 'top' },
    { className: styles.faceBottom!, label: 'Bottom', preset: 'bottom' },
  ];

  return (
    <div
      className={styles.scene}
      role="group"
      aria-label="View cube: click a face for that view, drag to orbit"
    >
      <div
        className={styles.cube}
        style={{ transform: cubeTransform }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={edgePointerUp}
        onPointerCancel={() => {
          dragState.current = null;
        }}
        onDoubleClick={() => props.onPreset('iso')}
      >
        {faces.map((face) => (
          <button
            key={face.preset}
            type="button"
            className={`${styles.face} ${face.className}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => onPointerUp(event, face.preset)}
            onDoubleClick={() => props.onPreset('iso')}
          >
            {face.label}
          </button>
        ))}
      </div>
    </div>
  );
}
