# Demanding-user review — Plan editor specification (2026-09-02)

Document class: report/verification evidence.

Static adversarial review against the CURRENT function contract and decision
doctrine. Verdict: **not ready for owner review or implementation**. Headline:
**5 blockers, 7 major findings, 2 minor findings, 0 ideas**. The workflow prose
is unusually good, but the core civil deliverable is still capable of carrying
the wrong scale or north direction, and the proposed capture, restore, native-
window, automation, and vendored-runtime contracts are not closed.

1.  **Severity: blocker. Contract question: C1 / E2.**

    **Objection:** I created the advertised A1 sheet, typed 1:250, rotated the
    plan frame, and inserted the north arrow. The specification gives me only
    the worked assertion “25 m measures 100 mm”
    (`plan-editor.md:109-114`). It never defines the transform that makes this
    true for the project's configured length unit, the bookmark's orthographic
    plane, the viewport crop, or a rotated view. The implementation evidence is
    narrower than the prose: `paper.ts:109-115` converts **world metres** to
    paper millimetres, while project units are project settings
    (`file-project.md:430-433`). The one `rotation` field is not identified as
    frame rotation, model-within-frame rotation, clockwise/counter-clockwise, or
    its zero direction. Worse, RIB W7 explicitly decorates a rotated plan with a
    north arrow (`rib-civil.md:261-267`), but the Plan spec never binds the arrow
    to grid/true/project north. Today's north-arrow template is a static group
    with no binding (`templates.ts:161-179`). A beautiful 1:250 PDF with a wrong
    north arrow is a false civil deliverable.

    **Proposed resolution:** **Derived decision (vetoable):** define one
    `PlanViewportTransform` contract from X1, the project-format ban on invented
    units/transforms, file-project's project-unit ownership, and RIB W7. It must
    carry the source orthographic basis, authoritative linear-unit-to-metre
    factor, crop center/extents, paper rectangle, scale denominator, and one
    named clockwise paper rotation. The invariant is
    `paper_mm = project_length * mm_per_project_unit / denominator`. Geographic
    or otherwise non-linear coordinates cannot claim `1:n` until an explicit
    projected working plane and its authoritative scale basis exist; otherwise
    the viewport is NTS with an actionable explanation. Define north-reference
    binding (`gridNorth`, `trueNorth`, or a project-defined north only), obtain
    meridian convergence from the authoritative CRS pipeline when required, and
    show **Unresolved north** plus block clean output if the chosen truth is not
    available. A north arrow references a specific viewport, and its paper angle
    is derived from that viewport transform; it is never a freely rotated
    decorative claim. Add metre and non-metre fixtures, 0/90-degree rotations,
    large surveyed coordinates, scale-bar checks, and printed/PDF measurements
    to G-PE-UNIT and G-PE-REAL-EXPORT.

2.  **Severity: blocker. Contract question: C4 / E2.**

    **Objection:** I made a snapshot, changed three sheets, refreshed a linked
    viewport, pinned it, then restored the snapshot. The spec does not tell me
    which sheets or captures come back. File-project currently says restore
    affects every canonical entity and project setting except snapshot entities
    (`file-project.md:178-190`, FP-D4 at `:814-835`). Plan deliberately says its
    paper records are **not** canonical model entities, but are a journaled
    product-data root (`plan-editor.md:432-441`). That leaves the entire Plan
    root outside the sibling's stated affected-state set. Within Plan, artifact
    references are called journal state (`plan-editor.md:339-342`), yet linked
    captures are also called rebuildable caches (`:485-490`), and a refresh
    completion is never classified as an undo step or a derived-cache
    publication. The statement that pinned objects remain reachable “until
    unpin/removal” is also wrong for an append-only journal: an older undo state
    or snapshot can still reach them. As written, restore can leave the sheet
    from generation A displaying or retaining generation B's capture, or garbage
    collection can destroy the artifact needed to undo an unpin.

    **Proposed resolution:** **Derived decision (vetoable):** revise PE-D2,
    PE-D3, PE-D5, PE-D7, Plan C4, and FP-D4 together. A project snapshot restores
    every journaled project root, including versioned product-data roots such as
    Plan, while snapshot entities remain the sole journal-state exemption.
    Sheet/element/template/filter/binding/schedule changes and pin/unpin are
    ordinary journaled, undoable Plan commands. A linked viewport's stale flag,
    pending job, and last-good rebuildable cache lookup are derived state;
    successful linked refresh does **not** add a user-visible Ctrl+Z step. Pin is
    the single journaled act that promotes the exact source tuple and verified
    hashes into the Plan root. Unpin/removal removes only the current-root edge;
    object collection still honours the full journal, undo/redo, snapshot
    markers, active export leases, and any other project references. Restoring a
    snapshot restores the old Plan root and its pinned hashes exactly, then
    re-evaluates linked viewports against the restored generation. Add tests for
    sheet rollback, pinned and linked rollback, restore-then-undo, async refresh
    racing restore, and GC after pin/unpin with an older snapshot.

3.  **Severity: blocker. Contract question: E2 / E1.**

    **Objection:** The main narrative promises “vector CAD/BIM output over a
    raster point-cloud underlay” (`plan-editor.md:105-111`) and PE-D7 promises a
    pass-complete vector/raster capture. There is no evidence-backed capture
    contract underneath that sentence. The only adapter is explicitly a mock
    and returns zero vector elements (`viewport.ts:117-129`). The current SVG
    writer iterates only `sheet.scene.elements` (`export.ts:120-148`), and the PDF
    writer does the same (`export.ts:269-335`); neither consumes
    `sheet.viewports`, `vectorSceneHash`, or raster capture bytes. More
    importantly, splitting “vector above raster” changes depth and transparency:
    a CAD line behind a wall, mesh, raster, cloud, or splat can be brought to the
    front merely because it was vectorized. The E2 table names broad passes but
    never defines vector eligibility, pass ordering, masks/clip boundaries,
    hidden-line behavior, transparency, or the least-typical mesh/splat members.
    “Where supported” is not a disposition and cannot fail a fidelity check.

    **Proposed resolution:** **Derived decision (vetoable):** PE-D7 gains a
    versioned capture-artifact contract produced by the canonical renderer, not
    an Excalidraw-shaped wish. Disposition every render class: authored analytic
    CAD curves, text, and derived dimensions may remain vector only where the
    renderer can preserve their resolved style, clip, ordering, and occlusion;
    point clouds, splats, source rasters, shaded meshes, and filled 3D/BIM passes
    are raster unless a real deterministic vector/hidden-line extractor exists.
    If mixed depth cannot be represented exactly, rasterize the affected
    composited partition rather than lie about vector fidelity. The artifact
    records ordered layers/partitions, paper transform, clip/mask data, color and
    alpha space, source revisions, and hashes. SVG/PDF must actually embed those
    resources, and preflight/fidelity JSON must name every raster fallback.
    Extend the passive-consumer matrix and G-PE-REAL-EXPORT across point, splat,
    raster, mesh, CAD curve/text/dimension, BIM object, empty view, transparency,
    and deliberately overlapping geometry. The billion-point mixed scene is the
    largest member; an empty filtered viewport is the least.

4.  **Severity: blocker. Contract question: catalog / A3.**

    **Objection:** This document calls itself specified, but the program's
    cross-check artifact still has no Plan rows. `REGISTRY.md:539-548` still
    describes Plan as a pending domain with five inherited obligations. The spec
    itself admits that the Plan owner “must trigger cite-and-revise updates”
    (`plan-editor.md:323-326`) instead of doing so. The siblings still queue the
    now-claimed work: VD-D12 still queues view-template include/exclude/locking
    (`view-domain.md:824-835`), BS-D15 still queues the view-filter/template
    analog (`bim-specs.md:749-758`), and UIP-D14 still names Plan as a persistent
    **island** (`ui-platform.md:769-787`). UIP-D9's reset/bounds class is likewise
    not revised for a second OS window. The program README explicitly requires
    registry rows at specification time and says one spec may not re-disposition
    another owner's capability. A promise to reconcile later fails that rule.

    **Proposed resolution:** **Derived decision (vetoable):** this spec remains
    pending until the cite-and-revise transaction lands on every side. Add its
    twelve catalog rows to REGISTRY, remove/replace the §5.3 pending obligations,
    and rerun duplicate-act, surface, state, gesture, shortcut, job, and command-
    family checks. Amend VD-D12 and BS-D15 to cite PE-D6 as the owning fulfilled
    disposition; amend UIP-D14 from “Plan island” to the dedicated workspace-
    window class while preserving “Escape never closes it”; amend UIP-D9's
    bounds/reset set for the Plan window; and amend file-project's restore and
    close lifecycle as findings 2 and 7 require. The registry owns the final
    distinction between File's canonical-model `export.plan` and Plan's
    composed-sheet `plan.export.*`. Only then may the target status say
    “specified”.

5.  **Severity: blocker. Contract question: E2 (dependency and licensing
    boundary).**

    **Objection:** Plan's runtime is maintained vendored Excalidraw source, not
    merely an npm call (`HCAD_FORK.md:28-32`, `:42-58`). Yet Excalidraw does not
    appear in `LICENSES/THIRD_PARTY.md:10-48`, which says it inventories
    load-bearing vendored/runtime inputs. The specification also requires two
    changes that may cross the fork boundary without saying so: replacing
    Excalidraw's undo/redo authority with the shared journal even though the
    maintained fork currently routes undo/redo through Excalidraw
    (`HCAD_FORK.md:45-48`), and bundling deterministic font metrics/resources
    (`plan-editor.md:205-213`, PE-D11). The fork contains several font families,
    but the spec names neither the shipped set nor its license/attribution and
    glyph-fallback closure. This violates the dependency workflow before any new
    feature code is written; licensing is an X1 boundary, not cleanup.

    **Proposed resolution:** **Derived decision (vetoable):** no new dependency
    is authorized. First audit exact Excalidraw v0.18.0, its shipped runtime
    closure, and every packaged font; add exact entries, provenance,
    redistribution requirements, and notices to `LICENSES/THIRD_PARTY.md`.
    Determine the shared-undo seam before implementation: prefer a host-level
    transaction/history adapter if the public fork API can prevent a second
    authority; otherwise make the smallest explicit fork change and record the
    changed files/date/behavior in `HCAD_FORK.md`. Update that document's “Plan
    island” host description to the dedicated window and reconcile its scene-
    authority wording with PE-D3. Name the allowed deterministic output fonts,
    fallback/subsetting policy, and licenses. Vendored-code, font-inventory, and
    notice packaging checks are release gates under TEST-TIERS.

6.  **Severity: major. Contract question: D1 / E3.**

    **Objection:** I selected a 500-million-point project and pressed Refresh.
    The spec says only “long and cancellable”, while its real-data gate asserts
    content but no elapsed time, time-to-first-progress, memory ceiling, or
    cancellation latency (`plan-editor.md:344-368`, `:620-626`). The user remains
    on a stale image, which is correct, but has no answer to “minutes or lunch
    break?” and no gate proving P5 kept the capture off the interaction path.
    “Sheet/byte phases” is not useful progress for renderer traversal unless the
    bounded units and total are defined.

    **Proposed resolution:** **Derived decision (vetoable, X6 calibration):** add
    a `G-PE-CAPTURE-500M` gate on a prepared 500M-point mixed project and an A1
    240 × 160 mm viewport at 300 dpi. Initial tunable budgets: enqueue without a
    main/Plan-window task longer than 50 ms; job row and first real phase within
    250 ms; cancel acknowledged within 250 ms and terminal/no-publication within
    2 s outside the short atomic swap; warm full-resolution capture p95 at most
    10 s on the interaction tier and 30 s on the weak tier. Report measured
    point-node/tile/pass units, raster tiles, vector primitives, bytes, elapsed
    time, peak resident memory, cache status, and cancellation checkpoints; do
    not fabricate a percentage when a total is unavailable. A regression beyond
    budget fails until the X6 value is deliberately recalibrated with evidence.
    G-PE-CANVAS simultaneously asserts unchanged presented-frame cadence while
    the capture runs.

7.  **Severity: major. Contract question: B2 / B3 / E2 / A3.**

    **Objection:** The dedicated window is specified as a noun, not an OS
    lifecycle. There is no parent/project lease, multi-monitor placement,
    off-screen recovery after monitor removal, DPI-change behavior, bounds/reset
    ownership, minimize/focus behavior, native-versus-themed title chrome, or
    renderer-crash recovery. “Project replacement closes the window after safe
    job cancellation” (`plan-editor.md:270-275`) and PE-D14's unconditional
    “project close cancels” (`:556-565`) contradict file-project's owner
    lifecycle: project switch/app quit with export or other long work prompts
    once for **Wait** or **Cancel and proceed**, while automation close is
    rejected (`file-project.md:742-746`). Closing only the Plan window is
    correctly backgroundable; closing the owning project is not the same act.

    **Proposed resolution:** **Derived decision (vetoable):** Electron main owns
    exactly one Plan `BrowserWindow` for the active project generation. File's
    toggle creates/focuses/closes it; title chrome and all product-owned content
    use shared tokens and accessibility semantics, with native controls only
    where the design system permits OS ownership. UIP-D9 persists its bounds,
    DPI-aware size, and display identity; opening clamps the header and a usable
    1280 × 720 surface into a current display work area, and a missing monitor
    rehomes it to the primary display. Closing the Plan window cancels only local
    gestures and backgrounds registered jobs. Project switch/quit adopts the
    file-project one-prompt Wait/Cancel rule; automation gets the same named
    rejection. Project-generation invalidation prevents every late worker result
    from publishing, then closes the window. Renderer reload restores the
    committed Plan root and UIP-D10 job mirror. Cover focus, bounds reset,
    monitor unplug/replug, scale-factor change, crash/remount, main-window close,
    and a Plan window already open on another monitor.

8.  **Severity: major. Contract question: B1 / E2.**

    **Objection:** The one-line automation chain is welcome, but “same
    validation, undo, staleness, job, and fidelity behavior”
    (`plan-editor.md:223-227`) is not a grant contract. The catalog does not say
    which calls require project read, project write, scoped filesystem access,
    or external-publication approval. It mentions approval only for physical
    print, although `.hcplan` exchange, library import/export, PDF/SVG export,
    and writes to a chosen path are externally visible too. It also omits CAS
    parameters/results, job handles/cancel, approval denial, and whether
    `plan.window.open` is meaningful to a headless client. ADR 0024 forbids
    capability inheritance across project/process boundaries and requires
    approval for externally visible actions.

    **Proposed resolution:** **Derived decision (vetoable):** add a per-command
    grant/result matrix. `*.list/get/describe` require the active project read
    grant; Plan mutations require project write plus `expectedPlanRevision` and
    return committed revision/undo label; capture/refresh require project read
    and return a UIP-D10 job handle; import/export/library file operations
    require a path-scoped filesystem capability and external-publication
    approval; printer submission requires an explicit device action approval
    and cannot run unattended. `plan.export.describe` is pure and needs no path;
    `run` consumes an approved destination and frozen description token.
    `plan.window.*` is an optional UI-session action, not a prerequisite for the
    headless workflow. Tests cover create-sheet → bookmark-backed viewport →
    refresh → export, stale CAS, revoked project, denied approval, expired path
    grant, cancel, renderer absent, and SDK schema staleness.

9.  **Severity: major. Contract question: B1 / A2 / A3.**

    **Objection:** The dossier disposition says RIB's dynamic dimensions are
    adopted through an ownership split (`plan-editor.md:68`), but in the Plan
    workflow I can only see dimensions that already exist in model space. Plan
    picking explicitly never reaches model entities inside a viewport
    (`plan-editor.md:350-357`), and the fork boundary says dimensions/point labels
    stay in the 3D view (`HCAD_FORK.md:13`). There is no visible Plan-window path
    to create or edit the dimension chains that RIB W7 uses while decorating the
    sheet. Drawing an Excalidraw arrow and typing “25.00 m” would bypass DR-D9's
    derived-only truth and manufacture a dangerous fake dimension.

    **Proposed resolution:** **Derived decision (vetoable):** DR-D9 remains the
    sole owner of measurement dimensions. Add a visible Plan access path,
    **Model dimension…**, for a selected linked orthographic viewport. It invokes
    `draw.dimension.create`/edit with the same associative anchors, chain mode,
    snap precision, and derived value; Plan stores no independent measurement
    value and only renders the resulting canonical dimension on refresh. The
    preferred workflow temporarily enables model picking in the selected real
    viewport and therefore must add its LMB/RMB/Tab/Escape/typing claims to the
    gesture table and cite-revise Draw. A safe fallback focuses the main Builder
    viewport at the referenced bookmark and returns to Plan after commit. Pinned,
    NTS, cached-only, or source-missing viewports explain why model dimensioning
    is unavailable and offer Unpin/Relink; they never measure pixels. Ordinary
    paper arrows/text are labelled **Annotation**, not Dimension.

10. **Severity: major. Contract question: C4 / E2.**

    **Objection:** `.hcplan` is changed from authority to exchange, but its new
    physical format is not specified. PE-D13 says it serializes the root “plus
    referenced portable objects” (`plan-editor.md:546-553`). Those objects now
    include embedded images, template bodies, schedules, and possibly large
    pinned raster captures, while the current v2 `.hcplan` is one JSON document
    parsed in memory (`document.ts:393-449`; the browser UI reads `file.text()` at
    `PlanIsland.tsx:520-535`). There is no container layout, magic/version,
    bounded reader, size/count policy, path safety, cross-project bookmark
    handling, or collision identity. A multi-gigabyte “portable JSON” is not a
    viable exchange contract.

    **Proposed resolution:** **Derived decision (vetoable):** define `.hcplan`
    next as a streaming portable package: a versioned manifest/root plus
    `objects/<sha256>` entries, safe normalized paths, declared byte lengths and
    media types, complete hash/reference validation, and no trusted external
    paths. Continue reading legacy v1/v2 JSON through explicit migrations. Export
    snapshots the source root, streams only portable reachable objects, reports
    size/category before writing, and uses sibling-candidate atomic replacement.
    Import enforces tunable entry/count/expanded-byte limits, stages and verifies
    every object, resolves project/sheet/template/bookmark collisions in the
    existing preview, and commits one Plan-root replacement last. A bookmark
    from another project is either imported/materialized through the View owner
    with explicit identity mapping or remains visibly unresolved; it is never
    rebound by matching a name. Cancel/failure publishes neither objects nor
    root. Add malicious-path, zip-bomb/oversize, missing/hash-mismatch,
    legacy-migration, cross-project, and multi-gigabyte streaming fixtures.

11. **Severity: major. Contract question: C4 / E2.**

        **Objection:** The linked/pinned source state is internally ambiguous. PE-D4
        says every viewport stores a bookmark id **and revision**
        (`plan-editor.md:453-462`), while PE-D5 says linked viewports watch changes
        and pin freezes the revision (`:464-472`). The schema does not distinguish
        the linked target from the last resolved revision or the pinned revision.
        The invalidation list omits some dependencies (rule-predicate attributes,
        specification membership, view-template revision, project-unit/CRS changes,
        and renderer/capture-contract version). Deleting the source bookmark has no
        lifecycle even though deletion of a layer and schedule is covered. I cannot
        tell whether Refresh follows the latest bookmark, recreates the old one, or
        silently keeps an orphaned picture.

        **Proposed resolution:** **Derived decision (vetoable):** specify one state
        machine with fields at least `sourceBookmarkId`, `updatePolicy`,
        `lastResolvedSource` (project generation, bookmark revision, ViewState/schema
        version, filter/template/display/unit revisions), `lastGoodArtifacts`,
        `pendingJobId`, and derived status `clean | stale | refreshing | error |

    sourceMissing`. Linked means resolve the current revision of the stable
    bookmark id; pinned means use the frozen full tuple and retained hashes.
    Rename alone does not stale; recapture, relevant entity/attribute/spec/layer/
    clip/display/unit changes do. Source deletion keeps the last good picture
    with **Source missing**, disables Refresh, and offers Relink/Remove; it never
    invents a replacement. A stale frame always shows the last-good source
    revision/time and the pending target revision, so a producer knows exactly
    what is on paper. Cover every transition, coalescing, superseded completion,
    pin-during-refresh, snapshot restore, and source deletion in unit/UI tests.

12. **Severity: major. Contract question: E3.**

    **Objection:** G-PE-UI is named “Dedicated-window workflow”, but its proposed
    command extends `test:plan-ui` (`plan-editor.md:608-613`). That script builds
    Vite and drives a headless Chromium page (`builder-plan-e2e.mjs:55-80`); it
    never starts Electron and even disables WebGPU. It cannot observe a second
    `BrowserWindow`, IPC project leases, title-bar close, native focus, monitor
    placement, app quit, or renderer rehydration. Calling that gate proof of a
    dedicated OS window is a false E3 claim.

    **Proposed resolution:** **Derived decision (vetoable):** retain the browser
    gate as `G-PE-CANVAS-UI` for finite-paper/component behavior, and add a real
    Electron integration gate that starts packaged-or-built Builder and inspects
    the native window/IPC lifecycle. It asserts one Plan window, open/focus/toggle
    symmetry, Escape non-close, committed-state remount, job rehydration, project
    generation invalidation, Wait/Cancel close behavior, off-screen bounds
    repair, DPI/display changes, and main-app shutdown on Linux and Windows.
    Native print-dialog interaction may remain a manual physical check, but the
    PDF handoff request and approval boundary are automated below the OS dialog.

13. **Severity: minor. Contract question: A2 / catalog.**

    **Objection:** The dossier-row table says the entire RIB **Rasterbilder** row
    is adopted, but its resolution covers only georeferenced model rasters and
    paper logos (`plan-editor.md:72`). The cited row also contains three-point
    fitting of unreferenced scans (`rib-civil.md:167`), which Plan neither owns
    nor dispositions. “Adopted” therefore hides part of the catalog row.

    **Proposed resolution:** **Derived decision (vetoable):** split the row. Plan
    adopts consumption of already georeferenced model rasters and embedded paper
    images; three-point raster fitting is rejected from this domain and cited to
    the Raster owner's rectification/georeferencing command. Revise that sibling
    only if it has not already claimed the act. This is a catalog accounting fix,
    not new Plan scope.

14. **Severity: minor. Contract question: B1 / C4.**

    **Objection:** The catalog says every path resolves to the “command” in the
    Automation column (`plan-editor.md:19-21`), but the column mixes journaled
    mutations, read-only queries (`*.list`, `describe`), UI-session actions
    (`plan.window.open/close`), job actions, and physical print. If implementers
    follow that sentence literally, opening a window or listing sheets can enter
    the canonical command/undo model that PE-D3 is trying to keep singular.

    **Proposed resolution:** **Derived decision (vetoable):** classify every verb
    in the registry and protocol as canonical command, canonical/read query,
    platform UI action, job action, or approved external action. Multiple access
    paths share the same underlying **command or query** as FUNCTION-CONTRACT B1
    says; only Plan data mutations journal and participate in Ctrl+Z. Reflect the
    classification in generated SDK signatures and the automation grant matrix.

## Contract questions answered convincingly

- **A1** — the four workflow narratives are concrete, user-centred, and cover
  creation through output even though several contracts beneath them fail.
- **B3** — composition genuinely outgrows a panel/island; the dedicated-window
  choice follows owner decision D2 and the function-contract surface class.
- **C2** — Plan selection is window-local, switching sheets clears it, and
  mixed multi-selection adopts UIP-D17 semantics.
- **C3** — viewport pin and assigned-template locking identify useful frozen
  invariants; declining a sheet-wide drawing lock is well reasoned.
- **D2** — degradation correctly sacrifices live/cached preview quality before
  input latency, scale truth, filter correctness, or export fidelity.

All other A1-E3 questions are answered weakly or not answered for at least one
capability group, as mapped in the findings above.

## Executed versus read

**Executed:** read-only repository inspection with `rg`, `sed`, `nl`, `wc`, and
`git status`. These commands located obligations, checked exact line ranges,
searched for stubs/mocks/localStorage and vector-capture consumers, and checked
the third-party inventory. No source, test, build, benchmark, or application
command was executed.

**Read/inspected only:** `.claude/agents/demanding-user.md`;
`docs/CURRENT-DIRECTION.md`; `docs/README.md`; the full current
`FUNCTION-CONTRACT.md`, `DECISION-DOCTRINE.md`, `DESIGN-SYSTEM.md`, and
`AGENT-FEEDBACK.md`; builder-program README, OWNER-DECISIONS, and REGISTRY;
`PROJECT-FORMAT.md`, `DEPENDENCY-POLICY.md`, `TEST-TIERS.md`, and ADR 0024; the
target spec; `PLAN-EDITOR-EXPORT.md`; `HCAD_FORK.md`; RIB Civil §1, §2.3, §2.9,
§2.10 and W7 plus every target-cited Revit section; the complete gold-standard
`viewing-box.md`; the prior view-domain, file-project, and draw review reports;
the cited decisions/flows in view-domain (VD-D3/D12/D13), BIM (BS-D1/D14/D15),
UI platform (UIP-D9/D10/D14/D17), file-project (snapshots/FP-D4/FP-D11/project
close), Draw (DR-D9/E2), and pointcloud PC-D11; relevant source throughout
`packages/@himmelcad/plan/src/`, `PlanIsland.tsx`, `App.tsx`, Electron main,
Plan tests, and the Plan browser driver. Every target file:line implementation
claim was checked; none was a hidden stub incorrectly labelled as existing.
The scale helper's narrower metre-only semantics and the capture stub/exporter
gap are findings 1 and 3.

Per the user's static-review instruction, builds, tests, benchmarks, the app,
screenshots, native windows/print dialogs, and web research were **not** run.

## Owner-decision items

**None (count: 0).** The apparently consequential choices all dissolve under
existing rules: exact scale/north under X1 plus the no-invented-transform
invariant and RIB W7; Plan snapshot scope and object reachability under C4,
FP-D4, PROJECT-FORMAT, and P5; vector/raster fallbacks under X1; the dedicated
window under D2/B3 with lifecycle inherited from UIP-D9/D10/D14 and
file-project; automation grants under accepted ADR 0024; shared dimensions
under DR-D9 and the cite-and-revise rule; and the fork/font audit under the
dependency policy. Numeric capture budgets are delegated calibration under X6.
No axiom conflict, product-identity/scope/money choice, licensing exception, or
owner-reserved boundary survives.

## System feedback

The contract and doctrine mostly did their job: C4 exposed the Plan-root/
snapshot and capture-reachability hole; E2 exposed the mixed-pass compositor and
native-window consumers; A2 plus the catalog rule exposed the incomplete raster
disposition; A3 plus registry cite-and-revise exposed the unlanded sibling
changes; X1/X2/X3/X5/P5 and ADR 0024 resolved every design choice without owner
escalation.

One contract question **failed to do its whole job**: D1 requires a measurable
gate for continuous interactions but asks long-running work only for progress
and cancellation. That allowed a 500M-point capture to be called “long and
cancellable” without time-to-first-feedback, interaction-blocking, throughput/
wall-time, memory, or cancel-ack/terminal budgets. D1/E3 should be sharpened so
the extreme member of every long-running class names representative data and
hardware plus measurable first-feedback, bounded-cancellation, resource, and
completion/regression gates. P5 supplied the missing principle, but the
contract question did not force the evidence.
