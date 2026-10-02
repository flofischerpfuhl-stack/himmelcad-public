/**
 * The modelling module's draft tools (`foundation/commands/draftTools.ts`):
 * Revolve … Align (`featureTools.ts`) and the print-part tools Hole, Emboss,
 * Draft, Rib and Thicken (`printFeatureTools.ts`), installed through
 * `defineAssemblerModule({ draftTools })` in `module.ts`.
 */
import {
  defineDraftTool,
  type DraftToolBadge,
  type DraftToolHandle,
} from '../../foundation/commands/draftTools.js';
import {
  MODELING_DRAFT_KINDS,
  acceptModelingPick,
  createModelingDraft,
  modelingDraftBadges,
  modelingDraftGuides,
  modelingDraftHandles,
  modelingDraftMeta,
  modelingDraftModifiedBodyIds,
  modelingDraftToFeature,
  type ModelingDraft,
} from './featureTools.js';
import {
  PRINT_DRAFT_KINDS,
  acceptPrintPick,
  createPrintDraft,
  printDraftBadges,
  printDraftGuides,
  printDraftHandles,
  printDraftMeta,
  printDraftModifiedBodyIds,
  printDraftPicksSketchLines,
  printDraftToFeature,
  type HoleDraft,
  type PrintDraft,
} from './printFeatureTools.js';

declare module '../../foundation/commands/draftTools.js' {
  interface DraftToolMap {
    hole: HoleDraft;
    emboss: Extract<PrintDraft, { kind: 'emboss' }>;
    draft: Extract<PrintDraft, { kind: 'draft' }>;
    rib: Extract<PrintDraft, { kind: 'rib' }>;
    thicken: Extract<PrintDraft, { kind: 'thicken' }>;
  }
}

/** Kinds whose tool takes an axis (a sketch line may be it). */
const TAKES_AXIS: ReadonlySet<string> = new Set([
  'revolve',
  'rotateAxis',
  'pattern',
  'mirror',
  'align',
]);

export { PRIMITIVE_DRAFT_TOOL } from './primitiveTools.js';
export { SCALE_DRAFT_TOOL, TRANSLATE_DRAFT_TOOL } from './transformTools.js';

export const MODELING_DRAFT_TOOL = defineDraftTool<ModelingDraft>({
  module: 'modeling',
  kinds: MODELING_DRAFT_KINDS,
  createDraft: createModelingDraft,
  acceptPick: (draft, pick, evaluation) => acceptModelingPick(draft, pick, evaluation),
  toFeature: modelingDraftToFeature,
  meta: modelingDraftMeta,
  // The generic badges/handles take any draft (they check its kind): narrowed to this tool's.
  badges: (draft) => modelingDraftBadges(draft) as unknown as DraftToolBadge<ModelingDraft>[],
  handles: (draft, evaluation, features) =>
    modelingDraftHandles(
      draft,
      evaluation,
      features,
    ) as unknown as DraftToolHandle<ModelingDraft>[],
  guides: (draft, evaluation) => modelingDraftGuides(draft, evaluation),
  modifiedBodyIds: modelingDraftModifiedBodyIds,
  picksSketchLines: (draft) => TAKES_AXIS.has(draft.kind),
  // Bodies that move (Align, Mirror in place): their old place as a ghost.
  ghostsModifiedBodies: (draft) =>
    draft.kind === 'align' || (draft.kind === 'mirror' && !draft.keepOriginal),
  // Shapr3D's Next between targets and references (UI-17): the step badges in the pill.
  steps: (draft) => {
    if (draft.kind !== 'rotateAxis' && draft.kind !== 'align') return null;
    return {
      labels: draft.kind === 'rotateAxis' ? ['Bodies', 'Axis'] : ['Moving reference', 'Target'],
      current: draft.step ?? 1,
      go: (d, step) =>
        d.kind === 'rotateAxis' || d.kind === 'align' ? { ...d, step: step <= 0 ? 0 : 1 } : d,
    };
  },
});

export const PRINT_DRAFT_TOOL = defineDraftTool<PrintDraft>({
  module: 'modeling',
  kinds: PRINT_DRAFT_KINDS,
  createDraft: createPrintDraft,
  // A construction plane clicked while the tool runs becomes its reference (Draft's neutral plane).
  acceptPick: (draft, pick, evaluation, features) =>
    acceptPrintPick(draft, pick, evaluation, pick.kind === 'datum' ? [] : features),
  toFeature: printDraftToFeature,
  meta: printDraftMeta,
  badges: (draft) => printDraftBadges(draft),
  handles: printDraftHandles,
  guides: printDraftGuides,
  modifiedBodyIds: printDraftModifiedBodyIds,
  picksSketchLines: printDraftPicksSketchLines,
  // Hole: a click into a through hole of the picked face removes that hole.
  acceptEmptyClick: (draft, ray, evaluation, features) =>
    draft.kind === 'hole' && draft.face
      ? acceptPrintPick(
          draft,
          { kind: 'face', bodyId: draft.face.bodyId, faceKey: draft.face.key, ray },
          evaluation,
          features,
        )
      : draft,
});
