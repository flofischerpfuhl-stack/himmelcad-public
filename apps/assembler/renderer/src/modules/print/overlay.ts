/**
 * Viewport overlays of Print mode, as flat GL batches the scene draws after
 * the bodies (`viewport/scene.ts` `extraOverlays`): overhang triangles
 * (amber → red with the angle), thin-wall triangles (violet), the printer
 * build volume (translucent box on Z = 0, centred on the origin) and the
 * ghost of the auto-orient candidate being previewed. Colours are fixed
 * print semantics (see the legend in the Printability panel), not theme
 * tokens, so they read the same on every body colour and theme.
 */
import type { Body } from '../../foundation/geometry-kernel/types.js';
import type { FlatBatch } from '../../platform/viewport/gl.js';
import { expandBody } from '../../platform/viewport/geometry.js';
import { transformPositions } from './orientation.js';
import { usePrintStore, type PrintState } from './printStore.js';
import { buildVolumeSize } from './settings.js';

export const OVERHANG_COLOR_LOW: readonly [number, number, number] = [0.96, 0.62, 0.04];
export const OVERHANG_COLOR_HIGH: readonly [number, number, number] = [0.86, 0.15, 0.15];
export const THIN_WALL_COLOR: readonly [number, number, number] = [0.66, 0.33, 0.97];
export const BUILD_VOLUME_COLOR: readonly [number, number, number] = [0.23, 0.51, 0.96];
export const ORIENT_PREVIEW_COLOR: readonly [number, number, number] = [0.13, 0.77, 0.37];

export function rgbCss(c: readonly [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

interface CacheKey {
  report: unknown;
  bodies: readonly Body[];
  settings: unknown;
  orient: unknown;
  hidden: readonly string[];
  isolated: readonly string[] | null;
}
let cacheKey: CacheKey | null = null;
export interface PrintOverlays {
  /** On body surfaces (overhangs, thin walls): drawn below edges and highlights. */
  surface: FlatBatch[];
  /** Translucent volumes (build volume, orientation ghost): drawn last. */
  last: FlatBatch[];
}
const EMPTY: PrintOverlays = { surface: [], last: [] };
let cacheValue: PrintOverlays = EMPTY;

function sameKey(a: CacheKey, b: CacheKey): boolean {
  return (
    a.report === b.report &&
    a.settings === b.settings &&
    a.orient === b.orient &&
    a.hidden === b.hidden &&
    a.isolated === b.isolated &&
    a.bodies.length === b.bodies.length &&
    a.bodies.every((body, i) => body === b.bodies[i])
  );
}

function trianglesBatch(
  source: Float32Array,
  triangles: ArrayLike<number>,
  color: (i: number) => readonly [number, number, number],
  alpha: number,
): FlatBatch | null {
  if (triangles.length === 0) return null;
  const positions = new Float32Array(triangles.length * 9);
  const colors = new Float32Array(triangles.length * 12);
  for (let i = 0; i < triangles.length; i += 1) {
    const t = triangles[i]!;
    positions.set(source.subarray(t * 9, t * 9 + 9), i * 9);
    const c = color(i);
    for (let k = 0; k < 3; k += 1) colors.set([c[0], c[1], c[2], alpha], i * 12 + k * 4);
  }
  return { positions, colors, mode: 'triangles', depthTest: true };
}

function buildVolumeBatches(size: [number, number, number]): FlatBatch[] {
  const [w, d, h] = size;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const corners = [
    [x0, y0, 0],
    [x1, y0, 0],
    [x1, y1, 0],
    [x0, y1, 0],
    [x0, y0, h],
    [x1, y0, h],
    [x1, y1, h],
    [x0, y1, h],
  ] as const;
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const lines = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => lines.set([...corners[a!]!, ...corners[b!]!], i * 6));
  const lineColors = new Float32Array(edges.length * 8);
  for (let i = 0; i < edges.length * 2; i += 1) lineColors.set([...BUILD_VOLUME_COLOR, 0.7], i * 4);
  // Plate (both sides) and faint walls.
  const quads: [number, number, number, number, number][] = [
    [0, 1, 2, 3, 0.1],
    [0, 3, 2, 1, 0.1],
    [0, 1, 5, 4, 0.03],
    [1, 2, 6, 5, 0.03],
    [2, 3, 7, 6, 0.03],
    [3, 0, 4, 7, 0.03],
  ];
  const fill: number[] = [];
  const fillColors: number[] = [];
  for (const [a, b, c, e, alpha] of quads) {
    for (const i of [a, b, c, a, c, e]) {
      fill.push(...corners[i]!);
      fillColors.push(...BUILD_VOLUME_COLOR, alpha);
    }
  }
  return [
    {
      positions: new Float32Array(fill),
      colors: new Float32Array(fillColors),
      mode: 'triangles',
      depthTest: true,
      noClip: true,
    },
    { positions: lines, colors: lineColors, mode: 'lines', depthTest: true, noClip: true },
  ];
}

/** The Print-mode overlay batches for the displayed `bodies` (empty when Print mode is off). */
export function printOverlayBatches(
  bodies: readonly Body[],
  hiddenBodyIds: readonly string[],
  isolatedBodyIds: readonly string[] | null,
  state: PrintState = usePrintStore.getState(),
): PrintOverlays {
  if (!state.enabled) return EMPTY;
  const key: CacheKey = {
    report: state.report,
    bodies,
    settings: state.settings,
    orient: state.orient,
    hidden: hiddenBodyIds,
    isolated: isolatedBodyIds,
  };
  if (cacheKey && sameKey(cacheKey, key)) return cacheValue;
  const batches: FlatBatch[] = [];
  const last: FlatBatch[] = [];
  const hidden = new Set(hiddenBodyIds);
  const isolated = isolatedBodyIds ? new Set(isolatedBodyIds) : null;
  const visible = bodies.filter((b) => !hidden.has(b.id) && (!isolated || isolated.has(b.id)));
  const report = state.report;
  const settings = state.settings;
  const analysed = state.reportEvaluation?.bodies ?? [];
  if (report) {
    for (const body of visible) {
      // Only draw results computed from exactly this mesh (a stale report would be misaligned).
      const source = analysed.find((b) => b.id === body.id);
      if (!source || source.mesh !== body.mesh) continue;
      const result = report.bodies.find((r) => r.bodyId === body.id);
      if (!result) continue;
      const expanded = expandBody(body).positions;
      if (settings.showOverhangs) {
        const span = Math.max(1e-6, 90 - settings.overhangAngleDeg);
        const batch = trianglesBatch(
          expanded,
          result.overhang.triangles,
          (i) => {
            const f = Math.min(
              1,
              Math.max(0, (result.overhang.angles[i]! - settings.overhangAngleDeg) / span),
            );
            return [
              OVERHANG_COLOR_LOW[0] + (OVERHANG_COLOR_HIGH[0] - OVERHANG_COLOR_LOW[0]) * f,
              OVERHANG_COLOR_LOW[1] + (OVERHANG_COLOR_HIGH[1] - OVERHANG_COLOR_LOW[1]) * f,
              OVERHANG_COLOR_LOW[2] + (OVERHANG_COLOR_HIGH[2] - OVERHANG_COLOR_LOW[2]) * f,
            ];
          },
          0.72,
        );
        if (batch) batches.push(batch);
      }
      if (settings.showThinWalls) {
        const batch = trianglesBatch(
          expanded,
          result.thinWall.triangles,
          () => THIN_WALL_COLOR,
          0.8,
        );
        if (batch) batches.push(batch);
      }
    }
  }
  const orient = state.orient;
  if (orient && orient.preview !== null) {
    const candidate = orient.candidates[orient.preview];
    const body = bodies.find((b) => b.id === orient.bodyId);
    if (candidate && body) {
      const moved = transformPositions(expandBody(body).positions, candidate.transform);
      const colors = new Float32Array((moved.length / 3) * 4);
      for (let i = 0; i < colors.length; i += 4) colors.set([...ORIENT_PREVIEW_COLOR, 0.35], i);
      last.push({ positions: moved, colors, mode: 'triangles', depthTest: true });
    }
  }
  const volume = buildVolumeSize(settings);
  if (volume && settings.showBuildVolume) last.push(...buildVolumeBatches(volume));
  cacheKey = key;
  cacheValue = { surface: batches, last };
  return cacheValue;
}
