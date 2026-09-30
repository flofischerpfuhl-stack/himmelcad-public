/**
 * The Construct tools (`model/constructionTools.ts`) as drafts of the
 * generic feature tool (`foundation/commands/featureDrafts.ts`), so the
 * store, the tool pill and the viewport run them without naming them.
 *
 * Phase B note: written by agent B when the modelling tools stopped
 * dispatching construction drafts; agent A's construction move owns this
 * file (take A's version on a merge conflict).
 */
import {
  registerFeatureDraft,
  type FeatureDraft,
} from '../../foundation/commands/featureDrafts.js';
import {
  acceptConstructionPick,
  constructionDraftBadges,
  constructionDraftGuides,
  constructionDraftHandles,
  constructionDraftMeta,
  constructionDraftToFeature,
  createConstructionDraft,
  isConstructionDraftKind,
  type ConstructionDraft,
} from '../../model/constructionTools.js';

type PlaneDraft = Extract<ConstructionDraft, { kind: 'constructionPlane' }>;
type AxisDraft = Extract<ConstructionDraft, { kind: 'constructionAxis' }>;

declare module '../../foundation/commands/featureDrafts.js' {
  interface FeatureDraftMap {
    constructionPlane: PlaneDraft;
    constructionAxis: AxisDraft;
  }
}

const isConstructionDraft = (draft: FeatureDraft): draft is ConstructionDraft =>
  isConstructionDraftKind(draft.kind);

for (const kind of ['constructionPlane', 'constructionAxis'] as const) {
  registerFeatureDraft<ConstructionDraft['kind']>({
    kind,
    module: 'construction',
    create: (ctx) => ({
      ok: true,
      draft: createConstructionDraft(
        kind,
        kind === 'constructionPlane' ? 'offset' : 'edge',
        ctx.selection,
        ctx.evaluation,
      ),
    }),
    acceptPick: (draft, pick, evaluation) => acceptConstructionPick(draft, pick, evaluation),
    toFeature: constructionDraftToFeature,
    meta: constructionDraftMeta,
    badges: (draft) =>
      constructionDraftBadges(draft).map((badge) => ({
        ...badge,
        apply: (d, value, evaluation) =>
          isConstructionDraft(d) ? badge.apply(d, value, evaluation) : d,
      })),
    handles: (draft, evaluation) =>
      constructionDraftHandles(draft, evaluation).map((h) => ({
        ...h,
        apply: (d: FeatureDraft, value: number) => (isConstructionDraft(d) ? h.apply(d, value) : d),
      })),
    guides: (draft, evaluation) => constructionDraftGuides(draft, evaluation),
    // An angled plane turns about an axis, which may be a sketch line.
    picksSketchLines: (draft) => draft.kind === 'constructionPlane' && draft.mode === 'angle',
  });
}
