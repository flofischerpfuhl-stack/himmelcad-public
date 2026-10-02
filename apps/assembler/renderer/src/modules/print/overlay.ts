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
import { usePreferences } from '../../platform/input/preferences.js';
import type { PrintFinding } from './analysis.js';
import { transformPositions } from './orientation.js';
import { usePrintStore, visibleFindings, type PrintState } from './printStore.js';
import { buildVolumeSize } from './settings.js';

export const OVERHANG_COLOR_LOW: readonly [number, number, number] = [0.96, 0.62, 0.04];
export const OVERHANG_COLOR_HIGH: readonly [number, number, number] = [0.86, 0.15, 0.15];
export const THIN_WALL_COLOR: readonly [number, number, number] = [0.66, 0.33, 0.97];
export const BUILD_VOLUME_COLOR: readonly [number, number, number] = [0.23, 0.51, 0.96];
export const ORIENT_PREVIEW_COLOR: readonly [number, number, number] = [0.13, 0.77, 0.37];
/** Closest points of a gap below the minimum clearance. */
export const CLEARANCE_COLOR: readonly [number, number, number] = [0.98, 0.45, 0.09];
/** Marker at the centre of two bodies' shared volume. */
export const OVERLAP_COLOR: readonly [number, number, number] = [0.94, 0.17, 0.42];

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
  ignored: readonly string[];
  hiddenKinds: readonly string[];
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
    a.ignored === b.ignored &&
    a.hiddenKinds === b.hiddenKinds &&
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

/**
 * Lines for clearance findings (the closest points, with end ticks) and
 * overlap findings (a cross at the shared volume's centre), sized to the
 * bodies involved.
 */
function markerBatch(findings: readonly PrintFinding[], bodies: readonly Body[]): FlatBatch | null {
  if (findings.length === 0) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  const line = (a: readonly number[], b: readonly number[], c: readonly number[]) => {
    positions.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
    colors.push(c[0]!, c[1]!, c[2]!, 1, c[0]!, c[1]!, c[2]!, 1);
  };
  const cross = (p: readonly number[], size: number, c: readonly number[]) => {
    for (let axis = 0; axis < 3; axis += 1) {
      const a = [...p];
      const b = [...p];
      a[axis]! -= size;
      b[axis]! += size;
      line(a, b, c);
    }
  };
  for (const f of findings) {
    const involved = bodies.filter((b) => b.id === f.bodyId || b.id === f.otherBodyId);
    const diagonal = Math.max(
      1,
      ...involved.map((b) =>
        Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]),
      ),
    );
    const size = Math.min(5, diagonal * 0.03);
    if (f.kind === 'clearance' && f.segment) {
      line(f.segment[0], f.segment[1], CLEARANCE_COLOR);
      cross(f.segment[0], size * 0.4, CLEARANCE_COLOR);
      cross(f.segment[1], size * 0.4, CLEARANCE_COLOR);
    } else if (f.kind === 'overlap' && f.point) {
      cross(f.point, size, OVERLAP_COLOR);
    }
  }
  if (positions.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    mode: 'lines',
    depthTest: false,
  };
}

/** The Print-mode overlay batches for the displayed `bodies` (empty when Print mode is off). */
export function printOverlayBatches(
  bodies: readonly Body[],
  hiddenBodyIds: readonly string[],
  isolatedBodyIds: readonly string[] | null,
  state: PrintState = usePrintStore.getState(),
): PrintOverlays {
  if (!state.enabled) return EMPTY;
  const hiddenKinds = usePreferences.getState().hiddenPrintFindings;
  const key: CacheKey = {
    report: state.report,
    bodies,
    settings: state.settings,
    orient: state.orient,
    hidden: hiddenBodyIds,
    isolated: isolatedBodyIds,
    ignored: state.ignored,
    hiddenKinds,
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
    // Clearance and overlap markers of the listed findings, drawn through the bodies.
    const current = (id: string | undefined) => {
      if (!id) return true;
      const body = bodies.find((b) => b.id === id);
      const source = analysed.find((b) => b.id === id);
      return !!body && !!source && source.mesh === body.mesh && visible.includes(body);
    };
    const markers = visibleFindings(report.findings, state.ignored, hiddenKinds).filter(
      (f) =>
        (f.kind === 'clearance' || f.kind === 'overlap') &&
        current(f.bodyId) &&
        current(f.otherBodyId),
    );
    const marker = markerBatch(markers, visible);
    if (marker) last.push(marker);
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
