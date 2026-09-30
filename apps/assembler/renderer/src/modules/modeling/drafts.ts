/**
 * Registers the modelling tools with the generic feature tool
 * (`foundation/commands/featureDrafts.ts`): Revolve … Align
 * (`featureTools.ts`) and the print-part tools Hole, Emboss, Draft, Rib and
 * Thicken (`printFeatureTools.ts`). Loaded by `module.ts`.
 */
import {
  registerFeatureDraft,
  type FeatureDraft,
} from '../../foundation/commands/featureDrafts.js';
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
} from './featureTools.js';
import {
  PRINT_DRAFT_KINDS,
  acceptPrintPick,
  createPrintDraft,
  isPrintDraftKind,
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

declare module '../../foundation/commands/featureDrafts.js' {
  interface FeatureDraftMap {
    hole: HoleDraft;
    emboss: Extract<PrintDraft, { kind: 'emboss' }>;
    draft: Extract<PrintDraft, { kind: 'draft' }>;
    rib: Extract<PrintDraft, { kind: 'rib' }>;
    thicken: Extract<PrintDraft, { kind: 'thicken' }>;
  }
}

/** Kinds whose tool takes an axis (a sketch line may be it). */
const TAKES_AXIS: ReadonlySet<string> = new Set(['revolve', 'rotateAxis', 'pattern', 'mirror']);

for (const kind of MODELING_DRAFT_KINDS) {
  registerFeatureDraft({
    kind,
    module: 'modeling',
    create: (ctx) => createModelingDraft(kind, ctx),
    acceptPick: (draft, pick, evaluation) => acceptModelingPick(draft, pick, evaluation),
    toFeature: modelingDraftToFeature,
    meta: modelingDraftMeta,
    badges: (draft) => modelingDraftBadges(draft),
    handles: modelingDraftHandles,
    guides: (draft, evaluation) => modelingDraftGuides(draft, evaluation),
    modifiedBodyIds: modelingDraftModifiedBodyIds,
    picksSketchLines: (draft) => TAKES_AXIS.has(draft.kind),
  });
}

const isPrintDraft = (draft: FeatureDraft): draft is PrintDraft => isPrintDraftKind(draft.kind);

for (const kind of PRINT_DRAFT_KINDS) {
  registerFeatureDraft({
    kind,
    module: 'modeling',
    create: (ctx) => createPrintDraft(kind, ctx),
    // A construction plane clicked while the tool runs becomes its reference (Draft's neutral plane).
    acceptPick: (draft, pick, evaluation, features) =>
      acceptPrintPick(draft, pick, evaluation, pick.kind === 'datum' ? [] : features),
    toFeature: printDraftToFeature,
    meta: printDraftMeta,
    badges: (draft) =>
      printDraftBadges(draft).map((badge) => ({
        ...badge,
        apply: (d, value, evaluation) => (isPrintDraft(d) ? badge.apply(d, value, evaluation) : d),
      })),
    handles: (draft, evaluation, features) =>
      printDraftHandles(draft, evaluation, features).map((h) => ({
        ...h,
        apply: (d: FeatureDraft, value: number) => (isPrintDraft(d) ? h.apply(d, value) : d),
      })),
    guides: printDraftGuides,
    modifiedBodyIds: printDraftModifiedBodyIds,
    picksSketchLines: printDraftPicksSketchLines,
  });
}
