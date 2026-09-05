# Adversarial specification review — Builder Civil

Document status: Review complete

Document type: Adversarial specification review

Document scope: `docs/builder-program/specs/civil/civil.md`

Document date: 2026-09-02

Document owner: Builder completion program

Document language: English

Document class: report/verification evidence

Verdict: **not ready to enter `Specified` or implementation**. The specification has a sound product boundary and unusually good treatment of fit evidence, failure visibility, table input, and frozen-source truth. It nevertheless leaves six release-blocking contracts unresolved. Most seriously, its derived objects do not implement doctrine P10, station equations have no unambiguous data model, the 10 km corridor cold path has no bounded execution contract, and Civil knowingly collides with the registered Draw input grammar.

Finding count: **6 Blocker · 8 Major · 2 Minor · 0 Idea**.

## Findings

### 1. Accepted Civil results do not have the mandatory P10 derived-object lifecycle

**Severity:** Blocker

**Contract question:** C4 / E2 / X3 / X6 — For every derived Civil entity or view, where are the recipe, source revisions, linked/stale state, regeneration policy, detach operation, missing-source recovery, dependency-DAG enforcement, undo/redo behavior, persistence, and automation surface required by doctrine P10?

**Objection:** The specification implements fragments of three incompatible lifecycle models. A fit _draft_ becomes stale when a selected source revision changes (`civil.md:119-133`, `civil.md:419-421`), but the accepted alignment merely records provenance and then has no linked/stale/regenerate/detach/auto-detach contract. Promoted secondary axes record a source edge and offset policy (`civil.md:172-177`) but likewise have no lifecycle. Generic slopes have a partial live/stale rule (`civil.md:206-218`), station-defined points are described as relations (`civil.md:275-280`), and corridor/pit outputs are handed to Mesh without a common recipe state. This also conflicts with current Mesh MT-D4, which says a materialized surface has no live dependency and is rebuilt explicitly (`mesh-terrain.md:696-706`). That statement predates and violates current P10. Source disappearance, project restore, undo across regeneration, cyclic dependencies, failed regeneration, and an automation caller observing the same state are consequently undefined. A source ID stored as provenance is not a P10 recipe.

**Proposed resolution:** Add one normative `DerivedRecipe` contract used by accepted best-fit alignments, promoted axes, station-relative points, slopes, corridor surfaces, and pit surfaces. It must persist source entity IDs and accepted revisions, parameters and referenced office-standard version, output ID, state (`linked-current`, `linked-stale`, `detached`), last successful result, and last error. Mark dependents stale at the source gesture's transaction end. Regenerate automatically only below a named budget; otherwise expose a batched, cancellable command while preserving the last good result. Add canonical query/commands for state, regenerate, detach, and relink; make detach journaled and retain provenance; auto-detach with a console event when a source disappears; reject dependency cycles at command validation; use creation-time error lists for regeneration failures. Define save/restore and undo/redo for both recipe and last-good artifact. Amend Mesh MT-D4 and the Registry in the same change so Mesh owns the surface artifact while Civil owns the typed recipe input. Add acceptance tests for source edit, source deletion, failed regeneration, detach, undo, reload, and automation parity for every derived-object class.

### 2. Station equations are promised without a model that makes station references unique

**Severity:** Blocker

**Contract question:** A1 / B1 / C1 / C4 — What is the canonical, lossless identity of a station when equations make the displayed value discontinuous or repeated, and which command creates and edits those equations?

**Objection:** Civil exposes station equations and discontinuities (`civil.md:269-272`) and names a station-equation test (`civil.md:786-788`), but the current alignment schema contains only scalar `station_origin` (`crates/himmelcad-core/src/entity_model.rs:946-959`). There is no station-equation component or creatable command. A point-by-station relation (`civil.md:275-280`) therefore becomes ambiguous when the same displayed station occurs on both sides of an equation. The same ambiguity propagates into width/crossfall tables, fit ranges, profile domains, labels, automation arguments, reversal, and LandXML round trips. A scalar plus a formatting rule cannot distinguish `10+000 back` from `10+000 ahead`. The specification would be inventing which geometric location the user meant, contrary to X1.

**Proposed resolution:** Make monotone internal chainage the geometric coordinate and add a versioned ordered station-equation model with stable region IDs, back value, ahead value, chainage location, direction, and label-format reference. Every persisted station reference must carry chainage plus region/equation-side identity; a displayed station alone is rejected when non-unique. Specify canonical create/update/delete/reverse commands, table and canvas UI, validation, import/export loss reporting, migration, Python/automation schemas, snapping, labels, and undo/redo. Width, crossfall, fit, profile, and point relations must state whether their intervals are stored in chainage and how they render across discontinuities. Add tests for repeated display values, exact equation position, reversal, references surviving an equation edit, save/reload, and LandXML unsupported-loss behavior.

### 3. The extreme 10 km corridor cold path is unbounded and can block interaction

**Severity:** Blocker

**Contract question:** D1 / D2 / P5 — Before a frozen cache exists, how is a 10 km alignment with the extreme number of bands and local frames built, published, cancelled, superseded, and kept within RAM, disk, and interaction budgets?

**Objection:** The catalog marks the corridor only `cont` (`civil.md:72`), the workflow describes local updates (`civil.md:184-190`), and G-CIV-3 measures only an edit after caches exist (`civil.md:817-819`). There is no cold-build member of the extreme class. The existing evaluator's `build` path walks all partitions before publishing (`crates/himmelcad-render/src/alignment_preview.rs:364-398`); it is evidence of a useful renderer primitive, not proof of a bounded Civil pipeline. On a 10 km/100 km axis with many width and crossfall bands, a synchronous first evaluation can consume the UI thread and memory without any contract violation detectable by the present gate. “Freeze reference traces” does not solve the first build, invalidation after broad edits, or rapid edit bursts.

**Proposed resolution:** Define a background, cancellable, generation-numbered cold-build job with bounded partition size, bounded in-flight memory, staged publication, time-to-first-visible partition, total build budget, RAM/disk ceilings, and deterministic eviction. A newer source or table revision must cancel or supersede old work; stale partitions must never publish. Broad edits may show the last-good surface with an explicit stale state, never a partially mixed revision. Add 10 km and 100 km fixtures with maximum supported band counts, cold and warm gates, cancellation latency, edit-burst supersession, reload, and failure injection. State the device tier and whether failure is a hard error or a visible degraded mode.

### 4. Civil assigns candidate cycling to a key owned by Draw's construction-input traversal

**Severity:** Blocker

**Contract question:** E2 — Does each physical gesture resolve to exactly one current command under the registered priority map?

**Objection:** Civil assigns `Tab`/`Shift+Tab` to fit candidates, vertical solutions, and point ambiguity (`civil.md:121-122`, `civil.md:161-162`, `civil.md:277-278`, `civil.md:572-592`). Current Draw DR-D1 reserves `Tab` for entering/traversing the construction input and uses `Up`/`Down` for candidate cycling (`draw.md:585-601`); DR-D6 repeats that arbitration (`draw.md:701-706`), and the armed Registry map does too (`REGISTRY.md:337-339`). The owner gap resolution explicitly directs Civil to adopt `Up`/`Down` (`OWNER-STATEMENTS-2026-09-02-GAP.md:345`, `:392`). This is not an owner question. It is an already-resolved registry contradiction that would make one physical event dispatch two acts.

**Proposed resolution:** Replace every Civil candidate/solution `Tab` binding with `Up`/`Down`, retain `Tab`/`Shift+Tab` solely for construction-input focus traversal, and update the gesture table, CIV-V11, named gates, and automation event fixtures. Add Civil to the Registry armed map. Repair the remaining stale `Tab` candidate language in UI-platform and the Registry summaries during the same consistency pass so their prose agrees with the normative Draw row.

### 5. Profile synchronization has no revision-safe answer when horizontal geometry changes mid-edit

**Severity:** Blocker

**Contract question:** B2 / C4 / E2 — If a horizontal alignment revision changes while a profile or vertical-geometry draft is open, exactly what do Synchronize, Discard, Stay, save, undo, and automation do?

**Objection:** Station-defined geometry is called live (`civil.md:248-250`), arbitrary projected curves receive Synchronize/Discard/Stay (`civil.md:255-260`), and exit also offers that triad (`civil.md:440-443`). The contract never captures the horizontal revision against which the profile draft was created. A horizontal edit may change length, station regions, curve boundaries, and the domain of vertical elements while the user is editing grades. “Synchronize” could silently reproject onto different geometry, overwrite a vertical draft, or combine revisions. Discard is equally ambiguous: does it discard only projected source changes, the vertical draft, or the horizontal change? This violates the user's explicit S8 race question and P10's stale-at-gesture-end rule.

**Proposed resolution:** Give every profile/vertical draft a captured alignment ID, horizontal revision, station-region map, source revisions, and draft revision. At the end of a horizontal edit gesture, mark the open profile stale while preserving its last-good overlay. Synchronize must open a preview of a deterministic rebase onto the newest horizontal revision, list unmappable/out-of-domain elements, and commit through compare-and-swap as one journal transaction. Discard must be relabelled and defined as discarding only the profile draft; it must never undo a separately committed horizontal edit. Stay keeps the stale draft and blocks commit. Define cancellation/supersession for projection jobs, reload recovery, closing behavior, and equivalent canonical query/commands. Test a horizontal shorten, reversal, station-equation edit, and source deletion during a pending vertical edit.

### 6. Slope and pit topology is not defined for common civil corner and terrain-hit cases

**Severity:** Blocker

**Contract question:** A1 / A2 / C1 / X1 — Which exact geometric branch constructs a valid slope or pit at convex/concave and obtuse corners, and which target-surface intersection is authoritative when there are zero, tangent, coincident, or multiple hits?

**Objection:** The specification correctly refuses arbitrary choices for coincident/near-coincident boundaries (`civil.md:220-238`), but the successful construction itself remains underspecified. It does not define corner patches, miters/fans, trimming, self-intersections, or continuity where side slopes from adjacent segments meet at convex, concave, or obtuse corners. For a generic slope that terminates on existing terrain (`civil.md:206-218`), it does not define “first hit,” tangent contact, multiple cut/fill intersections, holes/NoData, or coincident runs. The lower-envelope rule cannot repair missing or overlapping input panels; different implementations can create different earthworks while all appear conforming. Silent gap fill would invent domain truth.

**Proposed resolution:** Specify the surface mathematically before the envelope: edge panels generated from an explicit signed outward-distance field; deterministic convex-corner fan or miter construction; concave trimming/intersection; orientation and self-intersection validation; and watertight adjacency tolerances expressed in project units. For terrain termination, define the selected branch (for example, first valid outward ray hit satisfying the declared cut/fill direction) and reject tangent intervals, multiple unresolved hits, NoData, coincident overlap, or absent hits with typed, highlighted errors. Never bridge gaps heuristically. Include exact fixtures for convex, concave, and obtuse corners; terrain with two intersections; tangent/coincident contact; holes; mixed winding; and tolerance boundaries. Put the same rules in the P10 creation and regeneration error list.

### 7. The current schema cannot persist several semantics that the specification calls existing

**Severity:** Major

**Contract question:** A2 / A3 / C4 — Are all claimed current data capabilities real, versioned, and serializable rather than prospective structs or generic relations?

**Objection:** `WidthBand` and `CrossfallBand` currently store station functions but no referenced secondary-axis identity (`crates/himmelcad-core/src/entity_model.rs:897-923`). `Alignment` has horizontal/vertical geometry and `station_origin`, but no fit report/recipe, station equations, or station-reference relation (`entity_model.rs:946-959`). Repository search finds no `station_reference` schema. A generic `EntityRelation` exists (`entity_model.rs:1137-1149`), but using it requires a typed, validated extension; it is not evidence that the promised relation exists. Consequently `civil.md:62` overstates “schema exists,” and the implementation delta (`civil.md:718-726`) omits fit provenance, secondary-axis references, station equations, and point station relations.

**Proposed resolution:** Replace the broad existence claim with exact present-tense boundaries. Add versioned schemas for fit recipe/report, secondary-axis relation, station equation/region, station-relative point, and the shared P10 recipe. Identify serializers, validation, migrations, repair behavior, loss reporting, and command schemas. Amend DATA-MODEL and create/accept the needed ADR before implementation; update the implementation-delta table so no semantic field is hidden behind a generic relation.

### 8. Named UI workflows have no canonical automation/query parity

**Severity:** Major

**Contract question:** B1 / X3 — Can Python and an agent discover and perform every state transition available in the Civil UI with the same validation and result semantics?

**Objection:** Closing a fit preserves a named draft (`civil.md:384-405`), yet the catalog has only `alignment.fit`; it has no draft list/open/rename/discard/freeze query or command. Candidate selection, freeze-reference traces, “Apply to existing” for layer mapping, profile conflict inspection, and P10 regenerate/detach/relink are likewise missing. The prose says automation uses the same commands but does not name those commands or their typed results. A UI-only hidden draft is not recoverable or automatable, and a coarse `alignment.fit` endpoint cannot express candidate acceptance safely after asynchronous recomputation.

**Proposed resolution:** Add canonical typed commands/queries for fit-session create/update/cancel, candidate list/select/accept, saved-draft list/open/rename/discard, source freeze, recipe state/regenerate/detach/relink, layer-map apply, station-equation editing, and profile conflict preview/commit. Return stable IDs, source and generation revisions, progress/cancellation IDs, warnings, and typed errors. Make the UI call those exact contracts. Add schema conformance and UI-versus-Python parity tests for all catalog rows and all recovery actions.

### 9. Required sibling amendments and Registry entries are deferred, and two catalog rows duplicate shared acts

**Severity:** Major

**Contract question:** A3 — Have all reciprocal ownership and semantic changes been made now, with one Registry row per user-visible act?

**Objection:** There are no Civil rows in the current Registry, whose boundary prose still places future alignment/Civil work outside the active program (`REGISTRY.md:433-438`). Draw DR-D8 still defers the capability; Pointcloud PC-D8 only covers new baked cloud sampling; Mesh retains its pre-P10 no-live-link rule and lacks the typed Civil manifest; View lacks the S8 profile/section ownership amendment; Select/Edit has no Civil-dependent preflight. Section 10 (`civil.md:875-896`) records these as future requests rather than executing them, contrary to the program's reciprocal-amendment rule. The catalog also creates `civil.corridor.to-surface` in addition to shared `mesh.create-surface`, and `civil.point.station-offset` in addition to shared `draw.point`. Those are not separate user-visible acts; they are typed modes/access paths to shared acts.

**Proposed resolution:** Before promotion, amend Civil, Draw, Mesh, View, Pointcloud, Select/Edit, Measure/Inspect, and the Registry in one atomic documentation change. Register one row per act with Civil contributions and access surfaces: use `draw.alignment` for alignment creation/fit mode, `draw.point` for station/offset point mode, and `mesh.create-surface` for corridor/pit materialization. Give Civil ownership of recipes and parameter manifests, Mesh ownership of the resulting surface artifact and shared creation validation, and View ownership of the profile viewport infrastructure while Civil owns alignment-profile semantics. Remove future-work language once reciprocal text exists.

### 10. The vertical grammar omits the owner-required clothoid; its circular-versus-parabolic decision itself is sound

**Severity:** Major

**Contract question:** A1 / A2 / X1 / X4 — Where is the exact vertical clothoid requested by S9, and is rejecting a parabolic substitute for a requested circular arc evidence-faithful?

**Objection:** S9 requires vertical geometry drawn with lines, arcs, and clothoids. Civil defines grades, current parabolic vertical curves, and a new exact circular vertical curve (`civil.md:145-168`, `civil.md:624-632`) but silently drops the clothoid. That is a missing catalog and schema outcome, not a permissible approximation. Separately, the dossier explicitly describes a quadratic/parabolic vertical curve (`rib-civil.md:212-220`). Civil correctly retains that existing form and refuses to implement a _requested circular arc_ by silently substituting a parabola. That refusal does not violate X4; it is the necessary X1 distinction between two different geometric objects. The defect is the omitted clothoid, not the exact circular extension.

**Proposed resolution:** Add an exact vertical-clothoid member with parameterization, orientation, continuity requirements, degeneracies, station/elevation evaluation, serialization, validation, migration, tessellation, snapping, LandXML policy, UI construction/table entry, automation, and tests—or explicitly disposition it with owner evidence if S9 is amended. Retain both parabolic and circular members and label them unambiguously. Do not approximate either a circular arc or clothoid with the parabolic member.

### 11. Several dossier rows are overstated as adopted, and office civil conventions are not editable data

**Severity:** Major

**Contract question:** A2 / X5 / P7 — Does each dossier row have an honest per-row disposition, and can organizations edit, version, import, and export the civil rules that affect geometry and checks?

**Objection:** “Rampenband generation” is marked adopted through manual crossfall-band editing (`civil.md:317`), while the evidence describes regulation-driven generation (`rib-civil.md:83`); manual editing is only a partial foundation. “Mulden, Böschungsausrundung, Parallelen” is marked adopted (`civil.md:348`) although there is no ditch or slope-rounding act. “Erdbauwerke” is marked adopted (`civil.md:352`) even though the dossier row includes dams/ponds, benches/workspaces, and automatic DGM intersection (`rib-civil.md:156`). “Achsverziehung” is treated as a width transition without proving semantic equivalence. More broadly, fit tolerances, design checks, ramp rules, station labels, and layer templates are prose/defaults rather than versioned office data. This prevents German office practice from being represented without a code fork and leaves recipes non-reproducible.

**Proposed resolution:** Split each row into adopted, partial, deferred, or rejected sub-capabilities with exact evidence and owning act. Do not use “adopted” for a prerequisite. Add a versioned Civil standards/profile library containing fit constraints and check thresholds, transition/ramp policies, station-label rules, and layer templates, with UI editing, validation, preview, named defaults, import/export, project binding, and migration. Persist the selected profile/version in every derived recipe. Add table entry and batch import/export for width, crossfall, vertical, and station-equation data so X5 applies beyond the canvas.

### 12. The named Civil gates are labels, not runnable and creatable verification artifacts

**Severity:** Major

**Contract question:** D1 / E3 — Can an agent in a clean checkout create the fixture and run each `G-CIV-*` gate from a named command without opening the app manually?

**Objection:** Civil says the gates are agent-runnable (`civil.md:779-782`) but supplies no command, test target, script path, fixture path, capability declaration, environment prerequisites, or Verification Planner ID. Repository search finds the labels only in documentation; no Civil implementation or gate artifact exists. G-CIV-3 also tests only a warm local update, not the cold extreme member. A named assertion is useful E1 evidence, but it is not yet a creatable gate and cannot truthfully block promotion.

**Proposed resolution:** For each gate, name the repository test/benchmark target and fixture generator, required feature/capability, launch mode, output artifact, numeric threshold, and fail-not-skip behavior. Add deterministic synthetic fixtures plus a licensed/provenance-recorded real fixture where appropriate. Register the tasks with Verification Planner and make them self-launching from a clean checkout. Add the cold corridor, concurrency, restore, P10 lifecycle, gesture-arbitration, and pit-degeneracy gates identified in this review.

### 13. The shared point-info surface cannot report Civil station/offset outside an active Civil tool

**Severity:** Major

**Contract question:** E2 / A3 / X3 — Which passive consumer supplies station/offset truth in shared Measure/Inspect and status surfaces when no Civil command is active?

**Objection:** Civil reports station/offset during its corridor and station-point workflows (`civil.md:186-187`, `civil.md:275-280`) but does not enumerate the shared `inspect.point_info` consumer. The registered Measure/Inspect contract currently exposes position, source, and snap information, not nearest-alignment station/offset (`measure-inspect.md:50-59`, `:525-544`). The RIB Tachobox evidence makes this an ordinary persistent inspection convention. Without a bounded shared query, each UI surface will either omit the information or recompute it differently; repeated stations and multiple nearby alignments make a silent “nearest” guess unsafe.

**Proposed resolution:** Add a bounded canonical `alignment.station_offset.describe` query, or extend `inspect.point_info` with an explicitly optional Civil section. Return named candidate alignments, internal chainage, displayed station plus region/equation side, signed offset, direction convention, distance, Z acquisition/source, revision, and ambiguity. Default to the active/pinned alignment; when multiple unpinned candidates qualify, show the candidates and require selection rather than guessing. Amend Measure/Inspect, Civil, the Registry, status bar/ribbon access, and Python schemas together; add passive-consumer and repeated-station tests.

### 14. Rapid fit-constraint editing can publish or accept a stale solver result

**Severity:** Major

**Contract question:** C4 / D1 / E2 — When constraints change faster than the fit solver completes, which generation remains visible and which one may be committed?

**Objection:** The workflow has progress, cancellation, source-revision checks, and candidate review (`civil.md:109-141`), but no fit-session generation, debounce rule, latest-wins publication test, or acceptance lock after a constraint edit. A long solve may finish after a newer solve and replace its candidates; a user could then accept geometry whose displayed constraint values were never used. The source compare-and-swap in E2 does not protect against stale _parameter_ generations. Crash-restored drafts have the same ambiguity.

**Proposed resolution:** Give each fit session a stable ID and monotonically increasing input generation. Every committed constraint-field edit must debounce then cancel/supersede earlier work. Preserve the previous result only as visibly stale and make it non-committable. Candidate publication and acceptance must compare session ID, input generation, source revisions, constraint hash, and solver version. Checkpoint only matching inputs and label restored results stale until revalidated. Add burst-edit, out-of-order completion, cancellation-latency, stale-accept rejection, and reload tests.

### 15. Several code-evidence claims are broader than the cited implementation

**Severity:** Minor

**Contract question:** A2 — Does every code claim cite the exact implementation that exists, with prospective or stub semantics described as absent?

**Objection:** The renderer claim says the cited range compiles “alignment plus resolved slope parts” (`civil.md:707`), but `crates/himmelcad-render/src/entity_compiler.rs:1493-1545` is the slope-resolution path; alignment tessellation begins later, around `:1566`. The ownership/evidence prose calls `draw.alignment` an “existing act” (`civil.md:25`, `:138`) while the catalog itself correctly says no callable command currently exists (`civil.md:63`). “Schema exists” for best fit (`civil.md:62`) proves only that an alignment result can be stored, not that a fit recipe/report exists. Other checked anchors—`hcad.alignment`, horizontal clothoid, LandXML parse/export/loss, alignment preview, viewer bridge, local section frames, browser harness—resolve to real implementation rather than stubs.

**Proposed resolution:** Narrow each claim to what the cited range proves, cite the alignment compiler's actual range separately, and use “specified shared act; command absent” until `draw.alignment` is callable. State explicitly that current geometry schemas can hold a result but the fit and P10 schemas do not exist. Re-run all line anchors after the amendments because line numbers will move.

### 16. Two absence/evidence statements do not meet the dossier-wide and exact-row citation standard

**Severity:** Minor

**Contract question:** A2 — Is every negative evidence claim explicitly based on the whole relevant dossier, and does each catalog group cite the row that actually supports it?

**Objection:** The statement that “no source supplies permission for heuristic topology” (`civil.md:510`) does not say that the entire cited dossier was searched, so it does not satisfy the mandatory dossier-wide absence form. Group E cites §§2.1–2.3/2.7 for station-label behavior (`civil.md:547-549`), although station labeling is supported by §2.4/W3. By contrast, the best-fit absence note in `rib-civil.md:100-103` is properly dossier-wide, and its external Autodesk material supports one/two path inputs, tunable accuracy, regression, transitions, and a report; the spec should preserve that stronger citation discipline.

**Proposed resolution:** Replace the topology sentence with an explicit whole-dossier audit statement naming `rib-civil.md`, searched concepts/synonyms, and the exact unsupported branch. Correct Group E to cite §2.4/W3. For every amendment, retain one disposition per dossier row and distinguish direct evidence, inference, owner direction, and product decision.

## (a) Contract questions convincingly answered

- **B3 — Surface-selection gate:** The owning layer picker is constrained to visible, compatible surface layers and has a deterministic no-match path; it does not silently select hidden or incompatible terrain.
- **C2 — Selection transition:** The specification captures selected source IDs/revisions at fit start, keeps the working set stable, and defines a visible stale/error response when those sources change.
- **C3 — Freeze semantics:** “Freeze reference traces” creates real local immutable geometry with provenance and a named restore path; it is not merely a visual lock.
- **D2 — Degradation truth:** Preview tolerance, local-frame validity, frozen partitions, and error presentation are described as truthful quality states rather than hidden geometry changes.
- **E1 — Written verification artifact:** Section 7 is an in-repository, objectively checkable acceptance artifact. Finding 12 concerns whether the named gates are executable, not whether E1 exists.

The best-fit evidence subset of A2 is also convincing: `rib-civil.md:100-103` records a dossier-wide absence check, the cited Autodesk documentation supports the stated inputs and fit controls, and the specification correctly treats solver choice and failure policy as product decisions. A2 as a whole is not answered because Findings 7, 11, 15, and 16 remain.

## (b) Executed versus read

**Read and inspected:** `.claude/agents/demanding-user.md`; `docs/CURRENT-DIRECTION.md`; `docs/README.md`; the complete current `FUNCTION-CONTRACT.md` and `DECISION-DOCTRINE.md`; Builder program README, OWNER-DECISIONS, REGISTRY, owner statements S1–S14 and the 2026-09-02 gap resolution; DESIGN-SYSTEM, AGENT-FEEDBACK, TEST-TIERS, DATA-MODEL, and relevant ADR material; the complete Civil specification; gold-standard `viewing-box.md`; prior Draw, Mesh/Terrain, and View-domain reviews; relevant current Draw, Mesh/Terrain, View, Pointcloud, Select/Edit, Measure/Inspect, and UI-platform specification sections; the complete relevant `rib-civil.md` evidence and its field-code context.

**Code read:** `crates/himmelcad-core/src/entity_model.rs`, validation and entity-command paths; `crates/himmelcad-io/src/landxml.rs`; `crates/himmelcad-render/src/alignment_preview.rs`, `entity_compiler.rs`, viewer/section bridge and local-frame paths; relevant kernel E2E, Builder ribbon, and automation-schema code. Repository searches were used to test every Civil code anchor, find commands/schemas/gates, enumerate sibling consumers, and distinguish absent implementation from stubs.

**External evidence read:** Official Autodesk Civil 3D best-fit overview and dialog documentation referenced by the dossier. These corroborate the documented one/two-path input, regression/report, transitions, and adjustable fit controls. The DOI landing endpoints listed in the dossier did not yield usable content in this environment and were not used to substantiate a finding.

**Executed:** Read-only `rg`, `sed`, `find`, `wc`, and `git status` inspections plus web retrieval of the official evidence above.

**Not executed:** No build, unit/integration/browser test, benchmark, application launch, renderer capture, mutation command, or gate. This was the requested static specification review. No claim in this review represents runtime verification.

## (c) Owner-decision items

**Count: 0.**

All resolutions above follow current owner statements, the 2026-09-02 gap resolution, X1–X7, P1–P10, the function contract, the design system, and the one-row-per-act Registry rule. They are therefore proposed as executable program resolutions, not escalations. The owner may veto a resolution through the normal correction mechanism; no missing preference presently blocks specification repair.

## System feedback

No contract question or doctrine axiom failed to do its job. The mandatory extreme-member check exposed the cold corridor gap; input arbitration exposed the `Tab` collision; E2/A3 exposed passive-consumer and sibling drift; C4 and P10 exposed the missing derived-object lifecycle; X1 exposed station and pit ambiguity; and A2 exposed overclaimed evidence and schema.

The program's **change-invalidation mechanism was not executed consistently**, however. P10 now governs derived objects, while Mesh still carries a contrary pre-P10 lifecycle; the Registry says its gesture map has no contradictions even though stale `Tab` candidate prose remains in Registry/UI-platform and Civil repeats it. Add a mechanical consistency check for registered keys and duplicated act IDs, and require a Registry-tracked sibling re-walk whenever doctrine or an owner gap resolution changes. That is enforcement feedback, not a defect in the contract questions or doctrine axioms themselves.
