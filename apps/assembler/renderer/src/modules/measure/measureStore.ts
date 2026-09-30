/**
 * Measure mode state: pinned measurements (saved with the project, in the
 * `.hcasm` view state — they are references, re-measured on every change),
 * measured points picked in the viewport, the panel position, and the
 * kernel's exact minimum-distance results (`BRepExtrema`, one request at a
 * time per pair, cached per evaluated document). Not undo-tracked; pinning
 * and deleting pins marks the project dirty like saved views do.
 */
import { create } from 'zustand';

import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import type { DistanceTarget, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { Feature } from '../../foundation/document/document.js';
import { usePreferences } from '../../platform/input/preferences.js';
import { refKey, type DistanceResult, type MeasureRef, type Vec3 } from './measure.js';

export interface PinnedMeasurement {
  id: string;
  refs: MeasureRef[];
  /** Dimension overlay in the viewport. */
  showInViewport: boolean;
}

export type KernelDistanceState = DistanceResult | 'pending' | 'failed';

export interface MeasureState {
  pins: PinnedMeasurement[];
  /** Points picked with the Point tool (at most two). */
  points: MeasureRef[];
  /** The Point tool is on: viewport clicks pick measured points instead of selecting. */
  pointMode: boolean;
  /** Panel position (host-relative CSS px), `null` = default dock. */
  panelPosition: { x: number; y: number } | null;
  /** Kernel minimum-distance results for the current evaluation, by pair key. */
  distances: Record<string, KernelDistanceState>;

  pin: (refs: MeasureRef[]) => void;
  unpin: (id: string) => void;
  toggleOverlay: (id: string) => void;
  setPins: (pins: PinnedMeasurement[]) => void;
  clearPins: () => void;
  addPoint: (point: Vec3, label: string) => void;
  clearPoints: () => void;
  setPointMode: (on: boolean) => void;
  setPanelPosition: (position: { x: number; y: number } | null) => void;

  attachKernel: (adapter: KernelAdapter) => void;
  /**
   * The exact minimum distance of two references for `features` (the
   * evaluated document), or `null` when the kernel cannot answer (reference
   * meshes, no kernel). Starts a kernel request on first use; the result
   * arrives through `distances`.
   */
  kernelDistance: (
    features: readonly Feature[],
    evaluation: EvaluationResult,
    a: MeasureRef,
    b: MeasureRef,
  ) => KernelDistanceState | null;
}

let kernel: KernelAdapter | null = null;
/** The evaluation the cached distances belong to. */
let distancesFor: EvaluationResult | null = null;
let nextPinId = 1;

export function pairKey(a: MeasureRef, b: MeasureRef): string {
  return `${refKey(a)}~${refKey(b)}`;
}

export const useMeasureStore = create<MeasureState>((set, get) => ({
  pins: [],
  points: [],
  pointMode: false,
  // The last dragged position is a layout preference (remembered across sessions).
  panelPosition: usePreferences.getState().measurePanelPosition,
  distances: {},

  pin: (refs) => {
    if (refs.length === 0) return;
    const key = refs.map(refKey).join('~');
    if (get().pins.some((p) => p.refs.map(refKey).join('~') === key)) return;
    set((s) => ({
      pins: [
        ...s.pins,
        { id: `m${Date.now().toString(36)}${nextPinId++}`, refs, showInViewport: true },
      ],
    }));
  },
  unpin: (id) => set((s) => ({ pins: s.pins.filter((p) => p.id !== id) })),
  toggleOverlay: (id) =>
    set((s) => ({
      pins: s.pins.map((p) => (p.id === id ? { ...p, showInViewport: !p.showInViewport } : p)),
    })),
  setPins: (pins) => set({ pins }),
  clearPins: () => set({ pins: [] }),
  addPoint: (point, label) =>
    set((s) => {
      const next: MeasureRef = { kind: 'point', point, label };
      // A third point starts a new pair.
      return { points: s.points.length >= 2 ? [next] : [...s.points, next] };
    }),
  clearPoints: () => set({ points: [] }),
  setPointMode: (on) => set(on ? { pointMode: true } : { pointMode: false, points: [] }),
  setPanelPosition: (position) => set({ panelPosition: position }),

  attachKernel: (adapter) => {
    kernel = adapter;
  },
  kernelDistance: (features, evaluation, a, b) => {
    if (!kernel?.measureDistance) return null;
    if (!toTarget(a) || !toTarget(b)) return null;
    if (kernel.status.status !== 'ready') return null;
    if (distancesFor !== evaluation) {
      distancesFor = evaluation;
      // A new document state: earlier results no longer apply (set outside render).
      queueMicrotask(() => set({ distances: {} }));
      return request(features, evaluation, a, b);
    }
    const known = get().distances[pairKey(a, b)];
    if (known) return known;
    return request(features, evaluation, a, b);
  },
}));

/** Pairs requested per evaluation (a newer evaluation starts over). */
const inFlight = new WeakMap<EvaluationResult, Set<string>>();

function request(
  features: readonly Feature[],
  evaluation: EvaluationResult,
  a: MeasureRef,
  b: MeasureRef,
): 'pending' {
  const key = pairKey(a, b);
  let requested = inFlight.get(evaluation);
  if (!requested) {
    requested = new Set();
    inFlight.set(evaluation, requested);
  }
  if (requested.has(key)) return 'pending';
  requested.add(key);
  const adapter = kernel!;
  void adapter.measureDistance!(features, toTarget(a)!, toTarget(b)!).then(
    (result) => {
      if (distancesFor !== evaluation) return;
      useMeasureStore.setState((s) => ({
        distances: { ...s.distances, [key]: { ...result, approx: false } },
      }));
    },
    () => {
      if (distancesFor !== evaluation) return;
      useMeasureStore.setState((s) => ({ distances: { ...s.distances, [key]: 'failed' } }));
    },
  );
  return 'pending';
}

/** The kernel's form of a reference; `null` for reference meshes (never a kernel input). */
function toTarget(ref: MeasureRef): DistanceTarget | null {
  switch (ref.kind) {
    case 'mesh':
      return null;
    case 'point':
      return { kind: 'point', point: ref.point };
    default:
      return ref;
  }
}

// ---- persistence ------------------------------------------------------------------------------

export function serializePins(pins: readonly PinnedMeasurement[]): unknown[] {
  return pins.map((p) => ({ refs: p.refs, showInViewport: p.showInViewport }));
}

function parseRef(raw: unknown): MeasureRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  switch (r.kind) {
    case 'body':
      return str(r.bodyId) ? { kind: 'body', bodyId: r.bodyId } : null;
    case 'face':
      return str(r.bodyId) && str(r.faceKey)
        ? { kind: 'face', bodyId: r.bodyId, faceKey: r.faceKey }
        : null;
    case 'edge':
      return str(r.bodyId) && str(r.edgeKey)
        ? { kind: 'edge', bodyId: r.bodyId, edgeKey: r.edgeKey }
        : null;
    case 'mesh':
      return str(r.meshId) ? { kind: 'mesh', meshId: r.meshId } : null;
    case 'point': {
      const p = r.point;
      if (
        !Array.isArray(p) ||
        p.length !== 3 ||
        !p.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        return null;
      }
      return {
        kind: 'point',
        point: [p[0] as number, p[1] as number, p[2] as number],
        label: typeof r.label === 'string' ? r.label : 'Point',
      };
    }
    default:
      return null;
  }
}

/** Pinned measurements from a project file; malformed entries are dropped. */
export function parsePins(raw: unknown): PinnedMeasurement[] {
  if (!Array.isArray(raw)) return [];
  const out: PinnedMeasurement[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e.refs) || e.refs.length === 0 || e.refs.length > 16) continue;
    const refs = e.refs.map(parseRef);
    if (refs.some((r) => r === null)) continue;
    out.push({
      id: `m${nextPinId++}`,
      refs: refs as MeasureRef[],
      showInViewport: typeof e.showInViewport === 'boolean' ? e.showInViewport : true,
    });
  }
  return out;
}
