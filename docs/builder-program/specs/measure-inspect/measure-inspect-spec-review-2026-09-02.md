# Demanding-user review — Measure & Inspect specification (2026-09-02)

Document class: report/verification evidence. Static adversarial review of
`measure-inspect.md` against the current function contract, decision doctrine,
design system, SYSTEM-001, Builder-program registry rules, accepted data-model
authority, the cited sibling specifications, both cited reference dossiers,
and the cited implementation. No build, application, test, or benchmark was
run.

Headline: **3 blockers, 10 majors, 1 minor, 0 ideas.** The workflow has the
right professional shape, but it is not yet a specified contract. The program
registry still says measurement has no owner; the proposed built-in entity is
not admitted by accepted ADR 0016; and the locked-box chain silently assigns
different dependency semantics to typed and snapped endpoints while claiming
they are the same.

## Findings

1. **Severity: blocker — Contract question: catalog / A3.**

   **Objection:** This document declares itself specified and calls its §1
   table “registry rows” (`measure-inspect.md:3`, `:15-37`), but the registry
   of record still says interactive measurement is “owned by no spec today”
   and leaves Measure & Inspect in the pending-domain list
   (`REGISTRY.md:356-366`, `:575-588`). The target also inserts **Measure**
   between Clip and Style (`measure-inspect.md:21-23`, MI-D1), while the
   View-domain owner still defines Camera / Clip / Style / Overlays /
   Navigation / Diagnostics with no Measure group (`view-domain.md:64-69`).
   The program README requires registry rows at specification time and says a
   touching spec must cite **and revise** the owner rather than disposition the
   surface again. I cannot implement the ribbon or audit duplicate commands
   from two contradictory planning artifacts.

   **Proposed resolution:** Derived decision, vetoable: promote the seven
   Measure rows into `REGISTRY.md`, remove the “owned by no spec” wording from
   §4 F5a/§5.6, retain §5.6 only as the closed obligation trace, and amend the
   View-domain §1 layout plus its decision record to cite MI-D1. Run the
   registry collision checks again for command IDs, View-group order, panel
   ownership, gestures, and report-export contribution. Only then may this
   document say “specified.” This follows the README directly; no owner choice
   survives.

2. **Severity: blocker — Contract question: C4 / A3.**

   **Objection:** A distinct persistent measurement concept is justified, but
   the specification is dishonest about the architectural work required to
   introduce it. ADR 0016's accepted built-in list contains Label and
   Dimension but no Measurement (`docs/adr/0016-canonical-entity-model.md:71-95`),
   the explanatory data model says the same (`docs/DATA-MODEL.md:38-41`), and
   the current strict Rust admission surface has no measurement geometry
   (`entity_model.rs:20-159`, `:1072-1122`). ADR 0016 requires migrations for
   every built-in identifier and admission-matrix extension for new roles
   (`docs/adr/0016-canonical-entity-model.md:295-305`). MI-D2 merely says “new
   canonical `hcad.measurement@1`,” and the delta reduces the obligation to
   “schema” (`measure-inspect.md:472-475`, `:531-533`). That is not an honest
   implementation boundary.

   Reusing `hcad.dimension@1` would also be wrong as currently modeled: it is
   construction annotation with a placement and style, and it has no Point or
   planar-Area kind (`entity_model.rs:1038-1070`). `hcad.label@1` is still less
   suitable: it stores text and a leader, not an auditable derived result.
   Adding a casual “inspection role” to either would make the strict semantic
   admission lie and would breach DR-D9's dimension/measurement boundary.

   **Proposed resolution:** Derived decision, vetoable: keep the distinct
   `hcad.measurement@1` type, but make the architecture obligation explicit:
   add an accepted ADR that extends/supersedes ADR 0016 for this built-in;
   amend `DATA-MODEL.md`; define `MeasurementGeometry`, kinds, anchors, plane,
   verification status and result-cache semantics; extend strict semantic
   admission; register type/schema migration; generate TypeScript and SDK
   contracts; define old-reader preservation; update `.hcad`/`.hcadx` schema
   coverage; and add read-only sibling-app handling. Reject Dimension/Label
   role reuse for the semantic reasons above. X1, X3/P1, ADR 0016's own
   follow-up 3, and DR-D9 decide this without escalation.

3. **Severity: blocker — Contract question: C1 / C4.**

   **Objection:** I drove the requested chain keystroke by keystroke. A click
   or endpoint drag on the locked box records an exact associative geometry
   target. Typing X/Y/Z and pressing Enter is then promised to place “the same
   kind of anchor as a click” (`measure-inspect.md:63-70`). But the canonical
   contract later says a typed endpoint is a fixed `Position`, while a picked
   endpoint is entity/revision/primitive/source provenance
   (`measure-inspect.md:320-327`). Those are not the same artifact. Move or
   re-sync the facade: the clicked endpoint follows or becomes unresolved;
   the typed endpoint silently remains in world space. Calling those paths
   equivalent is a data-integrity defect.

   **Proposed resolution:** Derived decision, vetoable: make binding explicit
   in the input bar and panel. **Fixed coordinate** accepts absolute XYZ and
   relative distance/direction/height and stores `Position`. **Attached to
   source** stores the exact target; its source selector/pick is the direct
   manipulation, and any typeable source parameter/offset is its numeric twin.
   Typing a coordinate never guesses an entity binding. Editing attached XYZ
   requires an explicit **Detach to fixed coordinate** action, while replacing
   the source is **Pick source**. The row/readout must name Fixed versus the
   attached entity/primitive before commit. Update the locked-box automation
   and UI gate to assert both geometric equality at creation and deliberately
   different revalidation behavior afterward. X1 and the “never invent domain
   truth” rule decide this.

4. **Severity: major — Contract question: B2 / A1.**

   **Objection:** The primary workflow starts Distance with **Chain on** and
   keeps accepting later points (`measure-inspect.md:59-75`). B2 says every
   two-point Distance “auto-commit[s] when complete”
   (`measure-inspect.md:166-168`). My second click therefore either commits
   Distance 1 and prevents the third point, or violates B2. This is exactly the
   sort of end-path ambiguity that loses field work.

   **Proposed resolution:** When Chain is off, Distance auto-commits after the
   second valid anchor. When Chain is on, the second point completes segment 1
   but does not commit; Enter, valid tool-end Escape, ribbon toggle, or Finish
   commits the whole valid chain once; explicit Cancel discards it; Backspace
   removes the latest pending anchor. State this in B2 and test the exact
   click/type/Backspace/Finish sequence.

5. **Severity: major — Contract question: E2 / C4.**

   **Objection:** The passive-consumer table is not complete despite claiming
   it is. It names an entity tree generically, `.hcadx`, a report, and recovery
   (`measure-inspect.md:329-341`) but never settles the consumers a surveyor
   uses to control and deliver the artifact:
   - Draw's layer decision applies exactly-one-layer semantics to every entity
     (`draw.md:639-661`), yet a measurement has no creation layer, own-layer
     hide/lock/edit rule, or draw order.
   - Snapshot restore rolls back every canonical entity and project setting
     except snapshot entities (`file-project.md:178-190`), but the spec never
     says how measurements and restored source revisions revalidate together.
   - Bookmarks capture canonical visibility by entity reference and restore it
     as a journaled step (`view-domain.md:139-170`, VD-D3/VD-D4), but the spec
     never says whether a measurement eye is captured, or that anchors/values
     and panel state are not.
   - “Export/report” does not distinguish `.hcadx`, measurement CSV, ordinary
     CAD/model exports, screenshots, or plan/viewer output. Saying clips do not
     filter CSV is only one cell of that matrix.
   - WeltView and other strict readers are absent even though a new built-in
     type would otherwise fail admission or disappear from a delivered
     project.

   **Proposed resolution:** Add explicit rows. Each measurement belongs to one
   layer (captured at tool start, Default if omitted); its overlay is visible
   only when its own eye, its layer, and all anchor-source visibility tests
   pass; a locked measurement layer rejects anchor edits but remains readable.
   Snapshot restore includes measurement create/delete/revision/visibility and
   revalidates against the fully restored source state in the same published
   generation. Bookmarks capture only canonical measurement visibility by ID,
   never geometry/value/panel filters. `.hcadx` is lossless; CSV is explicit;
   ordinary geometry exports exclude inspection overlays unless their writer
   declares support; screenshots/plan viewports include visible overlays by an
   explicit option. WeltView gets read-only render/list/inspect support in the
   same tranche. Add restore/bookmark/export/sibling tests.

6. **Severity: major — Contract question: E2 / A3.**

   **Objection:** Endpoint editing is specified as a special handle-origin LMB
   drag (`measure-inspect.md:77-80`, `:359-372`), while selecting the
   measurement also selects a canonical entity (`:337`). The registry assigns
   whole-entity transforms and the platform gizmo to the owed select-edit
   domain (`REGISTRY.md:590-596`). The target never says which system wins when
   “West facade access run” is selected and **Edit anchors** is armed. I can
   plausibly drag an endpoint, orbit, or move the whole entity depending on
   which hit tester runs first. Panel close disarming measurement handles does
   not disarm the select-edit gizmo.

   **Proposed resolution:** Derived decision, vetoable: measurements are
   non-transformable entities. Move/rotate/scale context commands and the
   whole-entity gizmo are absent for `hcad.measurement@1`, because transforming
   a measurement independently of its sources falsifies the claim. Selection
   alone shows properties and overlay highlight. **Edit anchors/Edit plane**
   arms the single measurement tool, suppresses select-edit handles, and gives
   handle-origin drag exclusively to MI-D6; closing/exiting removes every
   measurement hit zone. Register this exclusion in the select-edit obligation
   and add overlap/hit-priority tests. X1 and the one-armed-tool rule decide it.

7. **Severity: major — Contract question: A2 (code evidence).**

   **Objection:** The “partial today” row claims exact candidates and positions
   already exist (`measure-inspect.md:35`), and the implementation delta again
   calls the current world candidate exact (`:522-524`). The cited controller
   only republishes whatever the viewer returns
   (`KernelNavigationController.ts:483-540`). At the Rust boundary, an unowned
   coarse hit is deliberately retained (`picking.rs:253-291`), and the coarse
   reconstruction is explicitly on the rendered depth surface pending a
   provider replacement (`picking.rs:294-298`). Worse, the TypeScript facade
   labels every candidate “Exact canonical Source coordinate”
   (`WgpuKernelViewer.ts:1077-1087`) while Builder hardcodes every candidate's
   source to `point-cloud` and synthesizes confidence from pixel distance
   (`BuilderKernelViewport.tsx:1297-1307`). That is not exact provenance.

   **Proposed resolution:** Rewrite the status to: candidate cycling and
   coordinate callbacks exist, but exactness, source classification,
   provenance, P4 admission, and core revalidation do not. Treat the
   TypeScript “exact” comment as a contract bug: carry an explicit
   exact/refined flag plus provider/source identity from Rust, never mark
   retained coarse hits exact, and forbid measurement commit until core
   revalidation returns an exact target. Add a gate where an unowned coarse
   hit cannot commit. The existing code is useful substrate, not shipped
   measurement truth.

8. **Severity: major — Contract question: A1 / E2.**

   **Objection:** The facade design reports residual ticks and Max offset and
   defines a warning threshold (`measure-inspect.md:87-106`), but it never says
   what the tool does after the threshold is exceeded. Finish appears to commit
   normally. “Cannot masquerade” is not a behavior: a bowed facade, a bad
   three-point plane, and one gross outlier all become the same ordinary Area
   row and CSV value. Max offset alone also does not distinguish distributed
   warp from one bad point.

   **Proposed resolution:** Plane projection remains mathematically valid at
   any residual, so do not pretend the result is surface area and do not
   silently refuse it. Below threshold, status is **Verified projected**.
   Above threshold, Finish opens a blocking choice with max offset, RMS offset,
   count/percentage beyond tolerance, and the threshold: **Edit plane** or
   **Save projected result with warning**. The accepted warning, residual
   statistics, tolerance, and plane revision are canonical and appear in the
   panel and CSV; later edits recompute the status. A single gross outlier is
   highlighted and reachable. This follows X1; the threshold remains tunable
   under X6.

9. **Severity: major — Contract question: A3.**

   **Objection:** The target says it cites siblings without re-dispositioning,
   but Draw still states “the dimension tool is the persistent sibling of the
   transient measurement” (`draw.md:362-365`). MI-D2 makes every valid
   measurement persistent from first commit. The target cites DR-D9 but never
   revises Draw's actual lifecycle claim. Two current specs now give the same
   capability opposite persistence semantics.

   **Proposed resolution:** Amend Draw A3 in the Draw-owned file to say both
   are canonical and associative, with different semantic/UI contracts:
   Dimension is construction annotation with dimension graphics/style and a
   derived value; Measurement is an inspection artifact with provenance,
   verification status, panel/report lifecycle, and no construction-annotation
   role. Cite MI-D2 from Draw and record the cross-spec disposition in both
   files. This is the README cite-and-revise rule, not an owner decision.

10. **Severity: major — Contract question: catalog / A2.**

    **Objection:** §1.1 says it is “not owned here,” then assigns IDs, intended
    outcomes, tab, surface, performance, and future commands to cloud-to-cloud
    and point-density functions (`measure-inspect.md:43-53`). That is a catalog
    disposition. PC-D10 owns the class; its prose already queues Twin Surface,
    while its registry rows remain only surface-to-model and floor flatness
    (`pointcloud.md:552-567`, PC-D10). More seriously, the dossier documents
    low-density **error messaging inside 3D inspection**, not a standalone
    point-density tool (`realworks.md:109-120`), which the target itself admits.
    A disclaimer does not make a second spec's invented row evidence-based.

    **Proposed resolution:** Remove the foreign IDs/table from this spec. Revise
    Pointcloud itself to add the dossier-backed Twin Surface/cloud-to-cloud and
    wall-verticality rows under PC-D10. Reject a standalone point-density row
    for now, or first extend the dossier with evidence and then specify a
    deliberate Himmel:CAD extension in the Pointcloud owner. Keep only a
    boundary sentence here that measurement reports may later consume
    Pointcloud-owned inspection results.

11. **Severity: major — Contract question: A2 / catalog.**

    **Objection:** The spec repeatedly says native TDX export is rejected “by
    import-formats IF-D10” (`measure-inspect.md:130`, `:149-152`, `:223-225`,
    MI-D8). IF-D10's owned row rejects opaque proprietary **imports** and only
    says to reopen when a documented format or compatible decoder exists
    (`import-formats.md:73-75`, IF-D10 at `:556-559`). It does not disposition a
    TDX measurement writer. The desired conclusion is defensible, but the cited
    owner has not made it; this is another cite-without-revise violation.

    **Proposed resolution:** Amend IF-D10 at its source to bind opaque
    proprietary codecs in both directions: no importer or writer ships without
    a documented format or dependency-policy-compatible decoder/encoder and a
    fidelity corpus. Add the Perspective TDX measurement-export row to that
    spec's format dispositions and reject it today. Then MI-D8 may cite the
    generalized record and state that open CSV plus `.hcadx` provide the
    supported outcomes. X1 and dependency policy derive this; no owner call.

12. **Severity: major — Contract question: A1 / E3.**

    **Objection:** “UTF-8 CSV” is not a report contract. The spec does not define
    delimiter/decimal rules, header/version, row granularity, coordinate and
    angle units, unknown-Z encoding, quoting/newlines, or how one Point, a
    10,000-anchor chain, an Area plane/boundary/residuals, and an unresolved
    measurement fit the same table (`measure-inspect.md:219-225`, MI-D8,
    G-MI-REPORT). A test can stream 100,000 unspecified rows and still produce a
    useless or locale-corrupted deliverable.

    **Proposed resolution:** Version the writer and commit a column schema.
    Recommendation: one RFC-4180 UTF-8 long table with `schema_version` and
    `record_type` (`measurement`, `segment`, `anchor`), stable IDs/revision,
    kind/metric/status, row indexes, canonical numeric values with `.` decimal,
    explicit unit columns, nullable Z as empty plus `z_known`, source entity /
    primitive / revision fields, plane basis, residual statistics/tolerance,
    creation view, and warning acceptance. Repeat measurement identity on child
    rows. Offer an Excel-friendly locale preset only as an explicitly named
    alternative. Add golden-file round-trip and spreadsheet-open checks for all
    kinds, commas/quotes/newlines, large coordinates, unknown Z, warnings and
    unresolved rows.

13. **Severity: major — Contract question: E3 / E2.**

    **Objection:** The verification plan calls for “planar shoelace
    area/perimeter” (`measure-inspect.md:408-412`) but never requires projection
    into a local plane frame or numerically stable accumulation. Survey
    coordinates can be millions of metres while the facade is ten metres wide;
    applying shoelace directly to large world coordinates loses meaningful
    digits through cancellation. The extreme-member analysis covers anchor
    count and cloud size, not coordinate magnitude or near-degenerate projected
    edges.

    **Proposed resolution:** Define the calculation in a right-handed local
    orthonormal basis rooted at the explicit plane origin; project f64 anchors
    after subtracting that origin; use compensated/pairwise accumulation;
    normalize winding; and define scale-aware tolerances for duplicate adjacent
    points, near-zero edges, closure, and intersection. Extend
    G-MI-UNIT-MATH/G-MI-AREA-FACADE with the same polygon translated to local,
    kilometre and national-grid-scale origins, reversed winding, almost
    collinear points, and 10,000 vertices; all must agree within the recorded
    project-unit tolerance.

14. **Severity: minor — Contract question: A2.**

    **Objection:** Angle is retained from today's placeholder, but neither cited
    measurement dossier supplies its behavior. Perspective's documented five
    types do not include angle (`trimble-perspective.md` §2.6), and RealWorks
    §2.6 documents coordinates, distance and projected clearance, not angle.
    The target quietly chooses the smaller 3-point angle without stating
    whether it is spatial, horizontal/projected, or a deliberate unsupported-by-
    reference extension (`measure-inspect.md:109-114`).

    **Proposed resolution:** State the dossier-wide absence honestly and ground
    retention on the existing Builder ribbon placeholder as product intent, not
    reference behavior. Define **Spatial** and **Horizontal** angle modes (or
    ship Spatial only and record Horizontal deferred), smaller angle by default,
    signed/reflex absent with reason, and project gon/degree formatting. Add
    non-coplanar-ray and unknown-Z tests.

## Contract questions answered convincingly

**B3** (viewport tool + right panel + existing export island are proportionate),
**C3** (no redundant measurement lock; committed source revisions are the
cache invariant), **D1** (continuous/bounded/long classifications and runnable
latency gates), **D2** (degradation preserves correctness), and **E1** (the
in-repo written visual criteria are concrete enough to fail against). The
other questions are either directly implicated above or depend on a missing
cross-spec/data-model resolution; they are not padded into this list.

## Executed vs. read

**Executed:** static repository inspection only: `rg`, `sed`, `nl`, `wc`, and
`git status` to locate and read the governing documents, check registry/cross-
spec claims, enumerate target file:line citations, and inspect each cited code
range. I verified that the Inspect buttons are placeholders; the Builder
command switch has no measurement report command; the current canonical
geometry/type lists have Dimension but no Measurement; the cursor callbacks
exist; the raster-depth helper exists; and the Rust pick path can retain
coarse rendered-depth candidates.

**Read:** `.claude/agents/demanding-user.md`; `docs/CURRENT-DIRECTION.md`;
`docs/README.md`; the current function contract, decision doctrine, design
system, active agent feedback, Builder-program README, owner decisions and
registry; the full target; accepted ADR 0016 and `docs/DATA-MODEL.md`; the
gold-standard viewing-box spec; the requested View, Draw, Pointcloud,
UI-platform and View-domain sibling sections/decision records; the full
Trimble Perspective and RealWorks dossiers (with every target A2 claim checked
against the dossier text); the relevant RIB Civil and import-formats evidence;
and the viewing-box, Draw, and View-domain prior demanding-user reviews.

**Not executed:** builds, the Builder application, tests, benchmarks, visual
screenshots, or web research. This was the requested static review; no runtime
or performance claim was accepted as observed behavior.

## Owner-decision items

**None (target count zero).** Every resolution above survives the escalation
audit without an owner question. The consequential decisions are reported as
vetoable derived decisions: keep a distinct Measurement built-in but complete
the ADR/admission/migration work (X1 + X3/P1 + ADR 0016); make typed binding
explicit and never infer associativity (X1); make measurements
non-transformable and give armed anchor editing exclusive handle ownership
(X1 + platform one-tool rule); retain projected area above tolerance only with
an explicit warning acceptance (X1/X6); and reject opaque TDX writing until a
documented encoder exists (X1 + dependency policy). No axiom conflict,
reserved product identity/scope boundary, money, or licensing choice remains.

## System feedback

No contract question or doctrine axiom failed to do its job. A2's evidence and
code-claim rules caught the false “exact today” claim and the TDX/point-density
overreach; A3 plus the registry cite-and-revise rule caught the unlanded View,
Draw and Pointcloud ownership changes; C1 exposed the typed/snap binding split;
C4 exposed the missing ADR/migration contract; and E2 exposed snapshots,
bookmarks, layers, sibling readers and gizmo arbitration. X1, X3, X6 and P4
derive the resolutions. The failure mode is compliance: the target names the
current rules in its header but does not carry them through the registry,
accepted data model, or passive-consumer matrix.
