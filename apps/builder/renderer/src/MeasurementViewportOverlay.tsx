import { useEffect, useMemo, useRef, useState } from 'react';

import {
  measurementAnchorPosition,
  measurementLabel,
  measurementValue,
  type MeasurementToolSnapshot,
} from '@himmelcad/app';
import { MeasurementGraphics, type MeasurementGraphicItem } from '@himmelcad/ui';
import type { KernelWorldCamera, KernelWorldPoint } from '@himmelcad/viewer/kernel';

import type { BuilderKernelViewportHandle } from './BuilderKernelViewport.js';
import type { BuilderMeasurementSummary } from './project.js';

const DISPLAY = { lengthUnit: 'm' as const, maximumDecimals: 6 };

export interface MeasurementViewportOverlayProps {
  readonly viewport: BuilderKernelViewportHandle | null;
  readonly measurements: readonly BuilderMeasurementSummary[];
  readonly tool: MeasurementToolSnapshot;
  readonly selected: ReadonlySet<string>;
  readonly onSelect: (entityId: string) => void;
}

/**
 * View-local DOM projection for V-05 glyphs. It samples the authoritative
 * world camera once per animation frame, so the labels cannot trail the
 * presented camera/cursor state by more than one frame.
 */
export function MeasurementViewportOverlay({
  viewport,
  measurements,
  tool,
  selected,
  onSelect,
}: MeasurementViewportOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [camera, setCamera] = useState<KernelWorldCamera | null>(
    () => viewport?.worldCamera() ?? null,
  );
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const update = (): void => setSize({ width: root.clientWidth, height: root.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    let cancelled = false;
    const sample = (): void => {
      if (cancelled) return;
      setCamera(viewport?.worldCamera() ?? null);
      frame = window.requestAnimationFrame(sample);
    };
    frame = window.requestAnimationFrame(sample);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [viewport]);

  const items = useMemo(() => {
    if (!camera || size.width === 0 || size.height === 0) return [];
    const committed = measurements.flatMap((item): MeasurementGraphicItem[] => {
      if (!item.measurement.visible) return [];
      const anchors = item.measurement.anchors.map(measurementAnchorPosition).flatMap((point) => {
        if (point.z === null) return [];
        const projected = projectWorldPoint(
          camera,
          { x: point.x, y: point.y, z: point.z },
          size.width,
          size.height,
        );
        return projected ? [projected] : [];
      });
      if (anchors.length !== item.measurement.anchors.length) return [];
      return [
        {
          id: item.entityId,
          anchors,
          label: measurementLabel(
            measurementValue(
              item.measurement.measurementKind,
              item.measurement.metric,
              item.measurement.anchors,
            ),
            DISPLAY,
            pixelsPerMetre(camera, size.height),
            6,
          ),
          selected: selected.has(item.entityId),
        },
      ];
    });
    const pendingAnchors = tool.preview ? [...tool.anchors, tool.preview] : [...tool.anchors];
    const previewAnchors = pendingAnchors.flatMap((anchor) => {
      const point = measurementAnchorPosition(anchor);
      if (point.z === null) return [];
      const projected = projectWorldPoint(
        camera,
        { x: point.x, y: point.y, z: point.z },
        size.width,
        size.height,
      );
      return projected ? [projected] : [];
    });
    if (
      !tool.armed ||
      previewAnchors.length !== pendingAnchors.length ||
      previewAnchors.length === 0
    ) {
      return committed;
    }
    return [
      ...committed,
      {
        id: 'measurement-preview',
        anchors: previewAnchors,
        label: measurementLabel(tool.liveValue, DISPLAY, pixelsPerMetre(camera, size.height), 6),
        preview: true,
      },
    ];
  }, [camera, measurements, selected, size.height, size.width, tool]);

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <MeasurementGraphics items={items} onSelect={onSelect} />
    </div>
  );
}

export function projectWorldPoint(
  camera: KernelWorldCamera,
  point: KernelWorldPoint,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } | null {
  const forward = normalize(subtract(camera.target, camera.eye));
  const right = normalize(cross(forward, camera.up));
  const up = cross(right, forward);
  const relative = subtract(point, camera.eye);
  const depth = dot(relative, forward);
  if (depth < camera.projection.near || depth > camera.projection.far) return null;
  const cameraX = dot(relative, right);
  const cameraY = dot(relative, up);
  let x: number;
  let y: number;
  if (camera.projection.kind === 'perspective') {
    const halfHeight = depth * Math.tan(camera.projection.verticalFovRadians / 2);
    x = cameraX / (halfHeight * camera.projection.aspect);
    y = cameraY / halfHeight;
  } else {
    x = cameraX / ((camera.projection.verticalSpan * camera.projection.aspect) / 2);
    y = cameraY / (camera.projection.verticalSpan / 2);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1.2 || Math.abs(y) > 1.2) {
    return null;
  }
  return { x: ((x + 1) * width) / 2, y: ((1 - y) * height) / 2 };
}

function pixelsPerMetre(camera: KernelWorldCamera, viewportHeight: number): number {
  if (camera.projection.kind === 'orthographic') {
    return viewportHeight / camera.projection.verticalSpan;
  }
  const distance = length(subtract(camera.target, camera.eye));
  return viewportHeight / (2 * distance * Math.tan(camera.projection.verticalFovRadians / 2));
}

function subtract(left: KernelWorldPoint, right: KernelWorldPoint): KernelWorldPoint {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left: KernelWorldPoint, right: KernelWorldPoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: KernelWorldPoint, right: KernelWorldPoint): KernelWorldPoint {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function length(value: KernelWorldPoint): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value: KernelWorldPoint): KernelWorldPoint {
  const magnitude = length(value);
  if (!(magnitude > 0)) return { x: 0, y: 0, z: 0 };
  return { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude };
}
