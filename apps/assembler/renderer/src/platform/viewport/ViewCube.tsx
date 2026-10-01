import { Check, RotateCcw, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';

import { ContextMenu, MenuItem, MenuSeparator, clampMenuPosition } from '@himmelcad/ui';

import {
  CUBE_FACES,
  cubeCellDirection,
  cubeFaceTransforms,
  isFaceOnView,
  type CameraPose,
  type CameraPresetName,
  type CubeFace,
} from './camera.js';
import type { Vec3 } from './math.js';
import type { Projection } from '../input/preferences.js';
import { PROJECTION_MODES } from './projection.js';
import styles from './ViewCube.module.css';

const DRAG_THRESHOLD_PX = 4;
/** Half the cube's edge length, px (the face box is 96 px). */
const HALF = 48;
/** Perspective distance, px (the eye sits this far in front of the cube centre). */
const PERSPECTIVE = 500;

export interface ViewCubeProps {
  pose: CameraPose;
  onPreset: (preset: CameraPresetName) => void;
  /** Edge/corner cells: look from this world direction (target → eye). */
  onDirection: (direction: Vec3) => void;
  onHome: () => void;
  onFit: () => void;
  /** Rotates the view about its viewing axis (positive = counter-clockwise). */
  onRoll: (degrees: number) => void;
  onOrbitDrag: (dxPixels: number, dyPixels: number) => void;
  /** The projection setting (Orthographic / Adaptive / Perspective), offered in the cube's menu. */
  projection: Projection;
  onProjection: (mode: Projection) => void;
  onSaveView?: () => void;
}

type Cell = -1 | 0 | 1;

function cellName(face: CubeFace, i: Cell, j: Cell): string {
  if (i === 0 && j === 0) return `${face.label} view`;
  const parts: string[] = [face.label];
  const neighbour = (axis: Vec3, sign: Cell) =>
    CUBE_FACES.find(
      (f) =>
        f.normal[0] === axis[0] * sign &&
        f.normal[1] === axis[1] * sign &&
        f.normal[2] === axis[2] * sign,
    )?.label;
  if (j !== 0) parts.push(neighbour(face.up, j) ?? '');
  if (i !== 0) parts.push(neighbour(face.right, i) ?? '');
  return `${parts.join(' ')} ${i !== 0 && j !== 0 ? 'corner' : 'edge'} view`;
}

/**
 * Top-right orientation cube (CSS-3D), Shapr3D-style. Its orientation comes
 * from the same camera basis as the scene (`cubeMatrix3d`), so the face in
 * front is always the side the camera looks from. Each face carries its full
 * transform (`perspective() · cube · face`) and is shown only while it faces
 * the eye (`cubeFaceTransforms`): no `preserve-3d`, no `backface-visibility`,
 * which WebKit (Safari, iPad) and the other engines handle differently. Click a face for that
 * view, an edge for the 45° edge view, a corner for the isometric view;
 * drag to orbit; double-click for the home view; right-click for Home, Fit
 * and the projection. In a face-on view two arrows roll it by 90°.
 */
export function ViewCube(props: ViewCubeProps): JSX.Element {
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    // Stop the 3D viewport's own pointer handling (orbit/pick) from also
    // reacting to clicks/drags on the cube overlay.
    event.stopPropagation();
    if (event.button !== 0) return;
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

  const release = (event: React.PointerEvent<HTMLElement>): boolean => {
    event.stopPropagation();
    const drag = dragState.current;
    dragState.current = null;
    return !!drag && !drag.moved && event.button === 0;
  };

  const activate = (face: CubeFace, i: Cell, j: Cell) => {
    if (i === 0 && j === 0) props.onPreset(face.name);
    else props.onDirection(cubeCellDirection(face, i, j));
  };

  const faceOn = isFaceOnView(props.pose);
  const faces = cubeFaceTransforms(props.pose, HALF, PERSPECTIVE);

  return (
    <div
      className={styles.scene}
      role="group"
      aria-label="View cube: click a face, edge or corner for that view, drag to orbit, double-click for the home view"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className={styles.stage}>
        <div
          className={styles.cube}
          onDoubleClick={(event) => {
            event.stopPropagation();
            props.onHome();
          }}
        >
          {faces.map(({ face, matrix, visible, depth }) => (
            <div
              key={face.name}
              className={styles.face}
              data-face={face.name}
              data-visible={visible ? 'true' : 'false'}
              // A hidden face takes no clicks and no focus; visible ones never overlap (convex).
              aria-hidden={visible ? undefined : true}
              style={{
                transform: `perspective(${PERSPECTIVE}px) matrix3d(${matrix.join(',')})`,
                visibility: visible ? 'visible' : 'hidden',
                zIndex: Math.round(depth) + HALF + 1,
              }}
            >
              {([1, 0, -1] as const).map((j) =>
                ([-1, 0, 1] as const).map((i) => (
                  <button
                    key={`${i}:${j}`}
                    type="button"
                    className={
                      i === 0 && j === 0
                        ? styles.faceCentre
                        : i !== 0 && j !== 0
                          ? styles.corner
                          : styles.edge
                    }
                    aria-label={cellName(face, i, j)}
                    title={i === 0 && j === 0 ? undefined : cellName(face, i, j)}
                    data-cell={`${face.name}:${i}:${j}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={(event) => {
                      if (release(event)) activate(face, i, j);
                    }}
                    onPointerCancel={() => {
                      dragState.current = null;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        activate(face, i, j);
                      }
                    }}
                  >
                    {i === 0 && j === 0 ? face.label : null}
                  </button>
                )),
              )}
            </div>
          ))}
        </div>
      </div>
      {faceOn ? (
        <>
          <button
            type="button"
            className={`${styles.roll} ${styles.rollLeft}`}
            aria-label="Rotate view 90° counter-clockwise"
            title="Rotate view 90° counter-clockwise"
            onClick={() => props.onRoll(90)}
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            className={`${styles.roll} ${styles.rollRight}`}
            aria-label="Rotate view 90° clockwise"
            title="Rotate view 90° clockwise"
            onClick={() => props.onRoll(-90)}
          >
            <RotateCw size={13} />
          </button>
        </>
      ) : null}
      {menu ? (
        <ContextMenu
          {...clampMenuPosition(menu.x, menu.y, 200, 220)}
          ariaLabel="View cube"
          onClose={() => setMenu(null)}
        >
          <MenuItem onSelect={props.onHome}>Home view</MenuItem>
          <MenuItem onSelect={props.onFit}>Zoom to fit</MenuItem>
          <MenuSeparator />
          {PROJECTION_MODES.map((mode) => (
            <MenuItem key={mode.id} title={mode.hint} onSelect={() => props.onProjection(mode.id)}>
              <span className={styles.menuRow}>
                <span className={styles.menuCheck} aria-hidden>
                  {props.projection === mode.id ? <Check size={12} /> : null}
                </span>
                {mode.label}
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          {props.onSaveView ? <MenuItem onSelect={props.onSaveView}>Save view</MenuItem> : null}
        </ContextMenu>
      ) : null}
    </div>
  );
}
