# Viewing box — workflow-level specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2.
Document class: plan. Walks `docs/FUNCTION-CONTRACT.md` in full; every
consequential choice carries a `docs/DECISION-DOCTRINE.md` decision record.
Input evidence: `viewing-box-review-2026-09-01.md` (implementation review),
`viewing-box-spec-review-2026-09-01.md` (spec review, findings 1–15),
the four dossiers in `docs/builder-program/dossiers/`.
E1 reference artifact: `viewing-box-visual-criteria.md` (in-repo, written
criteria; no third-party screenshots per repository license discipline).

Registry row: id `view.viewing-box` · ribbon **View** tab (D2 taxonomy) ·
surface: right function panel · performance class: continuous ·
automation namespace `viewing_box.*` · shortcut: F4 recommended to the
registry (VB-D9) · status: specified.

## 1. Workflow narratives

### 1.1 First use and placement

The user has a loaded point cloud and wants to isolate a stairwell. On the
View tab they press **Viewing box**. The button lights up and the right
panel opens; because the project has no boxes yet, placement starts
immediately: the status line says "Click the model to place the box" and
the cursor becomes a crosshair. One click on the stairwell places a box
centered on the picked point, sized to 60% of the visible span,
axis-aligned. The clip takes effect immediately: everything outside the box
disappears, the box edges and face handles render as an overlay, and the
console logs the placement with the full box size (all three extents). The
placed box is a canonical entity named "Viewing box 1" — it appears in the
left entity area, survives reload, and is visible to automation from this
first second. Escape during placement cancels placement only; a second
Escape closes the panel (§1.6). The ribbon button itself is strictly a
panel toggle — placement is started by the panel's **New box** button, the
quick-surface entry, or automatically when the panel opens with zero boxes.

### 1.2 Adjusting — drag and type

The box never fits on the first try. The user drags a face arrow: the face
follows the cursor at full frame rate, the opposite face stays anchored, and
the panel's Size fields update live. Clicking (not dragging) an arrow swaps
the handles to rotation rings; dragging a ring rotates the box about that
local axis while the panel's Rotation fields count along; clicking a ring
swaps back. A drag below the 4 px movement threshold changes nothing — no
accidental micro-resize, no stale preview frame.

The same panel always shows three groups, regardless of handle mode:
**Center** (X/Y/Z in project units — surveyed coordinates can be typed
directly), **Size** (full extents per axis), and **Rotation** (degrees about
the local X/Y/Z axes, displayed and typeable, with the ±15° nudge buttons
kept as accelerators). Fields commit on Enter or blur, validate then, and
show project-setting precision and units. Escape in a field reverts it to
the last committed value and keeps the panel open; closing the panel
mid-edit discards the half-typed value — a blur caused by closing or
reverting never commits (`docs/DESIGN-SYSTEM.md` "Input consistency").
Typing and dragging edit the same state: a drag mid-edit updates the
fields; a typed commit moves the box. "Set center in view" re-picks the
center from the model. Each committed adjustment — drag end or field
commit — is one journaled step; Ctrl+Z walks them back individually.

### 1.3 Locking — the box becomes a small point cloud

Satisfied with the fit, the user presses **Lock**. Builder bakes the boxed
point-cloud content into a reduced resident dataset: for a small box this
is instant; for a large one an inline progress state shows the bake
(cancellable — cancel returns to the unlocked box, nothing partial
published). The bake is a platform job: closing the panel does not cancel
it — it keeps running in the background, registered with the platform job
registry (ui-platform spec UIP-D10: jobs chip, jobs-island row, cancel
affordance), and applies the lock on completion; explicit cancel stays
available from both the panel and the jobs island with the same
no-partial-bake semantics. Once locked, the point passes render the baked subset with no
clip planes, while every other pass — mesh, CAD, raster, splat — keeps the
six planes, so a BIM model in the scene stays correctly clipped (the plane
cost only ever mattered against the massive cloud). Orbiting a boxed
stairwell inside a billion-point scan now feels exactly like opening a
stairwell-sized scan — indistinguishable from segment-extracting the same
region (P2, gated in §5 on a mixed cloud+mesh scene). Handles hide, fields
become read-only, and the panel shows "Locked — unlock to edit." If the
source data changes while locked — a segment-delete inside the box, an
import, a transform — the bake rebuilds automatically once the edits
settle, with the same progress state; the box never shows stale points. **Unlock** restores the
live-clipped, editable box; the bake is kept as a cache keyed on box
geometry, operation, and source-dataset revision, so re-locking an
unchanged box is instant.

### 1.4 Naming, saving, restoring

Every placed box is already saved — placement created a canonical entity.
The panel's **Saved boxes** list shows all boxes in the project with the
active one marked. The user renames "Viewing box 1" to "Stairwell B"
inline, presses **New box** to place a second one for the facade ("Facade
west"), and switches between them by activating a list entry; activation is
a journaled command, so at most one box clips at a time and Ctrl+Z restores
the previous activation. Deactivating all boxes shows the full cloud again
without deleting anything. Because boxes and activation are canonical, an
agent instruction like "restore the last viewing box" is executable through
`viewing_box.list(order: last_activated_generation_desc, limit: N,
state: surviving)`: order by activation generation, tie by stable entity id;
deleted boxes never return and `limit` is schema-capped. Activate the first
result with `viewing_box.activate`; no journal scan is permitted (AG-D12).
Boxes travel inside
`.hcadx` archives with the project (owner decision D1); standalone box-file
export/import for colleagues — RealWorks shares box files down to its free
viewer (`dossiers/realworks.md` §2.5 [13]) — is queued (VB-D11). On
reopening the project the last state — including an active, locked box —
is exactly restored.

### 1.5 Inside or outside

A toggle in the panel switches the box operation between **Keep inside**
(default) and **Remove inside**. Removing the stairwell to inspect the
structure around it is one click; the overlay restyles so the discarded
side is obvious (criteria file, §4). Lock bakes whichever side is kept —
unless the kept side is most of the cloud (typical for remove-inside), in
which case lock falls back to an edit-freeze that keeps the clip planes and
says so in the panel (VB-D12); the user still gets a frozen, safe box, just
without a pointless near-full-cloud bake.

### 1.6 Escape, close, and the quiet indicator

Escape follows one ladder, innermost rung first, one rung per press: in a
focused input it reverts the field and keeps the panel open; during a
handle drag it reverts the drag to its start state (as does
`pointercancel`); during center placement it cancels placement; otherwise
it closes the panel. Closing the panel — via Escape, the panel's close
affordance, or toggling the ribbon button — never removes the box, and
never cancels a running lock-bake (§1.3 — the bake continues as a
registered background job): the
clip stays active in the background, and a persistent chip appears in the
viewport overlay next to the view-mode chips showing the box name
(truncated) plus a lock glyph when locked; the tooltip names the operation.
Clicking the chip reopens the panel. While the panel is closed, box handles
are disarmed: no invisible 15 px hit zone steals gestures from other tools.

### 1.7 Removal — with a way back

**Remove box** deletes the active box entity in one click, without a
confirmation dialog, because it does not need one: removal is a journaled
command and Ctrl+Z brings the box back completely — geometry, name,
operation, lock state, activation. Removing a deactivated box from the
Saved boxes list works the same way.

### 1.8 Multi-box posture

Exactly one box is active at a time; this is enforced at the command layer,
not in the data model. Boxes carry stable ids, the clip scope is derived
from the box id, and the entity model already holds many boxes — so future
multi-box clipping (intersection of several boxes, per-viewport activation)
is a command-layer change, not a migration.

## 2. Function contract (A1–E3)

**A1 — User outcome.** §1 in full.

**A2 — Reference behavior** (all claims cite dossier sections per the
contract's evidence rule). RealWorks Limit Box
(`dossiers/realworks.md` §2.5, W3): F4 activation, center pick, per-face
arrow grips, manipulator mode switching, show/hide-outside toggle, named
stored boxes with import/export, and the Limit Box Extraction variant — we
adopt center-pick placement, handle-first manipulation, named stored boxes,
and the F4 recommendation; its in/out choice is display-only (show/hide
outside), whereas our operation toggle actually clips either side — the
in/out-keep pair is grounded in RealWorks' segmentation tool
(realworks.md §2.3) and X5, a stated deviation for the Limit Box itself.
Trimble Perspective limit box (`dossiers/trimble-perspective.md` §2.3
[S5][S10]): persists across tool/project/app restarts, restores a previous
box, highlights the active handle and affected face, seeds centered on the
current view, and doubles as an export scope — we adopt persistence,
restore, the highlight pattern, and view-centered seeding for void
invocation; the export-scope pairing maps to extract, which ships via the
pointcloud spec's `pointcloud.extract` command (VB-D11).
Trimble Access limit box (trimble-perspective.md §2.4 [S7][S8]):
slider+typed hybrid per face pair, reference-azimuth alignment,
thickness-locked storey slicing — typed parity we exceed; azimuth and
storey slicing are queued (VB-D11). RIB Civil documents no clip volumes
(`dossiers/rib-civil.md`, checked); its contribution is the F5-Box norm —
"every mouse construction has a numeric twin" (rib-civil.md §2 F5-Box,
§4 design lessons) — which drives full C1 parity. The Revit dossier
(`dossiers/revit.md`) covers specification management and contains no
section-box research; the previous "Revit section box" claim is withdrawn
as unresearched — named canonical boxes rest on P1, which needs no
reference support.

**A3 — Sibling functions.** Nearest relatives: authoritative sections
(clip-plane pipeline), segmentation (spatial subsets and the in/out-keep
pair, realworks.md §2.3), measurement/inspect tools (which must consume
the clip, VB-D13), view-mode overlay chips (indicator pattern). Panel
controls reuse the shared segmented control, tool buttons, and vector
editors; the improved Enter/Escape-commit `VectorEditor` (§1.2) must be
shared back to any sibling using it. Segment-extract shares the bake
machinery (P2).

**B1 — Reachability.** Ribbon: View tab toggle for the panel (present;
strictly a toggle, VB-D14). Entity context menu on a viewing-box entity:
activate / rename / remove (present). Viewport quick surface: "Place
viewing box here" (present); over geometry it uses the picked point, over
void it seeds centered on the current view (VB-D10). Console command and
automation (AI agent + Python SDK): full command set `viewing_box.place /
update / set_operation / lock / unlock / rename / activate / deactivate /
remove / list` (present), all resolving to the same canonical journaled
commands the UI uses. `view.state.get` reports the active box id, geometry,
operation, and lock state, so an agent receiving clipped renders knows a
clip exists. Keyboard shortcut: F4 recommended to `REGISTRY.md` (VB-D9).

**B2 — Open/close symmetry.** Ribbon button toggles the panel open/closed
and does nothing else; the panel has an explicit close affordance; Escape
ladder per §1.6. Closing means keep-alive: the box and its clip persist;
only the editing surface leaves, and a mid-edit field value is discarded,
never committed (§1.2). A running lock-bake is likewise not cancelled by
closing (or by Escape past the panel rung): it continues as a job
registered per ui-platform UIP-D10, with its cancel affordance in the jobs
surface, and applies the lock when it completes.

**B3 — Surface choice.** Right function panel — the user must keep
dragging handles in the viewport while reading and typing parameters; both
reviews confirmed this choice. The Saved boxes list fits the panel;
nothing in §1 outgrows it.

**C1 — Numeric parity.** Every manipulation has a typed twin (RIB F5-Box
norm, rib-civil.md §2): face drag ↔ Size fields, box drag/pick ↔ Center
fields, ring drag ↔ Rotation degree fields; all live-synchronized both
ways; units and precision from project settings; Enter/blur commit, Escape
reverts (§1.2). The dead mode-gated Center editor is removed — all three
groups are always visible.

**C2 — Selection semantics.** The function operates on its own entity, not
the selection; launching it neither requires nor consumes a selection.
Selecting a viewing-box entity in the entity area shows its properties and
context commands; viewport selection changes while the panel is open have
no effect on the box. While a box is active, selection, picking, snapping,
and measurement operate on what the user sees: clipped-away points are
excluded from hit-testing (locked: candidates come from the bake, results
resolve to full-precision source points) — VB-D13, doctrine P4.

**C3 — Freezability.** Lock (§1.3): bakes the kept point-cloud region into
a reduced resident dataset and drops the clip planes for the passes the
bake replaces, keeping them for all others (VB-D3). The bake is cached
across unlock, keyed on (box geometry, operation, source-dataset revision),
and auto-rebakes — debounced, on settled revisions — on source change
while locked; the bake job is backgroundable per B2. Remove-inside locks whose
kept region exceeds the VB-D12 threshold degrade to edit-freeze with planes
retained.

**C4 — Persistence and undo.** Boxes are canonical named entities (P1);
place, update-commit, set-operation, rename, activate, deactivate, remove,
lock, unlock are journaled commands and undoable. Boxes ship inside
`.hcadx` archives (D1); standalone box files are queued (VB-D11).
View-local state is exactly: drag previews between pointer-down and commit,
uncommitted field text, and hover/handle mode. Defensible to a Ctrl+Z user:
everything they would call "a step" is a step; cursor flourishes are not.

**D1 — Performance budget.** Continuous: face and ring drags, and plain
navigation with an active box in every state — gates: the viewing-box
benchmark (face drag, ring drag, and an orbit burst with an active
_unlocked_ box, presented-frame-interval p95 ≤ 2× target frame time —
presentation cadence, not render-body cost, VB-D7) and the
lock-parity benchmark on a mixed scene (VB-D8), both agent-runnable.
Bounded: placement, activation, typed commits (< 1 s, no indicator when
imperceptible). Bounded-to-long-running: lock bake and auto-rebake — inline
busy state, real progress when phases exist, cancellable (§1.3).

**D2 — Degradation.** During drags the existing interaction path applies:
`setInteracting`, preview caps dropped (`previewCap=false`), quality
governor may reduce point budget. Degradation order: cap/overlay fidelity
first, then point density. Never degraded: input responsiveness, clip
correctness at commit, clip-consistent picking (VB-D13), journal
integrity. On weak hardware a locked box is the escape hatch — the baked
subset restores full quality at small scale.

**E1 — Visual quality.** The in-repo reference artifact is
`viewing-box-visual-criteria.md`: failable criteria for handle legibility,
active-state highlight, grip stability under drag (the RealWorks v12.4
"jumping grips" regression class, realworks.md §4 [18], asserted from
benchmark samples), in/out legibility, chip copy, and locked-state styling
— grounded in dossier sources by URL. No third-party screenshots are
committed. Implementation review compares actual screenshots and benchmark
state samples against that file. Design tokens only; no one-off chrome.

**E2 — Conflicts, failure, and consumers.** Consumers of the clip volume
(shared by design — `WgpuKernelViewer.ts:474`) and the function's effect on
each:

| Consumer                   | Unlocked box                                                                                                                                                          | Locked box                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Point/splat render passes  | six planes applied                                                                                                                                                    | render bake, no planes (VB-D3)                                                                     |
| Mesh / CAD / raster passes | six planes applied                                                                                                                                                    | six planes kept (VB-D3)                                                                            |
| Picking, snapping          | exclude clipped points (VB-D13)                                                                                                                                       | candidates from bake; results resolve to full-precision source points in the box (VB-D13)          |
| Selection (box/lasso)      | visible points only (VB-D13)                                                                                                                                          | bake only                                                                                          |
| Measurement/inspect tools  | pick visible points only; existing measurement graphics follow their anchors' visibility                                                                              | same, full-precision per VB-D13                                                                    |
| Exporters / deliverables   | ignore the viewing box — exports read canonical data; box-scoped export is the explicit `pointcloud.extract` (pointcloud spec, VB-D11), never a silent partial export | same                                                                                               |
| Platform job registry      | —                                                                                                                                                                     | lock-bake/rebake registers per ui-platform UIP-D10; survives panel close; cancel from jobs surface |
| Automation                 | renders arrive clipped; `view.state.get` reports box id, geometry, operation, lock                                                                                    | same, plus lock state                                                                              |

Canonical commits serialize through the journal. An automation update
arriving mid-drag cancels the drag and reverts the preview to the new
canonical state. Lock is disabled while a drag is in flight; edits are
disabled while locked. A cancelled or failed bake or rebake publishes
nothing partial and returns to the unlocked (or prior locked) state with a
console entry naming what failed and that the box is intact. Crash: box
entities, activation, and lock flag replay from the journal; the bake cache
is derived data — persisted in the project's prepared-data store, rebuilt
on open if missing or key-stale.

**E3 — Verification plan.** §5. Unverified claims are listed there
explicitly.

## 3. Decision records

Viewer Core class-specific presented-frame and protected mixed-entity amendments to VB-D7/VB-D8 are specified in `viewer-core-addendum.md` (VC-D1/VC-D3 and `G-VC-VB-*`).

**VB-D1 — Boxes are canonical entities from placement, not from naming.**
**Decision:** every placed box is immediately a canonical, journaled, named
entity; there is no view-local "unsaved box" stage.
**Derivation:** X3 (deliberately created state is canonical by default), P1
(named viewing boxes and their class), implementation-review blockers C4/B1
— one model fixes all three and yields undo for free.
**Rejected:** view-local until explicitly saved — creates the exact
automation-invisible state P1 forbids and a second persistence code path.
**Tunable:** no.

**VB-D2 — Commit granularity.** **Decision:** drag previews and uncommitted
field text are view-local; pointer-up, Enter/blur field commit, and each
nudge button are single journaled updates. **Derivation:** X3 exception
clause; C4; keeps journal replay drag-free. **Rejected:** journaling every
preview frame (journal spam, meaningless undo steps). **Tunable:** no.

**VB-D3 — Lock bakes pass-scoped; bake keyed on data, not only geometry**
(revised per spec-review findings 1 and 7). **Decision:** lock runs a
cancellable bake of the kept point-cloud region into a resident reduced
dataset; while locked, clip planes are dropped **only for the passes whose
data the bake replaces** — all other passes (mesh, CAD, raster, splat) keep
the six planes. The bake cache key is (box geometry, operation, exact source
entity id, exact source entity/placement revision, source-dataset revision); a
source content or placement change while locked auto-rebakes with
the §1.3 progress state — keyed on settled/compacted revisions and
debounced, never once per intermediate apply (pointcloud review 7d);
geometry edits require unlock. During an SE-D1 transform preview the stale bake
is suspended and live planes clip the source at preview placement. Commit shows
**Rebuilding locked box** until one settled bake publishes atomically; cancel
restores the prior exact bake. The bake runs as a platform job registered
per ui-platform UIP-D10: panel close or Escape past the panel rung never
cancels it — it completes in the background and applies the lock; explicit
cancel (panel or jobs island) keeps the no-partial-bake semantics
(ui-platform review finding 12). **Derivation:** X2,
P2, X1 (dropping planes globally un-clips every non-point entity —
`WgpuKernelViewer.ts:474`; geometry-only invalidation shows stale deleted
points — both correctness defects). **Rejected:** global plane dropping
(the finding-1 blocker); bake-per-pass for meshes too (plane cost is only
significant against the massive cloud; no payoff). **Tunable:** bake
budget/point cap per hardware tier (X6).

**VB-D4 — In/out operation toggle** (re-derived per spec-review finding 4b).
**Decision:** the box operation is `keepInside`/`removeInside`, toggled in
the panel. **Derivation:** X5 (keep/remove pair); the sibling precedent is
RealWorks _segmentation_ in/out-keep (realworks.md §2.3); the kernel
already supports `removeInside`. Stated deviation: the RealWorks Limit Box
itself offers only a show/hide-outside display toggle (realworks.md §2.5)
— we clip either side because X5 treats a shipped half-pair as a defect.
**Rejected:** keep-inside only; display-only hide-outside (does not
compose with lock-bake). **Tunable:** no.

**VB-D5 — Escape ladder with a typing rung; drags revert** (revised per
spec-review findings 5 and 9). **Decision:** Escape resolves one rung per
press, innermost first: focused input → revert field, keep panel; active
drag → revert to drag start (`pointercancel` identical); placement →
cancel placement; otherwise → close panel. Closing a surface mid-edit
discards the uncommitted value; the resulting blur never commits.
Sub-threshold drags commit nothing and cancel the pending preview frame.
**Derivation:** `docs/DESIGN-SYSTEM.md` "Input consistency" (Escape in
text inputs) and "Complete user flows"; X5; implementation-review majors
B2/correctness. **Rejected:** Escape removing the box (destructive
surprise); blur-commits-on-close (silently moves the box the user was
abandoning — finding 5). **Tunable:** movement threshold (4 px; X6).

**VB-D6 — Handles armed only while the function is active; named chip when
not** (revised per spec-review finding 13). **Decision:** the overlay hit
test runs only while the viewing-box panel is open; with the panel closed a
viewport chip shows the truncated box name plus a lock glyph, with the
operation in its tooltip, and reopens the panel on click. **Derivation:**
implementation-review major C2/E2 (gesture theft); DESIGN-SYSTEM
discoverability and UI-copy rules (labels carry real state, not generic
words); A3 (view-mode chip pattern). **Rejected:** always-armed handles;
a generic "Box" label (hides which box and whether locked). **Tunable:**
name truncation length (X6).

**VB-D7 — Drag and orbit smoothness gate** (revised per spec-review
finding 10; metric pinned per view-domain review 2026-09-02 finding 2).
**Decision:** the gate metric is the **presented-frame-interval p95** —
deltas between rAF/present timestamps, what the user's eye receives — at
≤ 2× target frame time during scripted **face drags, ring drags, and an
orbit burst with an active unlocked box**, wired behind the `browser-gpu`
capability (risk-triggered on push for viewer/viewport paths, always in
release). The metric is explicitly _not_ render-body cost:
`FrameTelemetry` cpu/gpu/effective milliseconds measure render work, not
presentation cadence, and would hide React drag-sync jank. Only the
measurement source may migrate onto `view.diagnostics.sample` once it
exposes a presented-interval distribution; input driving and
overlay-state sampling stay in the benchmark harness. The benchmark is
agent-runnable — it launches the dev app itself — and its
sampled states also feed criterion 3 of the visual-criteria file.
**Derivation:** P3/X6; implementation-review major E3/D1; D1's rule that
every continuous interaction needs a named gate covers plain orbit with
planes active, not only drags; view-domain review finding 2 (doctrine
rule 2 — the metric is fixed here at the record, not by implication in a
telemetry migration). **Rejected:** the old
p95 ≤ max(55 ms, 3.5× target) (passes visible jank); drag-only coverage
(orbit with six planes was ungated); gating on `FrameTelemetry` render
cost (a fast render body presented late still janks — the finding-2
blocker). **Tunable:** yes — the 2× multiplier; the measurement _source_
(harness rAF vs. a future `view.diagnostics.sample` interval
distribution), never the metric.

**VB-D8 — Lock parity gate on a mixed scene** (revised per spec-review
finding 1). **Decision:** a benchmark orbits (a) a locked box and (b) a
segment-extract of the same region in a scene containing **both** a large
cloud and mesh/CAD content, asserting locked p95 presented-frame interval
(the VB-D7 metric, not render-body cost) ≤ 1.1× the
extract's — so a regression that un-clips or over-clips non-point passes,
or loses the bake payoff, fails the gate. **Derivation:** P2 needs a
runnable number (D1); X6; finding 1's blocker scenario is cloud+BIM.
**Rejected:** cloud-only parity scene (blind to exactly the blocker);
"faster than unlocked" (misses P2's point). **Tunable:** yes — the 1.1
tolerance.

**VB-D9 — Shortcut: recommend F4 to the registry** (reopened per
spec-review finding 4a). **Decision:** the earlier "no reference binds a
limit-box key" premise was false — RealWorks activates its Limit Box with
**F4** (realworks.md §2.5, W3). This spec recommends F4 for
`view.viewing-box` in `REGISTRY.md`, where the cross-function shortcut map
is owned; the registry assigns or resolves collisions (RIB Civil uses F4
for named-object selection, rib-civil.md §2 — a different domain, noted
for the registry's decision). **Derivation:** X4 (adopt reference behavior
absent conflicts); doctrine rule 2 (wrong premise ⇒ fix at the source).
**Rejected:** binding F4 unilaterally here (the map is a shared resource);
keeping "no shortcut" (contradicts the dossier). **Tunable:** yes —
registry-level assignment.

**VB-D10 — Placement seed, picked or view-centered** (revised per
spec-review finding 11). **Decision:** initial box: 60% of the visible
span per axis, axis-aligned; centered on the picked point when invoked
over geometry, centered on the current view when invoked over void (the
quick-surface case with nothing under the cursor). **Derivation:** X4 —
Perspective seeds its limit box centered on the current view
(trimble-perspective.md §2.3 [S5]); current implementation's
`viewFraction` 0.6. **Rejected:** rejecting void invocation (dead-ends a
legitimate entry); fit-to-dataset bounds (clips nothing useful).
**Tunable:** yes — fraction and uniform seeding.

**VB-D11 — Queued follow-ons** (extended per spec-review findings 12, 14,
15; extract un-queued per pointcloud review finding 14). **Decision:**
extract-box-to-entity is **no longer queued** — it ships with the
pointcloud spec as `pointcloud.extract`; this panel's extract button is
one-line wiring onto that command. Still queued behind this spec, in one
backlog: align-to-view/
picked-face; double-click-face to
type a dimension; standalone box-file export/import (realworks.md §2.5);
thickness-locked storey slicing and reference-azimuth alignment
(trimble-perspective.md §2.4 [S7]); densifying bake — refresh the boxed
region at full source density, beyond display density, as RealWorks Limit
Box Extraction pulls fresh points from raw scans (realworks.md §2.5 [8],
W3). **Derivation:** review classes them ideas/catalog, not defects;
`docs/CURRENT-DIRECTION.md` completion discipline; X2 makes the densify
bake a natural extension once the bake exists. **Rejected:** bundling them
now (delays the six-times-corrected core). **Tunable:** no.

**VB-D12 — Remove-inside lock threshold** (new per spec-review finding 8).
**Decision:** when the kept region's estimated point share exceeds a
tunable fraction of resident points (start: 50%), lock does not bake; it
becomes an edit-freeze that retains the clip planes, with panel copy
stating why ("Locked without bake — kept region is most of the cloud").
**Derivation:** X2 spends memory _for_ interaction speed — baking ~99% of
the cloud buys none and costs a near-duplicate of the dataset; X6
delegates the threshold. **Rejected:** always baking (memory doubled for
zero payoff); forbidding lock for remove-inside (loses the edit-freeze
half of C3). **Tunable:** yes — the 50% threshold, tightened with bake
telemetry.

**VB-D13 — Tools see what the user sees** (new per spec-review finding 3;
since generalized into doctrine precedent P4). **Decision:** while a box is
active, picking, snapping, selection, and measurement exclude clipped-away
points; when locked, hit-test candidates may come from the bake, but snap
and pick results resolve against the full-precision source points within
the box — display decimation never rounds a surveyed coordinate (X1; draw
review finding 13). **Derivation:** X1 — snapping to an invisible point
behind a clipped wall, or to a decimated stand-in for a measured point,
writes a wrong number into a survey deliverable; P4 (the visible-set rule,
generalized from this record); contract E2's passive-consumer rule;
DESIGN-SYSTEM input consistency (picking must not
change meaning between visually identical states). **Rejected:**
clip-unaware picking (the current behavior — a correctness defect, not a
scope choice); a per-tool opt-in flag (guarantees the defect recurs in the
next tool). **Tunable:** no.

**VB-D14 — Launch paths: toggle vs. placement** (new per spec-review
finding 6). **Decision:** the ribbon button only toggles the panel.
Placement starts from the panel's **New box** button, the quick-surface
entry, or automatically when the panel opens with zero boxes.
**Derivation:** B2 (a button that sometimes toggles and sometimes starts a
tool is asymmetric); the zero-box auto-start preserves the §1.1 two-click
first run; X5. **Rejected:** ribbon-starts-placement (double-booked
button, no second-box path); a separate ribbon "New box" button (ribbon
space for a panel-local action). **Tunable:** no.

## 4. Current implementation delta

**Exists and stays:** kernel math (`KernelViewingBox.ts`) including
`removeInside` support and per-id scopes; the drag pipeline (rAF
coalescing, `setInteracting`, `previewCap`, refs); overlay rendering; panel
surface in the right dock; kernel unit tests.

**Changes:** panel gains always-visible Center/Size/Rotation groups with
Enter/blur commit, Escape revert, units, precision (replaces the
mode-gated dead editor and live-apply `VectorEditor`); clip scope derives
from the box id; placement log reports all extents; pointer handlers arm
only while the function is active; `pointercancel` and Escape revert;
sub-threshold drags cancel cleanly; ribbon button becomes a pure toggle;
benchmark rewritten agent-runnable with ring-drag and orbit bursts.

**New:** canonical viewing-box entity + journaled command set and
automation surface; Saved boxes list, rename, activate/deactivate, New
box; in/out toggle; lock/unlock with pass-scoped bake, revision-keyed
cache, auto-rebake, progress, cancel; remove-inside edit-freeze fallback;
clip-aware picking/snapping/selection/measurement; named status chip;
lock-parity benchmark (mixed scene); `view.state.get` clip reporting;
visual-criteria checks.

### Disposition — implementation review (2026-09-01)

| Finding                                                               | Disposition                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. Gate unwired, manual, face-only                                    | §5, VB-D7                                                                   |
| 2. No visual reference/process                                        | E1, criteria file                                                           |
| 3. No lock/bake                                                       | §1.3, VB-D3                                                                 |
| 4. No panel close, no Escape                                          | §1.6, B2, VB-D5                                                             |
| 5. Dead Center editor, rotation not typeable                          | §1.2, C1                                                                    |
| 6. No named/saved boxes, destructive removal                          | §1.4, §1.7, VB-D1/D2                                                        |
| Blockers C3/C4/C1 (planes when final; no persistence; typed input)    | VB-D3, VB-D1/D2, §1.2                                                       |
| Major B2 (Escape, pointercancel commit)                               | VB-D5                                                                       |
| Major C2/E2 (armed handles, no indicator)                             | VB-D6                                                                       |
| Major B1 (no console/context/automation; blind `view.state.get`)      | B1                                                                          |
| Major E3/D1 (gate tolerance, unwired, ring untested)                  | VB-D7, §5                                                                   |
| Major correctness (click jitter, stale rAF)                           | VB-D5, §5                                                                   |
| Minors (`VectorEditor`, `keepInside` only, log size, hardcoded scope) | §1.2, VB-D4, §4 changes                                                     |
| Ideas (align/extract/double-click)                                    | align/double-click deferred, VB-D11; extract ships via `pointcloud.extract` |

### Disposition — spec review (2026-09-01, findings 1–15)

| #   | Finding                                     | Disposition                                                                                                        |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Lock un-clips non-point passes              | VB-D3 pass-scoped; VB-D8 mixed scene; §1.3, E2 table                                                               |
| 2   | Visual reference dangling                   | `viewing-box-visual-criteria.md` committed (E1); no third-party screenshots per license discipline                 |
| 3   | Tools see through the clip                  | VB-D13; C2, D2, E2 table; §5 pick test                                                                             |
| 4   | A2 claims contradicted; F4 missed           | A2 re-grounded on dossier sections; Revit claim withdrawn; VB-D4 re-derived; VB-D9 reopened with F4 recommendation |
| 5   | Escape while typing; blur-commit on close   | VB-D5 typing rung; §1.2, B2; §5 panel tests                                                                        |
| 6   | Second-box birth path; double-booked ribbon | VB-D14; §1.1, §1.4, B1                                                                                             |
| 7   | Bake invalidation geometry-only             | VB-D3 revision key + auto-rebake; §1.3, E2; §5 test                                                                |
| 8   | Remove-inside bakes ~99%                    | VB-D12 edit-freeze fallback; §1.5                                                                                  |
| 9   | §1.1/§1.6 Escape contradiction              | §1.1 fixed to the §1.6 ladder (one rung per press)                                                                 |
| 10  | Orbit with unlocked box ungated             | VB-D7 orbit burst; D1, §5                                                                                          |
| 11  | Quick-surface over void                     | VB-D10 view-centered seeding                                                                                       |
| 12  | Box sharing silent                          | §1.4/C4: inside `.hcadx` now (D1); standalone files queued VB-D11                                                  |
| 13  | Generic chip copy                           | VB-D6: name + lock glyph, operation tooltip                                                                        |
| 14  | Storey slicing, azimuth missing from queue  | VB-D11 queue extended                                                                                              |
| 15  | Densifying bake                             | VB-D11 queue extended (realworks.md §2.5 [8])                                                                      |

### Disposition — cross-spec reviews and doctrine updates (2026-09-01)

| Source                                     | Finding                                                       | Disposition                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ui-platform review, finding 12             | bake backgrounding on panel close undefined                   | §1.3, §1.6, B2, VB-D3: bake continues as a UIP-D10-registered job; E2 table row; §5 test                                    |
| draw review, finding 13                    | locked-bake snapping vs. full-precision promise               | VB-D13: candidates from bake, resolution against full-precision source points; E2 rows; §5 test                             |
| pointcloud review, finding 14              | extract double-queued                                         | VB-D11 un-queued; panel button wires onto `pointcloud.extract`                                                              |
| pointcloud review, finding 7d              | rebake keying per intermediate apply                          | VB-D3: settled/compacted revisions, debounced; §5 test                                                                      |
| doctrine precedent P4 (new)                | visible-set rule generalized from VB-D13                      | VB-D13 derivation now cites P4                                                                                              |
| view-domain review (2026-09-02), finding 2 | telemetry migration would swap the gate metric to render cost | VB-D7/VB-D8: metric pinned to presented-frame-interval p95; only the measurement source may migrate; D1, §5 wording aligned |

## 5. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** kernel unit tests — `removeInside` volumes, id-scope
  derivation, seed invariants incl. view-centered seeding (VB-D10);
  pass-scoped clip application (mesh/CAD volumes retain planes when the
  point pass switches to the bake, VB-D3). Command-layer tests — journal
  round-trip of place/update/rename/activate/remove/lock, single-active
  invariant, undo restores geometry+name+operation+activation, bake-cache
  invalidation on (geometry, operation, source revision) with auto-rebake,
  rebake debouncing — one rebake per settled revision batch, never one per
  intermediate apply (VB-D3), remove-inside threshold selects edit-freeze
  (VB-D12).
- **changed:** panel component tests — Enter/blur commit, Escape revert
  keeps panel open, close-mid-edit discards without committing (VB-D5),
  unit/precision formatting, live drag↔field sync, read-only when locked
  incl. edit-freeze copy, in/out toggle, Saved boxes activation, New box,
  remove+undo.
- **push (risk-triggered by viewer/viewport/kernel paths):** browser
  interaction tests — full Escape ladder one-rung-per-press,
  `pointercancel` revert, sub-threshold drag commits nothing and leaves no
  pending rAF, handles disarmed with panel closed, chip shows name+lock
  and reopens panel, ribbon toggles only; a pick through a clipped region
  must not return an outside point (VB-D13); a snap on a locked box
  returns the full-precision source coordinate, not a bake-decimated one
  (VB-D13); closing the panel mid-bake leaves the job running with a jobs
  surface row and working cancel, and completion applies the lock (VB-D3).
- **push (risk-triggered) / release (always), capability `browser-gpu`:**
  smoothness gate per VB-D7 (face + ring + orbit-with-unlocked-box,
  presented-frame-interval p95 ≤ 2× target frame time, measured from
  rAF/present timestamp deltas — never from `FrameTelemetry` render-body
  cpu/gpu ms; the measurement source may move to
  `view.diagnostics.sample` only once it exposes an interval
  distribution, with input driving and overlay-state sampling remaining
  in the harness), self-launching; its state samples also assert
  visual criterion 3 (grip stability).
- **release, capabilities `browser-gpu` + `real-data`:** lock-parity gate
  per VB-D8 on a real large cloud **plus mesh content**, asserting both
  parity and that non-point content stays clipped while locked; bake and
  rebake cancel leave no partial state.
- **automation:** SDK parity test — every `viewing_box.*` command callable,
  "restore the last viewing box" scripted end-to-end, `view.state.get`
  reports the active clip and lock state (runs with the deduplicated SDK
  gate).
- **manual/visual:** screenshots (both themes; idle/hover/drag; keep/
  remove; locked) compared against `viewing-box-visual-criteria.md`
  criteria 1–2 and 4–6 at implementation review.

Explicitly unverified: subjective drag feel beyond the p95 gate and
criterion 3; bake progress accuracy on exotic datasets; kept-region
estimation accuracy for VB-D12 (estimate quality is tunable calibration) —
accepted as manual-review-only.

## 6. Owner-decision items

None. Three candidates were tested against the escalation protocol and
dissolved in derivation: "where do named view artifacts persist?" — closed
by P1 plus `docs/PROJECT-FORMAT.md`; "how fast must locked clipping be?" —
closed by P2 plus delegated calibration P3 (VB-D8); "may we bind F4?" —
closed by X4 plus the registry owning the shortcut map (VB-D9); no axiom
conflict, scope boundary, or reserved question remains. All fifteen
spec-review findings resolved from X1/X2/X4/X5/X6, doctrine rule 2, and
the design system without an owner question.

## Cross-spec reconciliation 2026-09-02

| Item                  | Disposition                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent restore         | §1.4 defines the bounded indexed `viewing_box.list` order/limit/tie/deletion contract consumed by AG-D12.                                                                                                                               |
| Select/Edit placement | VB-D3 includes exact source entity/placement revisions and preview suspend/rebuild behavior required by SE-D3.                                                                                                                          |
| Semantic cursor       | Viewing Box cites UIP-D24/§9.7 and declares move/rotate handles, Shared3DTarget, prohibited, and wait; it never exposes a point-creation cursor.                                                                                        |
| Re-walk 2026-09-02    | P5: drag preview never journals per frame; bake publication is asynchronous. P6: Escape/Undo/double-click/right-click affordances retain honest effects. Current C4/D1/X3/B1/A2 and P7 are satisfied; no office convention is mandated. |

## Owner statements batch 2 — 2026-09-02

This section amends VB-D5/D7/D13. Viewing Box may use UIP-D22's Shared3DTarget for
center/orientation and section-plane placement, exposing the same picked/typed
origin and rotation handles. It consumes coordinates only for its clip command and
never claims point creation. Picks/snaps use SE-D19's effective P9 state: Hidden and
Inert are ineligible; Reference remains selectable/snappable; Editable behaves
normally. Reticle preview never changes clip authority until the existing commit.

**VB-D15 — Viewing Box consumes the shared reticle and P9 resolver.** **Decision:**
the adapter and eligibility behavior above reuse UIP-D22/SE-D19 without a second
reticle or state store. **Derivation:** C1, P9, S4/S5/G7, X1, UIP-D22, SE-D19.
**Rejected:** a box-private reticle; treating a reticle placement as a Draw point;
snapping through Inert nodes. **Tunable:** handle scale/occlusion under UIP-D22.

Verification covers picked/typed parity, rotate/move/cancel, no point entity side
effect, each P9 state, sparse-cloud NoData, and existing VB-D7 performance gates.

| Work-order item                   | Disposition                                |
| --------------------------------- | ------------------------------------------ |
| S4/G7 shared target consumer      | Applied by VB-D15 without point authority. |
| S5/G3 effective interaction state | Applied by VB-D15 via SE-D19.              |
