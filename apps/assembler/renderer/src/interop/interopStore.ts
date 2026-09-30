/**
 * Import/export from the UI: File menu entries, drag & drop onto the
 * window, progress with Cancel for large files, option dialogs (DXF
 * placement, STEP/DXF export) and a result report that says what was kept,
 * converted or skipped. The document edits are the shared ones
 * (`importActions.ts`), so the UI and the agent API produce the same steps.
 *
 * Long work and Cancel:
 * - reading and parsing (mesh files, DXF, the mesh-to-solid check) run in
 *   the import worker; Cancel terminates it (`importRunner.ts`);
 * - kernel work (STEP geometry, mesh-to-solid B-rep) runs in the kernel
 *   worker after the step is added; Cancel stops it and restores the
 *   document as it was (`store.cancelKernelWork`), so a cancelled import
 *   leaves nothing behind (it stays available as Redo).
 * A step whose evaluation fails is taken back (undo) and the reason shown.
 */
import { create } from 'zustand';

import type { KernelAdapter } from '../foundation/geometry-kernel/adapter.js';
import type { IgesLengthUnit, IgesWriteMode } from '../foundation/geometry-kernel/igesExchange.js';
import type {
  StepExportOptions,
  StepLengthUnit,
  StepSchema,
} from '../foundation/geometry-kernel/stepExport.js';
import { suggestStlUnitHint } from '../kernel/stlImport.js';
import type { Body, KernelFormatCapabilities } from '../foundation/geometry-kernel/types.js';
import type { Feature, SketchFeature, SketchPlaneRef } from '../foundation/document/document.js';
import { meshRowKey, useItemsStore, withDisplayNames } from '../interface/shell-ui/items.js';
import * as io from '../foundation/document/persistence.js';
import { useProjectStore } from '../interface/shell-ui/project/projectStore.js';
import type { ReferenceMesh } from '../model/referenceMesh.js';
import {
  nextFeatureName,
  shownFeatures,
  useAssemblerStore,
  type SelectionItem,
} from '../foundation/commands/store.js';
import { useWorkspaceStore } from '../interface/shell-ui/workspace.js';
import { writeDxf, type DxfDrawing, type DxfVersion } from './dxf.js';
import { faceOutlineToDxfEntities, sketchToDxfEntities } from './dxfSketch.js';
import {
  bytesToBase64,
  describeMeshCheck,
  dxfSketchFeature,
  dxfUnits,
  importStepFeature,
  meshSolidFeature,
  referenceMeshWorldPositions,
  referenceMeshesFromImport,
  type DxfUnits,
} from './importActions.js';
import { fileRowsIntoFolders, notifyAssemblyImported } from './importFolders.js';
import { importFormatOf, type ImportFormat } from './importParsers.js';
import { importRunner } from './importRunner.js';
import { ImportCancelledError } from './meshObjects.js';
import { stepAssemblyFromItems } from './stepTree.js';
import { importAccept } from './formats.js';

let kernel: KernelAdapter | null = null;

/** The kernel adapter used by STEP export (set once by `main.tsx`). */
export function setInteropKernel(adapter: KernelAdapter): void {
  kernel = adapter;
}

/** Exchange formats of the loaded OCCT build (`null` until the kernel is ready). */
export function kernelFormatCapabilities(): KernelFormatCapabilities | null {
  return kernel?.status.capabilities ?? null;
}

/**
 * The capabilities once the kernel has finished loading (a file dropped while
 * it loads must not be refused as "not in this build"); `null` if it failed.
 */
function settledCapabilities(): Promise<KernelFormatCapabilities | null> {
  const adapter = kernel;
  if (!adapter || adapter.status.status !== 'loading') {
    return Promise.resolve(adapter?.status.capabilities ?? null);
  }
  return new Promise((resolve) => {
    const off = adapter.onStatus((status) => {
      if (status.status === 'loading') return;
      queueMicrotask(() => off());
      resolve(status.capabilities ?? null);
    });
  });
}

/** Why IGES is unavailable (the default OCCT module). */
export const IGES_UNAVAILABLE_TEXT =
  'IGES is not in this build: the CAD kernel (replicad-opencascadejs 1.1.0) has no IGES reader or writer. It needs the HimmelCAD OCCT build. Export the part as STEP from the source system instead.';

export interface ImportJob {
  id: number;
  /** "Importing parts.3mf". */
  title: string;
  /** Current step, e.g. "Reading objects", "Building geometry". */
  detail: string;
  /** 0..1, or `null` while indeterminate. */
  fraction: number | null;
  /** Where Cancel acts: the import worker, or the kernel. */
  stage: 'worker' | 'kernel';
}

export interface ImportReport {
  title: string;
  tone: 'info' | 'warning' | 'error';
  lines: string[];
}

export interface DxfPending {
  fileName: string;
  drawing: DxfDrawing;
  units: DxfUnits;
  /** A planar face selected when the import started (offered as the placement). */
  face: Extract<SketchPlaneRef, { kind: 'face' }> | null;
}

export interface UnitOffer {
  meshIds: string[];
  hint: 'm' | 'in';
  scaleToMm: number;
}

export type StepExportScope = 'all' | 'visible' | 'selected';
export type StepExportStructure = 'folders' | 'flat' | 'each';

export interface StepExportSettings {
  scope: StepExportScope;
  structure: StepExportStructure;
  schema: StepSchema;
  unit: StepLengthUnit;
}

export interface IgesExportSettings {
  scope: StepExportScope;
  unit: IgesLengthUnit;
  mode: IgesWriteMode;
}

export interface InteropState {
  job: ImportJob | null;
  report: ImportReport | null;
  dxfPending: DxfPending | null;
  unitOffer: UnitOffer | null;
  stepExportOpen: boolean;
  stepExportSettings: StepExportSettings;
  dxfExportOpen: boolean;
  igesExportOpen: boolean;
  igesExportSettings: IgesExportSettings;
  /** Files are dragged over the window. */
  dragActive: boolean;

  /** File › Import…: a file picker for every supported format (or one format). */
  openImport: (format?: ImportFormat) => Promise<void>;
  /** Imports dropped or picked files one after another. */
  importFiles: (files: { name: string; bytes: Uint8Array }[]) => Promise<void>;
  cancelJob: () => void;
  confirmDxf: (options: {
    placement: 'plane' | 'face';
    plane: 'XY' | 'XZ' | 'YZ';
    offset: number;
    connect: boolean;
    unitScale: number | null;
  }) => void;
  dismissDxf: () => void;
  resolveUnitOffer: (apply: boolean) => void;
  convertMeshToSolid: (meshId: string) => Promise<void>;
  setStepExportOpen: (open: boolean) => void;
  exportStep: (settings: StepExportSettings) => Promise<number>;
  setIgesExportOpen: (open: boolean) => void;
  /** Writes one IGES file; resolves `true` when written, `false` when the save was cancelled. */
  exportIges: (settings: IgesExportSettings) => Promise<boolean>;
  setDxfExportOpen: (open: boolean) => void;
  exportDxf: (options: { version: DxfVersion; includeConstruction: boolean }) => Promise<boolean>;
  setDragActive: (active: boolean) => void;
  dismissReport: () => void;
}

let jobSerial = 0;

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Model';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens a native/browser file picker; resolves the picked files' bytes (empty if cancelled). */
function pickFiles(
  accept: string,
  multiple: boolean,
): Promise<{ name: string; bytes: Uint8Array }[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.remove();
      void Promise.all(
        files.map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ).then(resolve);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Waits until the kernel settled the document; `true` unless the job was cancelled meanwhile. */
async function settled(jobId: number): Promise<boolean> {
  await useAssemblerStore.getState().whenSettled();
  return useInteropStore.getState().job?.id === jobId;
}

function formatSize(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, noun: string): string {
  return `${formatSize(n)} ${noun}${n === 1 ? '' : 's'}`;
}

export const useInteropStore = create<InteropState>((set, get) => {
  const startJob = (title: string, detail: string, stage: ImportJob['stage']): number => {
    jobSerial += 1;
    set({ job: { id: jobSerial, title, detail, fraction: null, stage } });
    return jobSerial;
  };
  const updateJob = (id: number, patch: Partial<ImportJob>) => {
    const job = get().job;
    if (job?.id === id) set({ job: { ...job, ...patch } });
  };
  const endJob = (id: number) => {
    if (get().job?.id === id) set({ job: null });
  };
  const fail = (title: string, lines: string[]) => set({ report: { title, tone: 'error', lines } });
  /** Adds one History step at the end (a rolled-back History is rolled forward first, like agent commands). */
  const addStep = (feature: Feature, selection?: SelectionItem[]) => {
    const state = useAssemblerStore.getState();
    if (state.rollbackBefore !== null) state.setRollback(null);
    useAssemblerStore.getState().addFeature(feature, selection);
  };

  const importStep = async (name: string, bytes: Uint8Array, format: 'step' | 'iges' = 'step') => {
    const store = useAssemblerStore.getState();
    if (store.activeTool) {
      fail(`Could not import "${name}"`, ['Finish or cancel the active tool first.']);
      return;
    }
    const job = startJob(`Importing ${name}`, 'Building geometry', 'kernel');
    const id = store.allocateFeatureId('import');
    const data = bytesToBase64(bytes);
    const featureName = nextFeatureName('Import', store.features);
    const feature: Feature =
      format === 'iges'
        ? {
            id,
            name: featureName,
            suppressed: false,
            kind: 'importStep',
            format: 'iges',
            data,
            fileName: name,
          }
        : importStepFeature({ id, name: featureName, data, fileName: name });
    if (format === 'step') notifyAssemblyImported(id);
    addStep(feature);
    if (!(await settled(job))) return;
    endJob(job);
    const state = useAssemblerStore.getState();
    const error = state.evaluation.errors[id];
    if (error) {
      if (state.features.some((f) => f.id === id)) state.undo();
      fail(`Could not import "${name}"`, [error]);
      return;
    }
    const parts = state.evaluation.bodies.filter((b) => b.createdBy === id);
    const folders = new Set(parts.map((b) => (b.itemPath ?? []).join('/')).filter(Boolean));
    const warning = state.evaluation.warnings[id];
    state.clearSelection();
    parts.forEach((b, i) => state.select({ kind: 'body', bodyId: b.id }, { additive: i > 0 }));
    useWorkspaceStore.getState().sendCamera({ kind: 'fitAll' });
    const summary = `Imported ${parts.length} part${parts.length === 1 ? '' : 's'}${
      folders.size > 0 ? ` into ${folders.size} Items folder${folders.size === 1 ? '' : 's'}` : ''
    } (one History step).`;
    if (warning)
      set({ report: { title: `Imported "${name}"`, tone: 'warning', lines: [summary, warning] } });
    else useWorkspaceStore.getState().notify(summary);
  };

  const importMeshes = async (name: string, bytes: Uint8Array) => {
    const job = startJob(`Importing ${name}`, 'Reading the file', 'worker');
    let parsed;
    try {
      parsed = await importRunner().parseMesh(bytes, name, (fraction) =>
        updateJob(job, { fraction, detail: 'Reading triangles' }),
      );
    } catch (error) {
      endJob(job);
      if (error instanceof ImportCancelledError || (error as Error).name === 'ImportCancelledError')
        return;
      fail(`Could not import "${name}"`, [errorText(error)]);
      return;
    }
    endJob(job);
    const meshes = referenceMeshesFromImport(parsed, name);
    const store = useAssemblerStore.getState();
    for (const { mesh } of meshes) store.importReferenceMesh(mesh);
    fileRowsIntoFolders(
      meshes.map(({ mesh, folder }) => ({ key: meshRowKey(mesh.id), path: folder })),
    );
    if (meshes.length > 1) {
      store.clearSelection();
      meshes.forEach(({ mesh }, i) =>
        store.select({ kind: 'mesh', meshId: mesh.id }, { additive: i > 0 }),
      );
    }
    useWorkspaceStore.getState().sendCamera({ kind: 'fitAll' });
    const triangles = meshes.reduce((sum, m) => sum + m.mesh.indices.length / 3, 0);
    const lines = [
      `${meshes.length} reference mesh${meshes.length === 1 ? '' : 'es'}, ${formatSize(triangles)} triangles.`,
      ...parsed.warnings,
    ];
    if (parsed.declaredUnit === null) {
      let min: [number, number, number] = [Infinity, Infinity, Infinity];
      let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const { mesh } of meshes) {
        min = [
          Math.min(min[0], mesh.min[0]),
          Math.min(min[1], mesh.min[1]),
          Math.min(min[2], mesh.min[2]),
        ];
        max = [
          Math.max(max[0], mesh.max[0]),
          Math.max(max[1], mesh.max[1]),
          Math.max(max[2], mesh.max[2]),
        ];
      }
      const hint = suggestStlUnitHint(min, max);
      if (hint) set({ unitOffer: { meshIds: meshes.map((m) => m.mesh.id), ...hint } });
    }
    if (parsed.warnings.length > 0) {
      set({ report: { title: `Imported "${name}"`, tone: 'warning', lines } });
    } else useWorkspaceStore.getState().notify(`Imported ${lines[0]}`);
  };

  const importDxf = async (name: string, bytes: Uint8Array) => {
    const job = startJob(`Importing ${name}`, 'Reading the drawing', 'worker');
    let drawing: DxfDrawing;
    try {
      drawing = await importRunner().parseDxf(bytes);
    } catch (error) {
      endJob(job);
      if ((error as Error).name === 'ImportCancelledError') return;
      fail(`Could not import "${name}"`, [errorText(error)]);
      return;
    }
    endJob(job);
    if (drawing.entities.length === 0) {
      const skipped = Object.entries(drawing.skipped).map(([t, n]) => `${n} × ${t}`);
      fail(`Nothing to import from "${name}"`, [
        'The drawing has no lines, arcs, circles, polylines, splines, ellipses or points in the XY plane.',
        ...(skipped.length > 0 ? [`Not imported: ${skipped.join(', ')}.`] : []),
      ]);
      return;
    }
    const state = useAssemblerStore.getState();
    const faceItem = state.selection.find((s) => s.kind === 'face');
    let face: DxfPending['face'] = null;
    if (faceItem && faceItem.kind === 'face') {
      const body = state.evaluation.bodies.find((b) => b.id === faceItem.bodyId);
      const info = body?.faces.find((f) => f.key === faceItem.faceKey);
      if (body && info && info.surface === 'plane' && info.normal) {
        face = {
          kind: 'face',
          face: {
            bodyId: body.id,
            key: info.key,
            signature: {
              surface: 'plane',
              normal: info.normal,
              centroid: info.centroid,
              area: info.area,
              adjacentFaces: info.adjacentFaces,
            },
          },
        };
      }
    }
    set({ dxfPending: { fileName: name, drawing, units: dxfUnits(drawing), face } });
  };

  return {
    job: null,
    report: null,
    dxfPending: null,
    unitOffer: null,
    stepExportOpen: false,
    stepExportSettings: { scope: 'all', structure: 'folders', schema: 'AP242', unit: 'mm' },
    dxfExportOpen: false,
    igesExportOpen: false,
    igesExportSettings: { scope: 'all', unit: 'mm', mode: 'faces' },
    dragActive: false,

    openImport: async (format) => {
      const igesAvailable = kernel?.status.capabilities?.igesRead === true;
      const accept =
        format === 'step'
          ? '.step,.stp'
          : format === 'iges'
            ? '.igs,.iges'
            : format === 'stl'
              ? '.stl'
              : format === 'dxf'
                ? '.dxf'
                : importAccept(igesAvailable);
      const files = await pickFiles(accept, format === undefined);
      if (files.length > 0) await get().importFiles(files);
    },

    importFiles: async (files) => {
      // A new import replaces the previous result report (never two dialogs stacked).
      set({ report: null });
      for (const file of files) {
        const format = importFormatOf(file.name);
        switch (format) {
          case 'hcasm': {
            const text = new TextDecoder().decode(file.bytes);
            useProjectStore.getState().requestOpenFile(() => Promise.resolve({ path: null, text }));
            // Opening a project replaces the document: files dropped with it are not imported into it.
            return;
          }
          case 'step':
            await importStep(file.name, file.bytes);
            break;
          case 'iges':
            if ((await settledCapabilities())?.igesRead) {
              await importStep(file.name, file.bytes, 'iges');
            } else {
              fail(`Could not import "${file.name}"`, [IGES_UNAVAILABLE_TEXT]);
            }
            break;
          case 'stl':
          case '3mf':
          case 'obj':
            await importMeshes(file.name, file.bytes);
            break;
          case 'dxf':
            await importDxf(file.name, file.bytes);
            break;
          default:
            fail(`Could not import "${file.name}"`, [
              `Unsupported file type. Import takes STEP, ${kernel?.status.capabilities?.igesRead ? 'IGES, ' : ''}STL, 3MF, OBJ, DXF and HimmelCAD projects (.hcasm).`,
            ]);
        }
        if (get().report?.tone === 'error' || get().dxfPending) break;
      }
    },

    cancelJob: () => {
      const job = get().job;
      if (!job) return;
      set({ job: null });
      if (job.stage === 'worker') importRunner().cancel();
      else useAssemblerStore.getState().cancelKernelWork();
      useWorkspaceStore.getState().notify('Import cancelled; the document is unchanged.');
    },

    confirmDxf: (options) => {
      const pending = get().dxfPending;
      if (!pending) return;
      set({ dxfPending: null });
      const store = useAssemblerStore.getState();
      if (store.activeTool) {
        fail(`Could not import "${pending.fileName}"`, ['Finish or cancel the active tool first.']);
        return;
      }
      const plane: SketchPlaneRef =
        options.placement === 'face' && pending.face
          ? pending.face
          : { kind: 'plane', plane: options.plane, offset: options.offset };
      const units = dxfUnits(pending.drawing, options.unitScale);
      const id = store.allocateFeatureId('sketch');
      let built;
      try {
        built = dxfSketchFeature({
          id,
          name: nextFeatureName('Sketch', store.features),
          plane,
          drawing: pending.drawing,
          scaleToMm: units.scale,
          connect: options.connect,
        });
      } catch (error) {
        fail(`Could not import "${pending.fileName}"`, [errorText(error)]);
        return;
      }
      addStep(built.feature, [{ kind: 'sketchProfile', featureId: id }]);
      useWorkspaceStore.getState().sendCamera({ kind: 'fitAll' });
      const skipped = Object.entries(pending.drawing.skipped).map(([t, n]) => `${n} × ${t}`);
      const lines = [
        `${plural(built.stats.curves, 'curve')} and ${plural(built.stats.points, 'point')} in "${built.feature.name}"; ${plural(built.stats.connected, 'end point')} connected. Units: ${units.label}.`,
        ...(built.stats.approximated > 0
          ? [
              `${built.stats.approximated} rational or periodic spline(s) were approximated by fit splines.`,
            ]
          : []),
        ...(skipped.length > 0 ? [`Not imported: ${skipped.join(', ')}.`] : []),
        ...pending.drawing.warnings,
      ];
      void useAssemblerStore
        .getState()
        .whenSettled()
        .then(() => {
          // A profile the kernel cannot build (e.g. overlapping outlines) is reported, not hidden.
          const warning = useAssemblerStore.getState().evaluation.warnings[id];
          if (warning) lines.push(warning);
          if (lines.length > 1 || units.source === 'unitless') {
            set({ report: { title: `Imported "${pending.fileName}"`, tone: 'warning', lines } });
          } else useWorkspaceStore.getState().notify(lines[0]!);
        });
    },
    dismissDxf: () => set({ dxfPending: null }),

    resolveUnitOffer: (apply) => {
      const offer = get().unitOffer;
      set({ unitOffer: null });
      if (!offer || !apply) return;
      const k = offer.scaleToMm;
      const scale = (mesh: ReferenceMesh): ReferenceMesh => ({
        ...mesh,
        positions: mesh.positions.map((v) => v * k),
        min: [mesh.min[0] * k, mesh.min[1] * k, mesh.min[2] * k],
        max: [mesh.max[0] * k, mesh.max[1] * k, mesh.max[2] * k],
      });
      useAssemblerStore.setState((s) => ({
        referenceMeshes: s.referenceMeshes.map((m) =>
          offer.meshIds.includes(m.id) ? scale(m) : m,
        ),
      }));
      useWorkspaceStore.getState().sendCamera({ kind: 'fitAll' });
    },

    convertMeshToSolid: async (meshId) => {
      const mesh = useAssemblerStore.getState().referenceMeshes.find((m) => m.id === meshId);
      if (!mesh) return;
      const job = startJob(`Mesh to Solid: ${mesh.name}`, 'Checking the mesh', 'worker');
      let prepared;
      try {
        prepared = await importRunner().prepareSolid(referenceMeshWorldPositions(mesh));
      } catch (error) {
        endJob(job);
        if ((error as Error).name === 'ImportCancelledError') return;
        fail(`"${mesh.name}" cannot become a solid`, [errorText(error)]);
        return;
      }
      const store = useAssemblerStore.getState();
      if (store.activeTool) {
        endJob(job);
        fail(`"${mesh.name}" cannot become a solid`, ['Finish or cancel the active tool first.']);
        return;
      }
      updateJob(job, {
        stage: 'kernel',
        detail: `Building ${formatSize(prepared.check.faces)} faces`,
        fraction: null,
      });
      const id = store.allocateFeatureId('meshSolid');
      addStep(
        meshSolidFeature({
          id,
          name: nextFeatureName('Mesh to Solid', store.features),
          sourceName: mesh.name,
          mesh: prepared.mesh,
        }),
        [{ kind: 'body', bodyId: `body:${id}` }],
      );
      if (!(await settled(job))) return;
      endJob(job);
      const state = useAssemblerStore.getState();
      const error = state.evaluation.errors[id];
      if (error) {
        if (state.features.some((f) => f.id === id)) state.undo();
        fail(`"${mesh.name}" cannot become a solid`, [error]);
        return;
      }
      state.setReferenceMeshHidden(mesh.id, true);
      useWorkspaceStore
        .getState()
        .notify(
          `Converted "${mesh.name}" to a solid: ${describeMeshCheck(prepared.check)}. The mesh is hidden.`,
        );
    },

    setStepExportOpen: (open) => set({ stepExportOpen: open }),

    exportStep: async (settings) => {
      set({ stepExportSettings: settings });
      if (!kernel) throw new Error('The CAD kernel is not available.');
      const state = useAssemblerStore.getState();
      const items = useItemsStore.getState();
      const hidden = new Set(state.hiddenBodyIds);
      const selected = new Set(
        state.selection
          .filter((s) => s.kind === 'body')
          .map((s) => (s as { bodyId: string }).bodyId),
      );
      const bodies = withDisplayNames(state.evaluation.bodies, items).filter((b) =>
        settings.scope === 'visible'
          ? !hidden.has(b.id)
          : settings.scope === 'selected'
            ? selected.has(b.id)
            : true,
      );
      if (bodies.length === 0) throw new Error('No bodies to export.');
      const base: StepExportOptions = {
        schema: settings.schema,
        unit: settings.unit,
        names: items.names,
      };
      const filters = [{ name: 'STEP', extensions: ['step', 'stp'] }];
      if (settings.structure === 'each') {
        let written = 0;
        for (const body of bodies) {
          const bytes = await kernel.exportStep(shownFeatures(state), [body.id], base);
          const result = await io.exportBinary(
            bytes,
            `${sanitizeFileName(body.name)}.step`,
            filters,
            'model/step',
          );
          if (!result) break;
          written += 1;
        }
        return written;
      }
      const ids = bodies.map((b) => b.id);
      const options: StepExportOptions =
        settings.structure === 'folders'
          ? { ...base, assembly: stepAssemblyFromItems(state.projectName, ids, items) }
          : base;
      const bytes = await kernel.exportStep(shownFeatures(state), ids, options);
      const name = bodies.length === 1 ? bodies[0]!.name : state.projectName;
      const result = await io.exportBinary(
        bytes,
        `${sanitizeFileName(name)}.step`,
        filters,
        'model/step',
      );
      return result ? 1 : 0;
    },

    setIgesExportOpen: (open) => set({ igesExportOpen: open }),

    exportIges: async (settings) => {
      set({ igesExportSettings: settings });
      if (!kernel) throw new Error('The CAD kernel is not available.');
      if (!kernel.status.capabilities?.igesWrite) throw new Error(IGES_UNAVAILABLE_TEXT);
      const state = useAssemblerStore.getState();
      const hidden = new Set(state.hiddenBodyIds);
      const selected = new Set(
        state.selection
          .filter((s) => s.kind === 'body')
          .map((s) => (s as { bodyId: string }).bodyId),
      );
      const bodies = withDisplayNames(state.evaluation.bodies, useItemsStore.getState()).filter(
        (b) =>
          settings.scope === 'visible'
            ? !hidden.has(b.id)
            : settings.scope === 'selected'
              ? selected.has(b.id)
              : true,
      );
      if (bodies.length === 0) throw new Error('No bodies to export.');
      const bytes = await kernel.exportIges(
        shownFeatures(state),
        bodies.map((b) => b.id),
        { unit: settings.unit, mode: settings.mode },
      );
      const name = bodies.length === 1 ? bodies[0]!.name : state.projectName;
      const result = await io.exportBinary(
        bytes,
        `${sanitizeFileName(name)}.igs`,
        [{ name: 'IGES', extensions: ['igs', 'iges'] }],
        'model/iges',
      );
      return result !== null;
    },

    setDxfExportOpen: (open) => set({ dxfExportOpen: open }),

    exportDxf: async (options) => {
      const target = dxfExportTarget();
      if (!target) throw new Error('Select a sketch or a planar face first.');
      const entities =
        target.kind === 'sketch'
          ? sketchToDxfEntities(target.sketch, { includeConstruction: options.includeConstruction })
          : faceOutlineToDxfEntities(target.body, target.faceIndex);
      if (entities.length === 0) throw new Error('There is no geometry to export.');
      const text = writeDxf(entities, options.version);
      const result = await io.exportBinary(
        new TextEncoder().encode(text),
        `${sanitizeFileName(target.name)}.dxf`,
        [{ name: 'DXF', extensions: ['dxf'] }],
        'image/vnd.dxf',
      );
      return result !== null;
    },

    setDragActive: (active) => {
      if (get().dragActive !== active) set({ dragActive: active });
    },
    dismissReport: () => set({ report: null }),
  };
});

export type DxfExportTarget =
  | { kind: 'sketch'; name: string; sketch: SketchFeature }
  | { kind: 'face'; name: string; body: Body; faceIndex: number };

/** What "Export DXF…" exports for the current selection: a sketch, or a planar face outline. */
export function dxfExportTarget(): DxfExportTarget | null {
  const state = useAssemblerStore.getState();
  for (const item of state.selection) {
    if (item.kind === 'sketchProfile' || item.kind === 'feature') {
      const feature = state.features.find((f) => f.id === item.featureId);
      if (feature?.kind === 'sketch')
        return { kind: 'sketch', name: feature.name, sketch: feature };
    }
    if (item.kind === 'face') {
      const body = state.evaluation.bodies.find((b) => b.id === item.bodyId);
      const faceIndex = body?.faces.findIndex((f) => f.key === item.faceKey) ?? -1;
      const face = body?.faces[faceIndex];
      if (body && face && face.surface === 'plane' && face.normal) {
        return { kind: 'face', name: `${body.name} face`, body, faceIndex };
      }
    }
  }
  return null;
}
