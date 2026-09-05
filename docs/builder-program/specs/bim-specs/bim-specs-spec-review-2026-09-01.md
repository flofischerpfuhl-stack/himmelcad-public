# Demanding-user review — BIM specifications domain spec (2026-09-01)

Document class: report/verification evidence. Static review; all spot-checked
code citations in the spec hold. Strongest data-model reasoning in the
program so far (BS-D5/BS-D6/BS-D10 exemplary), but cross-spec contradictions
and an under-specified authoring canvas. Findings, most severe first:

1. **Blocker — catalog/E2. Draw and BIM contradict each other on what a
   placed symbol/fill IS.** Draw DR-D7: canonical `hcad.block@2` instances /
   fill entities. This spec: entity of the definition's kind + spec
   component, occurrences are derived data, blocks are render substrate
   only. Also duplicated commands: `draw.symbol.place`/`draw.fill.create`
   vs `bim_object.place`. _Resolution:_ this spec's model wins (stronger
   derivation, D3 separation); amend draw.md DR-D7; one canonical command
   (`bim_object.place`) with Draw-tab access paths resolving to it; record
   the reconciliation in both boundary notes.
2. **Major — C2/B2 self-contradiction. Apply picker closes on outside click
   but promises a live selection count.** _Resolution:_ picker ignores
   selection gestures; closes only on commit, Escape, close affordance, or
   other chrome (keeps live count and commit-time semantics).
3. **Major — A1/B3. The symbol canvas is two sentences — contract level in a
   workflow-level costume.** _Resolution:_ canvas hosts the Draw toolset
   over the shared snap pipeline and input bar (no second drafting path);
   primitives expose intrinsic dimensions as bindable slots directly (the
   honest simpler-than-Revit claim); unbound values are typed constants;
   canvas dimensions are a distinct driving kind outside DR-D9's scope
   (one sentence in both specs).
4. **Major — §1.2/BS-D8. Auto-flex evaluates min/max bounds the parameter
   model never declares; instance-bound parameters have no flex value.**
   _Resolution:_ optional min/max/enum domains on geometry-driving
   parameters (unbounded default); flex = {type rows} × {instance params at
   default/min/max}; evaluation-count budget (X6) trips the busy state.
5. **Major — BS-D9 covers type-row blast radius; the 4000-instance blast
   lives at definition level.** Parameter deletion with live values,
   rename identity, retype-to-sibling value mapping are all X1 data-loss
   holes. _Resolution:_ same affects-N copy for definition commits;
   parameter delete blocked-with-count offering explicit journaled "delete
   values"; parameters get stable ids (rename = display name); retype maps
   by parameter id, drops rest with console count.
6. **Major — X5/B1. `spec.unapply` exists for automation only; no UI
   button.** _Resolution:_ "No specification" entry in the picker + clear
   affordance in the properties Specification row, both → `spec.unapply`.
7. **Major — C2. Mixed-kind apply (40 points + 1 stray curve)
   unspecified.** _Resolution:_ union filter; per-definition applicable
   count ("40 of 41"); commit applies to applicable subset; console names
   skips. Never silent, never blocking.
8. **Major — D1/E3. Editor preview flexing is continuous with no runnable
   gate (the orbit benchmark measures the wrong thing).** _Resolution:_
   type-switch and parameter-typing bursts in the open editor, p95 preview
   latency ≤ one frame budget, agent-runnable; wire §7 criterion 3 to it.
9. **Major — A3/registry. "Properties never closes" contradicts
   ui-platform's tab model.** _Resolution:_ adopt ui-platform: Properties is
   the strip's default tab — always reachable, never closeable to nowhere,
   auto-restored when no function tab is active.
10. **Minor — A2 hygiene:** Fachbedeutungen is rib-civil §2.7 not §2.3;
    [from memory]-flagged dossier claims must carry the flag and a sourced
    primary when cited in decision records (BS-D2, BS-D9).
11. **Minor — C1. Symbol space (world vs screen per `TextSpace` precedent)
    and 3D behavior of 2D symbols unspecified.** _Resolution:_ declare per
    symbol; in-plane in 2D/2.5D, placement plane in 3D; per-mode stand-ins
    to BS-D15 queue.
12. **Minor — B1. Quick-surface row missing per function ("Place object
    here" recommended); symbol automation payload shape unsketched (parity
    test unwritable).**
13. **Minor — E2. Long-running spec operations (library import, >10⁴
    regeneration) must register with the UIP-D10 job registry.**
14. **Minor — E2. Editor stale-view on external commits: subscribe to
    canonical change events, re-query, preserve uncommitted field text.**
15. **Minor — C4/BS-D1. Migration prompt-per-project; library import
    collision preview (keep/replace/rename per code); implicit "Default"
    type row so apply never dead-ends.**
16. **Minor — C4. Undo in the editor window is global-journal undo — state
    it; console names the reverted step; window-scoped stack recorded as
    rejected.**
17. **Idea — promote "New specification from selection" (block-from-
    selection substrate exists: `BlockMemberSource::EntityReference`) into
    core; keep occurrence conversion queued.**

Answered convincingly: A3, C3, C4 data model (canonical/derived split),
D2, E2 consumer table, BS-D10 wire-contract reuse, §8 dissolutions.

Owner-decision items: **none** (finding 1 tested against the escalation
protocol: axioms decide it — it is a correction to draw.md, not a question).

System feedback: findings 1 and 9 share one generator — two "specified"
domain specs contradicting each other on shared surfaces, undetected because
`REGISTRY.md` does not exist yet. Create the registry before further domain
specs land; standing checks: "no two rows claim the same act; no two specs
claim the same surface with different guarantees."
