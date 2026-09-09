import { useEffect, useRef } from 'react';

import type { BuilderKernelViewportHandle } from './BuilderKernelViewport.js';
import { projectWorldPoint } from './MeasurementViewportOverlay.js';
import type { SurfaceEditPreview } from './project.js';

export function SurfaceEditViewportOverlay({
  viewport,
  preview,
  region,
}: {
  readonly viewport: BuilderKernelViewportHandle | null;
  readonly preview: SurfaceEditPreview | null;
  readonly region: readonly (readonly [number, number, number])[] | null;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || (!preview && !region)) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    let stopped = false;
    let frame = 0;
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
        const computed = getComputedStyle(canvas);
        const accent = computed.getPropertyValue('--hc-accent-base').trim() || '#5aa7ff';
        const support = computed.getPropertyValue('--hc-geometry-support').trim() || '#42a5d5';
        if (preview) {
          context.fillStyle = accent;
          context.strokeStyle = accent;
          context.globalAlpha = 0.5;
          context.lineWidth = 0.75;
          for (let offset = 0; offset + 2 < preview.indices.length; offset += 3) {
            const triangle = [0, 1, 2].flatMap((delta) => {
              const point = preview.positions[preview.indices[offset + delta] ?? -1];
              if (!point) return [];
              const projected = projectWorldPoint(
                camera,
                { x: point[0], y: point[1], z: point[2] },
                width,
                height,
              );
              return projected ? [projected] : [];
            });
            if (triangle.length !== 3) continue;
            context.beginPath();
            context.moveTo(triangle[0]!.x, triangle[0]!.y);
            context.lineTo(triangle[1]!.x, triangle[1]!.y);
            context.lineTo(triangle[2]!.x, triangle[2]!.y);
            context.closePath();
            context.fill();
            context.stroke();
          }
          context.globalAlpha = 1;
          context.strokeStyle = support;
          context.lineWidth = 2;
          for (const edge of preview.constrainedEdges) {
            const points = edge.flatMap((index) => {
              const point = preview.positions[index];
              if (!point) return [];
              const projected = projectWorldPoint(
                camera,
                { x: point[0], y: point[1], z: point[2] },
                width,
                height,
              );
              return projected ? [projected] : [];
            });
            if (points.length !== 2) continue;
            context.beginPath();
            context.moveTo(points[0]!.x, points[0]!.y);
            context.lineTo(points[1]!.x, points[1]!.y);
            context.stroke();
          }
        }
        if (region && region.length >= 3) {
          const points = region.flatMap((point) => {
            const projected = projectWorldPoint(
              camera,
              { x: point[0], y: point[1], z: point[2] },
              width,
              height,
            );
            return projected ? [projected] : [];
          });
          if (points.length >= 3) {
            context.fillStyle = accent;
            context.strokeStyle = accent;
            context.globalAlpha = 0.08;
            context.beginPath();
            context.moveTo(points[0]!.x, points[0]!.y);
            for (const point of points.slice(1)) context.lineTo(point.x, point.y);
            context.closePath();
            context.fill();
            context.globalAlpha = 1;
            context.stroke();
          }
        }
      }
      frame = window.requestAnimationFrame(render);
    };
    frame = window.requestAnimationFrame(render);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [preview, region, viewport]);
  return <canvas ref={canvasRef} aria-hidden="true" data-surface-edit-preview={preview ? 'ready' : 'empty'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}
