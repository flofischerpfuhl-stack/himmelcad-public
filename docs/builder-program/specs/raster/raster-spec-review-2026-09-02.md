# Demanding-user review — Raster domain spec (2026-09-02)

Document class: report/verification evidence.

Static adversarial review against the CURRENT function contract, decision
doctrine (X1–X7, P1–P6), design system, Builder-program registry rules, owner
decisions, the complete cited dossier evidence, the cited sibling records, and
the cited implementation. Findings are most severe first.

1. **Severity: blocker — Contract question: A1/C4.** **Objection:** The central
   Lageplan promise cannot be represented by the canonical model the spec says
   it will publish. Raster lines 101–108 create `hcad.raster-image@1` with “no
   asserted Z” and show it in plan view only. The shipped `RasterMapping`
   variants cannot carry that state: `OrthoGridMapping` requires three
   `Vector3` values (`crates/himmelcad-core/src/entity_model.rs:484-515`), and
   validation requires a valid 3D grid or plane
   (`crates/himmelcad-core/src/entity_validation.rs:762-783`). The general
   optional-Z rule in `docs/DATA-MODEL.md:51-65` does not magically make raster
   mappings optional-Z. The workflow then promises “placed on an explicit
   plane” (raster lines 104–106), but no catalog row, visible entry, command,
   undo rule, or automation method creates that plane placement. An implementer
   must either invent Z=0, publish an invalid entity, or quietly drop the
   promised path. All three are rejection outcomes for survey data.

   **Proposed resolution:** Derive the answer from X1, X3, X5, the data model,
   and FP-D15 rather than asking. Add an explicit canonical plan-raster mapping
   (for example `RasterMapping::PlanGrid2D` with f64 XY origin/steps and no Z)
   plus validation that excludes it from 3D render, pick, measure, and terrain
   consumption. Add a real `raster.set_plane` / `raster.clear_plane` row if the
   explicit-plane sentence remains: visible Raster entry, plane origin/normal
   numeric fields and manipulation parity, journal/undo, automation, and a
   clear mapping-versus-entity-placement rule so the transform is applied
   exactly once. Drape may consume the plan mapping's XY without promoting the
   image to a false plane. Add schema/SDK/migration tests proving that no path
   serializes an implicit zero height. This is a derived, vetoable decision:
   correctness and open/close/do/undo symmetry select it; no owner call exists.

2. **Severity: blocker — Contract question: E2 (P4).** **Objection:** I drape
   and convert while “Stairwell B” is the active viewing box, but the spec never
   defines the deterministic effective set. Section 3.3 says P4 scopes drape,
   crop input, and `to_dgm` (raster lines 243–250), while the `to_dgm` narrative
   calls the active clip _optional_ (lines 252–266). That directly contradicts
   P4: active clip volumes and explicit visibility scope geometry-consuming
   operations. The drape workflow (lines 110–129) neither shows the active box
   nor says whether the prepared surface is full-footprint, box-bounded, live-
   linked to the box, or frozen to its launch geometry. A later box edit could
   therefore silently change a canonical drape, or an implementation could
   process hidden terrain while claiming visible-set behavior. The target-point
   half of georeferencing similarly cites DR-D12 candidates without explicitly
   requiring P4/MT-D12 clip-aware resolution.

   **Proposed resolution:** Every geometry-consuming Raster command displays a
   non-optional **Scope: visible set** summary naming the active viewing box and
   hidden inputs. At launch/Apply, capture the effective clip/visibility scope
   as immutable world-space command arguments with referenced revisions; never
   retain a live pointer to mutable view state. Drape, crop, and Grid→Tin use
   that captured intersection. To act on the full entity, the user explicitly
   deactivates the box/unhides inputs before launch; export remains FP-D5's
   already-documented canonical-data exception. Georeference target picks use
   the P4-aware snap/pick pipeline. Add locked and unlocked viewing-box cases to
   G-RA-BROWSER and G-RA-REAL, including zero effects outside the captured box
   and full-precision target coordinates. This follows P4/X1; it is not an
   owner-decision item.

3. **Severity: major — Contract question: C1/A3.** **Objection:** This is not a
   survey-grade control-point adjustment yet. The only model offered is a
   six-parameter affine fit at three points (raster lines 95–99, 194–210,
   324–329). The repository's current transformation contract explicitly
   includes both 2D similarity/Helmert and 2D affine
   (`docs/TRANSFORMATIONS.md:26-30`; model types at
   `crates/himmelcad-core/src/transform.rs:266-286`), but the spec never offers
   the choice. Affine can absorb scan stretch and shear; Helmert preserves
   angles and one scale. Forcing affine makes paper distortion indistinguishable
   from bad control. Worse, three non-collinear pairs give six equations for
   six affine unknowns, so the displayed residuals are tautologically zero:
   there is no redundancy to audit. “Each residual and the aggregate residual”
   does not define dX, dY, planar norm, RMS, maximum, units, weighting, excluded
   observations, or the warning/acceptance rule.

   **Proposed resolution:** Add a **Transform** selector with **Helmert
   (similarity)** as the safe default and **Affine (6 parameter)** as a deliberate
   scan-distortion choice. Require at least three enabled, non-collinear,
   non-duplicate pairs for either model even though similarity is mathematically
   solvable from two; with exactly three affine pairs show **No redundancy — add
   a fourth control to verify the fit**. Show per-pair dX, dY, planar residual,
   weight/use state, RMS and maximum in project units; highlight and frame the
   worst pair; keep excluded pairs visible in the audit record. Show the fitted
   translation, rotation, scale and—only for affine—axis scales/shear. A tunable
   warning threshold requires explicit acknowledgement rather than inventing a
   hard survey tolerance. Persist an exportable registration report with model,
   controls, exclusions, parameters, residuals, source hash, and actor. Extend
   G-RA-UNIT/UI/SDK with exact, noisy, outlier, three-point-no-redundancy, and
   degenerate cases. The model choice is derived from X1 plus the existing
   transformation contract; it does not survive escalation.

4. **Severity: major — Contract question: B3/A3.** **Objection:** The surface
   choice is underspecified and too small for the workflow it contains. A right
   function panel plus an unnamed “source-image pane” (raster lines 201–204)
   must hold a huge scan canvas, the live project view, a point-pair table,
   residual diagnostics, and two-way framing. That is exactly the contract's
   dedicated-resizable-window class: spatially dense work with its own canvases
   and error list. The claimed sibling citation is also wrong. `importRegistrationProfile.ts:110-120`
   only advertises GeoTIFF methods; it proves no marker or table semantics. The
   actual sibling is `ImportRegistrationWizard.tsx:741-823`, which uses two
   registration views and a Fit action, and `:996-1015`, which shows aggregate
   3D RMS/overlap—not the per-pair table this spec claims to reuse. Its backend
   fits robust 3D similarity, not raster affine
   (`crates/himmelcad-core/src/registration.rs:343-415`).

   **Proposed resolution:** Use a dedicated resizable georeferencing window
   containing source-image canvas, project viewport, and residual/control table,
   with the main Builder viewport remaining available behind it. Reuse the
   sibling's actual two-view layout and shared controls, but record the semantic
   deviations: pixel↔XY pairs, Helmert/affine 2D models, no ICP, per-pair
   residuals. Define window x/ribbon re-toggle as discard of uncommitted edits,
   the UIP-D14 inner Escape rungs, detach/layout persistence, and source-pane
   pan/zoom gestures separately from project-viewport orbit/pan. Replace the
   false A3 citation with the actual component and backend flows.

5. **Severity: major — Contract question: A3/E2 (registry-level).**
   **Objection:** Opacity is correctly designed as per-entity canonical state,
   but monochrome is not reconciled with the upper display layer. Raster says it
   adopts VD-D8 verbatim and adds no competing View override (lines 160–164,
   316–322). VD-D8 currently delegates its lower canonical styles to Pointcloud
   and Mesh/BIM, not Raster (`view-domain.md:724-748`), while VD-D6 still carries
   a global `view.render-style` enum containing `source/monochrome/x-ray`
   (`view-domain.md:693-708`). The concurrent Mesh spec asks View to replace
   that enum with mesh modes (`mesh-terrain.md:1155-1159`). Without a two-sided
   cite-and-revise record, an automation render can apply “monochrome” as a
   raster canonical edit, a global View override, or both. That is the exact
   display-ownership defect the registry was created to prevent.

   **Proposed resolution:** Amend VD-D8 itself to name Raster's lower layer:
   raster opacity and source/monochrome are canonical, journaled entity style.
   Amend VD-D6 to scope the replacement `view.render-style` to Mesh/BIM only;
   Raster and Pointcloud are unaffected by it, and the cloud-only VD-D8 color
   override remains cloud-only. Raster then cites those amended records rather
   than declaring their semantics locally. Add a mixed cloud+raster+mesh test:
   raster canonical monochrome survives View override changes, raster opacity
   never changes pointcloud appearance, and bookmark restore changes only the
   documented upper layer. X7 and the README cite-and-revise rule decide this.

6. **Severity: major — Contract question: C4/E2.** **Objection:** Polygon crop
   has no canonical kept-pixel representation. The workflow accepts a polygon
   and promises a new raster bounded to it with excluded pixels absent
   (raster lines 224–250, 458–460). `RasterImageGeometry` carries pixels,
   dimensions, mapping, and optional depth only
   (`entity_model.rs:718-733`). A tight rectangular extent cannot represent a
   non-rectangular kept region. Treating transparent alpha as validity would
   also violate ADR 0020's explicit rule that alpha is not elevation validity.
   Render, pick, drape, future synthetic GeoTIFF, and `to_dgm` can therefore
   disagree about the corner pixels outside the polygon.

   **Proposed resolution:** Keep polygon crop and add an immutable canonical
   image-validity/kept-pixel mask (distinct from alpha and depth validity), with
   exact dimensions/encoding and one shared consumer contract. The cropped
   product uses the tight pixel bounding rectangle, adjusted pixel mapping,
   this mask, source revision, and authored polygon provenance. Render, picking,
   drape, plan composition, and export consume the same mask. Clip remains the
   reversible component on the source; crop creates a separate entity; undo of
   crop removes only product+mask, while undo of clear restores only the prior
   clip component. If that schema work is not in this tranche, restrict v1 crop
   to rectangles and say so; silently bounding a polygon is rejected by X1.

7. **Severity: major — Contract question: E2/C4.** **Objection:** The passive-
   consumer lists are nouns, not lifecycle contracts. After georeferencing an
   existing ortho, the spec says only that export loses passthrough eligibility
   (raster lines 214–220). It does not say what happens to an existing drape
   bake, derived crop, plan-composer placement, clip boundary, open Properties
   surface, or automation reader. Likewise, UIP-D10 guarantees renderer
   rehydration while the main process lives, but the Raster spec never states
   what survives a main-process/app crash for a staged scan, completed point
   pairs, crop, drape preparation, or Grid→Tin job. “No partial product” is not
   a recovery policy.

   **Proposed resolution:** Add a mutation-by-consumer table. A mapping change
   invalidates and atomically rebuilds the drape cache; pixel-coordinate clips
   retain their pixel meaning; an already-created crop stays bound to its exact
   old source revision and is visibly stale rather than moving; live plan views
   follow the current source revision; export re-plans; in-flight jobs with a
   stale source revision fail before publication. Project-managed staging and
   completed point pairs checkpoint off the interaction thread (P5) and return
   as a **Needs placement** job after renderer reload; state explicitly whether
   a full app restart resumes or offers retry. Long jobs publish only verified
   immutable artifacts plus one atomic link; interrupted unlinked staging is
   cleaned or recoverable, never shown as success. Add crash/reload/retry tests
   for each long-running class and a mapping-change race across every consumer.

8. **Severity: major — Contract question: E2/E3 (FP-D5).** **Objection:** Export
   honesty is asserted, but the Raster disposition matrix the user needs is
   missing. Section 3.5 covers GeoTIFF passthrough and DXF omission only
   (raster lines 276–295). File currently exposes DXF, LandXML, IFC, splat PLY,
   and GeoTIFF (`file-project.md:246-267`). LandXML emits
   `hcad.landxml.export-unsupported-entity@1` for raster geometry
   (`landxml.rs:53,1681-1732`); IFC and splat PLY are exact-source passthrough
   writers for their own source types and cannot export a Raster entity; none
   is dispositioned or tested here. The current GeoTIFF guard also requires
   entity revision zero and no placement (`geotiff_provider.rs:777-800`), so a
   style-only entity revision may lose passthrough even when pixels/mapping are
   unchanged—copy that the user must see, not infer.

   **Proposed resolution:** Add explicit export-honesty rows for native `.hcadx`
   retention, unchanged matching GeoTIFF import, any revised/placed/clipped/
   draped/generated/cropped raster, DXF, LandXML, IFC, and splat PLY. Each row
   names: availability/disabled reason, output, exact loss code(s), whether an
   accepted loss can execute, and whether display state is intentionally absent
   from the deliverable. Resolve the style-only revision policy explicitly:
   either retain the current conservative refusal and state it, or make the
   passthrough guard compare exact source geometry/mapping rather than blanket
   revision zero. Recommend the latter only if a test proves byte identity and
   no semantic raster edit; otherwise keep the honest refusal. Add one plan/
   execute test per row and unknown-loss rendering through FP-D5.

9. **Severity: major — Contract question: A2.** **Objection:** The dossier-wide
   absence claim is false. Raster lines 9–15 say all four dossiers contain no
   elevation color-ramp behavior. `trimble-perspective.md:55-68` explicitly
   documents “color by elevation,” including typed min/max in Trimble Access,
   and `:266-268` calls it the reference catalog. It is point-cloud display,
   not DGM display, but that makes “no dossier documents it” false under the
   contract's whole-dossier rule. The spec is consequently not entitled to call
   the elevation ramp a reference-free addition.

   **Proposed resolution:** Correct the top-level absence sentence and add the
   Perspective row to the display disposition: adopt elevation-color catalog
   and typed min/max as interaction evidence; state the domain deviation that
   Raster/Mesh applies the same display idea to authoritative ElevationSurface
   heights. Keep drape, hillshade, and raster crop as dossier-wide additions if
   their whole-dossier searches still hold. This is doctrine auditability rule
   2: fix the evidence statement before the derived decision.

10. **Severity: major — Contract question: catalog.** **Objection:** The spec is
    marked “specified,” but its rows were never written into the registry.
    `REGISTRY.md` contains no `raster.display`, `raster.drape`,
    `raster.georeference`, `raster.clip`, `raster.crop`, or `raster.to_dgm`
    row; §5.2 still describes Raster as a pending domain. Its shortcut map and
    gesture map likewise know nothing about Raster's armed clicks. This violates
    the Builder-program README rule that registry rows are written at
    specification time, and prevents the registry from detecting the display
    and input collisions above.

    **Proposed resolution:** Add the six catalog rows, exact access labels,
    performance classes, console/automation commands, and recorded shortcut
    absences to `REGISTRY.md`; register both armed-tool gesture sets; replace
    §5.2's pending obligations with links showing the ortho artifact side,
    georeferencing, dossier dispositions, and VD-D8 Raster layer are claimed.
    Add the single-owner cross-link PC-D9 → ordinary raster arrival and the
    pending RA-D7 → Mesh product link. Only then may the spec retain “specified.”

11. **Severity: minor — Contract question: catalog (pending cross-reference).**
    **Objection:** The concurrent Mesh file exists, but the forward hand-offs
    have not landed on that side. MT-D6 owns elevation ramp/slope classes but
    not hillshade or the Raster-tab fan-in (`mesh-terrain.md:816-835`), and the
    file contains no RA-D7 citation for Grid→Tin arrival. Raster accurately
    calls amendments necessary, but elsewhere speaks as though MT-D6 already
    owns hillshade (raster lines 316–351). That is premature sibling semantics.

    **Proposed resolution:** Treat this exactly as a pending cross-reference,
    not a blocker: amend MT-D6/catalog/B1 to cite the Raster access path and
    either own hillshade with its typed parameters or explicitly reject it;
    amend the Mesh Grid/Tin boundary to cite RA-D7 and specify arrival validity,
    editability, display, snap registration, and provenance. Until those land,
    Raster must say “proposed Mesh-owned hillshade,” not “already owned.”

12. **Severity: minor — Contract question: A2.** **Objection:** Several code
    citations point at declarations rather than the claimed working path.
    Raster line 34 says the surface-tile decoder exists but cites
    `elevation_raster.rs:21-45,83-90`, which define/validate the contract; the
    decoder is at `:569-619` and `:684+`. Lines 157–159 and 391–393 claim height
    gradients render but cite only the `ColorMode`/`HeightGradient` types in
    `render_world.rs:52-83`; runtime resolution and shader use are at
    `gpu_frame.rs:261-282` and `shaders/mixed.wgsl:201-225`. The DXF omission
    citation names the loss constant only; `dxf_provider.rs:1764-1782` proves a
    raster actually receives it. The claims are true, but the cited lines do
    not prove them, which the current code-evidence rule expressly forbids.

    **Proposed resolution:** Replace or extend those citations with the runtime
    and planner lines above. For absence claims such as “no affine command” and
    “no clip component,” record the repo-wide search surface rather than citing
    only one data struct. No design decision is needed.

13. **Severity: minor — Contract question: B1.** **Objection:** Reachability is
    syntactically complete but not registry-ready. “R accelerators” never names
    the Raster buttons or their effect; context-menu labels are mostly absent;
    and every function says “no shortcut” without the required why. I cannot
    tell whether the Appearance group contains **Monochrome**, **Opacity…**,
    **Drape onto…**, or only a generic Properties launcher, nor can the registry
    determine duplicate acts.

    **Proposed resolution:** Name every visible label and state exactly which
    canonical command it invokes. Recommended compact layout: **Georeference…**
    in Place; **Monochrome** and **Drape onto…** in Appearance (opacity remains
    Properties, not a redundant ribbon slider); **Clip…** and **Create cropped
    raster…** in Edit; **Convert grid to editable TIN…** in Convert. Record no
    shortcuts because these are selection-contextual, low-frequency operations
    with no cited reference binding; let the registry assign one later if usage
    evidence demands it.

## (a) Contract questions answered convincingly

- **B2** — open/close/cancel/background-job semantics are consistently stated,
  apart from the B3 host correction in finding 4.
- **C2** — captured versus retargeting selection and Mixed multi-edit behavior
  are explicit.
- **C3** — drape/crop/Grid→Tin are correctly treated as bakes; a redundant lock
  is rejected with reason.
- **D2** — weak-hardware degradation protects input response, mapping, topology,
  and authoritative coordinates.
- **E1** — §8 is a repo-resident, failable written artifact covering themes,
  state, residual legibility, NoData, and crop/source distinction.

The PC-D9 single-owner ortho hand-off and FP-D5 ownership boundary are also
convincing sub-answers, but A3 as a whole is not because findings 4, 5, and 11
remain.

## (b) Executed vs. read

**Executed:** static repository inspection only: `rg`, `nl`, `sed`, `wc`, file
existence checks, and `git status`. No build, test, benchmark, application,
renderer, screenshot comparison, or web research was run, as required by the
static-review instruction.

**Read:** `.claude/agents/demanding-user.md`; `docs/CURRENT-DIRECTION.md`;
`docs/README.md`; the complete current `FUNCTION-CONTRACT.md`,
`DECISION-DOCTRINE.md`, `DESIGN-SYSTEM.md`, `AGENT-FEEDBACK.md`,
`TEST-TIERS.md`; Builder-program README, OWNER-DECISIONS, and relevant complete
REGISTRY sections; the target spec; the gold-standard viewing-box spec; the
prior View-domain and Pointcloud reviews; all Raster-relevant rows and the
whole-text absence surface of `realworks.md`, `rib-civil.md`, `revit.md`, and
`trimble-perspective.md`; sibling records PC-D9/PC-D10/PC-D11, VD-D6/VD-D8,
DR-D4/DR-D12/DR-D13, FP-D5/FP-D15, MT-D6/MT-D12 and the Mesh RA-D7 search;
ADR 0020; `DATA-MODEL.md`; `TRANSFORMATIONS.md`; and every cited code location
plus the runtime/consumer paths needed to verify it.

## (c) Owner-decision items

None. **Owner-decision count: 0.** The escalation protocol was applied:

- plan-only raster truth and explicit plane placement are closed by X1/X3/X5,
  the canonical data model, and FP-D15's no-invented-placement class;
- active viewing-box scope is closed by P4 and X1;
- Helmert versus affine availability and residual disclosure are closed by X1,
  X4, the RIB evidence, and the existing transformation contract; numeric
  warnings are delegated by X6;
- display ownership is closed by X7 plus VD-D8 and the cite-and-revise rule;
- crop validity, recovery, and export disclosure are closed by X1, P5, ADR
  0020, and FP-D5;
- the Mesh items are ordinary two-sided cross-reference edits, not product
  identity or reserved-scope decisions.

No genuine axiom conflict, licensing/money call, product-identity boundary, or
owner-reserved scope survives.

## System feedback

No contract question or doctrine axiom failed to do its job. A2 exposed the
false dossier-wide absence and declaration-only citations; A3 exposed the
unverified sibling semantics; C4 exposed the impossible no-Z canonical state;
E2 plus P4 exposed the active-box and passive-consumer gaps; X7/registry rules
exposed the display double-ownership risk. The failure was application, not
doctrine. One enforcement improvement is warranted: mechanically reject a
domain spec marked `specified` when its ids are absent from `REGISTRY.md` or
its prior pending-domain obligations remain unresolved; the written registry
rule correctly asked the question but currently has no gate.
