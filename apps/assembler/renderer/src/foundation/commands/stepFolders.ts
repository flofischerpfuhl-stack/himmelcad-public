/**
 * Items folders for the bodies a new History step makes (Shapr3D Pattern
 * 3D: "the copies are placed in a folder in the Items manager"). A module
 * registers the kinds that get one ({@link registerStepFolderKind}); the UI
 * products install the sync ({@link installStepFolderSync}), which
 *
 * - notes every step that appears in the document for the first time in
 *   this document generation (a commit from a tool, History or the agent
 *   API — not Open, New, undo or redo);
 * - once that step's bodies are evaluated, files its source bodies and the
 *   bodies it created into one folder named after the step, inside the
 *   folder of its first source body.
 *
 * The folder remembers its step (`ItemFolder.featureId`): while the step is
 * undone or deleted the folder is not shown (`buildItemTree`), a redo shows
 * it again, and Save leaves it out once the step is gone. Folders are Items
 * properties, not History steps (`items.ts`), so this is not an undo step.
 */
import type { Feature } from '../document/document.js';
import type { Body } from '../geometry-kernel/types.js';
import { bodyRowKey, useItemsStore } from './items.js';

/** Kinds whose new steps get a folder: kind → the step's source bodies. */
const folderKinds = new Map<string, (feature: Feature) => readonly string[]>();

/** Registers a kind whose new steps file their bodies into a folder (once per kind). */
export function registerStepFolderKind(
  kind: string,
  sources: (feature: Feature) => readonly string[],
): void {
  const known = folderKinds.get(kind);
  if (known && known !== sources) throw new Error(`Step folders of "${kind}" registered twice`);
  folderKinds.set(kind, sources);
}

interface PendingFolder {
  name: string;
  sources: readonly string[];
}

/**
 * Files the bodies of `pending` steps found in `bodies` (each step once).
 * Returns the ids of the steps filed now. Exported for tests.
 */
export function fileStepFolders(
  pending: Map<string, PendingFolder>,
  bodies: readonly Body[],
): string[] {
  const filed: string[] = [];
  for (const [featureId, request] of [...pending]) {
    const created = bodies.filter((b) => b.createdBy === featureId);
    if (created.length === 0) continue;
    pending.delete(featureId);
    const items = useItemsStore.getState();
    if (items.folders.some((f) => f.featureId === featureId)) continue;
    const present = new Set(bodies.map((b) => b.id));
    const sources = request.sources.filter((id) => present.has(id));
    const keys = [...sources, ...created.map((b) => b.id)].map(bodyRowKey);
    const parentId = sources[0] ? (items.parent[bodyRowKey(sources[0])] ?? null) : null;
    items.createFolder({ name: request.name, keys, parentId, featureId });
    filed.push(featureId);
  }
  return filed;
}

interface StoreLike {
  getState(): {
    features: readonly Feature[];
    documentGeneration: number;
    evaluation: { bodies: Body[] };
  };
  subscribe(
    listener: (
      state: ReturnType<StoreLike['getState']>,
      prev: ReturnType<StoreLike['getState']>,
    ) => void,
  ): () => void;
}

let installed: (() => void) | null = null;

/** Subscribes the step folders to the app's store (idempotent; returns the unsubscribe). */
export function installStepFolderSync(store: StoreLike): () => void {
  if (installed) return installed;
  const pending = new Map<string, PendingFolder>();
  let seen = new Set(store.getState().features.map((f) => f.id));
  /** Set while a load runs: `loadDocument` bumps the generation, then sets the features. */
  let loading = false;
  const unsubscribe = store.subscribe((state, prev) => {
    if (state.documentGeneration !== prev.documentGeneration) {
      // Open/New/template: the loaded steps are not new.
      pending.clear();
      seen = new Set(state.features.map((f) => f.id));
      loading = true;
      queueMicrotask(() => {
        loading = false;
      });
    } else if (state.features !== prev.features && loading) {
      for (const feature of state.features) seen.add(feature.id);
    } else if (state.features !== prev.features) {
      for (const feature of state.features) {
        if (seen.has(feature.id)) continue;
        seen.add(feature.id);
        const sources = folderKinds.get(feature.kind);
        if (sources) pending.set(feature.id, { name: feature.name, sources: sources(feature) });
      }
    }
    if (pending.size > 0 && state.evaluation !== prev.evaluation) {
      fileStepFolders(pending, state.evaluation.bodies);
    }
  });
  installed = () => {
    unsubscribe();
    installed = null;
  };
  return installed;
}
