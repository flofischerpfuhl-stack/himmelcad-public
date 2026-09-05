# Demanding-user review — Mesh & Terrain domain spec (2026-09-02)

Document class: report/verification evidence.

Static adversarial review against the current `docs/FUNCTION-CONTRACT.md`,
`docs/DECISION-DOCTRINE.md` (X1–X7, P1–P6), `docs/DESIGN-SYSTEM.md`,
`docs/AGENT-FEEDBACK.md` SYSTEM-001, the Builder-program registry rules, all
Mesh obligations in `REGISTRY.md` §5.1, and the cited sibling decisions. The
RIB Civil §2.6/W5 and RealWorks §2.8/W7 dossier claims were checked against
the dossier text. The cited entity, LandXML, prepared-mesh, section, picking,
viewer-admission, importer, and scale-gate code was inspected at the claimed
lines. No build, benchmark, test, app, or web research was run, as requested.

Verdict: **not ready for owner review**. The dedicated error-fixing window is
the right product center, but the current contract can still invent a height,
cannot prove how a 500-million-point/20-minute run survives persistence and
restart, redefines View-owned display state without revising its owner, and
saves quantity numbers without an adequate datum/accuracy/export proof.

## Findings

1. **Severity: blocker — Contract question: C1 / E2 (X1).**
   **Objection:** I tried the owner's defining error case: two breaklines cross
   away from a shared surveyed point. The proposed fix splits both and assigns
   “the height from the higher-priority line” (`mesh-terrain.md:157-161`), but
   no priority exists in the captured inputs, RIB Civil's dossier, Draw's
   curve contract, or a decision record. This fabricates terrain truth. The
   same danger sits behind **Apply all safe** (`:181-184`): the spec never
   defines which fixes are safe, so a bulk action can change Z, exclude input,
   or choose between conflicting observations. W5 proves only that constraint
   lines may cross at shared surveyed points; it does not prove a priority
   rule or the “duplicate XY, conflicting Z” diagnosis attributed to its list
   of field-error causes.

   **Proposed resolution:** **Derived decision (vetoable):** X1 forbids any
   inferred survey value. Split automatically only when both evaluated XYZ
   positions agree within the recorded tolerance or an existing surveyed
   point already supplies the shared XYZ. If Z differs, show both source
   values and require an explicit authoritative-source choice or typed Z;
   record that choice in provenance. If the crossing represents grade-
   separated geometry, refuse it in a 2.5D DGM and offer exclude/reassign to a
   different surface. Limit **Apply all safe** to value-preserving topology
   normalization; coordinate changes, exclusions, Z choices, and source edits
   remain individually previewed. Add a test proving that no check/fix path
   synthesizes or changes XYZ without an explicit user/automation argument.

2. **Severity: blocker — Contract question: C4 / D1 / E2 (P5).**
   **Objection:** I closed a 500-million-point cloud session after a long mesh
   preview. The spec says the project-persisted draft contains the preview mesh
   (`:172-174`, `:316-319`, `:520-524`) and that one journaled command “carries”
   the baked mesh (`:186-188`), but it never separates lightweight journal and
   draft metadata from multi-gigabyte immutable artifacts. That contradicts
   P5: heavy data is written once by an explicit job; journal appends carry
   refs/hashes and never pay storage cost on the interaction path. Whole-app
   shutdown cancels the job (`:602-609`), while crash recovery merely says the
   preview “rebuilds on demand” (`:358`). For a 20-minute triangulation, that
   can mean silently losing completed preprocessing and doing it all again.

   **Proposed resolution:** **Derived decision (vetoable):** apply P5 exactly.
   Check products, sampled working sets, previews, canonical topology, and
   prepared hierarchies are immutable content-addressed artifacts written by
   registered jobs. The draft persists only a small manifest: source ids and
   revisions, effective scope, parameters, fix deltas, and completed artifact
   hashes. The canonical create command journals resource refs plus provenance,
   never vertex/index buffers. Fix-state writes are debounced, asynchronous,
   and bounded; canvas interaction causes zero heavy writes. Checkpoint large
   jobs at deterministic partitions so app restart resumes from the last
   verified partition; at minimum, the UI must state exactly which completed
   artifact survives and which phase restarts. Cancel publishes no entity and
   leaves staged artifacts unreachable for normal GC. Gate maximum journal
   payload, zero heavy writes during canvas interaction, crash/restart resume,
   and cancellation on both sides of the atomic publication boundary.

3. **Severity: blocker — Contract question: A3 / C4 / catalog.**
   **Objection:** I selected a mesh and used **Mesh ▸ Display ▸ View render
   style**. The spec promises Follow entity display / Realistic / Abstract /
   Wireframe (`:73-76`, `:248-256`), but the current owning record VD-D6 still
   defines `view.render-style` as source / monochrome / x-ray and keeps it
   automation-only (`view-domain.md:57`, VD-D6). The target acknowledges that
   View “must revise” later (`mesh-terrain.md:255-256`, `:786-789`) instead of
   executing the cite-and-revise rule. A consumer spec cannot replace an
   owner's enum, visibility, bookmark, or persistence semantics by recording a
   follow-up. The UI and automation therefore resolve the same id to different
   contracts.

   **Proposed resolution:** **Derived decision (vetoable):** X7 and the Builder
   README require one View-owned record. Amend VD-D6/VD-D8 first to define the
   polymorphic render-style override, including the exact effect on meshes,
   point clouds, CAD/BIM, rasters, bookmarks, and non-applicable entity kinds.
   Then cite that amended record verbatim here and register only the Mesh-tab
   accelerator. Until that revision lands, remove the accelerator from this
   tranche or change the target status from “specified”; `mesh.set_display`
   may still own only the canonical per-entity layer below VD-D8.

4. **Severity: blocker — Contract question: C1 / E2 / E3 (X1).**
   **Objection:** I computed cut/fill against “datum” and tried to issue a
   quantity deliverable. The panel accepts an unlabeled datum elevation
   (`:223-234`), reports a “prism refinement tolerance” only by implication
   (`:579-591`), and provides no statement separating numerical integration
   error from the accuracy of the two source surfaces. It does not say which
   project/vertical CRS the plane belongs to, what happens when source vertical
   references are missing or incompatible, how sign is defined, or how
   uncovered/NoData regions affect confidence. Worse, text/CSV export is merely
   queued (`:449-455`, `:638-643`), so the workflow-level volume function ends
   with a tree record and console output rather than a deliverable. RIB Civil's
   quantity workflow is not satisfied by an unexportable number.

   **Proposed resolution:** **Derived decision (vetoable):** X1 fixes the
   posture. Label the option **Horizontal plane at project Z** and show units,
   horizontal CRS, and vertical CRS (or an explicit “vertical CRS not set”
   warning); never imply a geodetic datum transformation. Reject incompatible
   or unresolved source references instead of transforming by guess. Define
   cut/fill sign, exact common-footprint/holes/NoData rules, the f64 overlay-
   triangulation/prism method, and a reported numerical bound/tolerance. The
   report must say that computational tolerance is not source/survey accuracy.
   Store surfaces, placements, revisions, scope, boundary, method/version,
   units/CRS, tolerance, excluded area, cut/fill/net/area, and stale reason.
   Route `hcad.volume-report@1` through File-owned Export and ship at least CSV
   in this workflow tranche; do not defer every external report form. Add
   analytic, mixed Grid/Tin, CRS-refusal, NoData, and exported-report round-trip
   checks.

5. **Severity: major — Contract question: catalog / A3.**
   **Objection:** The target declares itself specified while several registered
   hand-offs remain one-sided or contradictory:
   - Raster RA-D5 assigns ElevationSurface ramp **and hillshade** to MT-D6,
     while this spec has no RA-D5 citation and no hillshade contract.
   - Raster RA-D7 creates an editable Tin from a Grid and explicitly requires
     Mesh to cite the arrival contract (`raster.md:252-273,359-364`); the target
     still describes Grid as import-only and cites no RA-D7.
   - MT-D12 says it delivers DR-D13's terrain data side, but Draw DR-D13 has no
     MT-D12 citation; the target again records this as a later revision
     (`mesh-terrain.md:789-790`).
   - `REGISTRY.md` still contains only the pending §5.1 Mesh obligations; the
     catalog says its rows are merely “recommended” (`mesh-terrain.md:58-59`).
   - The boundary leaves twin-surface/difference inspection with Pointcloud
     PC-D10 (`:49-50`), then the dossier disposition and MT-D14 queue
     “difference models” to Mesh (`:97`, `:638-643`).

   **Proposed resolution:** **Derived decision (vetoable):** execute the
   program's cite-and-revise rule before restoring “specified”: add RA-D5 and
   RA-D7 dispositions here (including Grid hillshade/NoData and
   `raster.to_dgm` arrival); amend Draw DR-D13 to cite MT-D12 and add the shared
   browser gate once; put every Mesh row and cross-link into `REGISTRY.md`;
   remove difference models from MT-D14 and cite PC-D10 as their sole owner.
   Place cloud breakline finding on a registered Pointcloud-producer →
   Mesh-consumer hand-off instead of an unowned Mesh backlog item.

6. **Severity: major — Contract question: C2 / E2.**
   **Objection:** Selection changes are handled well, but source lifetime is
   not. While the window is open, an automation edit merely marks rows stale
   (`:350-358`). There is no contract for a deleted input, a matched in-place
   import update that retains the id but changes the revision, or an unmatched
   source removal. This misses both sides of import-formats IF-D4: its update
   plan reverse-scans dependents and blocks dangling references
   (`import-formats.md:178-211,440-473`), while Mesh must declare drafts,
   surfaces, contours, and reports as dependents that scan can actually find.

   **Proposed resolution:** **Derived decision (vetoable):** model provenance
   as an indexed reverse relation consumed by IF-D4. A matched update cancels
   or supersedes in-flight check/mesh work, preserves the last completed
   preview, marks the row stale, and requires Recheck before Commit. A removed
   source shows **Source removed** and blocks Commit until the user removes it,
   maps a replacement, or explicitly keeps the captured immutable revision as
   a detached snapshot with that fact in provenance. IF-D4 defaults a removed
   referenced source to Keep as local; it may not silently delete a surface
   input. Rebuild with missing sources fails with the exact missing list and
   leaves the current surface intact. Test delete, matched update, unmatched
   removal, undo of import update, and late job publication against a replaced
   project.

7. **Severity: major — Contract question: C4 / B2.**
   **Objection:** I applied five fixes, made the fifth one worse, and pressed
   Ctrl+Z before Commit. The spec defines only the eventual create undo and
   separate source-edit undo (`:186-194`, `:313-319`); it defines no draft-
   local undo/redo. It also persists one anonymous session per project and
   makes a second launch focus it (`:350-358`). Closing keeps that session, so
   I cannot park one 20-minute survey draft and edit another surface without
   committing or cancelling the first. **Apply all safe** has no grouping
   semantics, and global **Apply fix to source** commands make Ctrl+Z routing
   even more ambiguous.

   **Proposed resolution:** **Derived decision (vetoable):** X5 requires
   draft do/undo as well as canonical do/undo. While the window has focus,
   Ctrl+Z/Ctrl+Shift+Z operate on a session-local fix stack; one manual fix is
   one step and **Apply all safe** is one inspectable grouped step. Source
   fixes remain global journal commands and appear distinctly in the draft
   history; undoing one refreshes/revalidates the draft. Commit collapses the
   final draft into one canonical create command, after which global Ctrl+Z
   removes the surface. Give persistent drafts stable ids and generated names,
   with **Suspend**, **Resume**, and **Discard**; serialize only the active
   compute session, not the existence of other drafts. Automation exposes the
   same draft history and identities.

8. **Severity: major — Contract question: D1 / E3.**
   **Objection:** The largest claimed user class is “millions of points”
   (`:358-362`), but the owner asked about a 500-million-point cloud and a
   20-minute triangulation. G-MT-3 only checks 1 million sampled points and
   requires completion within 60 seconds (`:729-732`). That does not prove
   bounded source streaming, peak RAM/disk, UI responsiveness during a truly
   long job, cancellation after many minutes, restart behavior, or whether
   the sampling step destroys small terrain features. “The user switches
   auto-remesh off” also makes performance safety depend on remembering a
   toggle.

   **Proposed resolution:** **Derived decision (vetoable):** X2/X6 set a
   scale-class gate, not a convenient fixture. Add a 500M-logical-point
   streamed hierarchy gate with a recorded sampling rule, bounded working-set
   and peak-memory/disk ceilings, genuine phase/unit progress, navigation and
   error-list responsiveness, cancellation within the platform bound at early
   and late phases, and restart from the checkpoint defined in finding 2.
   Report the selected sample spacing/count and state that the DGM represents
   that sampled input; never imply full-cloud accuracy. Automatically disable
   auto-remesh above a tunable estimated-work threshold and explain why. Keep
   the 1M compute benchmark as a calibration test, not the extreme-member
   proof.

9. **Severity: major — Contract question: C4 / E2 / E1.**
   **Objection:** Contours are almost a deliverable contract, but not quite. The
   spec creates a group of ordinary curves with an output layer (`:393-410`)
   without adopting Draw DR-D4's exactly-one-layer invariant for every child,
   saying how major/minor styles bind, or proving DXF export. Its stale trigger
   says “surface edit/removal”, not whole-entity placement transforms or
   IF-D4 source updates. The E1 answer cites criteria 3 and 6, which describe
   the surface-window canvas and volume report, not contour appearance.

   **Proposed resolution:** **Derived decision (vetoable):** every generated
   contour curve receives exactly the selected layer (assign replaces; Default
   only when explicitly selected) and an explicit major/minor style ref; the
   group carries source id, source revision **and placement**, intervals,
   style/layer refs, min/max, scope, and generator version. Surface geometry or
   placement change, source update/removal, layer/style deletion, and relevant
   scope-reference loss produce a named stale state; regeneration is one
   atomic replace whose C4 restore set preserves unrelated group name/layer
   choices. Add a failable contour E1 block and a DXF export/re-import test
   proving elevations, major/minor layers/styles, grouping loss disclosure,
   and no stale export without an explicit reviewed warning.

10. **Severity: major — Contract question: catalog / E2 extreme member.**
    **Objection:** `mesh.edit-surface` sounds applicable to the whole declared
    surface class, but §2.2 specifies only elevation Tin editing; Grid is
    read-only and `hcad.surface-3d@1` is never dispositioned. Yet existing IFC,
    DXF, and SLPK imports create Surface3d entities. The RealWorks row promises
    hole filling and Add Triangles; the disposition says these become “add
    point/fill region” (`:104`, `:268`), but there is no fill-region/add-
    triangle operation, and hole filling is later queued (`:642`). The
    per-dossier-row disposition therefore overstates adoption.

    **Proposed resolution:** **Derived decision (vetoable):** split the class
    honestly. Rename the workflow action **Edit terrain surface** and limit it
    to ElevationSurface Tin, with Grid explaining **Convert to editable Tin**
    through RA-D7. Add a separate `mesh.edit-3d` catalog row for Surface3d,
    explicitly deferring or specifying Add triangles, fill hole, remove
    triangles, manifold/material/UV behavior, and resource-backed editing.
    Recommend promoting Add triangle/fill hole now because they are the cited
    RealWorks repair loop and the requested surface-editing outcome; otherwise
    mark them deferred in the RealWorks row instead of translating them to
    absent operations. Test the least members (one triangle/one-cell hole) and
    largest resource-backed members.

11. **Severity: major — Contract question: A2 / A3 (evidence integrity).**
    **Objection:** Several “exists today” or sibling-semantics citations do not
    prove the claim:
    - `ImportRegistrationWizard.tsx:107,1099` shows an elevation-surface option
      and option labels, not the claimed captured-input/review/commit lifecycle.
    - `mesh_picking.rs:1,122-209` shows data structures and BVH fields, not the
      surface/edge/vertex refinement used to support MT-D12; the relevant
      behavior is later in `refine` and its tests.
    - IFC `ifc_provider.rs:674-685`, DXF `dxf_provider.rs:934`, and SLPK
      `slpk_provider.rs:1539-1547` prove Surface3d creation, but the cited
      objects have no material ref and IFC has no texture coordinates. They do
      not prove the “imported textured mesh” Realistic-mode consumer
      (`mesh-terrain.md:387-391`, `:630-635`).
    - The LandXML export citation stops at `landxml.rs:2280`; breakline writing
      starts later. The repo-wide “zero wireframe hits” claim is also literally
      false because vendored CAD code contains wireframe modes; it must be
      scoped to the first-party Builder command/display surface.

    **Proposed resolution:** correct each claim to full repo-relative
    file:line ranges and actual semantics. Cite the registration island handler
    and commit flow, mesh refiner build/refine/clip integration and tests, and
    the complete LandXML breakline writer. Mark textured Surface3d import as
    unverified unless a real provider/admission/material path is cited and
    tested; storage capability and prepared-texture construction alone are not
    an end-to-end Builder consumer. Scope absence searches explicitly to
    first-party non-vendored code. A specified status requires these evidence
    repairs under the A2 rule.

12. **Severity: major — Contract question: C1 / E2 (X1).**
    **Objection:** Simplification accepts “target triangle count or geometric
    tolerance” (`:465-482`) but never defines the error metric or invariants.
    For an elevation surface it could remove a breakline, boundary, hole edge,
    or measured summit while still hitting a triangle count. For a 3D mesh it
    could cross a material/UV seam or change manifold/boundary status. P4
    clipping also turns a visible subset into a new boundary, but the output
    semantics do not say whether triangles are clipped, selected whole, or
    capped. “Tolerance and topology constraints never relax” is not a usable
    accuracy statement.

    **Proposed resolution:** **Derived decision (vetoable):** X1 requires
    type-specific contracts. ElevationSurface simplification preserves outer
    boundary, holes, breakline vertices/edges, 2.5D uniqueness, and source
    extrema, and uses a reported maximum vertical deviation in project units.
    Surface3d uses a stated symmetric surface-distance bound and preserves open
    boundaries, manifold classification, material/UV seams, and protected
    vertices. Record requested and achieved error/count plus the exact P4
    scope; if a clip creates the product boundary, bake that boundary
    explicitly and say so. Preserve the input entity type unless validation
    proves a deliberate type conversion. Add adversarial gates for sharp
    breaklines, holes, seams, thin triangles, and resource-backed streaming.

13. **Severity: major — Contract question: A3 / C4 / E2.**
    **Objection:** The dossier row says Move Mesh is covered merely because
    `TransformEntityCommand` exists (`:104`), but the current Select/Edit spec
    owns and defines the actual semantics: whole-entity transform changes
    placement, not source geometry, and derived products invalidate
    (`select-edit.md:250-286`, SE-D3). Mesh does not cite that sibling record or
    enumerate placement as an input to contours, reports, snapping indexes, or
    rebuild. Its C4 rebuild restore scope preserves style/name/layer but omits
    placement (`mesh-terrain.md:313-319`). A rebuild after moving a surface is
    therefore ambiguous, and a world-space contour/report may remain falsely
    current after the surface moves.

    **Proposed resolution:** cite SE-D3/SE-D11 with verified semantics. State
    that rebuild replaces local geometry/provenance only and preserves entity
    placement, name, exactly-one-layer membership, style, and lock; list those
    exemptions in the C4 restore set. Any accepted placement change invalidates
    world-space prepared pick/section products and marks contour groups and
    volume reports stale using source revision+placement/version hash. A
    transform preview uses the shared gizmo and never retriangulates. Add move
    → stale → rebuild/regenerate and undo/redo tests.

14. **Severity: minor — Contract question: B1 / catalog.**
    **Objection:** Command naming and reachability are not stable enough for a
    “specified” SDK surface. Registry ids use kebab case (`mesh.create-surface`),
    one reserved command uses `mesh.from_cloud`, leaves mix snake case and
    verbs, B1 abbreviates console access to `mesh check|create|rebuild`, and
    `mesh.volume.list_reports` appears only later, outside the catalog row.
    REGISTRY F8 is acknowledged but unresolved. I cannot script the 40-object
    repeat workflow against a contract that still has multiple spellings.

    **Proposed resolution:** apply the registry-wide F8 naming decision before
    SDK generation, then list the exact console alias and canonical automation
    id for every row, including draft list/resume/undo, report list/export, and
    regenerate. Keep UI ids separate from protocol ids and add a schema
    uniqueness/staleness gate.

15. **Severity: minor — Contract question: E1 / D1.**
    **Objection:** Criterion 4 requires every applied fix to update the canvas
    within one frame (`:758-760`), while auto-remesh may legitimately start a
    long job. As written, an implementation can either fail the visual gate or
    block a frame while rebuilding. The criterion does not distinguish the
    corrected input/error marker from the triangulated preview.

    **Proposed resolution:** require the edited constraint, marker, row state,
    and a visible **Preview stale / Rebuilding** state within one presented
    frame; require the old preview to remain visibly marked stale until the
    registered remesh publishes atomically. The new triangulation follows
    G-MT-3 progress/cancel, not a one-frame promise.

16. **Severity: idea — Contract question: A1 / B1.**
    **Objection:** Tomorrow I need contours and simplification on 40 named
    surfaces. Automation parity makes it possible, but the only visible UI is
    one captured source at a time. That is workable, not pleasant.

    **Proposed resolution:** after the single-surface workflow is correct, let
    multi-selection create a reviewed job group with shared settings and one
    output row/result per source; failures and cancel remain per source, like
    import-formats' batch pattern. Save the parameter set as a named preset
    only when repeated use proves the need (P1), and expose the generated
    automation recipe.

## (a) Contract questions answered convincingly

- **A1:** the create/check/fix/mesh/commit narrative is concrete and is the
  correct flagship workflow, notwithstanding the correctness gaps above.
- **B2:** x, launcher toggle, Commit, Cancel, and close-as-keep-session are
  distinguished; Escape is correctly kept inside the workspace window.
- **B3:** a dedicated resizable window is justified by the canvas, role table,
  and error list; volume/contour panels remain viewport-adjacent.
- **C3:** manual preview freeze by disabling auto-remesh is a real performance
  lever, and committed surfaces are correctly treated as baked data.
- **D2:** preview fidelity/LOD may degrade while correctness and input response
  do not.

No other A1–E3 question is counted as convincingly answered: A2/A3 contain
evidence and ownership defects; B1's protocol is unsettled; C1/C2/C4 fail on
height, source lifecycle, datum, storage, and undo; D1 misses the extreme
class; E1 misses contours and conflates fix/preview timing; E2 misses passive
consumers and type extremes; E3 lacks the corresponding gates.

## (b) Executed vs. read

**Executed:** read-only repository inspection using `sed`, `rg`, `find`, `wc`,
and numbered-line views. These were used to locate and compare citations,
absence claims, registry obligations, code stubs, actual importer payloads,
and sibling decision records.

**Read:** the demanding-user persona; current direction and documentation
authority index; FUNCTION-CONTRACT; DECISION-DOCTRINE; AGENT-FEEDBACK;
DESIGN-SYSTEM; TEST-TIERS; Builder-program README, OWNER-DECISIONS, and
REGISTRY; the target spec; the full viewing-box gold-standard spec; prior Draw,
View-domain, and Pointcloud reviews; the RIB Civil and RealWorks dossiers
(including §2.6/W5 and §2.8/W7); dossier-wide mesh/style search across Revit
and Trimble Perspective; and relevant sections/decisions in Draw, Raster,
View, Pointcloud, Select/Edit, UI Platform, and Import Formats. Code read
included `himmelcad-core` entity/validation/command surfaces, LandXML,
prepared-mesh and DGM tiling/runtime code, render compilation/section/topology/
picking/LOD, viewer admissions and legacy snap stubs, Builder ribbon/tree,
import wizard, importer emission sites, and the scale gate.

**Not executed:** builds, tests, benchmarks, the app, the renderer, screenshots,
or web research. This is a specification review, and the user explicitly
required static review without running builds or the app.

## (c) Owner-decision items

**Count: 0.** Every resolution above is derived and vetoable, not an owner
question. Survey truth and volume honesty follow X1; heavy artifact and restart
handling follow X2/P5; saved drafts/reports and automation parity follow X3/P1;
RIB/RealWorks behavior and the dedicated window follow X4; undo and lifecycle
symmetry follow X5; thresholds stay tunable under X6/P3; and cross-spec
ownership follows X7 plus the Builder README cite-and-revise rule. No axiom
conflict, product-identity/scope/money/licensing call, or owner-reserved
boundary survives the escalation protocol.

## System feedback

No contract question or doctrine axiom failed to do its job. The blockers are
violations the current system already exposes: X1 catches the invented
intersection Z and under-specified quantity claim; P5 catches heavy mesh data
on the persistence path; A2 catches unsupported code/reference claims; A3 and
the registry rule catch one-sided ownership; C4 catches draft/rebuild restore
scope; D1/E3 catch the absent 500M/20-minute gate; E2 catches import update,
transform, layer, export, and derived-product consumers. One useful future
sharpening is to make D1/E2 explicitly require a whole-app restart/checkpoint
policy for multi-minute jobs; today that duty is derivable from DESIGN-SYSTEM
app-shutdown coverage, X2/P5, and UIP-D10, but it is easier to miss than
renderer-reload recovery.
