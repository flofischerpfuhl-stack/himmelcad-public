/**
 * Sketch preferences of the sketching module (user-wide, not in documents,
 * not undoable): how circles are sized — by diameter or by radius (Shapr3D
 * shows circle dimensions as radius or diameter per setting). Persisted in
 * the renderer's `localStorage`; headless runs keep the default.
 */
import { create } from 'zustand';

export type CircleDimension = 'diameter' | 'radius';

const STORAGE_KEY = 'hcasm.assembler.sketchPreferences';

interface SketchPreferences {
  /** The circle tool's value chip and the Dimension tool on a circle use this kind. */
  circleDimension: CircleDimension;
  setCircleDimension(kind: CircleDimension): void;
}

function load(): CircleDimension {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { circleDimension?: unknown }) : null;
    return parsed?.circleDimension === 'radius' ? 'radius' : 'diameter';
  } catch {
    return 'diameter';
  }
}

export const useSketchPreferences = create<SketchPreferences>((set) => ({
  circleDimension: load(),
  setCircleDimension: (circleDimension) => {
    set({ circleDimension });
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ circleDimension }));
    } catch {
      // Storage unavailable (private mode, headless): the choice lasts for the session.
    }
  },
}));
