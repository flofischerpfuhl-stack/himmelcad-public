import { useEffect, useRef, useState } from 'react';
import { Color, GridHelper, Plane, Raycaster, Vector2, Vector3, WebGLRenderer, type Camera } from 'three';

import type { SnapResult } from '@himmelcad/data';

import { CameraController } from './camera/CameraController.js';
import { SceneGraph } from './scene/SceneGraph.js';
import { SnappingService } from './snapping/SnappingService.js';
import styles from './Viewport.module.css';

export interface ViewportProps {
  onCursorSnap?: (snap: SnapResult | null) => void;
}

/**
 * Skeleton viewport: a working three.js render loop with the agreed Z-up orbit
 * camera, an empty scene, a soft grid for orientation. It's the canvas onto
 * which Layers and TiledDatasets get attached during MVP Workstream 6+.
 */
export function Viewport({ onCursorSnap }: ViewportProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<SnapResult | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(new Color('#181a1d'));
    container.appendChild(renderer.domElement);

    const scene = new SceneGraph();
    const grid = new GridHelper(50, 50, 0x3c3f41, 0x25262a);
    grid.rotation.x = Math.PI / 2;
    scene.root.add(grid);

    const camera = new CameraController(container.clientWidth, container.clientHeight);
    camera.frame({ x: -25, y: -25, z: -1 } as never, { x: 25, y: 25, z: 1 } as never);

    new SnappingService();

    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h, false);
      camera.setViewportSize(w, h);
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    let dragMode: 'orbit' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) dragMode = 'orbit';
      else if (e.button === 2) dragMode = 'pan';
      lastX = e.clientX;
      lastY = e.clientY;
      (e.target as Element).setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dragMode === 'orbit') {
        camera.orbit(-dx * 0.005, -dy * 0.005);
      } else if (dragMode === 'pan') {
        const k = 0.05;
        camera.pan(-dx * k, dy * k);
      }

      // INVARIANT: cursor coordinate is filled by the SnappingService once
      // layers exist. Until then, project the pointer onto the Z=0 ground
      // plane so the overlay shows a non-fake demonstration value.
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      const groundPos = projectNdcToGround(ndcX, ndcY, camera.camera);
      setCursor(
        groundPos
          ? {
              position: { x: groundPos.x, y: groundPos.y, z: 0 },
              kind: 'EstimatedSurface',
              entity: null,
              confidence: 0.1,
            }
          : null,
      );
    };
    const onPointerUp = (e: PointerEvent) => {
      dragMode = null;
      (e.target as Element).releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      camera.zoom(factor);
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    let raf = 0;
    const tick = () => {
      renderer.render(scene.scene, camera.camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      renderer.dispose();
      container.removeChild(canvas);
    };
  }, []);

  useEffect(() => {
    onCursorSnap?.(cursor);
  }, [cursor, onCursorSnap]);

  return (
    <div ref={containerRef} className={styles.root}>
      <CursorOverlay snap={cursor} />
    </div>
  );
}

const GROUND_PLANE = new Plane(new Vector3(0, 0, 1), 0);
const RAYCASTER = new Raycaster();
const NDC_VEC = new Vector2();
const HIT = new Vector3();

function projectNdcToGround(ndcX: number, ndcY: number, camera: Camera): Vector3 | null {
  NDC_VEC.set(ndcX, ndcY);
  RAYCASTER.setFromCamera(NDC_VEC, camera);
  const out = RAYCASTER.ray.intersectPlane(GROUND_PLANE, HIT);
  return out ? HIT : null;
}

function CursorOverlay({ snap }: { snap: SnapResult | null }): JSX.Element {
  return (
    <div className={styles.cursorOverlay} aria-live="polite">
      {snap ? (
        <span>
          X {snap.position.x.toFixed(3)} &nbsp; Y {snap.position.y.toFixed(3)} &nbsp; Z{' '}
          {snap.position.z.toFixed(3)} &nbsp; <em>{snap.kind}</em>
        </span>
      ) : (
        <span className={styles.cursorOverlayMuted}>Move cursor over geometry…</span>
      )}
    </div>
  );
}
