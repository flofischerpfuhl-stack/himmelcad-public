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

import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { withDisplayNames, useItemsStore } from '../../foundation/commands/items.js';
import { useAssemblerStore, type SelectionItem } from '../../foundation/commands/store.js';
import { notify } from '../../foundation/commands/notices.js';
import { sendCamera } from '../../platform/viewport/cameraChannel.js';
import type { Feature } from '../../foundation/document/document.js';
import { usePreferences } from '../../platform/input/preferences.js';
import {
  bodyToPrintInput,
  type FindingKind,
  type FindingSeverity,
  type PrintFinding,
  type PrintReport,
} from './analysis.js';
import { runClearancePass } from './clearance.js';
import { printKernel } from './exporting.js';
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
  /** Selects and frames a finding's faces (or its body, or both bodies of a pair). */
  focusFinding: (finding: PrintFinding | null) => void;

  /**
   * Finding ids the user ignored here ("Ignore here" / "Mark as intended"),
   * saved in the project (`printIgnored`, `projectFile.ts`); not undo-tracked.
   * Agents still get every finding (`print.analyze` marks these `ignored`).
   */
  ignored: string[];
  ignoreFinding: (id: string) => void;
  restoreFinding: (id: string) => void;
  restoreAllFindings: () => void;
  setIgnored: (ids: string[]) => void;
  /** "Don't show this type": a user preference (`hiddenPrintFindings`), reversible in the panel and Settings. */
  hideFindingKind: (kind: FindingKind) => void;
  showFindingKind: (kind: FindingKind) => void;

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
}

let runner = new PrintabilityRunner(null);
let job: PrintJob<unknown> | null = null;
let orientJob: PrintJob<unknown> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let installed = false;
/** Cancel was pressed while the kernel's clearance pass runs (it stops before its next chunk). */
let clearanceCancelled = false;

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Findings of both passes, most severe first (stable within a severity). */
export function mergeFindings(
  mesh: readonly PrintFinding[],
  clearance: readonly PrintFinding[],
): PrintFinding[] {
  return [...mesh, ...clearance]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map(({ f }) => f);
}

/** The steps the shown evaluation comes from (above the History rollback bar). */
function activeFeaturesOf(doc: { features: Feature[]; rollbackBefore: string | null }): Feature[] {
  if (!doc.rollbackBefore) return doc.features;
  const index = doc.features.findIndex((f) => f.id === doc.rollbackBefore);
  return index < 0 ? doc.features : doc.features.slice(0, index);
}

/**
 * The findings the panel lists: without the ones ignored here and the
 * types the user hid. Agents get every finding (`print.analyze`).
 */
export function visibleFindings(
  findings: readonly PrintFinding[],
  ignored: readonly string[],
  hiddenKinds: readonly string[],
): PrintFinding[] {
  if (ignored.length === 0 && hiddenKinds.length === 0) return [...findings];
  const skip = new Set(ignored);
  const hidden = new Set(hiddenKinds);
  return findings.filter((f) => !skip.has(f.id) && !hidden.has(f.kind));
}

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
    const settings = get().settings;
    const kernel = printKernel();
    const clearance = settings.checkClearance && bodies.length >= 2 && kernel?.measureClearance;
    // The mesh analysis takes the first part of the bar, the kernel's clearance pass the rest.
    const share = clearance ? 0.8 : 1;
    const current = runner.analyze(bodies, settings, (fraction, label) =>
      set({ progress: { fraction: fraction * share, label } }),
    );
    job = current;
    clearanceCancelled = false;
    set({ status: 'running', progress: { fraction: 0, label: 'Starting…' }, error: null });
    current.promise
      .then(async (report) => {
        if (job !== current || !clearance) return report;
        set({ progress: { fraction: share, label: 'Clearance between bodies' } });
        const pass = await runClearancePass(
          kernel,
          activeFeaturesOf(doc),
          bodies.map((b) => ({ id: b.id, name: b.name, min: b.min, max: b.max })),
          settings,
          {
            cancelled: () => job !== current || clearanceCancelled,
            onProgress: (done, total) => {
              if (job !== current || total === 0) return;
              set({
                progress: {
                  fraction: share + (1 - share) * (done / total),
                  label: `Clearance between bodies (${done}/${total} pairs)`,
                },
              });
            },
          },
        );
        return { ...report, findings: mergeFindings(report.findings, pass.findings) };
      })
      .then((report) => {
        if (job !== current) return;
        job = null;
        set({
          status: clearanceCancelled ? 'cancelled' : 'done',
          progress: null,
          report,
          reportEvaluation: evaluation,
        });
      })
      .catch((error: unknown) => {
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
      });
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
      // The kernel's clearance pass stops before its next chunk (the mesh analysis at once).
      clearanceCancelled = true;
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
          : [
              { kind: 'body', bodyId: finding.bodyId },
              // Pair findings (overlap, clearance): both bodies.
              ...(finding.otherBodyId &&
              doc.evaluation.bodies.some((b) => b.id === finding.otherBodyId)
                ? [{ kind: 'body' as const, bodyId: finding.otherBodyId }]
                : []),
            ];
      doc.setSelection(items);
      sendCamera({ kind: 'fitSelection' });
    },

    ignored: [],
    ignoreFinding: (id) => {
      if (get().ignored.includes(id)) return;
      set({ ignored: [...get().ignored, id] });
    },
    restoreFinding: (id) => set({ ignored: get().ignored.filter((x) => x !== id) }),
    restoreAllFindings: () => set({ ignored: [] }),
    setIgnored: (ids) => set({ ignored: [...new Set(ids)] }),
    hideFindingKind: (kind) => {
      const prefs = usePreferences.getState();
      if (prefs.hiddenPrintFindings.includes(kind)) return;
      prefs.setPreference('hiddenPrintFindings', [...prefs.hiddenPrintFindings, kind]);
    },
    showFindingKind: (kind) => {
      const prefs = usePreferences.getState();
      prefs.setPreference(
        'hiddenPrintFindings',
        prefs.hiddenPrintFindings.filter((k) => k !== kind),
      );
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
          notify('The body already lies on that face.');
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
        notify(error instanceof Error ? error.message : String(error), 'warning');
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
        notify('Finish or cancel the active tool first.', 'warning');
        return;
      }
      if (isIdentityPlacement(candidate.transform)) {
        // "As modelled" won: nothing to move, so no History step.
        notify('The body is already in this orientation.');
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
          notify('Pick a face of the body being placed.', 'warning');
          return;
        }
        const problem = get().placeOnPlate(face.bodyId, face.faceKey);
        if (problem) notify(problem, 'warning');
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
