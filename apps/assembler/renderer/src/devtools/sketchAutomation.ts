/**
 * DEV-ONLY sketch-mode helpers merged into `window.__assembler` (see
 * `automationHook.ts`): sketch (u, v) → page pixels for the open sketch
 * session (or any evaluated sketch), a summary of the session, the screen
 * position of a dimension chip, and an idle wait for the solver queue.
 * Not part of the product contract.
 */
import { framePoint, type SketchFrame } from '../model/document.js';
import { useAssemblerStore } from '../model/store.js';
import { useSketchStore } from '../sketch/session.js';
import type { Vec2 } from '../sketch/types.js';
import { getViewportProbe, type ScreenPoint } from '../viewport/automation.js';

export interface SketchAutomation {
  sketchStore: typeof useSketchStore;
  /** Page pixel of sketch coordinates in the open session (or in sketch `featureId`). */
  sketchToScreen(uv: Vec2, featureId?: string): ScreenPoint | null;
  /** Summary of the open sketch session, or `null`. */
  sketchSession(): {
    featureId: string;
    tool: string;
    dof: number;
    solving: boolean;
    problem: string | null;
    entities: number;
    constraints: string[];
    dimensions: { id: string; name: string; kind: string; value: number }[];
    selection: string[];
  } | null;
  /** Centre of the value chip of dimension `name` (e.g. `"d1"`), or `null`. */
  dimensionChip(name: string): ScreenPoint | null;
  /** Resolves when no sketch edit/drag solve is pending and the frame is drawn. */
  waitForSketchIdle(): Promise<void>;
}

function frameFor(featureId?: string): SketchFrame | null {
  const session = useSketchStore.getState().session;
  if (session && (!featureId || featureId === session.featureId)) return session.frame;
  if (!featureId) return null;
  return (
    useAssemblerStore.getState().evaluation.sketches.find((s) => s.featureId === featureId)
      ?.frame ?? null
  );
}

export function sketchAutomation(): SketchAutomation {
  return {
    sketchStore: useSketchStore,
    sketchToScreen: (uv, featureId) => {
      const frame = frameFor(featureId);
      if (!frame) return null;
      return getViewportProbe()?.project(framePoint(frame, uv[0], uv[1])) ?? null;
    },
    sketchSession: () => {
      const s = useSketchStore.getState().session;
      if (!s) return null;
      return {
        featureId: s.featureId,
        tool: s.tool.kind,
        dof: s.dof,
        solving: s.solving,
        problem: s.problem?.message ?? null,
        entities: s.sketch.entities.length,
        constraints: s.sketch.constraints.map((c) => c.kind),
        dimensions: s.sketch.dimensions.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          value: d.value,
        })),
        selection: [...s.selection],
      };
    },
    dimensionChip: (name) => {
      const el = document.querySelector(`[aria-label^="Dimension ${name}:"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    waitForSketchIdle: async () => {
      await useSketchStore.getState().whenIdle();
      await useAssemblerStore.getState().whenSettled();
      await (getViewportProbe()?.nextFrame() ?? Promise.resolve());
    },
  };
}
