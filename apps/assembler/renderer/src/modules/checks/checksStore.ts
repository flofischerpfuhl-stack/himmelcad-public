/**
 * The checks module's state (assembler/CHECKS.md). The stored checks are
 * document state in the store core (`AssemblerState.checks`, undo-tracked);
 * here live what is derived or view-only:
 *
 * - the store slice: whether the Checks panel is open (the shell's right
 *   column reads it);
 * - `useCheckResults`: the latest result per check, the evaluation they
 *   belong to (older ones are shown as out of date), whether a background
 *   run is going on, and the check the panel focuses or edits.
 */
import { create } from 'zustand';

import type { CheckResult } from '../../foundation/commands/checks.js';
import type { StoreSliceCreator } from '../../foundation/commands/store.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';

export interface ChecksSlice {
  /** The Checks panel is shown (right column, between Parameters and History). */
  checksPanelOpen: boolean;
  setChecksPanelOpen: (open: boolean) => void;
}

declare module '../../foundation/commands/store.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AssemblerStateExtensions extends ChecksSlice {}
}

export const createChecksSlice: StoreSliceCreator<ChecksSlice> = (set) => ({
  checksPanelOpen: false,
  setChecksPanelOpen: (open) => set({ checksPanelOpen: open }),
});

export interface CheckResultsState {
  /** Latest result per check id. */
  results: Record<string, CheckResult>;
  /** The evaluation the results were computed for (`null`: none yet). */
  evaluatedFor: EvaluationResult | null;
  /** A background run is going on. */
  running: boolean;
  progress: { done: number; total: number } | null;
  /** Check the panel shows located in the viewport (its markers are drawn). */
  focusedId: string | null;
  /** Check open in the panel's editor (`'new'` with `draft` while adding one). */
  editingId: string | null;
  draft: { kind: string; params: Record<string, unknown> } | null;
}

export const useCheckResults = create<CheckResultsState>(() => ({
  results: {},
  evaluatedFor: null,
  running: false,
  progress: null,
  focusedId: null,
  editingId: null,
  draft: null,
}));
