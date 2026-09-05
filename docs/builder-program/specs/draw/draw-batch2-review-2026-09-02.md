# Adversarial specification review — Draw owner-statements batch 2

Document class: report/verification evidence

Review date: 2026-09-02

Review target: `docs/builder-program/specs/draw/draw.md`, scoped to **Owner
statements batch 2 — 2026-09-02**, the amendments that section says it makes,
and DR-D17–DR-D20. Earlier Draw behavior is raised only where the batch-2 text
depends on it or contradicts it.

Review method: static specification, evidence, registry, sibling-specification,
and source-code inspection. No build, application, test, benchmark, or runtime
workflow was executed, as required by the review instruction.

Verdict: **not ready for owner review or promotion to `specified`**. The batch
has the right architectural direction—one construction bar, one ordinary point
command, Civil-owned station semantics, view-local segment identity, and P10
linked offsets—but the user still cannot execute the flagship line workflow
deterministically. The same physical keys and Escape rung retain contradictory
outcomes, a repeated Civil station can resolve to two different world points,
the registry's zero-conflict verdict is stale, and the new continuous workflows
have no runnable gate.

Finding count: **5 blocker · 7 major · 2 minor · 0 idea**.

## Findings

### 1. Escape can either cancel the pending line or commit it

**Severity:** blocker

**Contract question:** B2 / C1 / C4 / E2 — What exact state transition does
each Escape press perform while Line has one captured point and a valid pending
second point?

**Objection:** I activate **Line**, click the first point, move to a valid
second point, and press Escape because I do not want the line. The batch-2
resolved workflow says Escape unwinds field, constraint, then armed tool, and
closing preserves no half-line (`OWNER-STATEMENTS-2026-09-02-GAP.md:301-305`).
The registry likewise says the armed-tool rung **cancels** Draw
(`REGISTRY.md:350-364`). But Draw B2 and DR-D5 still say Escape's tool rung is a
tool-end path that **commits** any valid pending construction
(`draw.md:390-399`, `draw.md:685-699`). The batch section claims to amend
DR-D1/D2/D4/D6/D8/D12/D13/D14, not DR-D5 (`draw.md:1098-1101`), so the old
commit rule remains normative. Two conforming implementations can produce
opposite document state and opposite Ctrl+Z history from the same keystrokes.
That is a survey-data integrity defect, not copy ambiguity.

**Proposed resolution:** Derived, vetoable decision from X1, X5, P6,
DESIGN-SYSTEM Complete user flows, UIP-D14, and the newer owner workflow:
Escape never commits Draw geometry. Its exact ladder is: focused field → revert
uncommitted text and retain the construction; active constraint/handle drag →
restore the preceding valid preview; armed Line/Point tool → cancel the pending
construction and publish nothing; next rung → close its function surface.
Enter or an explicit **Finish/Create** action is the commit path. Ribbon
re-toggle and panel close must use an explicit close policy: for single-result
Line/Point, cancel pending input; for multi-vertex Polyline, show the same
discoverable **Finish / Cancel** choice when a valid chain exists rather than
silently mapping close to commit. Revise B2, DR-D5, §3.1, the E2 map, registry
rung 4, and all tests in one transaction. This supersedes the 2026-09-01 review
resolution because the current owner statement and current platform ladder are
newer and more specific.

### 2. The settled Tab/Up-Down rule still has multiple owners and contradictory registered meanings

**Severity:** blocker

**Contract question:** E2 / A3 / catalog — Does every physical key have one
meaning in each focus/tool state across the complete registered system?

**Objection:** The new Draw rule itself is clear: Tab/Shift+Tab focuses or
traverses the input bar, and Up/Down cycles a live candidate set
(`draw.md:585-601`, `draw.md:701-709`, `draw.md:1140-1145`). But the registry
still assigns idle Tab to candidate cycling (`REGISTRY.md:300-311`), repeats
“Tab candidate cycling” in its baseline (`REGISTRY.md:367-375`), and records
Tab cycling for BIM, Raster, and Agent (`REGISTRY.md:381-398`). Its armed-key
table says the opposite (`REGISTRY.md:329-343`) and nevertheless declares zero
collisions (`REGISTRY.md:345-348`, `REGISTRY.md:421-429`). UI Platform's
normative prose is corrected, but its required browser test still presses Tab
to move selection through candidates (`ui-platform.md:961-969`); Draw's own
component test still asks for “Tab field traversal vs viewport cycling by
focus” (`draw.md:974-979`). The current kernel really does consume Tab
(`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:460-465`),
so this is not harmless historical prose: an implementer following the wrong
registered paragraph will preserve the collision.

**Proposed resolution:** Derived, vetoable decision from C1, the owner's S1
follow-up, X7, and the registry single-owner rule: **Tab/Shift+Tab never cycles
geometry candidates anywhere. Up/Down does so only while the shared candidate
indicator is live.** Outside that state Up/Down remains owned by the focused
list/control or is unclaimed; Tab remains normal focus traversal, with an armed
coordinate tool routing viewport Tab into its construction bar. Rewrite every
contrary registry and test line, including the BIM/Raster/Agent summaries, to
their owning specs' current focus rules. Rebind the kernel and rename its stale
“Tab-cycle” comments. Add a mechanical registry check that rejects the words
`Tab` and `candidate cycle` in the same active-state rule unless the statement
explicitly says “never.” The corrected registry report must replace, not sit
beside, the false zero-conflict report.

### 3. A station/offset point has no unambiguous persisted station identity

**Severity:** blocker

**Contract question:** C1 / C4 / A3 / X1 — When station equations repeat or
discontinue displayed station values, which exact world location does the Draw
point store and restore?

**Objection:** I create a point at displayed station `10+000`, but the alignment
contains a station equation with both a back and an ahead `10+000`. The batch
only says the tool accepts an alignment reference, station, offset, and vertical
mode, then commits `draw.point.create` with “the Civil relation”
(`draw.md:1127-1133`). DR-D19 derives from CIV-D1–D14
(`draw.md:1153-1157`). Civil's later, normative correction is CIV-D16: geometric
authority is monotone chainage, and a durable reference must also contain the
region/equation identity and side; a bare repeated display station must reject
with candidates (`civil.md:1031-1078`). Draw neither cites nor adopts that
contract. Its proposed payload can therefore choose one of two valid world
points, bake a guessed coordinate, or restore to a different point after a
station-equation edit while still appearing to satisfy DR-D19.

**Proposed resolution:** Derived, vetoable decision from X1, P10, CIV-D15 and
CIV-D16: `draw.point.create` station mode accepts the complete Civil
`StationReferenceV1`—alignment id and revision, chainage, region id, optional
equation id and back/ahead side, captured display station—plus signed offset and
an explicitly defined vertical basis. A scalar display station is only accepted
when `alignment.stationing.resolve` returns exactly one candidate. The preview,
bar, Properties, console, automation, reload, undo, and export-loss paths show
the same identity. Station-equation edits preserve chainage and reformat the
label; stale/deleted regions become a typed unresolved recipe state, never a
nearest-point guess. Update DR-D19's derivation to CIV-D15/CIV-D16 and add the
repeated-station, equation-edit, reversal, stale-axis, and reload cases to the
named verification plan.

### 4. The batch additions have no registry transaction, while the registry still defers Civil and certifies Draw

**Severity:** blocker

**Contract question:** catalog / B1 / A3 — Are all new user-visible acts,
access contributions, states, command leaves, and ownership boundaries present
once in the registry before this specification can advance?

**Objection:** Draw honestly says “registry delta awaiting rebuild” for the 3D
target, station/offset mode, and offset recipe operations
(`draw.md:1135-1138`). UI Platform and Select/Edit say the same for global
controls, P9 state, selection mode/history, and effective-state queries
(`ui-platform.md:1140-1144`, `select-edit.md:1052-1055`). None of those ids or
any `civil.*` row exists in `REGISTRY.md`. The registry instead says station
work is deferred to a future program (`REGISTRY.md:74`,
`REGISTRY.md:433-450`), claims all acts are owned and all fourteen specs are
specified (`REGISTRY.md:421-438`, `REGISTRY.md:502-507`), and still links layer
behavior to pre-batch SE-D9 (`REGISTRY.md:128`). That directly contradicts D7,
DR-D19, SE-D19, and the target's `Status: drafted (registry pending)`
(`draw.md:3-8`). The program rule is explicit: a spec is not specified until
the rows exist and the consistency report passes. There is currently no
registry-owned visible entry for **3D target** or **Point by station/offset**,
no command registration for offset regenerate/detach, and no registered Civil
ownership to prevent later double disposition.

**Proposed resolution:** Apply one atomic registry rebuild across all batch-2
consumers. Keep one `draw.point` act with separately enumerated visible access
modes **Point**, **3D target**, and **Point by station/offset**; keep one
`draw.offset` act with create/get/regenerate/detach lifecycle; add the Civil
rows and access contributions from `civil.md`; add UI/Select state and history
rows; replace F6's future-stations closure; update P8/P9/P10 provenance and
gesture maps; then rerun duplicate-act, surface, state, shortcut, and reciprocal
citation checks. Until that lands, keep Draw and every changed sibling
`drafted`. This is required by Builder README and X7, not an owner decision.

### 5. The specification calls its Draw interaction gate agent-runnable, but no such artifact exists and none covers the batch's new continuous paths

**Severity:** blocker

**Contract question:** D1 / E3 — What command can an implementing agent run to
fail reticle manipulation, line/point input, segment targeting, station/offset
preview, and linked-offset preview when interaction exceeds its budget or
publishes stale state?

**Objection:** Draw D1 promises an “agent-runnable, self-launching” 200-vertex
drafting benchmark (`draw.md:464-473`) and §7 treats it as a push/release gate
(`draw.md:997-1003`). A repository search found no Draw/drafting benchmark
script, test target, or verification-planner registration; the only mentions
of the 200-vertex gate outside this spec are planning rows in `MASTER-PLAN.md`.
The batch adds continuously moved and rotated Shared3DTarget handles,
station/offset rubber-band evaluation, segment-aware selection/highlight, and
offset regeneration previews, but its verification amendment is only the
sentence “Gates add … cases” (`draw.md:1165-1169`). It supplies no command,
fixture, capability route, frame/input threshold, resource bound, or assertion
that stale source generations never publish. Under current D1, a continuous
interaction without a runnable gate cannot be specified as smooth.

**Proposed resolution:** Create and register a self-launching
`G-DR-INPUT`/`G-DR-DERIVED` browser-GPU artifact before promotion. It must drive
the exact S1 keystrokes, reticle translate/rotate/type/cancel on a sparse
500-million-point-class streamed fixture, station/offset preview across
equations, segment targeting on the extreme curve members, and linked offset
preview/regeneration after rapid source edits. Retain the existing initial
budgets—presented-frame-interval p95 ≤2× target, snap query ≤4 ms p95, input to
visible preview ≤100 ms—and add bounded worker/memory/cancellation/latest-
generation assertions for derived work. Missing `browser-gpu`/`real-data`
capability must fail at the required tier, not skip. Put the actual target,
fixture generator, capability, output artifact, and fail conditions in §7 and
the registry.

### 6. Printable input and vertical-mode arbitration are not a deterministic state machine

**Severity:** major

**Contract question:** C1 — After the first point, exactly which field receives
the first typed digit, how are direction/length locks established, and what
happens when Cartesian, polar, and vertical representations conflict?

**Objection:** I click the first point, point the cursor east, and type `10`.
The owner workflow means “length 10,” but DR-D1 only says printable input
auto-focuses the bar and viewport Tab focuses its “first field”
(`draw.md:585-603`). The bar contains acquisition, two XYZ groups, horizontal
distance, direction, absolute Z, Delta Z, and slope (`draw.md:1100-1107`), so
“first” and “relevant field” are not implementable routing rules. The earlier
workflow says whichever absolute/relative field was filled last wins
(`draw.md:174-180`), while batch 2 says conflicting vertical fields are blocking
errors and DR-D17 rejects vertical modes that silently override each other
(`draw.md:1102-1107`, `draw.md:1140-1145`). It does not define whether X/Y versus
distance/direction conflicts also block, which fields become read-only after a
direction lock, whether Enter commits a field or the line, or how clicking
after half-typed polar input affects the retained constraint. The requested
keystroke-by-keystroke workflow still branches by implementation taste.

**Proposed resolution:** Specify an explicit Line state table. After point 1,
the active representation is initially cursor-derived **direction + horizontal
length**; printable digits go to length, while typing an axis prefix or focusing
X/Y chooses Cartesian. Tab order includes only editable fields and skips
read-only acquisition/first-point values. Choosing Z, Delta Z, or slope is an
exclusive vertical-mode selector; choosing endpoint XYZ versus polar is an
exclusive horizontal representation, with the other representation remaining
live-calculated rather than independently editable. Enter in a field validates
and returns viewport focus without committing while required values remain
pending; Enter with a complete valid line commits once. A click either commits
the current constrained preview or, after explicit confirmation, discards
uncommitted text—never “last writer wins” silently. Add a transition table for
focus, locks, typing, click, Enter, Backspace, Escape, candidate cycling, and
source invalidation for both Line and Point.

### 7. The A2 re-walk did not incorporate the corrected Access and RealWorks evidence, and one capability is dispositioned twice

**Severity:** major

**Contract question:** A2 / catalog — Does every batch-2 reference claim cite
the corrected dossier text, state adopted versus deliberately different
behavior, and have exactly one owning disposition?

**Objection:** Draw A2 still says Trimble Perspective has “no drafting system
relevant here” and is a viewing/limit-box dossier only (`draw.md:339-360`). The
corrected dossier now contains a full Access layer-state and selection section,
including three—not four—states, mixed parents, blue selection, and only
stakeout-context direction arrows (`trimble-perspective.md:304-361`). Those
facts are directly relevant to DR-D18's support/segment selection consumers.
The batch's 3D target also omits the new RealWorks subsection: RealWorks has
constrained picking, UCS frames, smart picks, and point creation, but no single
freely translatable/rotatable generic reticle (`realworks.md:350-412`). The
reticle is a defensible Himmel:CAD extension, but A2 never says so. The RIB
`Hilfspunkte` row is labeled simply “adopted” (`draw.md:143-147`) even though the
reference makes helper points number/code-less and excludes them from its point
database (`rib-civil.md:50-60`), while DR-D18 deliberately requires an explicit
role and rejects inference. Finally `Kleinpunkt / Achskleinpunkt` is marked
adopted in both Draw (`draw.md:127-131`) and Civil (`civil.md:299-315`), contrary
to cite-and-revise.

**Proposed resolution:** Rewrite A2 and the row table against the corrected
dossiers. Record the 3D reticle as a Himmel:CAD extension that combines—but does
not attribute to RealWorks—its evidenced constrained/UCS/smart-pick building
blocks. Record orange, universal direction cues, explicit support roles, the
fourth P9 state, and Ctrl multi-select as owner/doctrine extensions rather than
Access behavior. Mark `Hilfspunkte` **adapted**, with explicit differences and
export/database disposition. Give Civil the sole Achskleinpunkt/station-offset
semantic disposition; Draw cites it as an access contribution to
`draw.point.create`. Preserve one dossier row, one owner, one reciprocal
citation.

### 8. Draw still carries a second layer interaction model instead of consuming the one P9 effective-state resolver

**Severity:** major

**Contract question:** C2 / E2 / A3 — Which component owns requested node state,
which component composes effective state, and can every Draw command explain the
same result?

**Objection:** The batch says support/segment behavior derives from P9,
UIP-D20/UIP-D21, and SE-D19 (`draw.md:1147-1151`). UI Platform says it owns the
four-state control and Select/Edit is the sole effective-state authority
(`ui-platform.md:1155-1161`). Select/Edit says its resolver composes entity,
ancestors, layer, kind, cloud class, attachment, isolate, and global overlays
(`select-edit.md:1028-1035`). But DR-D4 still defines layer `visibility` and
`lock` as separate canonical fields, uses the older SE-D9 effective-editability
predicate, and has no Inert state (`draw.md:656-683`). C3 separately says hidden
leaves the candidate set while locked stays snappable (`draw.md:438-450`). The
batch claims to amend DR-D4 but supplies no replacement. That leaves two
requested-state stores and two predicates: a layer can be “locked,” “Reference,”
or “Inert” with no unique render/select/snap/edit answer. The proposed query is
even namespaced as `selection.effective_state.explain`, although render,
snapping, export, and command validation also consume it.

**Proposed resolution:** Derived, vetoable decision from P9, X7, UIP-D20, and
SE-D19: each taxonomy node stores one requested P9 state; UI Platform owns the
control/propagation presentation; a domain-neutral effective-interaction-state
service owned by Select/Edit composes all causes and is the sole authority for
render eligibility, selection, snapping, and edit rejection. Draw does not
store independent visibility/lock truth. Migrate legacy layer visibility/lock
combinations to Hidden/Reference/Editable and require an explicit choice for
Inert where introduced. Rename the query out of the selection namespace, or
state that namespace as a compatibility alias only. Amend DR-D4/C3, SE-D19,
UIP-D20, the registry row, automation schema, and all command preflight tests in
one cite-and-revise transaction.

### 9. Support roles and segment identity are slogans, not complete geometry contracts

**Severity:** major

**Contract question:** C2 / C4 / E2 — What is the canonical support-role schema,
what exactly is a stable segment locator for every curve class, and which Draw
commands consume it?

**Objection:** DR-D18 correctly refuses to explode geometry and refuses to infer
support from missing metadata (`draw.md:1116-1125`, `draw.md:1147-1151`). But no
canonical support component exists in DATA-MODEL or code, and the Draw
implementation delta never lists one. Its persistence, fragment/archive,
copy/paste, layer/specification, export, and automation behavior are absent. A
global Support toggle therefore has no defined source of truth. Segment mode is
equally thin: `{parent_id, revision, locator}` is named, but `locator` is not
defined for a line, closed polyline, reversed polyline, mixed Composite,
circle, arc, clothoid, spline, or associative area boundary. “A curve command”
accepts it, without listing offset/parallel, trim, fillet, divide, dimension,
or vertex edit applicability. “Deterministically remap or prune” supplies no
semantic identity that can prove a remap still names the same segment. The
extreme member—a 10,000-segment reversed/edited Composite—has no bounded remap
or refusal rule.

**Proposed resolution:** Admit a versioned `hcad.component.support-role@1`
before implementation, with explicit role kind, optional defining/defined
relation, provenance, and canonical query/command behavior. State whether
support geometry exports, copies, fragments, labels, and specification/layer
rules preserve or deliberately omit it; global hiding changes only effective
state. Define a versioned view-local `CurveSubentityRef` per analytic topology:
parent id/revision, stable component/member id where one exists, directed
parameter interval, loop/use identity for associative boundaries, and a
semantic hash. Remap is allowed only when the semantic id/hash and geometric
interval survive; otherwise prune with status. Publish an applicability matrix:
offset/parallel and trim may consume eligible line/arc/clothoid members;
whole-curve-only commands reject a segment token with a reason; no command
silently widens to the parent. Add least/extreme fixtures and restore/history
tests.

### 10. The sparse-cloud reticle can display invented “residual/confidence” and can dead-end the exact workflow it exists to solve

**Severity:** major

**Contract question:** C1 / B1 / E2 / X1 — What calculation makes the proposed
coordinate and confidence authoritative enough to display, and how does a user
complete placement when no cloud sample or inferred plane may be used?

**Objection:** I place the reticle between sparse neighboring points. The batch
says it exposes acquisition source, residual/confidence, and Estimated, but
sparse-cloud ambiguity or NoData blocks commit until I “confirm an explicit
coordinate,” and no inferred plane or sample becomes authoritative
(`draw.md:1109-1114`). UIP-D22 is intentionally only a component shell and owns
no point calculation (`ui-platform.md:1127-1134`, `ui-platform.md:1170-1175`).
No Draw record defines a fit, residual, neighborhood, manual-coordinate rule,
or the exact confirmation that converts the reticle transform into an explicit
coordinate. If the reticle is manually positioned, “residual/confidence” is
fabricated; if a fit is required, the no-inference rule blocks the sparse-cloud
case. The target also lacks a precise visible entry and exact
`draw.point.create` request shape for reticle origin/orientation/provenance,
despite the GAP workflow requiring automation to submit the same transform
(`OWNER-STATEMENTS-2026-09-02-GAP.md:303-305`).

**Proposed resolution:** Separate two honest acquisition modes. **Manual 3D
target** makes its typed/picked/manipulated origin the proposed coordinate;
orientation is a construction aid and carries no statistical residual. It may
commit after an explicit **Create estimated point** action that stores
`acquisition=manual-estimate`, the reticle transform, and user confirmation.
**Fit from neighbours** is optional and only appears after the user selects a
named evaluator with a documented neighborhood, residual, rank/degeneracy test,
and confidence definition; failure falls back to Manual, not a dead end. Neither
mode silently becomes surveyed truth. Add visible **3D target** entry under the
Point tool, exact console/SDK parameters and result provenance, Escape/close
behavior, accessibility, and sparse/no-data/degenerate/extreme-cloud tests.

### 11. DR-D20 borrows the P10 state names but never specifies an offset recipe or its geometry and restore semantics

**Severity:** major

**Contract question:** C4 / E2 / A3 / P10 — What exact recipe regenerates an
offset of every supported source, and what complete state does create,
regenerate, detach, source deletion, undo, reload, and export restore?

**Objection:** The batch repeats Linked/Stale/Regenerate/Detach/auto-detach/DAG
from P10 and MT-D25 (`draw.md:1120-1125`, `draw.md:1159-1163`). That is the right
lifecycle vocabulary, but MT-D25 is a surface recipe whose concrete roles and
parameters are breakline/form-line/boundary/hole/cloud
(`mesh-terrain.md:1141-1154`). Draw supplies no curve-recipe schema. It does not
record source subentity versus whole curve, plane, signed side, distance,
join/corner rule, end caps, self-intersection policy, source parameterization,
algorithm version, or output specification/layer. Offset geometry is undefined
for a circle whose distance collapses its radius, concave closed polylines,
self-intersecting composites, spatial/non-planar curves, clothoids, or a segment
token invalidated by parent edit. C4 also never names the affected-state set for
regenerate/detach undo, the last-good result retained after failure, stale
render/snap/export behavior, or when auto-detach retention is released. Calling
the operations journaled is not a restore-scope contract.

**Proposed resolution:** Define `hcad.draw.offset-recipe@1` as the Draw-specific
P10 recipe, reusing MT-D25's lifecycle state machine but not its surface fields.
Persist exact source/subentity reference and revision, construction plane,
signed distance/side, join/end/self-intersection policy, algorithm version,
output id, style/spec/layer, generation, last-good output hash, and last error.
List supported analytic source classes and typed refusal/degeneracy behavior;
never flatten non-planar geometry implicitly. Regenerate/detach/relink/auto-
detach commands restore recipe edge/state, output revision/hash, error, and
selection-visible status atomically; export either consumes last-good with an
explicit stale warning/loss plan or blocks a current claim. Source loss keeps
the last-good detached curve and provenance. Apply the same contract when the
source is a segment token. Add exact geometry, stale, failure, source-delete,
DAG, undo/redo, reload, automation, and exporter tests.

### 12. The batch adds four shared-state classes without adding them to Draw's E2 passive-consumer table

**Severity:** major

**Contract question:** E2 — What does each new state do to every renderer,
picker/snapper, selection surface, tool, exporter, sibling app, automation
reader, and failure/recovery path?

**Objection:** Draw's E2 table still enumerates only the pre-batch entity,
layer, clip, mode, Mesh, exporter, Plan, BIM, and automation effects
(`draw.md:515-530`). It does not mention Shared3DTarget state, support role,
segment tokens, station-reference recipes, or linked offset recipes. Concrete
questions therefore have no owner: does hiding Support remove it from snaps or
only rendering; do DXF/LandXML preserve the role; can Plan and WeltView show a
stale linked offset; does a segment selection survive undo of a parent edit;
does a station point re-evaluate on equation edit; does project replacement
clear a reticle; does point creation select the point or its recipe; can a stale
offset be used as a Mesh breakline; what do strict sibling readers do with the
new components; and what does automation see while a recipe is stale? The batch
sentence naming a few gates is not passive-consumer enumeration.

**Proposed resolution:** Add four E2 matrices, one per state class, and cite
each owning sibling reciprocally. Minimum consumers: point/curve render and
selection overlays; P9 resolver; picking/snapping and candidate indicator;
Properties/tree/layers/specification shortcuts; Draw operand commands; Civil
station resolver; Mesh breakline/boundary intake; BIM support/role generation;
Plan/WeltView/PhotoLab strict-reader behavior; File archive/fragment/restore/
export/loss plans; journal/undo/history; automation/SDK/Agent; and project
replacement/crash recovery. For each, state current/stale/detached/hidden/
inert behavior and failure publication. No consumer may infer semantics from a
component name.

### 13. Two current-code citations do not prove the claimed implementation baseline

**Severity:** minor

**Contract question:** A2 — Does every current implementation claim cite the
exact code that implements it rather than a nearby declaration or a partial
surface?

**Objection:** The catalog and §6 say the current status bar shows snap kind
**and coordinates**, citing `App.tsx:699` (`draw.md:101`,
`draw.md:917-918`). The cited Builder code renders only `Snap: ${snap.kind}`;
there is no coordinate readout at `apps/builder/renderer/src/App.tsx:681-709`.
The spec also says `cad_curve.rs:58-75, 291` proves per-curve semantic snap
emission (`draw.md:100`, `draw.md:910-913`). Lines 58-75 only declare
`CurveSemanticSnap`/storage, and line 291 starts the refinement function; actual
candidate consumption is around `cad_curve.rs:324-340`, while per-geometry
emission occurs in later builder methods (for example arc snaps at
`:571-574`). The implementation exists, but the cited lines do not prove the
claim. The checked DGM citation is correctly labeled a stub and not counted as
existence; the alignment, curve model, LandXML, kernel Tab binding, layer
placeholder, and dimension compiler citations were materially accurate.

**Proposed resolution:** Change the status-bar claim to “snap kind only;
coordinate/input bar is new,” cite the actual Builder lines, and cite the
semantic-snap builder plus refinement ranges that emit and consume candidates.
Keep declarations as schema evidence only. Re-run all anchors after the batch
is integrated because the current unqualified basename style is fragile when
several `App.tsx` and `ribbon.ts` files exist.

### 14. The Draw E1 artifact does not cover the batch's visible states

**Severity:** minor

**Contract question:** E1 — Which in-repository, failable criteria distinguish
the 3D target, support geometry, directed selection, segment selection,
station/offset preview, and linked/stale/detached offset states?

**Objection:** Draw's existing E1 criteria cover snap markers, rubber bands,
layers, dimensions, height state, and input-bar focus/prompts
(`draw.md:490-513`). The batch only declares cursor vocabulary and says Draw
defines no glyph (`draw.md:1165-1169`). UI Platform adds useful general failures
for selection/support/reticle states (`ui-platform.md:1177-1183`), but Draw does
not adopt those criteria or add domain states: reticle versus committed point,
manual-estimate badge, perpendicular-foot/station side and axis direction,
whole-versus-segment highlight, stale versus detached offset, and support
hidden/reference/inert combinations. An implementation can satisfy the current
Draw screenshot list without displaying the new state truth at all.

**Proposed resolution:** Extend Draw E1 by citation to UIP-D21/UIP-D22 plus
Draw-specific failable criteria. Require both themes and 150% scale; shape/text
in addition to color; exact screenshot states for manual/fit/error reticle,
station foot/side/equation ambiguity, parent-plus-segment highlight, support
role and hidden overlay, and linked/current/stale/detached offset. Add those
states to the manual/visual and browser-state assertions in §7. Theme tokens
remain UI-owned; Draw defines only semantic adapter output.

## (a) Contract questions answered convincingly

- **B3 — Surface choice.** A viewport tool with one persistent construction
  bar and a docked right panel only for tool-specific options is the correct
  surface. GAP-D2 improves on literal per-tool panel duplication, and the batch
  preserves that ownership.

No other A1–E3 question is convincingly closed for the batch as a whole. Several
individual directions are sound—ordinary `draw.point.create` authority,
explicit rather than inferred support role, view-local segment identity, Civil
ownership, and linked-by-default offsets—but their lifecycle, registry,
consumer, evidence, or verification contracts remain incomplete.

## (b) Executed versus read

**Executed:** no build, application, dev server, unit/integration/browser test,
benchmark, package command, or mutation command. I executed only read-only
repository inspection with `rg`, `rg --files`, `sed`, `find`, `wc`, `git status`,
and `git log`. No web research was needed because the corrected repo-resident
dossiers contain the evidence required for this review.

**Read in full:** `.claude/agents/demanding-user.md`;
`docs/CURRENT-DIRECTION.md`; `docs/README.md`; current
`docs/FUNCTION-CONTRACT.md`; current `docs/DECISION-DOCTRINE.md` including
X1–X7 and P1–P10; `docs/DESIGN-SYSTEM.md`; `docs/AGENT-FEEDBACK.md` SYSTEM-001;
`docs/TEST-TIERS.md`; Builder-program `README.md`, `OWNER-DECISIONS.md`,
`OWNER-STATEMENTS-2026-09-02.md`, the GAP analysis §2/§3 and governing
decisions, and the relevant registry rows/maps/report; the target specification;
the gold-standard `viewing-box.md`; the prior Draw and Select/Edit review files;
and the corrected Access layer/selection and RealWorks picking-aids dossier
subsections with the relevant complete RIB Civil rows/workflows.

**Sibling specifications read/checked for the batch boundary:** UI Platform
UIP-D16/UIP-D19–D22; Select/Edit SE-D19/SE-D20; Mesh/Terrain MT-D25–D27; Civil
catalog, station/offset workflow, gesture map, CIV-D15/CIV-D16, and reciprocal
requests; plus the batch amendments and gesture claims in Pointcloud,
Measure/Inspect, BIM/Specifications, Raster, Plan Editor, Agent, Import Formats,
File/Project, View Domain, and Viewing Box.

**Code read:** the target's cited ranges in canonical entity/model/command and
automation protocol code; LandXML alignment parsing; renderer curve picking,
snap ranking, annotation compilation, text, and block resources; Builder ribbon,
App status/command bridge, and EntityTree placeholder; kernel navigation and
candidate cycling; legacy/stub snapping surfaces; the current automation schema.
Repository-wide searches distinguished missing support/station/recipe schemas
and missing Draw gates from implemented declarations and stubs.

## (c) Owner-decision items

**Count: 0.** Every resolution is derived and vetoable, not escalated. X1
decides no ambiguous station or invented confidence; X3 decides canonical
recipe/automation parity; X5 and the Design System decide symmetric close,
cancel, and undo behavior; X6/P3 delegate numeric budgets; X7 and the Builder
README decide cite-and-revise and registry ownership; P8/P9 decide state/history
separation; P10 and MT-D25 decide the linked/stale/detach lifecycle class; C1
and the owner S1 follow-up decide Tab versus Up/Down. No axiom conflict,
product-identity/scope/money/licensing call, or explicitly owner-reserved
boundary survives the escalation protocol.

## System feedback

No contract question or doctrine axiom failed to do its job. C1 exposed the
non-executable input grammar; C4 exposed missing station/recipe restore scope;
D1/E3 exposed prose-only gates; E2 exposed both gesture collisions and missing
passive consumers; A2 exposed the stale dossier re-walk; P9 and P10 supplied the
correct class-level answers.

The failure is **change-invalidation enforcement**. The registry says it was
rebuilt against P1–P7 and all fourteen specs, while current doctrine is P1–P10,
Civil is now a fifteenth domain, and its own paragraphs contradict its row
table. Add a mechanical doctrine/contract revision stamp to each spec review and
registry report, fail the registry when an amended spec says “registry delta
awaiting rebuild,” and mechanically compare key/state claims across row, key,
gesture, test, and implementation-delta sections. P9 could also be clarified
editorially by naming its two distinct owners—requested-node-state UI versus
effective-state resolver—but its axiom was sufficient to derive the resolution;
the current defect is not missing doctrine.
