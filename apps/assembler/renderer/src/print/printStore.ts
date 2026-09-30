/**
 * Print mode state (Printability analysis, build-plate tools, export
 * dialogs). View state like Section/Measure: not saved in the project, not
 * undo-tracked. Settings persist per user in `localStorage`.
 *
 * Lifecycle: while Print mode is on, every change of the evaluated document
 * (or of the analysis settings) schedules a new analysis after
 * {@link ANALYSIS_DEBOUNCE_MS}; a newer request cancels the running one
 * (the worker is terminated). Results carry the evaluation they belong to,
 * so a stale report is never shown as current (`reportStale`).
 */
import { create } from 'zustand';

import type { Body, EvaluationResult } from '../kernel/types.js';
import { withDisplayNames, useItemsStore } from '../model/items.js';
import { useAssemblerStore, type SelectionItem } from '../model/store.js';
import { useWorkspaceStore } from '../model/workspace.js';
import { bodyToPrintInput, type PrintFinding, type PrintReport } from './analysis.js';
import type { OrientationCandidate } from './orientation.js';
import {
  isIdentityPlacement,
  orientationInput,
  orientFeatureName,
  placeOnPlateFeature,
  placementFeature,
  PlacementError,
} from './placement.js';
import { PrintabilityRunner, PrintJobCancelled, type PrintJob } from './runner.js';
import {
  DEFAULT_PRINT_SETTINGS,
  MATERIAL_PRESETS,
  sanitizePrintSettings,
  type PrintSettings,
} from './settings.js';

export const ANALYSIS_DEBOUNCE_MS = 350;
const STORAGE_KEY = 'hcasm.print.settings.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadSettings(): PrintSettings {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    return raw ? sanitizePrintSettings(JSON.parse(raw)) : { ...DEFAULT_PRINT_SETTINGS };
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

export type AnalysisStatus = 'idle' | 'scheduled' | 'running' | 'done' | 'error' | 'cancelled';

export interface OrientState {
  bodyId: string;
  status: 'running' | 'done' | 'error';
  candidates: OrientationCandidate[];
  /** Candidate shown as a ghost in the viewport (index into `candidates`), or `null`. */
  preview: number | null;
  error?: string;
}

export interface PrintState {
  /** Print mode (Printability panel + overlays) on. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  settings: PrintSettings;
  updateSettings: (patch: Partial<PrintSettings>) => void;
  /** Selects a material preset (fills density and price) or `custom`. */
  setMaterial: (id: PrintSettings['material']) => void;

  status: AnalysisStatus;
  progress: { fraction: number; label: string } | null;
  report: PrintReport | null;
  /** The evaluation `report` was computed from. */
  reportEvaluation: EvaluationResult | null;
  error: string | null;
  /** Re-runs the analysis now. */
  analyzeNow: () => void;
  /** Cancels the running analysis (the last report stays, marked stale). */
  cancelAnalysis: () => void;

  focusedFindingId: string | null;
  /** Selects and frames a finding's faces (or its body). */
  focusFinding: (finding: PrintFinding | null) => void;

  /** "Place on plate" pick state: waiting for a flat face of this body. */
  placePicking: string | null;
  startPlacePicking: (bodyId: string) => void;
  cancelPlacePicking: () => void;
  /** Lays the face flat on the plate (one undo step). Returns an error text or `null`. */
  placeOnPlate: (bodyId: string, faceKey: string) => string | null;

  orient: OrientState | null;
  startAutoOrient: (bodyId: string) => void;
  previewOrientation: (index: number | null) => void;
  applyOrientation: (index: number) => void;
  closeOrient: () => void;

  stlDialogOpen: boolean;
  setStlDialogOpen: (open: boolean) => void;
  slicerDialogOpen: boolean;
  setSlicerDialogOpen: (open: boolean) => void;
}

let runner = new PrintabilityRunner(null);
let job: PrintJob<unknown> | null = null;
let orientJob: PrintJob<unknown> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let installed = false;

/** Installs the worker-backed runner (app). Without it jobs run inline (tests, headless). */
export function setPrintRunner(next: PrintabilityRunner): void {
  runner.dispose();
  runner = next;
}

let agentRunner = new PrintabilityRunner(null);

/** The runner for agent-API printability queries (own worker: never cancels the panel's job). */
export function setAgentPrintRunner(next: PrintabilityRunner): void {
  agentRunner.dispose();
  agentRunner = next;
}

/** `SessionHost.printability` of the app: agent queries run in the print worker. */
export const agentPrintability = {
  analyze: (bodies: Parameters<PrintabilityRunner['analyze']>[0], settings: PrintSettings) =>
    agentRunner.analyze(bodies, settings).promise,
  orient: (
    mesh: Parameters<PrintabilityRunner['orient']>[0],
    thresholdDeg: number,
    faceLabels: string[],
  ) => agentRunner.orient(mesh, thresholdDeg, faceLabels).promise,
};

/** Bodies the analysis covers, with the user's display names. */
function analysedBodies(evaluation: EvaluationResult): Body[] {
  return withDisplayNames(evaluation.bodies, useItemsStore.getState());
}

export const usePrintStore = create<PrintState>((set, get) => {
  function schedule(): void {
    if (!get().enabled) return;
    if (debounce) clearTimeout(debounce);
    set({ status: 'scheduled' });
    debounce = setTimeout(() => {
      debounce = null;
      run();
    }, ANALYSIS_DEBOUNCE_MS);
  }

  function run(): void {
    if (!get().enabled) return;
    const doc = useAssemblerStore.getState();
    if (doc.evaluationPending) {
      // The document is still evaluating: the evaluation change will schedule again.
      set({ status: 'scheduled' });
      return;
    }
    const evaluation = doc.evaluation;
    const bodies = analysedBodies(evaluation).map(bodyToPrintInput);
    job?.cancel();
    if (bodies.length === 0) {
      set({
        status: 'done',
        progress: null,
        report: {
          settings: get().settings,
          bodies: [],
          findings: [],
          totals: { bodies: 0, volumeMm3: 0, massG: 0, cost: 0 },
          ms: 0,
        },
        reportEvaluation: evaluation,
        error: null,
      });
      return;
    }
    const current = runner.analyze(bodies, get().settings, (fraction, label) =>
      set({ progress: { fraction, label } }),
    );
    job = current;
    set({ status: 'running', progress: { fraction: 0, label: 'Starting…' }, error: null });
    current.promise.then(
      (report) => {
        if (job !== current) return;
        job = null;
        set({ status: 'done', progress: null, report, reportEvaluation: evaluation });
      },
      (error: unknown) => {
        if (job !== current) return;
        job = null;
        if (error instanceof PrintJobCancelled) {
          set({ status: 'cancelled', progress: null });
          return;
        }
        set({
          status: 'error',
          progress: null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  function persist(settings: PrintSettings): void {
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Best-effort: settings stay for this session.
    }
  }

  return {
    enabled: false,
    setEnabled: (on) => {
      if (on === get().enabled) return;
      installPrintSubscriptions();
      if (!on) {
        if (debounce) clearTimeout(debounce);
        debounce = null;
        job?.cancel();
        job = null;
        orientJob?.cancel();
        orientJob = null;
        set({
          enabled: false,
          status: 'idle',
          progress: null,
          focusedFindingId: null,
          orient: null,
          placePicking: null,
        });
        return;
      }
      set({ enabled: true });
      schedule();
    },
    settings: loadSettings(),
    updateSettings: (patch) => {
      const settings = sanitizePrintSettings({ ...get().settings, ...patch });
      persist(settings);
      set({ settings });
      schedule();
    },
    setMaterial: (id) => {
      const preset = MATERIAL_PRESETS.find((p) => p.id === id);
      get().updateSettings(
        preset
          ? { material: id, density: preset.density, costPerKg: preset.costPerKg }
          : { material: 'custom' },
      );
    },

    status: 'idle',
    progress: null,
    report: null,
    reportEvaluation: null,
    error: null,
    analyzeNow: () => {
      if (!get().enabled) get().setEnabled(true);
      if (debounce) clearTimeout(debounce);
      debounce = null;
      run();
    },
    cancelAnalysis: () => {
      if (debounce) clearTimeout(debounce);
      debounce = null;
      job?.cancel();
    },

    focusedFindingId: null,
    focusFinding: (finding) => {
      if (!finding) {
        set({ focusedFindingId: null });
        return;
      }
      set({ focusedFindingId: finding.id });
      const doc = useAssemblerStore.getState();
      if (!doc.evaluation.bodies.some((b) => b.id === finding.bodyId)) return;
      const items: SelectionItem[] =
        finding.faceKeys.length > 0
          ? finding.faceKeys.map((faceKey) => ({ kind: 'face', bodyId: finding.bodyId, faceKey }))
          : [{ kind: 'body', bodyId: finding.bodyId }];
      doc.setSelection(items);
      useWorkspaceStore.getState().sendCamera({ kind: 'fitSelection' });
    },

    placePicking: null,
    startPlacePicking: (bodyId) => {
      installPrintSubscriptions();
      set({ placePicking: bodyId });
    },
    cancelPlacePicking: () => set({ placePicking: null }),
    placeOnPlate: (bodyId, faceKey) => {
      const doc = useAssemblerStore.getState();
      if (doc.activeTool) return 'Finish or cancel the active tool first.';
      try {
        const feature = placeOnPlateFeature(
          doc.evaluation,
          doc.features,
          bodyId,
          faceKey,
          doc.allocateFeatureId('transform'),
        );
        set({ placePicking: null });
        // Already lying on that face: no History step that moves nothing.
        if (isIdentityPlacement(feature)) {
          useWorkspaceStore.getState().notify('The body already lies on that face.');
          return null;
        }
        doc.addFeature(feature, [{ kind: 'body', bodyId }]);
        return null;
      } catch (error) {
        return error instanceof PlacementError || error instanceof Error
          ? error.message
          : String(error);
      }
    },

    orient: null,
    startAutoOrient: (bodyId) => {
      const doc = useAssemblerStore.getState();
      let input: ReturnType<typeof orientationInput>;
      try {
        input = orientationInput(doc.evaluation, doc.features, bodyId);
      } catch (error) {
        useWorkspaceStore
          .getState()
          .notify(error instanceof Error ? error.message : String(error), 'warning');
        return;
      }
      if (!get().enabled) get().setEnabled(true);
      orientJob?.cancel();
      const current = runner.orient(input.mesh, get().settings.overhangAngleDeg, input.faceLabels);
      orientJob = current;
      set({ orient: { bodyId, status: 'running', candidates: [], preview: null } });
      current.promise.then(
        (candidates) => {
          if (orientJob !== current) return;
          orientJob = null;
          set({
            orient: { bodyId, status: 'done', candidates: candidates.slice(0, 3), preview: 0 },
          });
        },
        (error: unknown) => {
          if (orientJob !== current) return;
          orientJob = null;
          if (error instanceof PrintJobCancelled) {
            set({ orient: null });
            return;
          }
          set({
            orient: {
              bodyId,
              status: 'error',
              candidates: [],
              preview: null,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        },
      );
    },
    previewOrientation: (index) => {
      const orient = get().orient;
      if (!orient) return;
      set({ orient: { ...orient, preview: index } });
    },
    applyOrientation: (index) => {
      const orient = get().orient;
      const candidate = orient?.candidates[index];
      if (!orient || !candidate) return;
      const doc = useAssemblerStore.getState();
      if (doc.activeTool) {
        useWorkspaceStore.getState().notify('Finish or cancel the active tool first.', 'warning');
        return;
      }
      if (isIdentityPlacement(candidate.transform)) {
        // "As modelled" won: nothing to move, so no History step.
        useWorkspaceStore.getState().notify('The body is already in this orientation.');
        set({ orient: null });
        return;
      }
      const feature = placementFeature(
        orient.bodyId,
        candidate.transform,
        doc.allocateFeatureId('transform'),
        orientFeatureName(doc.features),
      );
      doc.addFeature(feature, [{ kind: 'body', bodyId: orient.bodyId }]);
      set({ orient: null });
    },
    closeOrient: () => {
      orientJob?.cancel();
      orientJob = null;
      set({ orient: null });
    },

    stlDialogOpen: false,
    setStlDialogOpen: (open) => set({ stlDialogOpen: open }),
    slicerDialogOpen: false,
    setSlicerDialogOpen: (open) => set({ slicerDialogOpen: open }),
  };

  /**
   * Store subscriptions (installed on first use): re-analysis on document
   * changes, and the "Place on plate" pick — the next click on a face of
   * the picked body (a selection change) places it.
   */
  function installPrintSubscriptions(): void {
    if (installed) return;
    installed = true;
    useAssemblerStore.subscribe((state, previous) => {
      if (state.evaluation !== previous.evaluation) {
        schedule();
        // Candidates were ranked (pivot, drop height) for the previous geometry: rank again.
        const orient = get().orient;
        if (orient) {
          const before = previous.evaluation.bodies.find((b) => b.id === orient.bodyId);
          const after = state.evaluation.bodies.find((b) => b.id === orient.bodyId);
          if (!after) get().closeOrient();
          else if (before?.mesh !== after.mesh) get().startAutoOrient(orient.bodyId);
        }
      } else if (
        state.evaluationPending !== previous.evaluationPending &&
        !state.evaluationPending
      ) {
        if (get().status === 'scheduled' && !debounce) schedule();
      }
      const picking = get().placePicking;
      if (picking && state.selection !== previous.selection) {
        if (state.selection.length === 0) {
          set({ placePicking: null }); // Escape / click on empty space cancels
          return;
        }
        const face = state.selection.length === 1 ? state.selection[0] : null;
        if (face?.kind !== 'face') return;
        if (face.bodyId !== picking) {
          useWorkspaceStore.getState().notify('Pick a face of the body being placed.', 'warning');
          return;
        }
        const problem = get().placeOnPlate(face.bodyId, face.faceKey);
        if (problem) useWorkspaceStore.getState().notify(problem, 'warning');
      }
    });
  }
});

/** `true` when the shown report belongs to an older evaluation than the current one. */
export function reportStale(state: PrintState): boolean {
  return (
    state.report !== null &&
    state.reportEvaluation !== useAssemblerStore.getState().evaluation &&
    state.enabled
  );
}
