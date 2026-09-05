# Demanding-user review — Import & formats domain specification (2026-09-02)

Document class: report/verification evidence. Static review only; no builds,
tests, or application runs. All target A2 dossier citations were checked against
the cited dossier text, the target's code citations were checked at their stated
lines, and the cited sibling contracts were read for actual semantics.

Verdict: **not ready for architect/owner review**. The everyday import narrative
is promising, but the specification still lets a changed source corrupt or
silently stale downstream work, lets a nominally similar LAS batch reuse the
wrong placement, and promises exact undo without reserving the bytes that make
undo possible. Headline count: **3 blockers · 10 majors · 3 minors · 0 ideas**.

## Findings

1.  **Severity: blocker — Contract question: E2/C4. Changed-source update has no
    implementable three-way merge and no consumer-effect matrix.**

    **Objection:** I edited an imported cloud, used it for a locked viewing box,
    draped an ortho onto a derived surface, measured it, placed it in a Plan
    viewport, and applied specifications. Then the source changed. The spec says
    source-owned geometry/attributes/styles update while user overrides remain
    (`import-formats.md:196-204`), but it never defines how a field becomes
    source-owned versus locally overridden, what happens when both source and
    user changed the same field, or how point masks/compactions survive a LAS
    whose point ordering changed. “Reverse-reference scan” is used only to
    decide removals. Matched entities can change just as destructively.

    The E2 list at `import-formats.md:466-474` names consumers, then falsely says
    §3.3 states each effect. It does not. It omits the binding rules already owned
    by siblings: a locked viewing-box bake is keyed on source-dataset revision
    (`viewing-box.md:329-340`); point-cloud masks, compactions, extracts, and
    measurements have revision-specific behavior (`pointcloud.md:432-447`); a
    drape is keyed on exact image and terrain revisions (`raster.md:338-343`);
    linked Plan captures become stale while pinned captures must remain exact
    (`plan-editor.md:124-132,195-203`); and specification assignment/presentation
    has its own retained identity (`bim-specs.md:497-520`). A generic “dependency
    stale marker” is not a safe answer for these different contracts.

    **Proposed resolution:** make update a provider-neutral three-way merge over
    `(old imported baseline, current canonical state, new staged baseline)`.
    Persist field/representation ownership and the old baseline hash. For every
    matched record classify each change as source-only, local-only, equal, or
    conflict; never infer ownership from the current value. Add an explicit
    dependency action table: preserve stable references; rebuild and atomically
    swap revision-keyed bakes; mark linked Plan artifacts stale; retain pinned
    captures unchanged; revalidate or block measurements/anchors; preserve
    specification assignment while separately reviewing newly derived IFC
    classifications; and reject replay of point-index masks/edits unless the
    provider declares stable point identity. Otherwise offer **Keep old import
    as local** or **Import as new**. Freeze this complete action plan and test
    each consumer, not merely the source entity diff. This is derived from X1,
    SYSTEM-001, E2, RA-D4, PE-D5, VB-D3, PC-D1, and BS-D13; it is vetoable, not
    an owner question.

2.  **Severity: blocker — Contract question: C4/D1/E2. “Exact undo” of an 80 GB
    update has no retention, peak-disk, or maintenance contract.**

    **Objection:** `import-formats.md:206-211` promises Ctrl+Z restores the old
    datasets exactly and cites FP-D16 reachability. That necessarily retains the
    old 80 GB source/dataset, the new 80 GB dataset, staging/ready material, old
    inventories, and every old dependent object. The review never tells me the
    peak disk requirement, checks free space, says how long the old root remains
    an undo root, or shows why **Clean up unreachable data** cannot remove it.
    “A billion-point root swap without copying payload on the UI thread”
    (`:456-459`) answers UI latency, not storage existence. With insufficient
    disk, the current text leaves failure to occur halfway through the expensive
    stage.

    **Proposed resolution:** before staging, compute a conservative peak-space
    plan by category and show **Required / Available / Retained for undo**. Fail
    before writes if the safe bound is unavailable. Exact undo roots include the
    prior source artifact, prepared datasets, inventories, provenance, affected
    dependants, and keep-local detachments; FP-D16 maintenance must label these
    bytes **Protected by undo history** and must never collect them. State the
    release event: only an explicit, separately specified history-retention
    operation can make them unreachable; ordinary cleanup cannot. Update/undo/
    redo must each be a UIP-D10 job when reattaching large inventories, with no
    payload copy on the interaction thread. Add a real 80 GB-class disk-pressure
    gate, including cancellation before and after `ready.json`. X1 fixes the
    integrity behavior; X2 authorizes the storage spend but does not invent
    infinite disk; FP-D16 fixes GC interaction.

3.  **Severity: blocker — Contract question: E2/C3. “Apply to similar” can place
    39 LAS files wrongly because similarity and batch review are undefined.**

    **Objection:** The only operative predicate is “same provider+format” plus
    an undefined “reusable input signature” and “decision shape”
    (`import-formats.md:160-168,487-495`). The descriptor extension never defines
    that signature. Under ADR 0025, LAS header CRS is audit-only; that does not
    make a header mismatch safe to ignore. Two files can use the same provider
    while differing in WKT/VLR, unit/scale records, point schema, axis posture,
    or intended coordinate frame. The completion card lists the copied recipe
    and options, not each sibling's source/transformed bounds or metadata
    differences. The text then says every sibling is “preview-validated” and
    commits it without saying who reviewed the preview. One mislabeled tile can
    land kilometres away and still satisfy provider+format equality.

    **Proposed resolution:** define `ReusableInputSignature@1` exactly. It must
    include provider id/version, format id, option-schema version, interpretation,
    source dimensionality/point-record schema, declared unit/axis contract, and
    a normalized audit-metadata compatibility result. Untrusted CRS metadata
    never selects a transform, but any mismatch excludes the file from bulk
    reuse and returns it to **Needs input**. Before confirmation, show every file
    with source bounds, transformed bounds, declared frame/units, metadata
    agreement, expected entity/dataset result, and any outlier warning; allow
    individual exclusion. One confirmation freezes those N reviewed previews.
    Re-probe and expected-source fingerprint checks still run per file, and any
    changed value invalidates only that child. This follows X1, ADR 0025's
    reviewed-preview rule, IF-D2's no-observation/no-consent reuse, and UIP-D10/
    UIP-D11. Same provider alone is explicitly insufficient.

4.  **Severity: major — Contract question: A3/catalog. The cite-and-revise rule
    has not landed on the owning sibling documents or registry.**

    **Objection:** The target says it revises the single `file.import` act rather
    than duplicating it (`import-formats.md:7`) and claims the UI-platform review
    routes apply-to-similar here (`:17`). Current sources disagree:
    - `file-project.md:41` and `REGISTRY.md:42` still call `file.import`
      implemented/relocation-only rather than partial and linked to this spec.
    - `ui-platform.md:490-491` still assigns apply-to-similar to file-project;
      registry finding F3 records that exact handoff.
    - `agent.md:640-642` explicitly requires IF-D12/B1 to be amended so bounded
      `registration.*` preview/session methods are available through the Agent;
      the target still catalogs only `io.probe`/`io.import`.
    - `bim-specs.md:719-733` assigns full IFC import depth to this domain but
      does not state the target's claimed stable re-import identity. The target's
      A3 sentence that “BS-D13 consumes stable IFC classification/identity”
      (`import-formats.md:418-421`) overstates the sibling's actual semantics.

    **Proposed resolution:** perform the required coordinated revisions before
    retaining “specified” status: make file-project reference this end-to-end
    owner and change its status; replace UIP's/file-project's handoff with
    `import.applyToSimilar` here; amend IF-D12/B1/verification to adopt AG-D4/
    AG-D5's bounded registration methods and exact confirmation grant; add a
    BS-D13 cross-link stating that valid IFC `GlobalId` preserves the canonical
    entity id across update and that classification-derived specification
    handling follows the update merge plan; then add the five target rows to
    REGISTRY and rerun its duplicate-act/gesture/state checks. The program README
    makes these source edits mandatory, not follow-up work.

5.  **Severity: major — Contract question: A2/C3. Several “exists today” code
    claims are wrong, and one hides a real source-race gap.**

             **Objection:** Probe does **not** freeze a source fingerprint as claimed at
             `import-formats.md:280-282`. `ImportProviderSelection` contains only provider
             id/version, format id, and confidence
             (`canonical_provider.rs:203-215`); the cited `:1026-1045` verifies only the
             selected provider/version/format. Likewise `import_registration_runtime.rs:

        1284`is merely the display string for`ResourceChanged`, not the original

    source mutation check asserted at `import-formats.md:384-385`; actual checks
    at `:306-325`concern already staged resources. Other inaccurate anchors:
    `raster_runtime.rs:553`proves that a GDAL audit found the GPKG driver, not
    that a GeoPackage canonical import runtime exists;`main.rs:56`is a Rust
    `use`statement, while the`.hcap`call is at`main.rs:1237`; and
    `canonical_provider.rs:109,374,851,895`define descriptors/package/traits,
    not host staging and journal-last publication (that implementation is in
    `canonical_app_runtime.rs:219-255`and
    `canonical_project_store.rs:699-727`). Several App/Wizard anchors are also
    starts of functions rather than the claimed act: identity auto-commit is
    `BuilderImportRegistrationIsland.tsx:223-235`, and X→cancel is
    `ImportRegistrationWizard.tsx:257-269`.

             **Proposed resolution:** correct every status/delta citation to the exact
             implementing statement and mark unsupported behavior missing. Add a bounded
             probe token containing canonical source capability identity, file identity,
             size, mtime, and prefix hash; revalidate it before provider execution. The
             provider must snapshot/copy or verify pre/post identity while producing the
             authoritative full hash so a changing input cannot yield mixed bytes.
             Freeze the final full source hash into the accepted preview/update plan.
             Add a race test that rewrites the original during probe→stage. This repairs
             both the evidence and the data-integrity hole.

6.  **Severity: major — Contract question: E2/IF-D5. The descriptor dialect
    cannot express the spec's own richest option UI.**

    **Objection:** IF-D5 permits closed scalar properties and a unique string
    list (`import-formats.md:514-523`). The T1 ASCII workflow needs a variable
    column table, one role per source column, row previews, per-cell errors,
    header rows, and role uniqueness. SLPK also needs source-derived layer
    choices rather than an unlabeled integer. Neither a repeated structured
    mapping nor dynamic probe-derived choices fit the declared dialect. The
    likely implementation is exactly what the decision rejects: a format-id
    switch or opaque encoded JSON/string lists.

    **Proposed resolution:** version a presentation dialect separately from
    value validation. Add generic, provider-neutral controls for `columnMap`
    (source column id/name + exclusive role + preview cells), dynamic enums
    whose ids/labels come from a hash-bound probe result, file encoding and
    locale-aware numeric grammar, and read-only validation summaries. The value
    schema remains closed JSON Schema; presentation metadata references its
    fields and cannot change semantics. Unsupported control versions disable
    the provider honestly. Make ASCII mapping the actual largest-class fixture,
    SLPK the dynamic-enum fixture, LAS the empty fixture, and prove every current
    descriptor renders with no format-id branch.

7.  **Severity: major — Contract question: D1/E3. The million-line XYZ/CSV path
    is not classified or bounded, and its canonical result is still vague.**

    **Objection:** The preview promises an exact file-wide invalid-row count
    from a “bounded validation pass” (`import-formats.md:122-132`), while D1 calls
    column preview bounded and moves only staging to the long-running class
    (`:363-368`). An exact count over ten million lines is a full scan, not a
    sub-second card transition. If the user chooses Survey points, the spec can
    create millions of `hcad.point@1` entities in one in-memory package/journal
    command with no entity-count, memory, tree, selection, or undo gate. “Streams
    through the prepared Potree path” does not pin the required entity/dataset/
    provenance contract.

    **Proposed resolution:** split sample detection from full validation. Probe
    reads a bounded prefix and shows N real rows; full validation/import is a
    cancellable bytes/lines job with bounded memory and a stable grammar. A
    confirmed **Point cloud** creates exactly one `hcad.point-cloud@1` entity,
    one Potree `potree@2` prepared dataset, the immutable original source, and
    mapping/unit/CRS/loss provenance. A confirmed **Survey points** creates
    `hcad.point@1` entities with number/code/description and must pass a separate
    large-entity transaction/tree gate. Keep 50,000 as an X6-tunable
    recommendation, never a semantic auto-conversion; above it, warn with the
    projected entity/disk cost and either prove the large-point-list gate or
    refuse honestly. Add German fixtures for semicolon+decimal comma, comma+
    decimal point, quoted fields, thousands separators, UTF-8/Windows-1252,
    invalid rows near EOF, and multi-million-line cancellation.

8.  **Severity: major — Contract question: B2/C4/E2. Close, reload, and running
    phases have no single continuation owner.**

    **Objection:** X/Escape supposedly changes the job to Needs input while
    completed pairs, options, and accepted preview survive
    (`import-formats.md:224-233`). A renderer reload also supposedly rehydrates
    the jobs (`:170-176,377-389`). UIP-D10 persists only job metadata in main;
    current point pairs and provider-option form state live in React, while the
    sidecar state retains the recipe/aggregate preview, not the pair rows.
    Closing during staging, ICP, artifact copy, or the short atomic commit also
    cannot truthfully turn a running job into Needs input. The spec conflates
    hide, pause, and cancel.

    **Proposed resolution:** define phase-by-phase close semantics and ownership.
    Awaiting-user-input closes to `needsInput`; staging/ICP/publish closes to a
    still-running background job; the atomic boundary says **Finishing…** and
    cancels at the next safe point. Main owns the durable job record; the
    sidecar registration session owns all transient committed option values,
    point-pair rows, recipe, source fingerprint, and accepted preview so renderer
    remount can reconstruct the exact island. Uncommitted field text alone may
    remain renderer-local and discard on close. Project/app close revokes the
    session and records interruption; no transient picks enter a saved preset.
    Add close/remount tests in every phase, not just a jobs-chip rehydration test.

9.  **Severity: major — Contract question: C1. Picked point pairs have no typed
    twin.**

    **Objection:** C1 says point picking's numeric equivalent is switching to an
    entirely different parameter/transform-file method
    (`import-formats.md:341-345`). That is not parity. When I know the surveyed
    source and target coordinates for a control point, I need to type or paste
    that exact pair into the same fit, inspect residuals, and correct a mistyped
    coordinate without abandoning the point-pair method.

    **Proposed resolution:** the point-pair table exposes editable source X/Y/Z
    and project X/Y/Z cells with project units/precision, plus pick buttons for
    either side. Pick and type mutate the same transient pair and recompute the
    same preview. Escape reverts a cell; deleting a pair is explicit; paste of
    tabular pairs is bounded and validated. Parameters and transform-file remain
    alternative registration methods, not fake numeric twins. This follows C1,
    X5, and the RIB F5-box precedent.

10. **Severity: major — Contract question: B1/C4/X3. Import preset lifecycle is
    not automation-complete.**

            **Objection:** C4 promises preset save, **rename**, and delete are canonical
            journaled actions (`import-formats.md:357-361`), but the catalog and IF-D3
            expose only `import.preset.save/list/delete` (`:18,497-503`). There is no
            rename command and no exact statement of whether `save` creates, updates by
            expected revision, or silently overwrites a same-named preset. That fails
            the same canonical command from UI/Python/Agent rule.

            **Proposed resolution:** define `import.preset.create/update/rename/delete/

        get/page`with stable preset id and expected revision; names need not be

    identity. UI chooser/manage actions and console aliases call those same
    commands. Delete/rename/update are each one undoable journal step; stale
    provider/schema repair creates an explicit updated revision rather than
    mutating on open. Add`.hcadx`, undo/redo, name-collision, and generated SDK
    parity tests.

11. **Severity: major — Contract question: B1/E2. The spec freezes new public
    method names while the registry's naming defect is unresolved.**

    **Objection:** Registry F8 says snake-case leaves and camel-case leaves
    conflict and requires one convention before another SDK method lands
    (`REGISTRY.md:422-431`). The target nevertheless adds
    `import.apply_to_similar` beside existing wire methods such as
    `registration.preview.pointPairs`, and mixes public `io.import` with the
    existing facade `io.import.execute`. ADR 0024 says the Python clients are
    generated from one versioned protocol; names are not harmless prose once
    generated.

    **Proposed resolution:** settle the registry defect now. Derived decision:
    use dotted namespaces with lower-camel path segments/leaves for new wire
    methods because that is the implemented app/registration convention; use
    Python generator aliases for idiomatic snake_case methods. Rename this
    spec's wire verb to `import.applyToSimilar` and reconcile all new import/
    update/preset methods mechanically in REGISTRY and Agent. Keep
    `io.import.execute` as the internal app facade and define one public,
    plan/approval-bound automation command without presenting both as peers.

12. **Severity: major — Contract question: A2/catalog. Dossier-row disposition
    is incomplete, and some priority rationale is assertion dressed as X6.**

    **Objection:** §2.3 says every “relevant” catalog row is accounted for. The
    contract requires every dossier catalog row once a domain catalog derives
    from that dossier, including rows assigned to another owner. This table
    covers RealWorks §§2.1-2.2 and three RIB sections, but silently omits the
    rest of both dossier catalogs. It even uses RealWorks W8 to motivate glTF,
    PLY, and OBJ without a corresponding disposition of the dossier's mesh/model
    import relationship. The cited text supports generic DWG/DXF/IFC/mesh model
    import (`realworks.md:212-217`), not those specific file formats. RIB
    §2.10 and §4 support REB/OKSTRA importance, but do not decide DA45/DA40/
    DA58 first or REB-before-OKSTRA; X6 delegates calibration only after a
    defensible rationale is recorded. DA40 axes and DA58 DGM also depend on
    still-owed civil/Mesh owners, while the text uses missing owners as the
    reason to defer OKSTRA.

    **Proposed resolution:** add a complete row-for-row disposition appendix for
    both dossiers, citing existing owning decisions instead of deciding them
    again. Mark glTF/PLY/OBJ/3D Tiles as Himmel:CAD additions driven by existing
    compatible decoder/renderer investment, not RealWorks-format adoption.
    Derive tranche order from implementable canonical consumers and verified
    dependency readiness: T1 ASCII + `.hcap` registration + existing IFC gaps;
    glTF only when the Mesh entity owner and provider corpus are ready; first
    REB subset only after Point/Alignment/ElevationSurface admission exists.
    Record why REB precedes or follows OKSTRA using consumer readiness and
    German workflow coverage, and keep the order tunable. Do not cite X6 as a
    substitute for the rationale X6 explicitly demands.

13. **Severity: major — Contract question: B2/A1. A moved source has no recovery
    path.**

    **Objection:** On open, a missing source gets **Source unavailable** and the
    old canonical import remains usable (`import-formats.md:180-185`), which is
    correct. But B2 only says the badge remains (`:428-430`). There is no
    **Relocate source…** action, even though file-project already specifies that
    recovery for a missing attached project. Moving a survey folder or opening
    an archive on another workstation should not force “Import as new” and break
    the stable update lineage.

    **Proposed resolution:** add **Relocate source…** to the badge/context menu,
    console, and automation. The OS-selected replacement is probed and hashed;
    it may bind to the existing source lineage only through the normal update
    plan, stable-key checks, and explicit review. A provider/format mismatch
    refuses relocation and offers Import as new. Successful relocation journals
    the new canonical path/source fingerprint/provenance and is undoable; it
    does not update geometry until Update is confirmed.

14. **Severity: minor — Contract question: D1. Open-time `stat` is asserted
    bounded even on dead mounts.**

    **Objection:** `import-formats.md:456` calls the open-time source stat bounded
    and non-blocking. A canonical path on a disconnected SMB/NFS/removable mount
    can block at the OS boundary. File-project's prior review already caught the
    same class for recent paths.

    **Proposed resolution:** render the project immediately from cached source
    status, run liveness checks asynchronously with a tunable timeout and
    bounded concurrency, and report **Source check delayed** rather than holding
    project open. Manual Update/Relocate remains available. Add a simulated
    hanging-path test.

15. **Severity: minor — Contract question: E2/E3. The option-schema extreme is
    hypothetical, so the claimed class gate cannot fail usefully.**

    **Objection:** E2 names LAS as the smallest schema and “future REB toggles”
    as the largest (`import-formats.md:297-305`). A future, undefined schema is
    not a member of the class and cannot prove the renderer. The actual extreme
    is the planned ASCII column-map UI; among shipped descriptors it is the
    three-budget splat contract. G-IF-2 says it proves “both extreme schemas”
    without naming fixtures.

    **Proposed resolution:** name three executable fixtures: LAS empty;
    Gaussian-splat scalar budget form; ASCII dynamic column-map/delimited
    preview. Add SLPK dynamic-layer selection as the atypical source-derived
    member. Assert field order, keyboard/focus behavior, overflow/scrolling,
    validation, and no format-id branches for each.

16. **Severity: minor — Contract question: E3. The dependency gate does not
    prove the full policy for non-Cargo inputs.**

    **Objection:** G-IF-8 centers `cargo deny check` plus a generic third-party
    audit (`import-formats.md:647-649`). The dependency policy also requires the
    official-source and lock/artifact license match, complete transitive/runtime
    closure, models/datasets/native binaries/generated artifacts, redistribution
    terms, and local modification records. `cargo deny` cannot prove all of
    that, especially for vendored parsers, GDAL/PROJ-style runtimes, test corpora,
    or generated fixtures.

    **Proposed resolution:** require one checked-in dependency-evidence record
    per provider/version covering official source, lock/artifact hash, license,
    transitives/runtime files, corpus/data license, attribution, source revision,
    modifications, and redistribution. G-IF-8 validates completeness and hashes
    of those records in addition to `cargo deny`; a missing/uncertain record
    keeps the provider out of product and release builds exactly as the policy
    requires.

## Contract questions answered convincingly

- **B3** — Settings page, focused registration island, jobs island, and reused
  wide update review are appropriate surfaces for their interaction density.
- **C2** — new imports ignore project selection; update targets are captured by
  id and expected revision; multi-source update does not merge unrelated groups.
- **D2** — degradation order preserves coordinate correctness, atomicity, loss
  review, and input responsiveness while reducing only preview density and job
  concurrency.
- **E1** — §6 is a repo-resident written comparison artifact with concrete,
  screenshot-failable criteria in both themes. It is sufficient at spec time;
  implementation still owes the recorded screenshots.

No other A1-E3 question is credited merely because it has a paragraph: A1 is
undermined by the update and missing-source dead ends; A2/A3 fail evidence and
cite-and-revise checks; B1/B2 fail automation/lifecycle parity; C1/C3/C4 fail
typed pairs, source binding, and exact undo; D1 fails the ASCII/80 GB extremes;
E2 fails passive-consumer effects; E3 does not yet prove those missing rules.

## Executed vs. read

**Executed:** repository-static inspection commands only (`rg`, `sed`, `nl`,
`wc`, and `git status`). I did not run a build, test, benchmark, dev server,
Electron, the Builder app, or any import. I did not use web research; dossier
claims were judged only from the required repo-resident evidence.

**Read:** `.claude/agents/demanding-user.md`; `docs/CURRENT-DIRECTION.md`;
`docs/README.md`; all of `docs/FUNCTION-CONTRACT.md`,
`docs/DECISION-DOCTRINE.md`, `docs/DESIGN-SYSTEM.md`, and
`docs/AGENT-FEEDBACK.md`; builder-program README, OWNER-DECISIONS, and REGISTRY;
the complete target; the gold-standard viewing-box spec; the file-project and
ui-platform prior reviews; ADRs 0018, 0021, 0023, 0024, 0025, and the target's
relevant ADR 0027 citation; DEPENDENCY-POLICY, TRANSFORMATIONS, and
PROJECT-FORMAT; the cited sections and catalog rows of the complete RIB Civil
and RealWorks dossiers; the relevant actual semantics in file-project,
ui-platform, Agent, pointcloud, BIM/specifications, raster, and Plan specs; and
the cited provider, importer, sidecar, app-client, Builder renderer, wizard,
project-store, Python SDK, glTF/3D Tiles, CRS, and raster-runtime source.

## Owner-decision items

**None. Target count: zero.** The apparently consequential choices all derive:
three-way update and consumer invalidation from X1/SYSTEM-001/E2; old-dataset
retention and disk preflight from X1/X2/FP-D16; exact batch similarity from X1
and ADR 0025; T1/T2/T3 calibration from X6/P3 plus consumer/dependency
readiness; method naming from the implemented versioned wire convention and
ADR 0024; and Relocate from X5 plus FP-D7's source-missing precedent. No axiom
conflict, product-identity/scope/money/licensing acceptance, or owner-reserved
boundary survives the doctrine escalation protocol.

## System feedback

**One contract question needs sharpening; no doctrine axiom failed.** C4 asks
for the affected-state set of restore/rollback but did not force the author to
state the physical retention roots, peak disk requirement, retention release
event, and maintenance/GC interaction for exact undo of immutable heavy data.
Add that clause to C4 using this 80 GB re-import case as evidence. E2 and A3 did
their jobs—the target listed consumers and siblings—but the author treated
enumeration as disposition and did not state effects or land coordinated source
revisions. X6 also did its job: its existing text already requires a defensible
value and rationale; the REB/OKSTRA ordering simply failed to apply it. X2 does
not need amendment: permission to spend disk for interaction is not permission
to assume disk is infinite.
