import { useEffect, useMemo, useRef, useState } from 'react';

import {
  measurementAnchorPosition,
  measurementLabel,
  measurementValue,
  type MeasurementToolSnapshot,
} from '@himmelcad/app';
import {
  cssColorToLinearRgba,
  EMPTY_RENDERER_OVERLAY,
  overlayAnchorSquare,
  overlayMidpointPixelOffset,
  type KernelRendererOverlayPayload,
  type KernelWorldCamera,
  type KernelWorldPoint,
} from '@himmelcad/viewer/kernel';

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
 * Renderer-native V-05 projection. The hidden host supplies extent/theme
 * tokens; every visible line, square and chip is submitted in protected lanes.
 */
export function MeasurementViewportOverlay({
  viewport,
  measurements,
  tool,
  selected,
}: MeasurementViewportOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cameraKeyRef = useRef('');
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
      const next = viewport?.worldCamera() ?? null;
      const nextKey = JSON.stringify(next);
      if (cameraKeyRef.current !== nextKey) {
        cameraKeyRef.current = nextKey;
        setCamera(next);
      }
      frame = window.requestAnimationFrame(sample);
    };
    frame = window.requestAnimationFrame(sample);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [viewport]);

  const payload = useMemo<KernelRendererOverlayPayload>(() => {
    if (!camera || size.width === 0 || size.height === 0) return EMPTY_RENDERER_OVERLAY;
    const computed = rootRef.current ? getComputedStyle(rootRef.current) : null;
    const color = (token: string, fallback: string) =>
      cssColorToLinearRgba(computed?.getPropertyValue(token).trim() || fallback);
    const support = color('--hc-geometry-support', '#43b9ff');
    const selection = color('--hc-geometry-selection', '#ff9f1c');
    const foreground = color('--hc-fg-strong', '#f5f7fa');
    const background = color('--hc-island-high', '#20242bfa');
    const halo = color('--hc-geometry-support-halo', '#101114');
    const lines: KernelRendererOverlayPayload['lines'][number][] = [];
    const quads: KernelRendererOverlayPayload['quads'][number][] = [];
    const labels: KernelRendererOverlayPayload['labels'][number][] = [];
    const append = (
      id: string,
      anchors: readonly KernelWorldPoint[],
      label: string,
      selected: boolean,
      preview = false,
    ): void => {
      const projected = anchors.map((point) =>
        projectWorldPoint(camera, point, size.width, size.height),
      );
      if (projected.some((point) => point === null)) return;
      const screen = projected as { readonly x: number; readonly y: number }[];
      const active = selected ? selection : support;
      if (anchors.length > 1) {
        lines.push({ id: `${id}:line`, points: anchors, widthPixels: 1.5, color: active });
      }
      anchors.forEach((anchor, index) => {
        quads.push(overlayAnchorSquare(`${id}:anchor:${index}`, anchor, active, 6));
      });
      const first = screen[0]!;
      const last = screen.at(-1)!;
      labels.push({
        id: `${id}:label`,
        anchor: anchors[0]!,
        pixelOffset: overlayMidpointPixelOffset([first.x, first.y], [last.x, last.y]),
        text: label,
        heightPixels: 12,
        textColor: preview ? support : foreground,
        backgroundColor: background,
        borderColor: selected ? selection : halo,
      });
    };
    for (const item of measurements) {
      if (!item.measurement.visible) continue;
      const anchors = item.measurement.anchors.flatMap((anchor) => {
        const point = measurementAnchorPosition(anchor);
        return point.z === null ? [] : [{ x: point.x, y: point.y, z: point.z }];
      });
      if (anchors.length !== item.measurement.anchors.length) continue;
      append(
        item.entityId,
        anchors,
        measurementLabel(
          measurementValue(
            item.measurement.measurementKind,
            item.measurement.metric,
            item.measurement.anchors,
          ),
          DISPLAY,
          pixelsPerMetre(camera, size.height),
          6,
        ),
        selected.has(item.entityId),
      );
    }
    const pendingAnchors = tool.preview ? [...tool.anchors, tool.preview] : [...tool.anchors];
    const previewAnchors: KernelWorldPoint[] = pendingAnchors.flatMap((anchor) => {
      const point = measurementAnchorPosition(anchor);
      if (point.z === null) return [];
      return [{ x: point.x, y: point.y, z: point.z }];
    });
    if (
      tool.armed &&
      previewAnchors.length === pendingAnchors.length &&
      previewAnchors.length > 0
    ) {
      append(
        'measurement-preview',
        previewAnchors,
        measurementLabel(tool.liveValue, DISPLAY, pixelsPerMetre(camera, size.height), 6),
        false,
        true,
      );
    }
    return { lines, quads, labels };
  }, [camera, measurements, selected, size.height, size.width, tool]);

  useEffect(() => {
    viewport?.setRendererOverlayPayload('measurements', payload);
  }, [payload, viewport]);

  useEffect(
    () => () => {
      viewport?.setRendererOverlayPayload('measurements', EMPTY_RENDERER_OVERLAY);
    },
    [viewport],
  );

  return (
    <div
      ref={rootRef}
      aria-label="Measurement graphics rendered in the viewport"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
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
