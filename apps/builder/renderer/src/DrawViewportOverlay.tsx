import type { ConstructionPoint, DrawToolSnapshot } from '@himmelcad/app';
import {
  cssColorToLinearRgba,
  EMPTY_RENDERER_OVERLAY,
  overlayAnchorSquare,
  overlaySupportRoleGeometry,
  type KernelRendererOverlayPayload,
  type KernelWorldPoint,
} from '@himmelcad/viewer/kernel';
import { useEffect, useMemo } from 'react';

import type { BuilderDrawCurveSummary } from './project.js';
import type { BuilderKernelViewportHandle } from './BuilderKernelViewport.js';

export function DrawViewportOverlay({
  viewport,
  tool,
  curves,
  supportVisible,
  constructionPreview,
}: {
  readonly viewport: BuilderKernelViewportHandle | null;
  readonly tool: DrawToolSnapshot;
  readonly curves: readonly BuilderDrawCurveSummary[];
  readonly supportVisible: boolean;
  readonly constructionPreview: ConstructionPoint | null;
}): null {
  const payload = useMemo<KernelRendererOverlayPayload>(() => {
    const computed = getComputedStyle(document.documentElement);
    const accent = cssColorToLinearRgba(
      computed.getPropertyValue('--hc-accent-base').trim() || '#5aa7ff',
    );
    const support = cssColorToLinearRgba(
      computed.getPropertyValue('--hc-geometry-support').trim() || '#42a5d5',
    );
    const lines: KernelRendererOverlayPayload['lines'][number][] = [];
    const quads: KernelRendererOverlayPayload['quads'][number][] = [];
    if (supportVisible) {
      for (const curve of curves) {
        const points = curve.vertices.flatMap(worldPoint);
        if (points.length < 2) continue;
        const item = overlaySupportRoleGeometry(
          `draw:support:${curve.entityId}`,
          'defining_curve',
          points,
          support,
        );
        lines.push(...item.lines);
        quads.push(...item.quads);
      }
    }
    const placed = tool.vertices.at(-1)?.point;
    const pending = constructionPreview ?? tool.preview?.point;
    if (placed && pending) {
      lines.push({
        id: 'draw:preview',
        points: [placed, pending],
        widthPixels: 1.5,
        color: accent,
      });
    }
    if (pending) quads.push(overlayAnchorSquare('draw:preview:vertex', pending, accent, 6));
    return { lines, quads, labels: [] };
  }, [constructionPreview, curves, supportVisible, tool.preview, tool.vertices]);

  useEffect(() => {
    if (viewport?.isAlive()) viewport.setRendererOverlayPayload('draw', payload);
  }, [payload, viewport]);
  useEffect(
    () => () => {
      if (viewport?.isAlive()) viewport.setRendererOverlayPayload('draw', EMPTY_RENDERER_OVERLAY);
    },
    [viewport],
  );
  return null;
}

function worldPoint(point: {
  readonly x: number;
  readonly y: number;
  readonly z: number | null;
}): KernelWorldPoint[] {
  return point.z === null ? [] : [{ x: point.x, y: point.y, z: point.z }];
}
