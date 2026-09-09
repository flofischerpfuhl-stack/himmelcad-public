import { useEffect, useRef } from 'react';

import type { BuilderKernelViewportHandle } from './BuilderKernelViewport.js';
import { projectWorldPoint } from './MeasurementViewportOverlay.js';
import type { GroundPreviewResult } from './project.js';

export function GroundPreviewOverlay({
  viewport,
  result,
}: {
  readonly viewport: BuilderKernelViewportHandle | null;
  readonly result: GroundPreviewResult | null;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return undefined;
    let frame = 0;
    let stopped = false;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const render = (): void => {
      if (stopped) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const camera = viewport?.isAlive() ? viewport.worldCamera() : null;
      if (camera && width > 0 && height > 0) {
        context.fillStyle = getComputedStyle(canvas).getPropertyValue('--hc-success').trim();
        context.globalAlpha = 0.6;
        for (const point of result.preview.points) {
          if (point.classification !== 'ground') continue;
          const projected = projectWorldPoint(
            camera,
            { x: point.position[0], y: point.position[1], z: point.position[2] },
            width,
            height,
          );
          if (!projected) continue;
          context.fillRect(projected.x - 1, projected.y - 1, 3, 3);
        }
        context.globalAlpha = 1;
      }
      frame = window.requestAnimationFrame(render);
    };
    frame = window.requestAnimationFrame(render);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [result, viewport]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-ground-preview={result ? 'ready' : 'empty'}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
}
