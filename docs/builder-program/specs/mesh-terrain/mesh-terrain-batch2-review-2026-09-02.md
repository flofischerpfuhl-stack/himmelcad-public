# Demanding-user review — Mesh & Terrain batch 2 amendments (2026-09-02)

Document class: report/verification evidence.

Static adversarial review scoped to `mesh-terrain.md`'s **Owner statements
batch 2 — 2026-09-02** amendment and the records it adds or changes. The
review applies the current `FUNCTION-CONTRACT.md`, `DECISION-DOCTRINE.md`
(X1–X7 and P1–P10), `DESIGN-SYSTEM.md`, Builder registry rules, owner
statements S1–S14/G1–G12, and the resolved GAP decisions and gates. Every A2
reference assertion in the affected Mesh evidence chain was checked against
the cited dossier text, including the corrected Trimble Perspective access-
state/selection subsection and the corrected RealWorks picking-aids
subsection. The fourteen amended specs were compared for cite-and-revise
ownership, recipe lifecycle, P9 effective state, and Tab/Up/Down semantics.
Relevant code and claimed absences were inspected at source. No build, test,
benchmark, app, or web research was run.

Verdict: **not ready for implementation or owner review**. Headline count:
**6 blockers, 7 majors, 1 minor, 0 ideas**. MT-D25 is not yet a common record:
it has no interoperable persisted envelope, complete state/restore model, or
complete command surface, while Civil has already invented the missing
details locally. MT-D26 leaves Form line and crop/exclusion geometry
underdetermined. MT-D27 cannot yet produce the separately specified cut and
fill solids or a non-invented borehole-strata result.

## Findings

1. **Severity: blocker — Contract question: C4 / E2 / E3 (P10, P5, X1,
   X3, X7).**
   **Objection:** MT-D25 is declared to be the one shared recipe lifecycle
   cited by every other domain, but it is only a paragraph of outcomes. It
   says “every surface” has one recipe and names Linked, Stale, Regenerate,
   Detach, auto-detach, DAG checking, and last-good behavior
   (`mesh-terrain.md:1141-1154`). It does not define a versioned persisted
   envelope, stable recipe/output identity, exact states, recipe generation,
   source placement revisions, last-successful output hash/revision, typed
   error, dependency-recipe ids, reverse-index ownership, transaction/CAS
   preconditions, reload validation, or the restore set for automatic
   regeneration, Detach, auto-detach, relink, undo, and redo. “At gesture end”
   does not cover import replacement, headless commands, source deletion, or
   multi-entity transactions. “Every surface” also incorrectly captures
   imported or directly authored surfaces that are not P10 derivatives.

   Civil has consequently created a richer quasi-common lifecycle in
   CIV-D15: `hcad.civil.derived-recipe@1`, exact source fields and states,
   generation/last-good/error, transaction-end invalidation, numerical auto-
   rebuild thresholds, output CAS, `list`, batch, and `relink` operations,
   one batch undo root, reload revalidation, and heavy-artifact roots
   (`civil.md:977-1014`). Draw, Raster, BIM, and Mesh expose only
   `get/regenerate/detach`; none can invoke the promised batch or recovery
   transition. A source deletion auto-detaches, but there is no canonical
   relink operation or specified inverse when deletion is undone. That is
   multiple domain-specific dependency machines—the exact result MT-D25 says
   it rejects. Repository-wide searches of `DATA-MODEL.md`,
   `PROJECT-FORMAT.md`, and first-party code found no shared derived-recipe
   schema or implementation.

   **Proposed resolution:** **Derived decision (vetoable):** before another
   spec cites MT-D25, promote a versioned `hcad.derived-recipe@1` envelope to
   `DATA-MODEL.md` and `PROJECT-FORMAT.md`; domain records supply only a typed
   recipe payload and output semantics. Limit it to derived outputs. Require
   `recipe_id`, recipe kind, output id/type/locator, ordered source refs with
   entity/revision/content hash/placement revision/role, typed parameters,
   algorithm and schema versions, dependency recipe ids, state
   `linked-current | linked-stale | regenerating | detached | error`,
   monotonic generation, last-good output ref/hash/revision, and last typed
   error. Define one indexed DAG and transaction-end invalidation service for
   gestures, imports, automation, and source deletion. Regeneration must CAS
   source refs, recipe generation, and output revision; failure retains the
   last good artifact. Standardize `get/list/regenerate/regenerate_batch/
detach/relink`; make automatic rebuild, detach, relink, and explicit or
   batched rebuild journaled transactions. One batch is one undo root with
   per-item results. Undo/redo and save/reload restore or validate recipe
   edges, state, last-good ref, error, and output revision together. Name
   recipe/draft/checkpoint/undo references as heavy-artifact GC roots. Domain
   prefixes may remain adapters over that one transition contract.

2. **Severity: blocker — Contract question: A3 / catalog / C3 / C4 (P10,
   X3, X7).**
   **Objection:** the target contains two commands and three incompatible
   truths for the same surface dependency act. The original catalog owns
   **Rebuild from sources…** as `mesh.rebuild` /
   `mesh.surface.rebuild` (`mesh-terrain.md:79,93-96,107-108`); the amendment
   adds `mesh.surface.recipe.regenerate` to the existing create row
   (`:1175-1179`). Both replace a surface from its sources. That is a duplicate
   canonical act, despite the registry's uniqueness rule. The A3 section still
   says Pointcloud extraction's provenance-without-live-linkage is adopted
   “exactly” (`:413-415`), and C3 still says no live recomputation exists
   (`:440-444`), although amended MT-D4/MT-D25 require linked-by-default
   automatic or stale regeneration (`:697-705`, `:1141-1154`). MT-D7 says
   contours and reports are “never auto-regenerated” and explicitly rejects
   auto-regeneration (`:731-738`), while MT-D25 claims one state machine for
   surface derivatives without declaring those derivative kinds' automatic
   budget to be zero. An implementation cannot determine which statement or
   command is canonical.

   **Proposed resolution:** **Derived decision (vetoable):** keep one protocol
   act, `mesh.surface.recipe.regenerate`; retain **Rebuild from sources…** and
   `mesh surface rebuild` only as UI/console spelling routed to that act, and
   remove `mesh.surface.rebuild` before schema/SDK freeze. Revise A3 to state
   the actual semantic delta from PC-D7: both preserve immutable last-good
   artifacts, but P10 adds an indexed live dependency. Revise C3 to distinguish
   immutable published geometry from live recipe state. Revise C4 with the
   common restore set from finding 1. If audited contours and volume reports
   must never change automatically, bind those recipe kinds to an automatic
   budget of zero and say why; otherwise revise MT-D7. Add a uniqueness test
   that fails whenever two ids dispatch the same journaled mutation.

3. **Severity: blocker — Contract question: A2 / C1 / C4 / E2 (X1, X3).**
   **Objection:** Form line is named, not specified. The amendment says only
   that it “influence[s] triangulation without boundary clipping”
   (`mesh-terrain.md:1124-1129`). MT-D5's supposedly exhaustive role contract
   still lists only breakline, outer boundary, and hole, and its edit family
   has no add/remove Form-line operation (`:707-715`). The current canonical
   TIN can store only a mesh plus curves that “must remain triangle edges” in
   `breaklines` (`crates/himmelcad-core/src/entity_model.rs:465-472`); there is
   no Form-line field. RIB Civil §2.6 and W5 support breaklines and boundary
   lines, not a Form-line topology rule. The existing A2 disposition likewise
   attributes only breakline/boundary role assignment to that evidence
   (`mesh-terrain.md:124-130`). The owner statement supplies the feature name,
   but not whether every Form-line segment must be a triangle edge, whether
   only its sampled vertices influence the TIN, how curve tessellation works,
   or what survives LandXML/DXF export. The requested
   “Form-line-vs-Breakline fixture” (`:1188`) has no pass condition.

   **Proposed resolution:** **Derived decision (vetoable):** define Form line
   as a soft height-control role: evaluate its authoritative XYZ vertices (and
   deterministic curve samples within a recorded chord/spacing tolerance),
   admit those points to triangulation, but do not constrain its segments as
   TIN edges and never clip a boundary. Breakline remains the hard constrained-
   edge role; outer boundary and hole clip. This distinction gives S10 a real
   function without silently aliasing Breakline. Add a typed role collection
   to the TIN/provenance schema or make role snapshots a versioned associated
   resource; do not put soft lines into the existing `breaklines` field. Add
   draft and committed add/remove/re-role commands, exact revision capture,
   undo, selection/snap/render consumers, and import/export loss declarations.
   The fixture must prove that the same curve changes vertex influence as a
   Form line, forces every segment as a Breakline, and clips neither case.
   Mark this semantic rule owner-derived; do not attribute it to RIB.

4. **Severity: blocker — Contract question: C1 / E2 (X1, P4, P9).**
   **Objection:** crop and exclusion behavior is not geometrically complete.
   A 2D crop polyline obtains Z only at its vertices and blocks only an
   ambiguous/NoData vertex (`mesh-terrain.md:1131-1137`). A long edge can cross
   a NoData hole, discontinuity, vertical ambiguity, or sharp terrain feature
   between two valid endpoints. The spec does not say which XY coordinate
   frame, evaluator/interpolation rule, adaptive tolerance, closure tolerance,
   self-intersection rule, or stored 2D/3D representation applies. It therefore
   permits an apparently valid crop to invent the unsampled boundary between
   vertices. The “ordered” exclusion rules are also undefined: outside-boundary
   and within-distance filters could be a commutative set union or sequential
   mutations with different displayed counts. Distance metric, equality at
   the threshold, boundary-point treatment, overlapping-rule attribution, and
   recomputation after source revision are absent.

   Input arbitration is incomplete too. The Mesh canvas reserves Up/Down for
   error-list navigation (`mesh-terrain.md:653-658`), while the current
   program-wide C1 rule and DR-D17/UIP-D16 reserve Tab for fields and Up/Down
   for live spatial candidates. The amendment cites DR-D17 but does not define
   focus scopes for crop vertex acquisition, candidate cycling, and error-list
   navigation. A focused error list may own arrows; a live canvas candidate
   cannot.

   **Proposed resolution:** **Derived decision (vetoable):** store crop input
   as a project-XY closed 2D curve plus an evaluator id/revision and a derived
   draped boundary. Drape the entire curve adaptively to a declared maximum XY
   chord and Z interpolation error; any ambiguous/NoData interval blocks
   Check and links the interval, not merely its endpoints, to the error list.
   Reject self-intersection and sub-tolerance closure; never average ambiguity.
   Define exclusions as a deterministic set union over the immutable admitted
   point ids: exclude points strictly outside the valid outer boundary and at
   distance `<= d` from the selected breakline geometry in project XY;
   boundary-on points remain admitted. Show gross count per rule, overlap
   count, and net excluded count, so ordering is presentation only. Recompute
   against exact revisions. In the canvas, Tab/Shift+Tab traverses fields and
   Up/Down cycles a visible candidate stack; only a focused error-list widget
   owns Up/Down for row movement. Record the crop LMB/RMB/Escape claims in the
   target and registry gesture maps.

5. **Severity: blocker — Contract question: A1 / C1 / C4 / E2 (S11, X1,
   X3).**
   **Objection:** MT-D27 does not meet the owner's explicit solid result. S11
   requires “cut and fill each assignable a specification”
   (`OWNER-STATEMENTS-2026-09-02.md:124-132`). The target accepts singular
   “cut/fill specification” and promises singular “a canonical solid”
   (`mesh-terrain.md:1167-1173`). It never defines whether crossing evaluators
   publish one mixed-sign object, two solids, multiple disconnected parts, or
   no object for an empty sign class; nor how holes, boundary caps, NoData
   edges, equality/zero thickness, and part identity are represented. That
   prevents separate cut/fill specifications and stable downstream selection,
   measurement, export, and regeneration.

   The repository already has the canonical foundation: `SolidGeometry` is a
   validated volume representation and `ClosedMesh` requires a closed,
   oriented manifold triangle boundary
   (`crates/himmelcad-core/src/entity_model.rs:819-849`), exposed as
   `GeometryObject::Solid` (`:1103-1104`). MT-D27 never binds its result to
   that type. “A cloud side uses the cell-center mean-Z evaluator directly,
   not triangles” correctly protects the authoritative sampling semantics,
   but a `ClosedMesh` publication still needs a derived tessellated boundary;
   the text currently makes semantic evaluation and storage topology sound
   mutually exclusive.

   **Proposed resolution:** **Derived decision (vetoable):** one checked
   command atomically publishes a result group containing up to two canonical
   `hcad.object-3d@1` entities with `SolidGeometry::ClosedMesh`: **Cut** and
   **Fill**, each with its own required specification id, stable part ids,
   layer/style, and a shared signed-overlay recipe. Disconnected components
   remain named parts of the appropriate solid; an empty class produces no
   entity and is reported explicitly. Define top/bottom and `A-B` sign,
   equality tolerance, valid-footprint intersection, holes, NoData edges,
   crossing splits, side walls/caps, orientation, watertight/manifold proof,
   and atomic replacement/undo. For a cloud side, PC-D17's mean-grid samples
   are the authoritative evaluator; deterministic cell faces and boundary
   tessellation are derived storage only and must not substitute triangle-
   interpolated source heights. Keep MT-D8's report a separate optional
   product, as already required.

6. **Severity: blocker — Contract question: A1 / A2 / C1 (X1, S11).**
   **Objection:** “Mesh never invents layers” does not make borehole solids
   defined. BS-D25 gives each borehole authoritative XYZ and ordered observed
   interfaces with datum, uncertainty/missing flags, and specifications
   (`bim-specs.md:1648-1655`). It deliberately has no dossier support and says
   so. Neither BS-D25 nor MT-D27 defines the lateral support footprint,
   interpolation between boreholes, extrapolation beyond the support hull,
   treatment of different interface counts, pinching/disappearance, faults,
   collar/datum transformation, or whether one borehole may create a region.
   Missing and crossing checks cannot choose those truths. Yet MT-D27 promises
   canonical solids (`mesh-terrain.md:1169-1173`). Any implementation must
   invent geological geometry to proceed.

   **Proposed resolution:** **Derived decision (vetoable):** make a strata-
   solid recipe require an explicit project-XY host boundary, exact validated
   `BoreholeStratumSet@1` revision, vertical CRS/datum agreement, and an
   explicit interpolation method with versioned parameters. Default support
   is the 2D convex hull of borehole collars clipped by the host boundary;
   outside it is NoData, never extrapolation. Require at least three non-
   collinear observations for an interpolated interface. A one-borehole
   constant extrusion is a separate explicitly chosen method with a typed
   boundary, never an automatic fallback. Define deterministic pinching only
   where the two bounding interfaces meet within tolerance; otherwise
   missing, duplicate, inverted, crossing, datum-incompatible, and unsupported
   cells block. Publish one separately specified solid per stratum, preserving
   observation ids, uncertainty, support extent, method, parameters, and
   content hashes. Mark all interpolation as derived—not observed—and test
   that absent observations never become invented interfaces.

7. **Severity: major — Contract question: C1 / D1 / E2 (X1, P4).**
   **Objection:** “Convex hull” has no unique mathematical or entity contract.
   The assistant accepts points/polylines and reports a 2D footprint separately
   from a “3D hull surface” (`mesh-terrain.md:1165-1167`), but does not say
   whether hull inputs are vertices, entire analytic curves, or tessellated
   samples; whether 2D uses project XY; whether 3D means a true spatial convex
   polytope or a terrain surface over the 2D hull; which canonical types are
   published; or what one point, two points, collinear, coplanar, coincident,
   closed-loop, and huge-input cases return. “Previews degeneracy” is not a
   refusal/output rule. “Very quickly” in S11 is not a measurable budget.

   **Proposed resolution:** **Derived decision (vetoable):** define two
   separately selectable outputs from one captured revision set. The 2D
   footprint is the project-XY convex hull published as canonical Area; input
   curves contribute exact vertices and analytic extrema or deterministic
   samples within a declared chord-error bound. The 3D output is the true
   spatial convex hull of authoritative XYZ samples, published as a
   `Surface3d` closed boundary (or canonical Solid if the data model forbids a
   closed surface without volume semantics). One/two/collinear inputs produce
   no area or 3D body; coplanar inputs may produce the planar area/surface but
   no fabricated thickness; coincident points are deduplicated by typed
   tolerance with counts disclosed. Define P4 scope, exact source/placement
   revisions, stable output/part identity, preview-vs-final fidelity, memory/
   time estimates, long-job threshold, cancellation, and extreme gates.

8. **Severity: major — Contract question: C2 / E2 (P9, X7).**
   **Objection:** the amendment never says which effective interaction states
   are eligible as source rows. The old Mesh contract captures a selected set
   and scopes picks to the “visible set” (`mesh-terrain.md:433-434,473`), but
   P9 no longer equates visible with eligible. SE-D19 is the sole resolver:
   Hidden is absent; Inert renders but cannot select/snap/edit; Reference may
   select/snap but not edit; Editable may edit
   (`select-edit.md:1028-1069`). UIP-D20 owns only presentation/control and
   explicitly cites that resolver as sole authority
   (`ui-platform.md:1155-1161`). A visible Inert cloud or curve must not enter
   the captured source table through stale selection or automation. A
   Reference source may be consumed without being edited. The draft's behavior
   when an ancestor/layer/type/project state changes while the window is open
   is unspecified.

   The corrected Trimble Perspective dossier was checked: its Access layer is
   Selectable/Visible/Off, not P9's four-state model, and it does not provide
   Editable semantics. The corrected RealWorks subsection documents picking
   aids, not an effective-state resolver. The current P9 contract is therefore
   owner/doctrine-derived, and Mesh must not attribute or approximate it from
   either reference.

   **Proposed resolution:** **Derived decision (vetoable):** every UI and
   automation source admission calls SE-D19 and records its explanation.
   Hidden and Inert are ineligible; Reference and Editable may be immutable
   recipe inputs; only Editable sources may receive a separately confirmed
   source-edit command. Recheck effective state at Check and publication. A
   state change during a draft retains the row and last-good preview but marks
   it ineligible/stale with cause; publication blocks until eligibility is
   restored or the row is removed. Do not add Mesh-local lock, visibility, or
   role-state storage. Add all four states, inherited causes, mid-job changes,
   and automation parity to MT-D26 verification.

9. **Severity: major — Contract question: D1 / E3 (X2, P5, P6).**
   **Objection:** the new work has nouns but no calibrated performance or
   recovery contract. MT-D26/27 say jobs checkpoint/restart and all long calls
   use shared status/cancel (`mesh-terrain.md:1156-1163,1175-1179`), while
   tunables remain merely “hull/overlay performance budgets and solid cell
   size” (`:1181-1186`). There is no threshold separating bounded from long,
   first-progress/cancel-ack limit, peak RSS/disk bound, partition rule,
   restart unit, post-restart validation, or completion target for a 500M-
   logical-point mean grid, many long curves, a very large hull, crossing
   surfaces, or a large borehole set. MT-D17/G-MT-5 covers the pre-existing
   surface-draft class, not all new hull/solid/recipe cascades. The named Mesh
   launchers at `mesh-terrain.md:965-969` do not exist in `scripts/`; the batch
   merely cites GAP gates and adds prose fixtures (`:1188-1192`). Static review
   therefore cannot identify an agent-runnable gate for these promises.

   **Proposed resolution:** extend MT-D17 explicitly to each new job class.
   Define bounded/long thresholds and estimates before Run; first visible
   progress and cancel acknowledgement bounds; peak resident memory,
   temporary disk, and total completion on a calibrated tier; deterministic
   partition/checkpoint keys; crash/app-restart resume; and atomic CAS
   publication. Add extreme members for 500M logical cloud points, maximum
   curve vertices, maximum hull samples, maximally crossing surface grids,
   disjoint/NoData regions, and maximum borehole/interface counts. Add actual
   in-repo launchers for `G-B2-MESH-DRAFT-RULES`, `G-B2-MESH-RECOVERY`,
   `G-B2-SOLID`, and `G-B2-STRATA`, or mark each promise explicitly unverified
   until the launcher lands. “Very quickly” becomes a tunable measured budget,
   never an acceptance phrase.

10. **Severity: major — Contract question: E2 / C4 (X3, P8, P10).**
    **Objection:** the target's passive-consumer table predates batch 2 and was
    not amended. It enumerates committed surfaces, contours, reports, sections,
    export, Plan, renderer siblings, automation, and properties
    (`mesh-terrain.md:467-502`), but not recipe records, hull Areas/Surface3d,
    Cut/Fill solids, or strata-derived solids. The batch does not trace render
    admission, clipping, picking, snapping, selection/P9, transforms, section
    cuts, measurement/inspection, specification properties, File round-trip,
    import replacement, export formats/losses, Plan capture, sibling apps,
    content-addressed GC, or automation paging for those products. File,
    Measure, Plan, Import, and Agent say they consume or mirror parts of the
    new surface, solid, and recipe family, but the owning Mesh spec has no
    per-consumer effect or invalidation guarantee. Restore scope is especially
    absent for replacing a multi-part Cut/Fill result and its common recipe
    while a report or Plan capture points at the old generation.

    **Proposed resolution:** add a batch-2 E2 matrix owned here. For each of
    recipe, 2D hull, 3D hull, Cut solid, Fill solid, and per-stratum solid,
    state canonical type, admission/render path, clip/pick/snap/select/transform
    behavior, section and Measure behavior, specification/property display,
    source/import/P9 invalidation, File persistence/export/loss, Plan capture,
    automation query/paging, sibling-renderer non-regression, and heavy-
    artifact reachability. Define one atomic replacement restore set:
    recipe generation/state/error/edges, all output entities and stable parts,
    layer/style/spec ids, last-good artifact refs, report links, and reverse
    relations. Exercise the least and largest member of every class and refuse
    unsupported consumers explicitly rather than letting them disappear.

11. **Severity: major — Contract question: catalog / B1 / E2 (X3, X7).**
    **Objection:** no current registry obligation for batch 2 is honored. The
    target honestly says its delta awaits rebuild (`mesh-terrain.md:1175-1179`),
    but `REGISTRY.md` still reports 162 rows, zero duplicates, zero
    contradictions, zero unowned capabilities, and only fourteen old specs
    (`REGISTRY.md:416-431`). It contains neither Civil nor the new recipe,
    hull, solid, strata, P9, history, and sampler acts. It therefore cannot
    prove unique ownership or automation parity. Its shortcut map still says
    Tab cycles candidates (`REGISTRY.md:289-311`) and its gesture baseline and
    Raster/BIM/Agent entries repeat Tab candidate cycling (`:367-398`), in
    direct conflict with current C1, DR-D17, UIP-D16, and the GAP gate: Tab/
    Shift+Tab fields; Up/Down candidates. The false zero-contradiction count
    would let a release gate pass while the program's defining input rule is
    contradictory.

    **Proposed resolution:** perform one atomic registry rebuild after findings
    1–10 settle the contracts. Register Civil and every batch-2 row; identify
    shared acts once and cite consumers; retire the duplicate Mesh rebuild act;
    add query/mutation/performance/status/owner columns for the complete recipe
    operations; and rerun dangling-id, duplicate-act, missing-mutation,
    automation-parity, and contradictory-guarantee scans. Replace every idle or
    armed candidate-cycle statement with Up/Down and reserve Tab/Shift+Tab for
    field focus/traversal; record focused list navigation as a widget-local
    exception. REGISTRY must not claim zero findings until the generated map
    and all fourteen amended specs agree.

12. **Severity: major — Contract question: A2 / A3 (X4, X7).**
    **Objection:** the batch-2 dossier disposition is incomplete and one old
    disposition is now false. RIB Civil §2.6's constraint-line row supports
    breaklines and boundary lines; it does not support the new Form-line
    meaning. RIB's multiple-horizons/soil-layer row does support the user need,
    but the target still says soil-layer volume accounting is queued to a
    deferred Civil DR-D8 class (`mesh-terrain.md:136`). Batch 2 has instead
    assigned semantic strata to BIM BS-D25 and canonical solids to Mesh
    MT-D27. That row must be revised rather than silently supplemented. RIB W5
    still supports the check/error-fix posture. RealWorks §2.8 and W7 support
    mesh creation/editing followed by volume, but not Form lines, linked
    recipes, convex hull semantics, mean-grid cloud sides, or borehole strata.
    The target correctly uses owner statements/GAP and sibling records for
    those additions; it must state the dossier-wide absence explicitly.

    The corrected dossier subsections were also checked. Trimble Perspective
    documents Selectable/Visible/Off and blue selection, not P9 or the shared
    orange semantic token. RealWorks documents product-specific picking aids
    and does not evidence a generic rotatable/translatable reticle. The amended
    Select/Edit and UI specs disclose those deltas correctly; Mesh must consume
    SE-D19/UIP-D20 rather than re-dispose them.

    **Proposed resolution:** revise the RIB per-row table so multiple horizons
    are split explicitly: BIM BS-D25 owns observed stratum semantics; Mesh
    MT-D27 owns checked solid publication; MT-D8 retains auditable numeric
    volume. Amend the constraint-line row to say RIB evidences Breakline and
    boundary only, while Form line is an owner-derived S10 addition with the
    exact deviation from finding 3. Add one dossier-wide absence statement for
    recipe lifecycle, Form lines, grid-mean cloud sides, convex hull contract,
    cut/fill solid specifications, and borehole interpolation. Preserve the
    verified W5/W7 claims and do not manufacture support from the corrected
    access-state or picking-aid sections.

13. **Severity: major — Contract question: E1 / E3 (DESIGN-SYSTEM, X5).**
    **Objection:** “E1 follows GAP-V7/V8/V9”
    (`mesh-terrain.md:1188-1192`) is not an E1 artifact contract. GAP-V7–V9
    are useful failable criteria for the source table, crop/error links, and
    solid assistant (`OWNER-STATEMENTS-2026-09-02-GAP.md:431-442`), but the GAP
    itself requires implementing specs to commit captures/fixtures in-repo.
    The target's existing §7 predates batch 2: it has no Linked/current/Stale/
    regenerating/error/detached/auto-detached recipe comparison; no Detach or
    relink recovery flow; no hull result/degeneracy treatment; no distinct Cut
    and Fill specification/part presentation; and no strata uncertainty/
    support-boundary state. Its §6 promises screenshots at implementation
    review (`mesh-terrain.md:1020-1025`) but points to no batch-2 comparison
    artifact. Existing terrain validation screenshots elsewhere in the repo
    are renderer evidence and are not cited as these UI-state comparisons.

    **Proposed resolution:** commit and cite a batch-2 storyboard or reference
    capture set in-repo, built from DESIGN-SYSTEM tokens and the gold-standard
    window language. Include both themes and 100%/150% scale for: source table
    roles/exclusions/count provenance; crop acquisition with ambiguous/NoData
    intervals and bidirectional error jump; all recipe states and recovery
    actions; 2D/3D hull plus degenerate refusal; separate Cut and Fill rows with
    specifications, crossings, holes, valid footprint, stale reason, and
    report distinction; and strata support/uncertainty/missing refusal. Add
    exact fail criteria for focus, arrow-key ownership, accessibility beyond
    color, long labels, minimum window size, progress/cancel, close/resume,
    error recovery, and stale last-good visibility. Bind each capture to a
    named runnable gate.

14. **Severity: minor — Contract question: A3 / evidence traceability (X7).**
    **Objection:** the new sibling derivations cite the wrong resolved GAP
    record. Raster RA-D14 derives signed difference ownership from `GAP-D7`
    (`raster.md:853-859`), and BIM BS-D25 derives borehole strata from
    `GAP-D7` (`bim-specs.md:1675-1679`). GAP-D7 is only the Mesh-window
    extension; the product/ownership split for quantity report, solid, cloud
    mean-grid side, strata-derived solid, and Raster difference Grid is
    GAP-D8 (`OWNER-STATEMENTS-2026-09-02-GAP.md:84-96`). MT-D27 cites RA-D14
    and BS-D25 (`mesh-terrain.md:1181-1185`), so its evidence chain currently
    terminates at an irrelevant decision even though the correct decision is
    adjacent.

    **Proposed resolution:** change RA-D14 and BS-D25 to cite GAP-D8; RA-D14
    should additionally cite GAP-V10 for its UI evidence, while BS-D25 should
    cite `G-B2-STRATA` for validation. Retain GAP-D7 only for MT-D26's extended
    Mesh-window workflow. Re-run the mutual-citation/dangling-evidence check as
    part of `G-B2-CATALOG`.

## (a) Contract questions answered convincingly

- **B3:** extending the existing dedicated, resizable, persistent Mesh
  workspace for roles, exclusions, crop, Civil manifests, Check, and errors is
  convincingly justified. GAP-D7 and the pre-existing MT-D1 window contract
  agree; no popup or second Civil publisher is introduced.
- **X3 ownership split as applied to product classes:** MT-D27 correctly keeps
  numeric volume reports distinct from canonical solids and leaves signed
  difference Grids/legends with Raster. Pointcloud owns immutable sampling,
  BIM owns semantic strata, Civil owns corridor/pit semantics, and Mesh owns
  checked surface/solid publication. The missing operational details above do
  not require moving those ownership boundaries.
- **PC-D17 hand-off:** the two cloud sampling modes are cited rather than
  redefined. The sibling record supplies an exact mean, deterministic nearest-
  existing tie break, synthetic center, NoData, provenance, and estimates
  (`pointcloud.md:1151-1180`). MT-D26/27 correctly prohibit source-cloud edits
  and triangle-interpolated source heights.

No other A1–E3 question is counted as convincingly answered for the complete
batch-2 scope. A1/C1 fail for hulls, solids, and strata; A2 is stale; A3 and
the catalog contain contradictions; B1 is incomplete; C2 omits P9 admission;
C3/C4 conflict with P10; D1/D2 are not extended to the new extreme classes;
and E1–E3 lack complete artifacts, consumers, restore scopes, and runnable
gates.

## (b) Executed vs. read

**Executed:** read-only repository inspection with `rg`, `rg --files`, `sed`,
`nl`, `wc`, `git status`, and `git diff`; file-presence and repo-wide absence
checks for recipe/strata/hull/solid commands, schemas, scripts, fixtures, and
visual artifacts. These commands verified documentation and code citations,
stub status, per-dossier-row claims, cross-spec decision ids, registry rows,
and shortcut/gesture assertions.

**Read:** `.claude/agents/demanding-user.md`; `CURRENT-DIRECTION.md`, the docs
authority index, `AGENT-FEEDBACK.md`, the complete current
`FUNCTION-CONTRACT.md`, `DECISION-DOCTRINE.md` including P8/P9/P10,
`DESIGN-SYSTEM.md`, Builder `README.md`, `OWNER-DECISIONS.md`, current
`REGISTRY.md`, `OWNER-STATEMENTS-2026-09-02.md`, and
`OWNER-STATEMENTS-2026-09-02-GAP.md` §§2/3 and its visual/gate sections; the
target spec in full with the review scoped to batch 2; the complete viewing-box
gold-standard spec; the prior Mesh and Select/Edit reviews; RIB Civil §2.6,
W5, and relevant dossier-wide rows; RealWorks §2.7/§2.8, W7, and the corrected
picking-aids subsection; the corrected Trimble Perspective access-layer/
selection subsection; and all same-day amended sections in Civil, Draw,
Pointcloud, Raster, BIM, Select/Edit, UI Platform, View, Plan, File, Import,
Measure, Agent, and the remaining touched sibling spec. Cross-checks included
CIV-D15, DR-D17/DR-D20, PC-D17/18, RA-D14/15, BS-D24/25, SE-D19/20,
UIP-D16/UIP-D20, File persistence, Import invalidation, Measure consumption,
Plan consumption, and Agent parity.

**Code read:** `crates/himmelcad-core/src/entity_model.rs` kind ids,
`ElevationSurfaceGeometry::Tin`, `SolidGeometry`, and `GeometryObject::Solid`;
relevant entity validation/commands; Builder interaction sites cited by the
target; and repository-wide first-party implementation searches. The existing
Tin schema has breaklines but no Form lines. Canonical closed solids exist.
No first-party derived-recipe or `BoreholeStratumSet` schema, Mesh hull/solid
command implementation, or named batch-2 Mesh gate launcher was found. The
deprecated TypeScript DGM/Mesh snap providers cited by the target are stubs and
were treated as not existing, exactly as the target says. No batch-2 code
citation was found falsely claiming that new implementation already exists.

**Not executed:** builds, tests, benchmarks, the application, renderer,
screenshots, external services, or web research. This was the requested static
specification review.

## (c) Owner-decision items

**Count: 0.** Every resolution is derived and vetoable. X1 fixes non-invention,
signed output, topology, and evidence honesty; X2/P5/P6 fix bounded work,
immutable artifacts, CAS publication, cancellation, and restart; X3 fixes
canonical entities, commands, persistence, undo, and automation; X4 preserves
the verified RIB/RealWorks behavior while marking owner-derived additions;
X5 and DESIGN-SYSTEM fix complete window/recovery flows; X6/P3 keep numerical
budgets and tolerances tunable; X7 and the registry's cite-and-revise rule fix
single ownership. P8 supplies restore scopes, P9 supplies source eligibility,
and P10 supplies the derived-product lifecycle intent. No surviving issue is
an axiom conflict, owner-reserved product-identity decision, or money/licensing
decision.

## System feedback

No FUNCTION-CONTRACT question or DECISION-DOCTRINE axiom failed to do its job.
A2 exposed the stale/unsupported dossier claims; A3 and X7 exposed the
duplicate lifecycle ownership; C1 exposed invented geometry; C4/P8 exposed
missing restore sets; D1/E3 exposed absent extreme gates; E1 exposed the
missing in-repo comparison artifact; and E2 exposed passive consumers and
input arbitration. **P10 itself is a precedent, not an axiom, and its current
text is too permissive for the program-critical role assigned to MT-D25.** It
names the right states and outcomes but does not require a shared versioned
envelope, non-gesture transaction invalidation, relink/batch commands, CAS,
reload validation, or the detach/auto-detach undo restore set. Adding those
minimum transition and persistence requirements to P10 would prevent each
domain from independently filling the same holes while still leaving domain
payloads and X6 thresholds local.
