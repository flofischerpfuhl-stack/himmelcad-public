# Demanding-user review — Import & formats: PhotoLab product datasets amendment

Document class: report/verification evidence

Review date: 2026-09-02  
Review target: `docs/builder-program/specs/import-formats/import-formats.md`, amendment “PhotoLab product datasets — 2026-09-02”  
Review mode: static specification and source review; no build or application execution  
Verdict: not implementation-ready for PhotoLab WP-G1  
Headline count: 4 blockers / 7 major / 0 minor / 0 idea

The amendment has the right product boundary in outline: Builder registers one prepared PhotoLab product into a destination project, the resulting entity belongs to its normal domain, and lineage remains provenance. It is not yet an executable contract. The largest defect is not editorial. The mandatory historical lineage cannot be recovered from the records PhotoLab currently publishes, while the text invites the implementer to collect it later from mutable current project state. That would create authoritative-looking but false provenance.

## Findings

1. **Blocker — C3/A3: At what exact lifecycle point is immutable product lineage captured, and can every mandatory value be recovered then?**

   **Objection.** The amendment requires source alignment version, GCP entity version and CRS/reference-frame snapshots, then says registration must “collect existing source snapshots.” That is impossible for existing product records. `ProductLineage` stores the alignment entity ID, processing-set ID, optional GCP ID/snapshot and image-mask scope hash, but not the alignment version or frozen CRS (`crates/himmelcad-sidecar/src/project_runtime.rs:704`). `ProjectProductDatasetRecord` likewise has no alignment version, GCP entity version or product-bound reference-frame snapshot (`crates/himmelcad-sidecar/src/project_runtime.rs:888`). The job launcher may resolve the _current_ alignment version (`crates/himmelcad-sidecar/src/main.rs:6842`), but the published product does not retain it. Reading the current alignment or current project manifest during a later Builder registration would silently attach new state to old bytes. The amendment also omits already-recorded causal inputs—processing-set identity, camera/mask scope and tool versions—from its mandatory provenance list. ADR-0012 makes lineage part of product identity; ADR-0019 and X1 prohibit reconstructing domain truth from mutable present state.

   **Proposed resolution.** Make publication-time capture a hard PhotoLab producer requirement. Every newly published product package must carry an immutable lineage record containing: source project stable ID and archive/manifest fingerprint; product entity ID, version/content hash, publication generation, kind and labels; source alignment ID and exact version hash; processing-set ID, version and membership hash, or an explicit none/all sentinel; frozen camera-selection and mask-scope hashes; GCP ID, entity version and frozen snapshot, or explicit no-GCP; frozen source spatial reference and `ProjectReferenceFrame`, including the accepted transformation hash or an explicit local-frame marker; algorithm/config/tool identities; and the product-package hash. Builder copies this record byte-for-byte into `hcad.photolab-product-provenance@1`; it must not derive missing history. A legacy product lacking any required field is catalogued as **Needs republish/recompute**, never completed from current project state. Add these fields to the PhotoLab publication record before WP-G1 proceeds.

2. **Blocker — A1/B1/E3: What versioned package does PhotoLab publish, and what exact canonical object does Builder validate and commit?**

   **Objection.** The amendment names a “source-product canonical package adapter” and invents `hcad.photolab-product-provenance@1`, but neither has an admitted schema. There is no normative package manifest, object graph, artifact inventory, hash boundary, safe-path rule, unknown-field policy, migration policy, or atomic publication rule. The component identifier occurs only in the target amendment. ADR-0018 requires canonical admission packages with complete object/resource declarations, lengths, hashes and media types. `docs/PROJECT-FORMAT.md:128` reserves a planned `hcad.fragment-manifest@1` profile and requires an ADR before implementation. A cross-project product snapshot is fragment-like; a prose adapter label is not a transfer contract.

   **Proposed resolution.** Before implementation, admit one versioned PhotoLab product-package profile in the data model/project-format contract and an ADR. Prefer a constrained canonical-import-package or fragment profile rather than a product-private bridge. Its manifest must bind the product ID/version and immutable lineage to: exact canonical admission object(s); normalized format and dataset root; complete artifact list with safe relative path, byte length, content hash and media type; prepared-resource metadata; producer/schema versions; total byte and object counts; and one package hash over the canonical manifest. PhotoLab publishes the package atomically with the product record. Builder validates that package, stages only hash-addressed declared artifacts, and commits the declared canonical entity plus the provenance component. Define unknown-field preservation, forward-version rejection and migration ownership. Until this normative schema exists, the format rows cannot be marked Adopted.

3. **Blocker — A3/X1: Does an orthomosaic enter Builder through the Raster-owned canonical mapping, or through the current PhotoLab zero-height workaround?**

   **Objection.** The Raster specification owns this semantic decision and explicitly says `RasterMapping::PlanGrid2D` must be added before the workflow ships; no implementation may substitute a zero-height `OrthoGrid` (`docs/builder-program/specs/raster/raster.md:67`). The current PhotoLab bridge does exactly that workaround by constructing an `orthoGrid` with `z: 0` (`apps/photolab/renderer/src/PhotolabKernelViewport.tsx:290`). The amendment adopts orthomosaics, says Builder must never invent Z, but neither requires `PlanGrid2D` nor makes the Raster change a prerequisite. That re-dispositions a sibling-owned capability and gives WP-G1 two contradictory implementation paths.

   **Proposed resolution.** Change the orthomosaic disposition to **Needs canonical PlanGrid2D admission** until the Raster/data-model revisions land. The only accepted R1 mapping is `RasterImage` plus `RasterMapping::PlanGrid2D`, carrying the source grid affine transform and CRS and an explicit plan-only/no-Z policy. A zero-height `OrthoGrid` is rejected. Revise the Raster specification and registry in the same change. For DEMs, likewise name the exact `Grid` geometry/resource, mapping, sampling and prepared-render binding rather than merely saying “Grid + raster representation.”

4. **Blocker — A3/registry cite-and-revise: Where are the new capability, command and entity-owner obligations registered and reconciled?**

   **Objection.** They are not. `docs/builder-program/REGISTRY.md:272` still contains only the existing Import & formats rows; it has no `import.photolab-product`, `import.photolab-products`, `io.import.product_dataset.register` or `.list`. The registry header still enumerates only P1–P7 (`docs/builder-program/REGISTRY.md:17`) and its completion assertions remain unchanged. The Agent specification still says the public import surface is exactly `io.probe` and `io.import` and has no product-dataset commands (`docs/builder-program/specs/agent/agent.md:21`, `:510`). The Point-cloud specification has no Gaussian-splat entity ownership; Raster and Mesh do not accept IF-D19 or the proposed provenance component. The amendment leaves these as later “cross-spec requests,” contrary to the builder-program cite-and-revise rule. A spec may not privately re-disposition capabilities owned elsewhere.

   **Proposed resolution.** Land one atomic documentation change before WP-G1: add and count the registry rows; register P11 and regenerate the duplicate/disposition audit; add exact P11 commands to the Agent command table; have Point-cloud either own the splat result or introduce one unambiguous owner; revise Raster and Mesh with accepted arrival/provenance/export semantics; and revise File & project with the import-versus-attach ruling below. Replace the amendment’s cross-spec requests with normative citations to the landed revisions. Keep the amendment Drafted and all new rows non-implementation-ready until that set is complete.

5. **Major — A1/P10/D5: Is “open a PhotoLab project's products in Builder” Attach, Import, or a linked recipe?**

   **Objection.** The amendment never gives the required single answer. File & project D5 defines Attach as a whole-project, source-linked, read-only project-reference entity with block selection, display overrides, re-sync and Relocate (`docs/builder-program/specs/file-project/file-project.md:329`). The requested operation instead selects one published product and materializes a normal Builder entity. Mesh MT-D25 also says an imported object with no admitted canonical mapping has no recipe (`docs/builder-program/specs/mesh-terrain/mesh-terrain.md:1215`). Leaving the classification implicit creates incompatible expectations for editing, source dependency, stale status, re-sync and undo.

   **Proposed resolution.** Record the derived, vetoable decision: **this capability is Import, not Attach, and not a P10 linked recipe**. It copies one immutable product snapshot into an ordinary destination entity governed by Point-cloud, Raster or Mesh. The destination is editable according to that owner. It creates no project-reference entity, no block-wide display overrides, no source dependency edge, no re-sync and no automatic movement or staleness when PhotoLab changes. PhotoLab alignment/GCP identifiers remain immutable provenance and do not enter Builder’s recipe DAG or reverse index. A separate explicit Update operation may import a later product version under the rules in finding 10.

6. **Major — C3/X1: How is a consistent source snapshot obtained without racing PhotoLab or mutating the source project?**

   **Objection.** The amendment permits source writes to race staging and relies on a later fingerprint check, but the current project runtime has one mutable open session and acquires an exclusive project lock (`crates/himmelcad-sidecar/src/project_runtime.rs:1485`). Opening installs a working session and updates manifest state (`crates/himmelcad-sidecar/src/project_runtime.rs:1748`); it is not a passive package reader. File & project currently rejects concurrent Builder/PhotoLab project open (`docs/builder-program/specs/file-project/file-project.md:95`). A fingerprint-at-end rule also does not pin roots against garbage collection during a multi-terabyte copy.

   **Proposed resolution.** Define an R1 read-only source-package lifecycle. For a `.hcad` source, a dedicated reader—not PhotoLab `open`—must acquire the exclusive source lock, must not create a working copy or mutate clean-shutdown/modified state, and must hold/pin the selected package root until all declared bytes are copied and verified into destination staging. If the source is busy, fail before staging with the actionable message “Close PhotoLab or select a `.hcadx` archive.” Treat a selected `.hcadx` as immutable for the operation. Release the source lease only after destination staging is independently complete. Shared snapshot leases may be a later optimization; they are not an R1 dependency.

7. **Major — D1/X6: Can listing remain bounded while showing complete products, sizes and hashes?**

   **Objection.** Not with the current publication record. Product listing reads individual records that expose relative paths, format, bounds and point counts, but not a complete artifact inventory, total byte count or package hash (`crates/himmelcad-sidecar/src/project_runtime.rs:4505`). Computing those values by walking and hashing a large hierarchy would turn the allegedly bounded list command into a long job. Current list logic also skips at least one raw-mesh case rather than returning an unsupported disposition (`crates/himmelcad-sidecar/src/project_runtime.rs:4533`), contradicting the amendment’s “never omit” chooser rule.

   **Proposed resolution.** Require PhotoLab to precompute and publish artifact count, total bytes and package hash in the small product-package manifest from finding 2. `list` reads only bounded, pageable manifest records and returns every published product, including unsupported and legacy records with explicit disposition/reason. Full artifact hashing occurs only in the cancellable registration job. A legacy record without a complete package is **Needs preparation**; preparation/republish is a separate long PhotoLab job, never hidden inside list.

8. **Major — B1/P11: What are the exact generated request, result, grant and replay contracts for the two new commands?**

   **Objection.** The amendment provides command IDs and descriptive result prose, not schemas. P11 requires generated automation exposure, yet the Agent matrix and current import grant model are file-handle oriented and know nothing about a PhotoLab project directory/archive, a product version or a pinned catalog snapshot. Without exact schemas an implementation cannot safely distinguish a stale selection, a changed package, a replayed grant or a different destination generation.

   **Proposed resolution.** Add generated schemas and the Agent-table rows in the same revision. `list` must take a user-granted source-project/archive handle plus a bounded cursor and return a source fingerprint/generation, product ID/version/package hash, size/count and exact disposition. `register` must bind the same source grant and fingerprint to one product ID/version/package hash, destination expected generation, normalized admission/placement choice and optional explicit update target. The result must distinguish completed, already-registered, needs-preparation, unsupported, stale-source, busy-source, cancelled-before-commit and failed-with-no-commit. Reconfirm the single-use user grant at commit; do not expose raw paths or private sidecar RPCs. Journal the canonical command/result through the normal operation path.

9. **Major — E2/A3: What does every passive consumer do for each resulting entity kind and for its provenance?**

   **Objection.** “Picking/snapping where the owning kind permits” is not an enumeration. The adopted rows yield materially different entities: point cloud, Gaussian splat, DEM `Grid`, plan-only orthomosaic, open `Surface3d`, and closed `Object3d`. Point-cloud has no admitted splat owner; Raster distinguishes non-snappable raster images from terrain-capable grids; Mesh gives imported objects no recipe by default. The amendment also does not say what native and external exporters do with the provenance component. Deferring sibling edits prevents consumers from implementing one consistent result.

   **Proposed resolution.** Add a per-result passive-consumer matrix, accepted by the owning specs, covering render, pick, snap, selection, editability, tree, Properties, export, Plan, WeltView and automation. At minimum: provenance is read-only in Properties and generic property mutation rejects it; committed native `.hcadx` preserves it byte-for-byte; each external exporter explicitly preserves it through an admitted provider extension or reports lineage loss before export; unsupported render/pick/snap paths fail explicitly rather than omit the entity. State the exact splat ownership and semantics before adopting that row.

10. **Major — C4/P10: What happens when the same or a later PhotoLab product is registered again?**

    **Objection.** The amendment says duplicate provenance is reviewed but defines no duplicate identity or update behavior. This leaves room for silently duplicated datasets, provenance mutation in place, or an accidental source-linked recipe. It also does not separate Relocate of a source locator from replacement of committed product truth.

    **Proposed resolution.** Define exact identity and restore behavior. Registering the same source-project stable ID, product ID/version and package hash returns `alreadyRegistered` with existing destination IDs and creates no duplicate. A user who wants a spatial copy uses the normal Duplicate/placement command. A different version/package imports as a new entity by default. An explicit `import.update.plan/execute` may target an existing imported entity and atomically create a new destination version with new immutable provenance; undo restores the old entity version, prepared roots and provenance, and heavy-root retention follows IF-D15. Relocate may change only a separate source-location binding after hash proof; it never rewrites immutable provenance. Missing or changed source material never alters committed geometry.

11. **Major — E3/R1 gate 8: What exact artifact does WeltView open, and what proves parity?**

    **Objection.** “The same committed entities open read-only” does not specify an R1 lifecycle or test input. File & project identifies WeltView as a consumer of `.hcadx` archives (`docs/builder-program/specs/file-project/file-project.md:736`), while `docs/PROJECT-FORMAT.md:115` distinguishes archive behavior and reserves broader R3 collaboration modes. The amendment could otherwise be interpreted as requiring concurrent access to Builder’s mutable working project, reopening the locking problem in finding 6.

    **Proposed resolution.** Make the R1 gate exact: after each adopted product is registered into a Builder project, Builder performs canonical Save As to a complete `.hcadx`; WeltView opens that archive read-only through the canonical store/kernel path. The gate compares entity IDs, version/content hashes, prepared-dataset bindings, provenance bytes and expected view semantics for each adopted format row. Direct access to a mutable Builder working project and R3 network/collaboration modes are deliberately out of scope.

## (a) Contract questions convincingly answered

- **A1, user outcome and boundary:** one prepared PhotoLab product is registered into a destination Builder project as a normal domain-owned entity; the source project is not edited.
- **A2, reference grounding:** the amendment adds no unsupported third-party behavior claim. Its inherited RealWorks dossier citations accurately support per-format import options, reference/moving/preview registration panes, pair picking/refinement/visual checking, and RIB’s station-checkbox multi-application behavior. No dossier-wide absence claim is introduced by the amendment.
- **B2, close/cancel/error phases:** the inherited Import & formats contract defines pre-commit cancellation, one atomic commit, post-commit undo and failure without partial destination mutation.
- **B3, extreme-class member:** retaining the existing floating registration island is justified for the spatial registration workflow and is not generalized to ordinary import dialogs.
- **C1, selection and numeric handling:** the product choice is identifier-based; placement/registration numeric behavior inherits the already-specified canonical placement contract, and provenance is read-only.
- **C2, concurrency:** selection is captured by product ID/version and independent product registration jobs may run separately subject to source and destination coordination.
- **C4, single successful commit:** for one registration, the inherited IF-D15 transaction/undo and heavy-root retention rules provide a sound atomic restore baseline. Finding 10 is the missing repeated-registration extension.
- **D2, degradation:** prepared versus deferred formats are visibly distinguished and the amendment does not authorize silently degraded substitutes.
- **E1, in-repo visual evidence:** the chooser, progress, deferred-reason, long-hash/CRS, focus, Escape and final Properties states have written dark/light manual acceptance criteria capable of failing; no external mockup is required for this amendment.

## (b) Executed versus read

Executed:

- Static repository inspection only, using `rg`, `sed`, `nl`, `wc`, `test` and `git status`.
- Created this report as the sole repository mutation.

Not executed:

- No build, formatter, linter, unit/integration/end-to-end test, benchmark or application launch.
- No sidecar command or automation command.
- No web research; all reviewed claims were resolvable from the repository’s normative documents, dossiers and source.

Normative and calibration material read:

- `.claude/agents/demanding-user.md`
- `docs/CURRENT-DIRECTION.md`, `docs/README.md`, `docs/AGENT-FEEDBACK.md`
- `docs/FUNCTION-CONTRACT.md`, `docs/DECISION-DOCTRINE.md`, `docs/DESIGN-SYSTEM.md`
- `docs/builder-program/README.md`, `OWNER-DECISIONS.md`, `REGISTRY.md`
- `docs/ROADMAP.md`, `docs/TEST-TIERS.md`, `docs/PROJECT-FORMAT.md`
- ADR-0012, ADR-0018, ADR-0019, ADR-0021 and ADR-0025
- `docs/builder-program/IMPLEMENTATION-PLAN.md` WP-A2 and WP-G1
- Gold standard `docs/builder-program/specs/view/viewing-box.md`
- Prior reviews under Import & formats, File & project, and Agent
- Sibling Point-cloud, Raster, Mesh & terrain, Agent, and File & project specifications
- The RealWorks and RIB dossier passages cited by the inherited A2 evidence

Source claims inspected:

- Builder registration surface and format-ID forwarding in `BuilderImportRegistrationIsland.tsx`, `App.tsx` and `import_registration_runtime.rs`
- PhotoLab product lineage, records, publication/listing and project locking in `project_runtime.rs`, `main.rs` and `photolab_project.rs`
- Current PhotoLab raster bridge in `PhotolabKernelViewport.tsx`
- Render-core providers and viewer admission paths under `crates/himmelcad-render/src/providers/`
- Automation schemas/allow-list and the canonical Grid/entity model

The cited source locations were treated as static implementation evidence, not runtime verification. The inspected Builder registration path is real and format-ID matched rather than a stub; however, it currently admits only the existing registration workflow. The inspected PhotoLab publication code is also real, but it does not publish the complete immutable lineage/package required by the amendment.

## (c) Owner-decision items

Count: **0**.

All disputed choices are derivable without escalation:

- Import rather than Attach follows D5/File & project plus the stated one-product materialization outcome.
- No linked recipe follows P10/MT-D25 because PhotoLab lineage has no admitted Builder mapping recipe.
- Publication-time immutable lineage and a hashed canonical package follow ADR-0012, ADR-0018, ADR-0019 and X1.
- `PlanGrid2D`, rather than zero-height `OrthoGrid`, follows Raster ownership and X1.
- Atomic registry/sibling/P11 revision follows the builder-program cite-and-revise rule, P11 and X3.
- Exclusive read-only source acquisition for R1 follows current lock semantics, SYSTEM-001 and X1; shared snapshot leasing remains a later optimization.
- Bounded manifest listing follows X6.
- WeltView parity through a saved `.hcadx` follows File & project, Project format and the R1/R3 boundary.

These are vetoable derived decisions. None conflicts with an accepted ADR or reserved owner decision.

## System feedback

No contract question or doctrine axiom failed to do its job. A3 and the registry cite-and-revise rule exposed the unlanded sibling ownership changes; C3, C4 and E2 exposed the unrecoverable provenance, repeated-registration and passive-consumer gaps; X1 rejected reconstructed domain truth; X6 rejected unbounded catalog work; P10 resolved recipe status; and P11 exposed the missing generated command schemas. The defects are failures to apply the existing system, not evidence that the review system needs another axiom.
