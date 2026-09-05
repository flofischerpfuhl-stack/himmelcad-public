# Adversarial specification review: Builder registration and stations

Document class: report/verification evidence

Date: 2026-09-02

Reviewed artifact: `docs/builder-program/specs/registration-stations/registration-stations.md`

Review mode: static specification and evidence review; no product, test, benchmark, or build execution

Verdict: **FAIL — not eligible for Specified or implementation hand-off**

Finding count: **4 Blockers / 12 Majors / 2 Minors / 0 Ideas**

The proposal has a sound product nucleus: a reviewed placement-only transaction, immutable audit records, resumable station-depth generation, and a Station View that refuses to manufacture survey truth. It is nevertheless not a closed contract. The draft claims five public functions before their registry and sibling ownership changes exist; its advertised one-to-many registration session cannot identify which moving resource owns a pair or the single on-screen Moving pane; and its commit/undo description omits several existing placement consumers. Those are implementation-blocking defects, not editorial polish.

## Findings

### 1. The draft claims public ownership that the registry and incumbent specifications still assign elsewhere or do not register

**Severity:** Blocker

**Contract question:** A3 — Is this function already owned elsewhere, and was the ownership decision verified in the authoritative artifacts rather than asserted locally?

**Objection:** The evidence is unambiguous. `docs/builder-program/REGISTRY.md:75` still marks `view.station` as Deferred to a future registration/stations program; it has no rows for `station.catalog`, `registration.cloud-to-cloud`, `registration.report`, or `station.depth-image`. The shared `derived.recipe-manage` row at `REGISTRY.md:270` remains owned by Mesh/Terrain. `docs/builder-program/specs/view/view-domain.md:501-522,810-839` still defers Station View and queues per-station color behavior. `docs/builder-program/specs/import-formats/import-formats.md:20-22` still places stations and registration outside its current catalog. `docs/builder-program/specs/ui-platform/ui-platform.md:1386-1458,1470-1506` neither admits registration as a Shared3DTarget consumer nor defines its post-import cursor/gesture row. `docs/builder-program/specs/agent/agent.md:979-992` does not enumerate these generated commands. Point Cloud is the one verified reciprocal sibling: it cites this exact owner at `pointcloud.md:78-83,1224-1229` and does not re-own the capabilities or PC-D17/PC-D18 sampling. The reviewed draft itself concedes that the other reciprocal edits remain queued (`registration-stations.md:565-580`) while presenting the functions and command names as contractual. That violates the Builder registry rule that ownership, acts, commands, surfaces, gestures, state, and schema implications must be registered before a draft can be specified, and the cite-and-revise rule forbidding local appropriation of another specification's contract.

**Proposed resolution:** Keep this document Drafted. In one reviewable change set, add the five function rows and every exact public command to `REGISTRY.md`; add the post-import registration gesture/cursor rows; revise View VD-D11/VD-D12, UI Platform Shared3DTarget and cursor matrices, Agent P11 command enumeration, Import Formats station boundaries, Measure/Inspect provider/consumer tables, Mesh/Terrain MT-D25 specialization, and File/Project restore ownership. Preserve Point Cloud's already-correct citation and PC-D17/PC-D18 semantics. Run the registry uniqueness and state-owner checks. Only after those authoritative edits land may the schema row move through Pending and this document claim Specified. A queue inside the claimant specification is not reciprocal ownership.

### 2. The advertised one-reference-to-many-moving workflow has only one moving-side interaction model

**Severity:** Blocker

**Contract question:** C2 — What exact state is reachable after every action, including the extreme one-to-many class member?

**Objection:** The committed-report schema correctly gives each `RegistrationLinkV1` a `moving_id`, and C2 says moving input is one-or-many, but there is no transient session/link schema and no command payload assigning a pair set or ICP run to a link (`registration-stations.md:51-61,157-198,395-406`). The flow exposes one Reference pane and one Moving pane while merely mentioning local “active ... link selection”; it never supplies the member list/selection act, says which of 100 moving members is visible, or defines whether links may be in different Coarse/Refined/Ready states. Nor does it say how failure/removal/retry of one member affects the promised atomic commit. The current in-repo session implementation is an import-stage substrate, not evidence that this absent post-import state machine exists (`crates/himmelcad-sidecar/src/import_registration_runtime.rs:33-119,133-220,404-588`). The named “100 moving clouds” extreme therefore exercises an undefined class member rather than the specified operation.

**Proposed resolution:** Add a canonical `RegistrationLink` per moving resource with stable ID, moving resource ID, pair observations, coarse transform, ICP settings/result, review state, validation token, and error. Add an ordered member list beside the single Moving pane; the active link alone drives that pane and all pair/refine commands require its link ID. Define state transitions and commands for activate, add/remove/retry, discard link, and apply settings to selected links. Require every retained link to be Ready against the same reference generation immediately before commit. Define the transaction as all retained links succeeding or none changing, with no partial group, reports, undo entry, or placement revision on failure. Extend the 100-member gate to switch active links, preserve independent pairs/results, inject one stale/failing member, repair or remove it, and then prove one atomic commit and undo.

### 3. Registration commit and undo omit existing placement consumers and therefore cannot promise an atomic restored state

**Severity:** Blocker

**Contract question:** E2 and C4 — Have all passive consumers been enumerated, and does undo restore the complete affected state rather than only the initiating object?

**Objection:** The established placement-consumer contract is already concrete. `docs/builder-program/specs/select-edit/select-edit.md:199-215` requires locked viewing boxes to suspend the old bake and rebuild after a committed placement change, raster drapes to become stale and suppress misleading output, associative measurements to follow and recompute while fixed-world anchors remain fixed, linked Plan views to become stale while pinned snapshots stay fixed, and attached project items to follow. SE-D20 additionally requires one typed invalidation publication per committed gesture (`select-edit.md:1074-1078`). MT-D25 invalidates recipes from source content or placement revisions (`mesh-terrain.md:1226-1327`). The reviewed draft explicitly handles only station depth and historical reports, then relies on generic “dependent derived consumers” language and an incomplete matrix (`registration-stations.md:190-198,540-563,712-724`). It does not state the observable behavior of a live locked viewing box, drape, associative/fixed measurement, linked/pinned Plan view, section/pick index, or other MT-D25 recipe during commit, failure, and undo. A placement-only operation is still a system transaction.

**Proposed resolution:** Cite and adopt the SE-D3 consumer matrix rather than restating a subset. The commit root must include all moving resource placements and revisions, station/panorama/group projections, one typed invalidation set, locked-viewing-box bake state, raster-drape suppression/rebuild state, associative measurement recomputation/unresolved results, linked Plan stale state, and every P10 recipe transition. Fixed-world anchors and pinned snapshots remain unchanged by definition. During commit, keep the last valid locked clip visible but label it Rebuilding; suppress stale drape/derived geometry that would assert false alignment. Failure restores the exact pre-commit set without publishing a durable invalidation. Undo and redo restore/reapply the same full set and generation tokens, not merely transforms and a group ID. Add one gate containing all these consumers and assert the before/commit/undo/redo snapshots.

### 4. The immutable report promise conflicts with accepted ADR 0025 and is too weak to support its own pair/outlier UI

**Severity:** Blocker

**Contract question:** C4 and A3 — What is canonical, what is audit-only, and does the proposed persistence agree with the accepted architecture decision?

**Objection:** Accepted `docs/adr/0025-interactive-import-registration.md` says viewport picks and sampled ICP points live only in the transient session, are not serialized into the recipe, and the audit retains the transform plus aggregate residual/overlap. The draft promises immutable `pair_statistics[]`, per-pair residual export, and an outlier action that locates pair endpoints, but never defines whether the endpoints, acquisition type, source generations, locators, enabled state, or weights are persisted (`registration-stations.md:77-89,239-257,421-440`). If endpoints are absent, “Locate endpoints” cannot work after restart. If they are persisted without changing ADR 0025, the specification contradicts an accepted decision. A vague `pair_statistics[]` cannot carry the audit boundary.

**Proposed resolution:** Amend or supersede ADR 0025 in the same change set with a narrow distinction: reviewed manual pair observations are copied into the immutable registration report for audit only; sampled ICP working points and nearest-neighbor correspondences remain transient; neither report data nor picks enter or replay a DerivedRecipe. Define each audit pair with stable pair ID, moving-link ID, reference and moving exact/typed acquisition discriminants, source entity/content/placement generation, immutable locator when exact, world coordinate captured at review, weight/enabled state, and final residual. Define sampled ICP statistics as aggregate/histogram/provenance only. The outlier action may re-resolve an exact locator or show the captured coordinate as historical; it must never mutate or rerun registration. If the ADR is not changed, delete the endpoint locator and per-pair persistence promises and retain aggregate audit only.

### 5. Registration-group lifecycle, membership invariants, and P9 visibility semantics are not specified

**Severity:** Major

**Contract question:** B1 and C2 — Is every noun actionable, and are the already-grouped and mixed-visibility states deterministic?

**Objection:** `RegistrationGroup` is introduced as a first-class named entity with a fixed member and moving members, yet the public contract exposes only ambiguous create/update wording and `station.set_group`; it does not define list/get, rename, remove member, delete empty group, replace fixed member, or collisions with an existing group (`registration-stations.md:35-52,317-355`). The draft names “already grouped” as an extreme case without choosing reject, move, merge, or split semantics. It also calls registration groups a separate projection while promising parent propagation and Mixed state. P9's canonical resolver in Shared Editing uses entity ancestry/layer/taxonomy/class inputs; registration membership is not an inherited parent relation, and no precedence rule has been revised to add one. A fixed member can therefore be removed or hidden under undefined invariants, and a visibility eye risks becoming a second truth owner.

**Proposed resolution:** For v1, make group membership exclusive. An ungrouped reference creates a named group; an existing group may be the destination only when its fixed resource equals the selected reference. Reject moving resources that belong to another group and provide an explicit whole-group dissolve/move command rather than silently reparenting. The fixed member cannot be removed until the group is dissolved; delete is allowed only when no retained moving members remain and historical reports retain stable group/name snapshots. Add generated list/get/create/rename/remove/dissolve commands with conflict and undo semantics. Treat the group eye as a P9 bulk operation over exact current members, not an inherited visibility parent: Mixed is summary presentation, and the eye dispatches canonical per-entity visibility commands. Revise SE-D19 and the registry if product intent instead requires registration membership as a visibility parent.

### 6. Reticle dragging can destroy exactness while the UI and report continue to call the observation exact

**Severity:** Major

**Contract question:** C1 — Can every input path preserve or explicitly downgrade the promised source-space exactness?

**Objection:** The draft adopts Shared3DTarget handles and allows a picked pair endpoint to be dragged, while its pair/report and readiness language depend on exact source locators (`registration-stations.md:168-186,505-538`). The incumbent Shared3DTarget contract permits handle drag but distinguishes Exact, Estimated, and Typed acquisition states (`ui-platform.md:1386-1458`). Free screen-space/world-space dragging does not by itself produce a point that exists in either source cloud. The draft neither requires a fresh snap/revalidation on release nor changes the endpoint's acquisition type. That lets a synthetic coordinate masquerade as surveyed exact data and makes the immutable audit misleading.

**Proposed resolution:** Make pair endpoints a discriminated union. `Exact` requires entity/content/placement generation plus immutable source locator and resolved coordinate. A handle release becomes Exact only after snapping to and revalidating a source point in the endpoint's own pane; otherwise it becomes visibly `Typed`, records its entered/world coordinate, and loses any source locator. `Estimated` may aid hover but cannot enter a Ready pair. Show Exact/Typed on the pair row and report, reject stale/unresolved Exact endpoints at precommit, and never silently substitute a nearest neighbor. Add pointer, keyboard, automation, drag-off-source, stale-generation, and undo parity tests.

### 7. A common rigid registration delta needlessly invalidates a station-local depth product whose geometry has not changed

**Severity:** Major

**Contract question:** C3 and D2 — Is invalidation applied at the cheapest exact equivalence class, or does it force avoidable heavy recomputation?

**Objection:** MT-D25 currently treats any placement revision change as recipe invalidation (`mesh-terrain.md:1254-1267`), and the draft consequently marks station depth stale after registration (`registration-stations.md:111-119,190-198`). But the normal registration transaction left-composes the same rigid delta onto the station pose, associated panorama pose, and its source cloud. Rays, source-point locators, visibility collisions, and depth in station-local coordinates are then mathematically unchanged. Rebuilding a possible 500-million-point depth artifact merely because world placement changed violates P10's “live when cheap and unambiguous” principle and X2's preprocessing economy. Conversely, blindly preserving the artifact when only one member changes would be wrong. The draft specifies neither distinction.

**Proposed resolution:** Add a reviewed MT-D25 `placement_equivalence` specialization through reciprocal cite-and-revise. During registration commit, prove that the station, panorama, and exact depth source all receive the identical rigid delta and that source content, profile, locator mapping, and station-relative transform are unchanged. If proven, advance the recipe's source placement references/generation transactionally while retaining the same immutable artifact hash and Current status. If any source receives a differential transform, content revision, association change, or failed proof, mark Stale and follow normal rebuild/suppression rules. Record the equivalence proof in the commit audit and test common-delta, differential-delta, undo, and redo cases. This is an exact remap, not relaxed correctness.

### 8. The station-depth contract does not determine its authority, rasterization result, or honest NoData presentation

**Severity:** Major

**Contract question:** A1 and C1 — What exact artifact is produced for each admissible source combination, including the no-RGB and no-depth cases?

**Objection:** Owner record S16 requires a panorama depth image from the E57 panorama data or the station's own cloud; the E57 importer explicitly preserves image provenance while not deriving depth and may lose structured row/column layout (`crates/himmelcad-io/src/e57_import.rs:3-17,1229-1288,1612-1674`). The draft usefully fixes `rayDistance`, nearest-positive-point, and an immutable-locator tie-break, but it still does not freeze the pixel-center/seam/pole projection convention, structured-range validity mapping, source choice when both structured range and cloud are admissible, or the confidence/discontinuity formulas. It exposes a `collision_policy` even though the named algorithm already asserts one winner rule, without saying whether that parameter is fixed or variable. Finally, the cloud-only flow promises that building depth will enable “image-backed Station View” even though the artifact outputs contain depth/masks/locators and no radiometry (`registration-stations.md:91-119,200-237,451-490`). “RGB never determines depth” is correct, but the opposite direction is also relevant: depth alone is not an RGB image, and an RGB underlay must not visually imply valid geometry at an invalid depth cell.

**Proposed resolution:** Define source choice deterministically: prefer an exact structured range/depth channel associated with the station and source generation; otherwise use the explicitly associated station cloud; an RGB image alone is ineligible and yields NoData, never photogrammetric inference. Freeze projection coordinates, pixel centers, range units, near/far validity, z/range comparison, deterministic nearest-depth tie-break, discontinuity neighborhood, confidence calculation, and locator winner semantics in the profile version. Make radiometry optional and non-authoritative: show the associated RGB panorama as an underlay where available, otherwise render an honest depth/luminance shader from valid geometry. Overlay invalid cells with the design-system invalid-data treatment, disable their target cursor/click, and expose valid/NoData/discontinuity masks without hiding the image. Define precedence when RGB and depth resolutions differ and gate seam, overlap, tie, invalid, image-only, and cloud-only fixtures.

### 9. “Resolve locator and revalidate in core” has no bounded algorithm for the promised data sizes

**Severity:** Major

**Contract question:** D1 and C1 — What is the latency and correctness contract for turning one depth pixel into one source point?

**Objection:** The draft correctly refuses to trust cached world coordinates, but the phrase “resolve the locator and revalidate in core” leaves both locator shape and cost undefined (`registration-stations.md:222-232,443-449`). A nearest-neighbor search over a 134-million-cell image or 500-million-point cloud would be neither exact nor interactively bounded. MI-D5 requires an exact provider/core path and makes unresolved a valid result (`measure-inspect.md:809-820`); the existing viewer can sample raster depth but does not prove a canonical Builder source-point resolver (`packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:2259-2357`). Without immutable direct addressing, the click path is an aspiration.

**Proposed resolution:** Version the locator union. Structured range uses source content hash plus scan/image ID, row, and column; cloud-derived depth uses source content hash plus immutable partition/chunk ID and point ordinal (and any lossless import-member discriminator). Resolution must be direct/indexed, verify the recipe/source/placement generations, retrieve that exact stored point, and return Unresolved on mismatch or absence; nearest-neighbor substitution is forbidden. State memory and latency budgets: hover uses only resident cells, click shows busy feedback within 100 ms, direct resolution is cancellable and reports progress if storage fetch exceeds 250 ms, and no full-source scan is allowed. Gate cold-cache, evicted-chunk, stale-hash, deleted-source, and cancellation behavior as well as coordinate equality.

### 10. The “hundreds of stations” class has no batch planning, reservation, scheduling, or recovery contract

**Severity:** Major

**Contract question:** D1 — Does the contract stay bounded for the requested class, rather than only for one large member?

**Objection:** The draft exposes a batch regeneration action and correctly specifies per-job checkpoints, but its extreme evidence covers only one 500-million-point source (`registration-stations.md:91-119,451-490,615-667`). It does not define multi-selection/all-eligible discovery, aggregate disk reservation, concurrency, deterministic scheduling, duplicate-source sharing, per-station failure isolation, batch cancellation, or restart after process loss. Hundreds of stations can exceed disk even when each individual estimate passes, and unrestricted concurrent builders can violate the bounded-RSS promise.

**Proposed resolution:** Add a visible multi-select and “Build missing/stale depth images” flow backed by one canonical batch plan. The plan lists eligible/ineligible stations, source/profile, per-item and aggregate peak disk estimates, current free-space margin, deterministic order, and explicit confirmation. Use a calibrated worker cap (default one heavy builder until evidence permits more), bounded queues, content-addressed source sharing, per-station checkpoint/result states, cancel-current/cancel-remaining choices, and resume that skips completed artifacts after hash verification. Reservation failure starts nothing. One batch history entry may group UI intent, but artifact lifecycle and retry remain per station. Add 100-station gates for aggregate refusal, process loss, one corrupt member, cancellation response, resume, and bounded RSS/disk.

### 11. Registration thresholds, extreme completion, export, and feedback budgets are left as uncalibrated variables

**Severity:** Major

**Contract question:** D1 and X6 — Are the numbers actual defaults and limits with calibration evidence, or merely parameters?

**Objection:** The core proves real robust-fit and point-to-point ICP code, including a 2,048-sample-per-cloud ceiling (`crates/himmelcad-core/src/registration.rs:18-19,343-416,510-635,1093-1177`). The draft has unusually concrete RSS, scratch, progress, and cancel limits, but it exposes robust-fit/ICP thresholds without freezing shipped defaults, unit-aware ranges, validation, or a calibration plan (`registration-stations.md:365-420`). Its 100-link class has no first-progress or total-completion budget. Report export is classified long-running without time, RSS, disk, progress granularity, cancellation residue, or restart behavior. The current progress callback occurs after correspondence work, so the asserted cancel-observation limit is not yet supported by the cited implementation. X6 specifically forbids arbitrary calibration.

**Proposed resolution:** Add a versioned registration profile whose shipped defaults, units, ranges, and validation are explicit; seed it from the current implementation only as a measured baseline, not as domain truth. Define a calibration corpus spanning scale, density, overlap, noise, outliers, weak geometry, and 1/10/100 moving links; publish accuracy, false-ready, runtime, memory, first-progress, and cancellation distributions and use them to freeze defaults. Require chunked cancellation checks inside correspondence construction, not only per completed iteration. Add preview and 100-link budgets for first feedback, steady RSS, completion, and cancel latency. For report export, stream rows, reserve a bounded temporary destination, expose bytes/rows and current phase, delete or mark incomplete output on cancel/failure, and gate worst-case report size. Persist the exact profile and effective values in the immutable report.

### 12. Fourteen gate names are not executable verification obligations

**Severity:** Major

**Contract question:** E3 — Could an implementer execute the acceptance gate today from an in-repo artifact?

**Objection:** The draft does provide valuable failable criteria, but expressly says no runner or capture exists and none of the fourteen gates is claimed passed (`registration-stations.md:615-667`). No gate has a repository script path, fixture manifest, deterministic seed, output/capture path, timeout, owner, or CI/planner task. This fails E3 even though E1 is satisfied: prose evidence is in-repo, but the claimed gates cannot be run or fail.

**Proposed resolution:** Before Specified, create a checked-in registration/stations verification manifest that maps every `G-RS-*` ID to an exact runner/test target, fixture hashes and licenses, deterministic seed, timeout, expected machine-readable assertions, screenshot/audit capture path where applicable, and CI/planner task. Provide separate core, command/automation, renderer/browser, persistence/restart, and performance targets rather than one opaque end-to-end script. Mark unavailable fixtures or harness work as explicit Pending registry obligations; do not call the identifiers gates until their commands exist. Require the review report to record command, revision, environment, and output artifact for each eventual pass.

### 13. Station View has automation-readable angles but no visible numeric input parity

**Severity:** Major

**Contract question:** B3 and C1 — Can direct manipulation, numeric UI, keyboard, and automation reach the same orientation state?

**Objection:** The draft defines direct drag, wheel zoom, presets, and `view.station.*` state/commands, but no visible numeric control for yaw, pitch, or FOV (`registration-stations.md:200-237,464-466,505-538`). Reading or setting values only through automation does not let a survey user reproduce an exact orientation. This is the same parity class that the gold-standard viewing-box specification closes with shared canonical fields and commands.

**Proposed resolution:** Add a design-system Station View orientation popover or Properties card with editable yaw, pitch, and vertical FOV plus Reset and named presets. Show project angular units while storing canonical values, validate/wrap/clamp explicitly, commit one undoable orientation gesture, and keep fields synchronized during drag/wheel. Direct manipulation, keyboard stepping, visible fields, and generated commands must call the same canonical command/state reducer. Add parity gates that reach and serialize the same values through each path and restore them after close/reopen.

### 14. Closing during a long ICP run forces the workspace to remain captive

**Severity:** Major

**Contract question:** B2 and D1 — Can a user safely leave a long-running flow without either losing work or waiting in place?

**Objection:** The draft treats ICP as a main-owned job and gives progress/cancel behavior, but its close path offers cancel-and-close or keep working in the registration workspace; it does not provide a background continuation/reopen path (`registration-stations.md:185-198,393-420`). That becomes untenable for the defined 100-moving-resource class. Renderer reload tolerance does not compensate for a foreground workspace that remains captive until the job finishes.

**Proposed resolution:** Add `Continue in background` for ICP. The session remains canonical in the main process, appears in Jobs with reference/group/member count, phase, progress, cancel, and Reopen actions, and reopens to the exact active link and review state. Snapshot immutable resource generations, pair observations, and effective parameters at launch. If they become invalid before readiness, finish as Needs attention and return that link to Coarse with a precise reason; never apply automatically. Closing or renderer restart must not change job identity. Gate backgrounding, unrelated editing, reopen, stale-input completion, cancellation, and process restart policy.

### 15. The Perspective evidence does not establish the “structured range panorama” mechanism the draft attributes to it

**Severity:** Major

**Contract question:** A2 — What does the cited source establish, what is an inference, and was that distinction corrected before the specification used it?

**Objection:** `docs/builder-program/dossiers/trimble-perspective.md:103-127` and its measurement source establish that points may be picked on scan data in Station, Map, or 3D views. The dossier's W5 wording at `:182-187` upgrades that observation to “picking runs against the station's structured range panorama,” but the cited source does not disclose that implementation and the dossier does not label the statement as inference. The reviewed draft repeats it as grounding for structured-range measurement (`registration-stations.md:297-305,441-449,731-741`). This is precisely the evidence-precedes-spec failure the current Function Contract forbids. The product may and should implement exact structured locators under X1 and S16, but a competitor UI source cannot be made to prove an unseen storage mechanism.

**Proposed resolution:** Correct the dossier first: retain the observed claim that measurement works on scan data in Station View; mark structured-range resolution as an inference or absence and record the source limit. In this specification, ground the exact-locator requirement in X1, S16, MI-D5, and the Builder's versioned source schema, not in a hidden competitor implementation. Add a fixture-backed proof that each valid depth cell resolves to the exact imported source record. Re-run every Perspective citation against the corrected dossier before this review can pass.

### 16. RealWorks catalog rows are summarized instead of dispositioned at sub-capability granularity

**Severity:** Major

**Contract question:** A2 and X4 — Did every observed catalog capability receive Adopt, Adapt, Defer, or Reject with a conflict-based reason?

**Objection:** The RealWorks Cloud-Based Registration row includes automatic “magic wand,” manual Pan/Rotate alignment, pairwise picking, Refine, visual check, and Apply Group (`docs/builder-program/dossiers/realworks.md:38-61,168-175`). The draft adopts pairs, ICP/refine, review, and group commit, but never says whether automatic seed generation or manual pan/rotate alignment is Adopted, Adapted, Deferred, or Rejected (`registration-stations.md:259-296`). Separately, the Project tree row includes batch rename patterns (`realworks.md:42-48`), while the draft defers batch rename merely “until repeated evidence.” Repeated evidence is not X4's bar; an observed reference behavior is the default unless it conflicts with higher doctrine, and an automation-only loop is not visible UI parity.

**Proposed resolution:** Split the Cloud-Based Registration row into its observed sub-capabilities. Adapt automatic seed generation as an explicit optional coarse-suggestion command that never reaches Ready or commits without review; adopt pairwise picking/refine/visual review/apply group; and either adopt constrained manual rotate/translate with numeric parity or reject it because unconstrained manipulation would violate the rigid, auditable model—state the actual conflict. Adopt multi-select batch station/group rename with preview, deterministic collision handling, one transaction, cancel-before-commit, undo, and generated command parity, or record a specific correctness/security/ownership conflict. Update the dossier-row table one row/sub-row at a time and add evidence IDs to gates.

### 17. The RealWorks absence check is not dossier-wide

**Severity:** Minor

**Contract question:** A2 — When absence is used as evidence, was the whole dossier searched and was the search range recorded accurately?

**Objection:** The depth-lifecycle disposition says the absence search covered RealWorks “anywhere in §§1-7” (`registration-stations.md:307-311`), but the current dossier also has §8. The searched concept does appear absent from the complete document, yet the recorded range fails the dossier-wide-absence rule and cannot support a formal absence claim as written.

**Proposed resolution:** Re-run and record a whole-file search over the current dossier revision, including §8 and the source ledger, with the terms and synonyms used (depth/range image, station raster, cache/artifact, build/regenerate, stale/invalidate, checkpoint/resume, NoData). State the result as dossier-wide absence, not evidence that the competitor lacks the feature. Repeat after any dossier revision used by the spec.

### 18. `main.rs` proves that raw registration methods exist, not that they are private

**Severity:** Minor

**Contract question:** A3 — Does each code citation prove the exact claim made about the implementation and boundary?

**Objection:** The catalog's code claim at `registration-stations.md:26` cites `crates/himmelcad-sidecar/src/main.rs:1316-1317` for raw registration dispatch, but those lines dispatch `photolab.gcp.*`; the actual registration prefix dispatch is at `main.rs:1323-1324`. The second range, `:1896-2106`, is real import-bound handler code, but it still does not by itself establish the Agent/Python privacy boundary. That boundary is established by the accepted owner contracts (`docs/builder-program/specs/agent/agent.md:625-633`; `docs/builder-program/specs/import-formats/import-formats.md:615-632`). The draft therefore contains both a wrong file:line citation and an overclaim about what the handler proves, even though its intended P11 boundary is correct.

**Proposed resolution:** Correct the dispatch range to `main.rs:1323-1324,1897-2106` and use it with `import_registration_runtime.rs` only for existence and import-staging semantics. Cite AG-D4 and IF-D12 for non-public status. Add an automation negative test that raw `registration.*` is rejected and a positive enumeration test that only generated `pointcloud.registration.session.*` and the other registered public commands are exposed.

## Registry-obligation audit

| Obligation | Authoritative current state | Draft behavior | Verdict |
| --- | --- | --- | --- |
| `view.station` | Deferred in `REGISTRY.md:75`; VD-D11 still defers it | Claims full ownership | **Fail:** registry and incumbent owner not revised |
| `derived.recipe-manage` | Shared row owned through MT-D25 at `REGISTRY.md:270` | Uses recipe lifecycle but queues its specialization | **Fail:** consuming semantics and common-delta equivalence are not landed |
| `file.import` / raw import registration | Public import remains `file.import`; raw `registration.*` stays import-private | Preserves the intended public boundary | **Pass in intent:** repair the code citation in Finding 18 |
| Input gesture and cursor arbitration | Current UI maps import-time registration, not this post-import workspace | Adds a local map and queues UI edits | **Fail:** no authoritative arbitration row |
| P11 generated command ownership | Current Agent/Automation owner list omits this domain | Names generated commands locally | **Fail:** exact command table and registry rows are absent |
| Schema implication | No accepted registry ownership row exists for this domain | Marks new entities/recipes/reports as contractual | **Fail:** schema row cannot advance before ownership lands |
| Point Cloud PC-D17/PC-D18 boundary | Point Cloud cites this exact owner and retains sampling semantics | Cites rather than re-dispositions sampling | **Pass:** reciprocal semantics are already aligned |

## Code-claim audit

The cited implementation substrates are real rather than stubs: robust fitting and ICP exist in `crates/himmelcad-core/src/registration.rs:343-635`; import-stage session, preview, commit, cancel, and progress paths exist in `crates/himmelcad-sidecar/src/import_registration_runtime.rs:33-119,404-588`; raw dispatch exists in `crates/himmelcad-sidecar/src/main.rs:1323-1324,1897-2106`; the E57 path retains image/panorama provenance while leaving depth unbuilt in `crates/himmelcad-io/src/e57_import.rs:3-17,1229-1288,1612-1674`; `PanoramaGeometry` is a real entity-model type at `crates/himmelcad-core/src/entity_model.rs:44,750-759`; and the WGPU viewer has real depth registration/sampling substrate at `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:2259-2357`. The draft's statement that `docs/TRANSFORMATIONS.md:29` is stale is correct: the repository now contains tested ICP even though that document still says not to advertise it. The only material code-citation failure found is the wrong dispatch range plus privacy overclaim in Finding 18. The draft correctly marks the five product functions absent/partial rather than counting any substrate or stub as the finished function. None of these substrates proves the missing Builder orchestration, persistence, ownership, or acceptance gates.

## Dossier-row audit

| Evidence slice | Row coverage | Audit result |
| --- | --- | --- |
| RealWorks §2.1 import/project/station rows | Every row is named | **Partial:** the Project tree row hides the batch-rename sub-capability behind an X4-invalid defer rationale (Finding 16) |
| RealWorks §2.2 registration/georeference rows | Every row is named | **Partial:** the Cloud-Based Registration row aggregates Automatic, manual Pan/Rotate, pairs, Refine, visual check, and Apply instead of dispositioning each (Finding 16) |
| RealWorks cross-area measurement, markers, output, and navigation rows | Relevant rows are named and their incumbent owners retained | **Pass**, except the recorded absence range omits dossier §8 (Finding 17) |
| Perspective §§2.1-2.7 station/view/color/marker/NoData/limit-box/selection/measurement/filter rows | Every relevant row is named | **Partial:** the disposition imports W5's unsupported structured-range mechanism (Finding 15); Area and Magnify/filter distinctions are otherwise explicit |
| Dossier-wide depth-lifecycle absence | Perspective §§1-7 cover its whole current dossier; RealWorks §§1-7 do not | **Fail for RealWorks only:** repeat against the entire file including §8 |

## (a) Contract questions answered convincingly

- **B3 — Surface choice and parity intent:** The draft identifies Project tree, context menus, workspace, Inspector/Properties, Jobs, status, and generated-command surfaces, and it avoids a hidden import-only entry. Finding 13 is a remaining numeric-input omission, not a failure to identify the relevant surface classes.
- **D2 — Weak-hardware degradation:** The ordering is correct: reduce optional visual/preview work, keep loaded interaction responsive, and never relax registration or measurement correctness. The station-depth checkpoint direction also follows X2/P10.
- **E1 — In-repository failable criteria:** V1-V12 and the `G-RS-*` descriptions are stored in the repository and state observable failure conditions. They are not executable gates yet (Finding 12), but they do satisfy the narrower E1 question.

All other contract questions are either directly failed above or only partially answered and therefore receive no credit here.

## (b) Executed versus read

**Executed:** Read-only repository inspection only: file enumeration/search, line-numbered source inspection, cross-reference searches, and working-tree/status checks. The only mutation was creation of this review file. No Builder binary, browser fixture, unit/integration test, benchmark, verifier, build, formatter, migration, capture, or product interaction was executed. Consequently, no runtime behavior or performance claim is marked verified by this review.

**Read:** `.claude/agents/demanding-user.md`; `docs/CURRENT-DIRECTION.md`; `docs/README.md`; all of `docs/FUNCTION-CONTRACT.md`; all of `docs/DECISION-DOCTRINE.md`; `docs/AGENT-FEEDBACK.md`; `docs/DESIGN-SYSTEM.md`; `docs/builder-program/README.md`; `OWNER-DECISIONS.md`; relevant and cross-cutting rows of `REGISTRY.md`; accepted ADRs 0021 and 0025; the full reviewed draft; the gold-standard `view/viewing-box.md`; prior reviews for Viewing Box, Point Cloud, and Measure/Inspect; the relevant View, Point Cloud, UI/Properties, Agent/Automation, Import/Export, Shared Editing, Mesh/Terrain, Measure/Inspect, and File/Project contracts; all cited RealWorks and Perspective dossier rows/source ledgers; the registration core/runtime/desktop dispatch and automation allowlist; E57 entity/import code; panorama/viewer depth substrate and fixtures; and `TRANSFORMATIONS.md`. Official Trimble help was consulted only to check the dossier attribution; it confirmed the observed ability to pick scan data in Station View but did not establish the dossier's claimed hidden structured-range implementation.

## (c) Owner-decision items

**Count: 0.**

No genuine doctrine conflict, product-identity choice, scope/budget/licensing boundary, or reserved owner boundary blocks resolution. The following are derived, vetoable program decisions, not escalation questions:

1. Land registry and reciprocal owner edits before changing this document to Specified.
2. Model one-to-many registration as independently reviewable moving links under one atomic transaction.
3. Reuse SE-D3/SE-D20 placement-consumer behavior and restore the entire affected set on undo/redo.
4. Narrowly amend ADR 0025 so reviewed manual observations may exist in immutable audit reports while recipes and sampled ICP points remain non-replayable/transient.
5. Treat registration-group visibility as P9 bulk application unless the P9 resolver is explicitly extended.
6. Preserve station-depth artifacts across a proven common rigid co-transform; invalidate on every non-equivalent change.
7. Make source locators direct, immutable, generation-checked, and non-substituting.
8. Adopt a bounded, resumable batch planner for hundreds of station-depth products and calibrate every shipped registration default.

If the owner vetoes one of these, the veto must identify the doctrine/precedent conflict and supply the replacement contract; it should not reopen the already-answerable question without new evidence.

## System feedback

No Function Contract question or X1-X7 doctrine axiom failed to do its job. A2 exposed the unsupported Perspective mechanism and incomplete catalog dispositions; A3 exposed local ownership without reciprocal edits; C2 exposed the missing one-to-many state model; C4/E2 exposed the incomplete transaction; and D1/E3 exposed labels without calibrated or executable gates. One specialization defect did surface: MT-D25's unconditional “any placement revision means stale” rule is too coarse for a derived artifact expressed wholly in a frame that receives the same rigid delta as all of its sources. P10 and X2 already decide this case in favor of a cheap exact remap, so the repair belongs in MT-D25 as a verified placement-equivalence hook; no new doctrine axiom or contract question is needed.
