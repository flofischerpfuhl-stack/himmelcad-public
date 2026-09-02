# PhotoLab release polish — implementation plan

Status: execution plan, 2026-09-01. Source of truth for the findings is the
six-part PhotoLab audit (UX walkthrough, multi-mission/merge, Metashape gap,
robustness/R1 gates, power-user review, hands-on run) performed 2026-09-01.
Every work package below carries its audit evidence as `file:line` anchors;
anchors are as of commit `0674e49` and may drift.

Execution model:

- Implementation: Codex (`gpt-5.6-sol`, reasoning effort high) via
  `codex exec`, one work package per run, sequential — most packages touch
  `crates/himmelcad-sidecar/src/{main.rs,project_runtime.rs}` and
  `apps/photolab/electron/main.ts`, so parallel runs would collide.
- Review, verification, and follow-up fixes: the coordinating Claude session
  reviews each diff, runs the named acceptance tests, and either fixes or
  re-dispatches before the next package starts.
- Hard constraints for every package: do not touch `apps/builder` (a separate
  agent works there); English UI only (`check-photolab-english-ui.mjs` must
  pass); design tokens only; no new dependencies without a note in the PR
  description; follow `docs/FUNCTION-CONTRACT.md` for user-facing surfaces;
  respect ADR boundaries (no chunk model, no network processing, batch never
  interactive per ADR 0021).
- Commit per package with a conventional message; do not push.
- Two-lane coordination (binding since 2026-09-02, owner decision Q1 →
  Branch A): `docs/builder-program/COORDINATION.md`. This lane owns
  PhotoLab paths and the PhotoLab-only sidecar/core modules; shared
  substrate (packages/@himmelcad/\*, render core, core entity/document/
  protocol modules, himmelcad-io, sidecar `main.rs`, schemas, sdk,
  verification scripts, root configs) is edited only after announcing files
  and intent to the Builder session and announced again when landed. The P11
  command table, job registry, base controls and gesture map are implemented
  once in the Builder lane; this plan supplies rows and gates. Cargo builds
  use `CARGO_TARGET_DIR=target/photolab` (export it before `git commit` so the
  hook inherits it; e2e and export drivers point at `target/photolab/debug`).
  A failing PhotoLab release gate has priority on shared resources.

Phases are ordered by product value; inside a phase, packages are ordered by
dependency. "Size" is an implementation-effort estimate (S < 2h, M ≈ half
day, L ≈ 1–2 days, XL = investigation-bounded).

---

## Phase A — Deliverables and accuracy (P0 vs Metashape)

### WP-A1 — LAS/LAZ point-cloud export and camera export (Size L)

Problem. Product export is a verified byte copy only
(`crates/himmelcad-sidecar/src/project_runtime.rs:3792-3940`): dense/sparse
clouds export as PLY, camera/calibration export bails
(`project_runtime.rs:3929`). `himmelcad-core/src/photolab_batch.rs` already
declares `ExportFormat::{Las, Laz, E57}` unused. Clients (TBC, Civil 3D,
RealWorks) require LAS/LAZ; PLY float32 loses millimetres at 6-digit eastings.
A LAS 1.2 writer already exists as intermediate
(`dense_raster_prep.rs:248-290`); the `las` crate (with `laz` feature) is
already a dependency of `himmelcad-io`.

Design.

1. Sidecar: add a `format` parameter to the product-export RPC
   (`photolab.products.export`, dispatch `main.rs:3073-3104` →
   `product_export.rs:55`). For `dense`/`sparse` accept `ply | las | laz`
   (default `laz` for dense). Implement a streaming PLY→LAS/LAZ transcoder in
   a new `crates/himmelcad-sidecar/src/pointcloud_export.rs`: read the fused
   binary-LE PLY (validator exists, `mvs_runtime.rs:1429-1595`), write LAS 1.4
   point format 2 (RGB) via the `las` crate with proper scale (0.001) and
   offset (bbox min), and the project CRS as WKT VLR (the frozen canonical WKT
   is available from the CRS runtime; reuse the WKT that raster export already
   validates, `raster_runtime.rs:2039-2046`). Keep the operation cancellable
   (token check per chunk) and atomic (write to temp, rename).
2. Camera export: replace the bail at `project_runtime.rs:3929` for alignment
   entities with a COLMAP-text export (writer exists,
   `alignment_merge_runtime.rs:590-592`) packaged as
   `{name}-cameras/cameras.txt|images.txt|points3D.txt`, plus a
   `calibration.json` per calibration group (params + which were refined).
3. Electron: `exportExtension()` in `apps/photolab/electron/main.ts` gains the
   format choice; the save dialog offers filters (LAZ default, LAS, PLY, E57
   greyed/absent for now). Renderer: extend the tree-context export call
   (`EntityTree.tsx:261-271` consumer in `App.tsx:2722-2783`) to pass the
   chosen format.
4. E57 export is explicitly out of scope for this package (no writer exists);
   remove it from any UI enum it would leak into.

Acceptance criteria.

- Exporting the smoke dense cloud as LAZ yields a file `pdal info`/`lasinfo`
  can read with correct point count, RGB, scale/offset, and CRS WKT.
- Camera export of a published alignment round-trips through
  `mvs_scene.rs` COLMAP reader.
- Cancel during export leaves no partial file at the destination.
- New Rust unit tests: transcoder header/scale/offset/CRS, cancellation, and
  camera-export content; existing `product_export.rs` tests still pass.

### WP-A2 — Processing report v2: survey content + determinism (Size L)

Problem. The report is an audit ledger, not client evidence: no GSD, no
camera-calibration tables, no GCP residual map, no human-readable processing
parameters (only SHA-256 hashes); `generatedAt` defaults to `new Date()`
(`apps/photolab/renderer/src/processingReport.ts:48`) and the caller never
pins it (`PhotolabBottomPanel.tsx:497-509`), so identical inputs never produce
byte-identical reports; `buildProcessingReportHtml` has zero tests. Mask-scope
and tool-version lineage exist in records but are never rendered
(`project_runtime.rs:737-761` omits them; sparse rows hardcode
`processing_set_id: None` at `:3728-3731`).

Design.

1. Sidecar: extend `ProjectProductDatasetRecord` with
   `image_mask_scope_sha256` and `tool_versions` (from `tool_manifest_sha256`,
   `brush_version`, `GdalAudit`); fix the sparse-cloud branch to carry its
   stored `processing_set_id`. Add a `photolab.report.surveyData` query
   returning per-alignment: GSD estimate (mean ground resolution from camera
   height/focal or sparse-point spacing), per-calibration-group adjusted
   intrinsics with sigmas where the GCP optimization snapshot has them, and
   per-point GCP residual vectors with 2D positions.
2. Renderer `processingReport.ts`:
   - `generatedAt` becomes a required input; the caller pins it from the
     snapshot it renders (project save timestamp or explicit user action time)
     so re-export of the same state is byte-identical.
   - New sections: survey overview (image count, GSD, area from footprint
     bbox), camera calibration per group (f, cx, cy, k1–k3, p1, p2 + sigmas,
     "refined vs fixed" flags), processing parameters rendered from the frozen
     configs (profile names and knob values, not only hashes — hashes stay as
     an audit annex), GCP residual map as inline SVG (point positions, scaled
     residual vectors, control vs check colouring per design tokens), product
     table gains mask-scope hash + tool versions.
3. Tests: a golden test for `buildProcessingReportHtml` with a fixed input
   fixture asserting byte-identical output across two invocations and the
   presence of every section; wire it into a real `test` script (see WP-F1).

Owner default encoded here (flagged, veto possible): one report artifact with
survey content first and the audit ledger as annex — not two separate
documents.

Acceptance criteria: byte-identical re-export; all new sections render with
the smoke dataset; golden test green; english-ui check green.

### WP-A3 — Reachable true 3D mesh product (Size XL, investigation-bounded)

Problem. Only the 2.5D DEM terrain mesh is reachable
(`main.rs:5915-6043`, `mesh_tiler.rs`); COLMAP Poisson/Delaunay meshing is
dead code (`ColmapProductRequest::default()` all false,
`colmap_runtime.rs:265-275`, sole caller `main.rs:4743`;
`mesh_texturer` idle). Facade/close-range work — the multi-mission use case —
cannot produce a mesh.

Design (staged):

1. Stage 1 (this WP): wire a `meshSource: dem | dense` option into the mesh
   product (`productConfiguration.ts:41`, `ProductPanel.tsx`). For `dense`,
   run COLMAP `poisson_mesher` on the fused dense cloud (binary is vendored;
   add the invocation to `colmap_runtime.rs` behind the existing kill-loop
   supervision), then feed the resulting PLY through the existing
   `prepared_triangle_mesh_ply.rs` tiler for the viewer, and publish with the
   same 5-tuple lineage. Decimation via the existing stride path; texture via
   vertex colours in stage 1 (the ortho-drape texturer stays DEM-only).
2. Stage 2 (separate follow-up WP, not this one): image-based texturing and
   hole filling.
   Cancellation/checkpoint: poisson_mesher is one child process — cancellable by
   kill, no mid-stage checkpoint (matrix entry stays "restart stage").

Acceptance criteria: mesh-from-dense of the smoke dataset publishes, renders
in the viewer, exports as PLY; cancellation kills the child within bounds;
lineage validated; DEM-mesh path unchanged (golden viewer test still green).

### WP-A4 — Ground classification for a real DTM (Size L)

Problem. DTM is a class filter (`raster_runtime.rs:116-134`) over classes the
in-house dense cloud never has — DTM output is a declared primary product
(PHOTOLAB-CONCEPT.md:22) but effectively a DSM.

Design. Implement SMRF (simple morphological filter) as a post-fusion,
cancellable, deterministic pass in the sidecar (new
`ground_classification.rs`): grid minimum surface → progressive morphological
opening with slope threshold → classify points ground/non-ground; parameters
(cell size, slope, max window) exposed on the DEM product config with
surveying defaults; classification stored as LAS class 2 in the fused cloud
artifact (and carried into WP-A1 LAZ export). The DTM raster path then
filters on class 2 as it already does. No ML classifier in this package
(Metashape-parity multi-class stays a reserved follow-up).

Acceptance criteria: on the smoke dataset the DTM differs from the DSM over
elevated objects; unit tests on a synthetic scene (plane + boxes) assert
ground recall/precision bounds; deterministic across two runs (hash-equal
class array); cancellable.

### WP-A5 — Golden-gate accuracy investigation (Size XL, evidence-gated)

Problem. The repo's own parity gate has never passed: best 135-image run
0.9657 px vs the 0.8299 px Metashape reference
(`docs/photolab-agisoft-golden-dataset.md:226-230`).

Design. This is an investigation, not a feature: run the 135-image Quality
Hybrid pipeline (manual, after the product chain is idle), then iterate on
the known levers in order of expected yield: (1) enable the unwired
GNSS-reference pair preselection (`himmelcad-core/src/photolab_matching.rs`
has ~1,200 lines with no production caller — wire `Reference` preselection
into `main.rs:4880-4900` pair planning as an opt-in profile field first);
(2) raise feature budgets for the quality profile; (3) verify per-group
intrinsics freezing is not harming the solve (interacts with WP-D2);
(4) mapper settings (BA iterations, refinement toggles). Each iteration
records `result.json` evidence under `.build/` per the golden doc's protocol.
Codex implements the wiring; the accuracy runs and judgement stay with the
reviewing session + owner.

Acceptance criteria: the wiring lands behind profile opt-ins with unit tests;
gate passage itself is an evidence milestone, not a merge criterion.

### WP-A6 — GPU enablement assessment (Size XL, decision package)

Problem. CPU is hardcoded everywhere (COLMAP `Cpu` at `main.rs:4716`, DeDoDe
`Cpu` at `main.rs:4787`, portable MVS rejects GPU
(`himmelcad-portable-mvs.rs:76-80`)); documented 6.6–8.4× slower than the
Metashape reference machine.

Design. Deliver a short feasibility memo + minimal safe wiring, not a broad
port: (1) probe whether the vendored COLMAP build carries CUDA support; if
yes, thread the existing hardware probe (`hardware_runtime.rs:115,158`) into
`ColmapExecutionMode` selection with a conservative allowlist (CUDA ≥ minimum
VRAM) and a config kill-switch; (2) DeDoDe ONNX: enable CUDA execution
provider when `onnxruntime` GPU libs are present, else CPU fallback —
strictly optional, never a new required runtime; (3) portable MVS GPU stays
out of scope (own project). Every GPU path must degrade to today's CPU path
with identical outputs gated by the determinism tests.

Evidence gathered 2026-09-02 (read-only probes, no code change):

- Vendored COLMAP 4.1.0 (`vendor/colmap/linux-x64/bin/colmap`) reports
  "without CUDA"; `ldd` links no CUDA libraries. The `--FeatureExtraction.use_gpu`
  flag exists but has no backend, so no in-place toggle is possible — GPU
  support means a new hash-pinned COLMAP runtime built with CUDA (ADR 0013
  inventory, licence and size review), for Linux and Windows separately.
- DeDoDe's packaged ONNX Runtime 1.24.4 exposes only
  `CPUExecutionProvider` (plus Azure); a CUDA execution provider requires
  shipping `onnxruntime-gpu` and its CUDA/cuDNN closure — again a runtime
  artifact decision, not a flag.
- The portable MVS worker declares itself the CPU reference worker
  (`himmelcad-portable-mvs.rs:78`).
- Development machine: Quadro M2200, 4 GiB VRAM, driver 580 — compute
  capability 5.2, which current CUDA 12 toolchains only support with
  explicit legacy targets; not representative of user hardware.

Conclusion: WP-A6 is an owner decision about shipping CUDA-enabled runtimes
(build effort, ~1 GiB extra payload, licence inventory, Windows parity),
not an engineering task inside this plan. The safe code-side preparation —
threading the hardware probe into an execution-mode selection with a
kill-switch — only pays off once such runtimes exist, so it is deferred
until the owner decides.

Acceptance criteria: on a non-GPU machine nothing changes (CI-provable); on
the dev machine the smoke alignment uses GPU when allowed and produces a
result passing the existing contract tests; kill-switch documented.

---

## Phase B — Resume, shutdown, and job-owner integrity

### WP-B1 — Wire the checkpoint sink; make `interruptedRecoverable` real (Size M)

Problem. No production worker calls `context.checkpoints.record*` (sole
caller is the unit test `job_runtime.rs:1177`), so `last_checkpoint_sequence`
is always `None` and every interrupted job reports "Restart the operation; no
committed checkpoint was recorded" (`project_runtime.rs:6161-6167`) even when
resumable MVS/raster/batch checkpoints sit on disk.

Design. At each durable checkpoint write, report it: MVS tile checkpoints
(`mvs_runtime.rs:415-448`), raster step markers (`raster_runtime.rs:604-609`),
batch step commits (`main.rs:4196-4203`), brush recovery checkpoints
(`brush_runtime.rs:264`) call the job context's checkpoint sink with
`{sequence, stage, config_hash, input_hash}`. `mark_interrupted_jobs` then
classifies genuinely resumable kinds as `interruptedRecoverable`. Do not
report checkpoints for kinds with no cross-restart resume (alignment, mesh) —
their label must stay "Restart required" (truth-in-UI).

Acceptance criteria: kill during MVS → reopen shows `interruptedRecoverable`
with the checkpoint sequence; kill during alignment → still plain
interrupted; unit tests per kind; the swallowed cancelled-checkpoint write
for merge (`main.rs:3442-3454`) becomes an error-logged, retried write.

### WP-B2 — Resume UX: one-click resume + splat resume (Size L, depends B1)

Problem. "Resume available from checkpoint N" renders with no action
(`PhotolabBottomPanel.tsx:754-769`); no `photolab.jobs.resume` RPC exists;
brush resume machinery is complete but hardcoded off (`resume: None`,
`main.rs:6663`); raster checkpoints are keyed by an ephemeral renderer UUID
(`App.tsx:1873`) so re-runs never find them.

Design.

1. Sidecar: new RPC `photolab.jobs.resume { historyJobId }` that reloads the
   frozen `{kind, configHash, inputHash}` job record, revalidates identity
   exactly like the e2e gate, and resubmits with the stored configuration —
   no renderer-side reconstruction. For raster, derive the checkpoint key
   from `{kind, configHash, inputHash}` instead of the operation UUID so a
   resubmitted identical job finds its markers. For brush, thread
   `recovery_checkpoints()` into `prepare_brush_product_job` when the resume
   flag is set.
2. Renderer: a "Resume" button on `interruptedRecoverable` job rows calling
   the new RPC; remove `pauseRequested`/`paused` from the UI vocabulary (no
   worker supports pause — honest UI per concept) or leave them behind a
   capability flag defaulting off.
3. Move the resume-identity rejection currently living in the e2e harness
   (`scripts/photolab-e2e.mjs:897-904`) into the sidecar for aliked/sift/
   dedode/mapper/splat: the resume RPC is the single place that enforces it.

Acceptance criteria: kill during splat training → relaunch → Resume button →
training continues from the checkpoint iteration (log-provable); changed
config → resume rejected with the mismatch field; e2e-contract suite
extended and green.

### WP-B3 — Shutdown/close drain and child reaping (Size L)

Problem. Close/open/create request `cancel_all` but never await terminal
states; `clean_shutdown` is stamped while workers may still run
(`main.rs:3058`, `project_runtime.rs:5560-5579`); stdin-EOF shutdown neither
cancels nor kills (`main.rs:1039-1042`); no signal handler; external
COLMAP/MVS/brush children are orphaned on sidecar exit.

Design.

1. `JobManager::drain(deadline)` = cancel_all + await all workers terminal
   with a bounded deadline (workers already kill children in sub-second
   loops, so 20 s is generous); project close/open/create/replace call drain
   before touching the manifest; `clean_shutdown = true` only after drain.
2. Main loop: on stdin EOF and on SIGTERM/SIGINT (tokio signal handler), run
   drain, then close.
3. Child lifetime: spawn external workers in their own process group and
   deliver the kill to the group (unix: `setpgid` + negative-pid kill;
   windows: Job Objects via `windows` crate or `CREATE_NEW_PROCESS_GROUP` +
   `TerminateJobObject` — keep it minimal), so even a sidecar SIGKILL leaves
   no orphans where the OS supports it; at minimum, normal shutdown paths
   reap everything.
4. Electron `before-quit` (`apps/photolab/electron/main.ts:2285-2289`) waits
   for the sidecar drain acknowledgement (bounded) before quitting.

Acceptance criteria: integration test — start a long MVS job, close the
project → no `himmelcad-portable-mvs` process survives and the job record is
terminal before `clean_shutdown`; kill -TERM the sidecar mid-alignment → no
COLMAP orphan; existing cancellation tests green.

### WP-B4 — Same-target admission + unify side-channel operations (Size M)

Problem. No same-target conflict check (two jobs publishing to the same
entity are admitted, last-writer-wins); disk budget unchecked; six operation
families (image commit, CRS, LAS import, archive, capture, automation) run
outside the JobManager — invisible to `jobs.list`, uncovered by `cancel_all`
(concept lines 99-117 violated).

Design. (1) Admission: compute a publication-target key per job (entity id /
product kind + lineage target) at `JobManager::start`; reject queueing a job
whose target collides with a queued/running job (`ConflictingTarget` error
surfaced in UI). (2) Disk: preflight free-space check against a per-kind
estimate; fail early with an actionable message. (3) Side channels: register
archive and image-commit operations as lightweight JobManager entries (state

- cancel routing) so `cancel_all`/drain covers them; CRS/LAS/capture/
  automation keep their own cancel but get drain hooks. Full migration of all
  six families into `PhotolabJobKind` is out of scope; the drain hook is the
  contract.

Acceptance criteria: queuing two DEM builds on the same alignment rejects the
second with a clear message; project close during an archive save cancels it
(existing archive-cancel tests extended); unit tests for the target-key
collision logic.

### WP-B5 — Journal/manifest ordering + orphan-dataset GC (Size M)

Problem. PhotoLab writes the journal entry before the manifest
(`project_runtime.rs:4769-4770`) and never replays the journal → silent
lineage divergence after a crash between the two writes; a crash between the
dataset-dir rename (`:4667`) and the manifest write leaves orphan
`datasets/*` dirs that existence-based heuristics misread as published
(`:5786,5814,5832,5893`).

Design. (1) Reverse the order: manifest write commits the operation, journal
entry follows; on open, verify the last journal sequence against the manifest
generation and log+repair (re-emit the missing journal entry from the
manifest state — the journal is evidence, so re-emission is honest if marked
`recovered: true`). (2) Open-time GC: any `datasets/*` dir not referenced by
the manifest is moved to `tmp/orphaned/` with a log line, and the cleanup
heuristics switch from directory existence to manifest lookup. (3) Windows:
implement `sync_dir` via handle flush where available instead of the no-op
(`canonical_project_store.rs:1805-1808`) — best effort, documented.

Acceptance criteria: fault-injection tests (write journal, crash before
manifest → open repairs; rename dataset, crash before manifest → open
quarantines); existing 41 project_runtime tests green.

### WP-B6 — Error-swallowing cleanup (Size S)

Problem. Material `let _ =` / `.ok()` sites: cancelled-checkpoint write for
merge swallowed (`main.rs:3442-3454`, covered in WP-B1), materialized camera
map silently degrades to empty (`main.rs:4527-4529` — silently changes
alignment inputs), corrupt project records silently skipped
(`project_runtime.rs:2478-2491,7460-7634,6046-6056`), durable history retried
only inside `list()` (`job_runtime.rs:637-668`).

Design. Camera-map read failure becomes a hard job-preparation error; corrupt
record parses log a structured warning with the file path and surface a
project-diagnostics counter ("N unreadable records") instead of silence;
history persistence gets a background retry tick independent of `list()`.

Acceptance criteria: corrupt-record fixture surfaces in
`ProjectDiagnosticsPanel`; camera-map corruption fails the job with an
actionable message; unit tests for each.

---

## Phase C — UX blockers and app polish

### WP-C1 — Factory alignment presets + first-run path (Size S)

Problem. Fresh install: empty `.hcalign` dropdown, Start disabled with no
reason (`AlignmentProfilePanel.tsx:195,262-268`); the explanatory error is
unreachable (`App.tsx:1765-1767`).

Design. Ship three read-only factory presets (Fast / Quality Hybrid /
Maximum Robustness) generated from `alignmentPreset.ts` defaults, listed
first in the dropdown with a "built-in" badge (source: packaged resources
dir, merged in `alignmentPresets` listing in `electron/main.ts:929-981`);
user files layer on top; when nothing is selected, preselect Quality Hybrid.
Disabled-Start always shows its reason inline (also covers the unconfirmed-
groups case which already has copy). Batch alignment steps reference the same
presets instead of a bare profile enum (resolves the doctrine contradiction,
`BatchConfiguratorPanel.tsx:108`, `batchRecipe.ts:8-9`).

Acceptance criteria: fresh profile → open Align Photos → Start enabled with
Quality Hybrid; preset provenance visible; batch step shows preset picker;
`alignmentPreset` tests extended (and made runnable via WP-F1).

### WP-C2 — GCP height transform: implement or fail honest (Size M)

Problem. The GCP wizard asks "Transform height?" and collects vertical CRS
pairs, but commit always hardcodes `preserveValues`
(`GcpImportPanel.tsx:480-485,1742-1757`) — a metric trap contradicting
PHOTOLAB-CONCEPT.md:35-36.

Design. Implement it: the CRS runtime already builds vgridshift pipelines
(`crs_runtime.rs:756-764`); route the GCP commit through
`photolab.crs`-resolved height transformation when the user chose transform
(same frozen-operation mechanism the image import uses), storing both source
values (immutable) and transformed values with the operation hash. If any
grid is missing, the wizard blocks commit with the existing grid-coverage
error pattern — never silently preserve. Remove the "audit UI only" branch.

Acceptance criteria: DHHN2016→ellipsoidal test vector transforms within
tolerance (use the golden grid fixtures in `photolab/01_Transformation`);
choosing "no transform" labels heights with their CRS; sidecar test +
renderer wizard test.

### WP-C3 — Session restore, recent projects, close guard, recovery surface (Size L)

Problem. Every dev launch silently creates `Untitled-<ts>.hcad` (13 litter
files observed); after relaunch the previous project is not reopened
(hands-on `26-relaunch.png`); no recent-projects UI (`main.ts:1096-1105`,
memory only `main.ts:1671-1702`); window close has no unsaved guard
(`main.ts:479`) despite "Autosave: local · N"; crash recovery is a console
log (`App.tsx:866-872`).

Design.

1. Reopen last project in dev exactly as packaged builds do (drop the
   dev-clean special case `main.ts:1074-1076` behind an env flag).
2. Welcome state: when boot has no last project, show a lightweight welcome
   card in the empty viewport (New project / Open / recent list from a
   persisted MRU of 10) instead of silently creating Untitled; Untitled is
   created on first import action instead.
3. Close guard: intercept `window:close`; if the working copy has unsaved
   generations, show the shared ConfirmationDialog (Save and close / Close
   without saving / Cancel).
4. Recovery: when `opened.session.recoveryAvailable`, show a non-modal banner
   "Recovered unsaved changes from <time> — Keep (default) / Discard" wired
   to the existing recover flag.
5. GC: on boot, offer to clean Untitled projects older than 14 days with zero
   images (count shown, explicit confirm).

Acceptance criteria: relaunch reopens the previous project with images/GCPs
intact (hands-on repro); close with unsaved changes prompts; recovery banner
appears after a simulated crash (kill -9 electron during autosave interval);
english-ui + dialog-policy checks green.

### WP-C3b — Close semantics per doctrine D1/X7 (Size S, supersedes the WP-C3 close guard)

Problem. WP-C3 shipped a "Save and close / Close without saving / Cancel"
prompt when unsaved autosave generations exist. Owner decision D1
(`docs/builder-program/OWNER-DECISIONS.md`) rejects exactly this classic
dirty-flag pattern for the project-lifecycle class, and doctrine X7 binds the
class across products: PhotoLab's working copy is already durable (30 s
autosave, always-on recovery, recovery banner since WP-C3, drain before
close since WP-B3), so the prompt claims a data-loss risk that does not
exist.

**Decision:** No close prompt. Window close and quit run the drain, flush
the working copy, and close; the status bar affirms "All changes stored ·
<time>" (bounded-lag durability indicator per P5) and shows a loud failure
state if the flush fails. Save (Ctrl+S) stays as the universal affordance
(P6) and means durability flush; its dropdown offers "Save As…" = `.hcadx`
archive copy to a chosen path, and "Save snapshot…" is deferred until
PhotoLab adopts named journal snapshots (WP-B5 follow-up).
**Derivation:** D1 + X7 (class precedent), X1 (durability is already a
correctness property of the working copy), P5/P6, `docs/PROJECT-FORMAT.md`
(archive = copy, working copy = truth).
**Rejected:** keeping the prompt (contradicts D1; asks the user to decide
about a loss that cannot happen); removing Save (P6).
**Tunable:** indicator lag budget (X6; reuse FP-D2's value once set).

Implementation: delete the close-guard prompt path from WP-C3
(`closeGuardDecision` becomes a durability-flush wait with a bounded
deadline), keep the ConfirmationDialog extension only where a genuinely
destructive choice remains (Discard recovery), add the stored-indicator copy
and failure state, update `projectLifecycle.test.ts` accordingly, and record
the D1 alignment in `docs/PROJECT-FORMAT.md` if it still describes
PhotoLab close differently.

### WP-C4 — Product prerequisite validation + GCP revision selector (Size M)

Problem. Product Start is enabled with zero alignments; failures surface only
as raw console errors (`SidecarRpcError: no completed sparse alignment…`,
hands-on `22`); `valid()` checks numeric ranges only
(`ProductPanel.tsx:305-312`). Products silently pin the latest GCP revision
with no display or choice (`App.tsx:1822`, `main.rs:3529`).

Design. (1) `ProductPanel` queries the same candidate list the input selector
uses; when prerequisites are missing, Start is disabled with the reason
("Run an alignment first — Products need a published sparse alignment") and a
link-button jumping to Align Photos. RPC failures on Start render as an
inline panel error (message from the sidecar code map), not console-only.
(2) A GCP-revision row in `ProductPanel` (default "Latest converged —
<operationId> · <hash8>", dropdown of converged revisions, same pattern as
`AlignmentMergePanel.tsx:48-61`), passed explicitly through `startProduct` to
the sidecar which then pins it instead of resolving latest. Batch configurator
gets the same field per product step. (3) The freeze becomes visible: before
start, the panel shows the resolved alignment entity + hash ("This run will
freeze: …"), satisfying PHOTOLAB-CONCEPT.md:93-95 interactively.

Acceptance criteria: fresh project → Products disabled with reason; two GCP
revisions → both selectable, report shows the pinned one; sidecar test that
an explicit revision id is honored; renderer test for the disabled logic.

### WP-C5 — Video import UI (Size M)

Problem. Complete dead backend: `capture.selectVideo` preload
(`preload.ts:104-106,312-314`), main handler (`main.ts:1311-1330`), five
`photolab.capture.*` RPCs allowlisted (`main.ts:243-247`), ffmpeg extraction
implemented (`capture_runtime.rs:448-577`, `photolab_capture.rs:526`) — zero
renderer callers; `capture` missing from `global.d.ts`.

Design. Ribbon Images → "Video Frames…": select video → sidecar
`capture.capabilities` + `video.prepare` → a small FloatingTaskIsland flow:
frame-selection parameters (interval / max frames / sharpness gate from the
capture scale evaluation), preview counts, then feeds the extracted frames
into the existing image-import inspect→commit wizard (frames are just images
with synthesized metadata; local-metric per ADR 0023 when no GPS). Add the
`capture` namespace to `global.d.ts`. Cancel wired to `capture.cancel`.

Acceptance criteria: an mp4 fixture yields N frames imported through the
normal wizard; cancel mid-extraction leaves no partial commit; english-ui
green; the mixed-selection filter keeps excluding video from the image picker
(the flows stay separate).

### WP-C6 — One batch surface (Size L)

Problem. One button opens two rival surfaces with incompatible file formats
(`App.tsx:329-340,3294-3308,3611-3641`; pipeline `formatVersion:1` vs recipe
`formatVersion:2`); the node canvas is decorative (`batchRecipe.ts:38-104`);
batch cannot express GcpOptimize/Export/Report although core types exist
(`himmelcad-core` `BatchStageConfig`); "Queue" shows no queue; `startBatch`
toggles the bottom panel closed (`App.tsx:1886`).

Design (owner default, veto possible: the configurator panel wins).

1. `batch.configure` opens only the `BatchConfiguratorPanel`. The
   `BatchRecipeDialog` node canvas is demoted to a read-only "Pipeline
   preview" rendered from the panel's current pipeline (edges drawn from step
   dependencies), opened via a button inside the panel; its file format dies —
   a one-time loader migrates `formatVersion:2` recipe files into pipeline
   files on open.
2. Add the missing stages to the panel: GCP optimize (pinned snapshot
   selector per WP-C4), Export (per-product format from WP-A1 + output path
   template validated at configure time), Report (renders WP-A2 report to a
   target path). All three map to existing core `BatchStageConfig` variants.
3. `startBatch` forces the bottom panel open like every other starter; the
   scope-value encoding is unified (`processing-set:` everywhere).

Acceptance criteria: evening workflow queueable end-to-end (optimize → depth
→ dense → DEM → ortho → export LAZ+GeoTIFF → report) and runs unattended on
the smoke dataset; legacy recipe file loads with a migration notice;
`batchRecipe` tests updated (runnable via WP-F1).

### WP-C7 — Agent panel crash fix (Size S)

Problem. Opening Project → Agent throws
`ERROR · DISCOVERYFAILED — … 'automation:agent:request': TypeError: Cannot
read properties of undefined (reading 'split')` twice (hands-on `29`), an
unhandled main-process exception when no harness/API key is configured.

Design. Find the `.split` on an undefined config value in the automation-host
discovery path (`@himmelcad/automation-host` / the `automation:agent:request`
handler in `apps/photolab/electron`), guard it, and return a typed
"not configured" result the renderer renders as a friendly empty state
("No agent runtime configured — set … to enable") instead of a raw error.

Acceptance criteria: opening the Agent panel with no configuration shows the
empty state, zero console errors; a regression test on the handler with empty
config.

### WP-C8 — QC loop closure + workspace navigation (Size L)

Problem cluster. Accuracy-table rows are rendered clickable but the callback
is never passed (`GcpAccuracyPanel.tsx:107-111` vs
`PhotolabBottomPanel.tsx:99`); observation creation is right-click-only and
unhinted (`ImageWorkspace.tsx:1020-1076`); the Optimize panel never shows
which alignment it optimizes (`App.tsx:1896-1952`); no image filmstrip —
tree-only navigation for 500+ images (`ImageWorkspace.tsx:218-299`);
checkpoint auto-reassignment is silently pre-applied
(`GcpOptimizationPanel.tsx:57`).

Design. (1) Thread `onSelectPoint` through `PhotolabBottomPanel`: clicking a
residual row selects the GCP, opens the GCP-images filter, and jumps the
workspace to the worst-residual image. (2) A small toolbar hint in the image
workspace ("Right-click to place a marker") plus a toolbar button entering
place-marker mode. (3) Explicit alignment selector atop
`GcpOptimizationPanel` (same source as product inputs; shows name, processing
set, camera count); the started snapshot pins it. (4) Filmstrip: a
virtualized thumbnail strip below the image workspace (thumbnails via the
existing image preview pipeline), synced with tree selection; arrow-key
navigation documented in a tooltip. (5) Checkpoint suggestion becomes an
explicit chip ("No check points assigned — suggest 2 spatially distributed?"
→ Apply), not a pre-applied default.

Acceptance criteria: residual click lands on the correct image with the
marker highlighted; 800-image project scrolls the strip at 60fps-ish
(virtualized — no full-list render); optimize panel shows and pins the chosen
alignment; renderer tests for the selection threading.

### WP-C9 — Fit-and-finish batch (Size M)

One package for the verified small items, each a one-liner-to-small fix:

- Import: mixed `.hcap`+images selection → split and route both paths
  (`App.tsx:1112-1115`); combined-transform stubs fail _before_ data entry
  (disabled cards with explanation, `ImageImportPanel.tsx:726-746`,
  `GcpImportPanel.tsx:517-522`); mode-`none` workflow restore lands on review
  not operations (`ImageImportPanel.tsx:988-993`); GCP workflow save moves
  from localStorage to the `workflows` file API with success feedback
  (`GcpImportPanel.tsx:677-711`, `importWorkflow.ts:145-157`); Germany
  fallbacks (bbox + BETA2007) get an inline "assumed region: Germany" notice
  (`GcpImportPanel.tsx:1672-1718`).
- Copy/branding: "Batchprocessing" → "Batch processing" (`App.tsx:3182`);
  "Depth-Index/Depth-Tile HTTP" (`ImageWorkspace.tsx:120,516`); "HimmelCAD" →
  "Himmel:CAD" in title bar + report (`App.tsx:3084`,
  `processingReport.ts:64,68`); ALL-CAPS role labels → sentence case
  (`GcpImportPanel.tsx:1766-1768`); unlocalized `toLocaleString()` → pinned
  `en-US` (`PhotolabBottomPanel.tsx:274`, `ImageImportPanel.tsx:1233`,
  `GcpImportPanel.tsx:686`).
- Jobs UI: CANCELLED badge neutral not green; progress text spacing ("0% of
  stage · overall 7%"); terminal-job dismiss/clear action (`App.tsx:1609`);
  tab force-stealing gets a per-session "don't auto-switch" toggle
  (`App.tsx:1548-1580`).
- Tree/viewport: sorted images and GCPs; empty-viewport hint ("Import images
  to begin"); pre-alignment content — render camera GPS positions and GCPs as
  simple markers once import commits (data exists; viewport currently black,
  hands-on `19`); investigate+fix the spurious "Image could not be loaded"
  error after commit.
- Ribbon: `alignment.define` and `batch.configure` become proper toggles
  (`App.tsx:331-336`); properties show raw enums humanized ("needsReview" →
  "Needs review"); `ImagePropertiesPanel` orientation as yaw/pitch/roll with
  matrix tooltip and both RTK sigmas labeled (σH horizontal / σV vertical).
- CaptureGroups: preserve calibration-split drafts across selection changes
  for still-selected cameras; default name "Calibration group 1"
  (`CaptureGroupsPanel.tsx:47-50,91-93`).

Acceptance criteria: english-ui + visual-regression + dialog-policy suites
green; each fix has at least a targeted assertion where a test harness
exists; hands-on re-run of the import flow shows sorted tree, viewport
markers, no spurious error.

---

## Phase D — Multi-mission correctness and teachability

### WP-C10 — GCP grid-kind normalization parity (Size S, found 2026-09-02)

Problem. `gcpImportDecision.ts` `userGrid()` builds a `GridCatalogEntry`
without `normalizeGridKind`, so a GDAL-mislabeled `.gsb` stays
`kind: 'gtg'` in the GCP freeze payload while the image import path
normalizes it to `'ntv2'` (`importFreeze.ts`). `containsArea` is also
duplicated three times with identical bodies (`ImageImportPanel.tsx`,
`gcpImportDecision.ts`, `GcpImportPanel.tsx`).

Design. Route the GCP wizard's user-grid construction through the shared
`normalizeGridKind` from `importFreeze.ts`; dedupe `containsArea` into the
same module; add a test that a mislabeled `.gsb` freezes as `ntv2` on both
paths. This changes the GCP freeze payload for mislabeled grids only — that
is the fix, not a regression.

Acceptance criteria: both wizards produce the same `GridCatalogEntry` for
the same file; existing gcpImportDecision and importFreeze tests green.

### WP-D1 — Georeferencing after overlap merge (Size L)

Problem. GCP optimization only resolves `EntityKind::AlignmentRun`
(`project_runtime.rs:6448-6461`) via latest-per-processing-set
(`main.rs:4464-4471`); no optimization can target a merged run, so overlap-
merged products proceed with `(None, None)` GCP lineage
(`main.rs:5624-5637`) — silently non-georeferenced; no UI warning
(`AlignmentMergePanel.tsx:167-171`).

Design. (1) Extend GCP optimization dataset resolution to accept a published
`MergedAlignmentRun` (its solved COLMAP model is on disk,
`alignment_merge_runtime.rs`); the optimize panel's alignment selector
(WP-C8) then lists merged runs. Intrinsics policy per calibration group
carries over from the union partition. (2) Until (1) lands, and as a
permanent guard: the merge panel and product panel show an explicit warning
chip on overlap merges without a downstream optimization ("Overlap merge is
in an arbitrary frame — run GCP optimization on the merged result before
building georeferenced products"); products with georeferenced kinds
(DEM/ortho) refuse an overlap-merge source lacking a converged optimization
unless the project is declared local-metric (ADR 0023).

Acceptance criteria: two-mission overlap merge → optimize on merged run →
DEM carries GCP lineage (report shows it); without optimization, DEM start is
blocked with the actionable message; sidecar tests for merged-run resolution.

### WP-D2 — Per-group intrinsics refinement in alignment/merge (Size L)

Problem. Refinement is a run-wide binary: if any group has full embedded
calibration, all groups freeze (`main.rs:4840-4856` — `_profile` unused →
`ba_refine_* = 0,0,0`, `colmap_runtime.rs:2903-2913`). An overlap merge of a
DJI mission + uncalibrated camera freezes the uncalibrated group. The
Auto/Prior/Fixed/Custom policy exists only in GCP optimization
(`photolab_gcp_optimization.rs:1443-1556`).

Design. COLMAP supports per-camera refinement only coarsely, so implement the
honest version: (1) group the run's cameras by policy outcome; if groups
disagree (some Fixed, some Auto), run the joint solve with refinement ON and
re-pin Fixed groups afterwards via a constrained re-bundle in the in-house
GCP/BA code (which already supports per-group masks) — or, where no GCP data
exists, run COLMAP with refinement ON but seed Fixed groups' intrinsics and
restore them post-solve with a pose-only re-triangulation pass; record which
strategy ran in the artifact. (2) Wire the per-group policy into
`prepare_alignment_job`/merge preparation so the run-wide binary disappears;
the policy editor in CaptureGroupsPanel becomes effective for alignment, not
just optimization. This is the riskiest correctness package — the reviewing
session must validate on the golden smoke evidence that single-mission
results are bit-comparable to today.

Acceptance criteria: mixed merge (embedded + no-seed groups) refines the
no-seed group (params move from defaults, artifact records it) while the
DJI group's params stay pinned within tolerance; single-mission runs
unchanged vs baseline; unit tests on the policy→strategy mapping.

Status 2026-09-02: implemented (`bundle_adjuster` path; capability probed).
Remaining, deliberately not shipped: the in-house per-group-masked pose-only
fallback for workers without `bundle_adjuster` — an unverified second
definition of "adjusted" was judged worse than an actionable failure on a
branch the vendored runtime cannot reach. Reopen only if a shipped worker
lacks the capability. ADR 0014 carries a dated amendment.

### WP-D3 — Merge quality evidence (Size M)

Problem. Post-merge feedback is a track count
(`project_runtime.rs:2888-2893`); no residuals in the merged frame; merges
silently inherit the global profile state (`App.tsx:214,2689-2695`); lineage
rendered as raw entity ids (`AlignmentMergePanel.tsx:145-152`).

Design. (1) Compute and store per-connection statistics in
`MergedAlignmentRunRecord`: cross-run track reprojection RMS (px), and for
shared-control merges the per-edge control misclosure E/N/H (m); render both
in the merge panel and the WP-A2 report. (2) The merge panel gets its own
profile selector (default Quality Hybrid) instead of inheriting hidden global
state. (3) A cheap pre-flight estimate for overlap merges: count candidate
cross-run image pairs from GPS footprints (when available) and warn below a
threshold before the expensive solve. (4) Human-readable lineage labels
(entity names + hash8) instead of raw ids.

Acceptance criteria: merged run shows RMS + misclosure; pre-flight warns on
the disjoint-footprint fixture; profile visible and frozen into the plan.

### WP-D4 — Calibration-group teachability + manual capabilities (Size M)

Problem. UI never teaches the concept (default names "Autofocus 1",
`CaptureGroupsPanel.tsx:47,91-93`); backend `Manual` grouping basis and
per-group `initial_calibration` seeds unreachable
(`project_runtime.rs:208-214,2288-2292` vs hardcoded
`captureGroupDraft.ts:14-21`); cameras outside any group silently pinned
Fixed (`main.rs:4549-4552`); confirmed groups permanently frozen with no
escape hatch (`project_runtime.rs:2330-2336`); the 120 s session gap is
invisible.

Design. (1) Inline help block in the panel (2–3 sentences: what a calibration
group is, when to split — links to docs); defaults renamed "Calibration
group N"; evidence strings kept. (2) Manual grouping basis surfaced: the
create-from-selection flow sends `groupingBasis: manual` when the user built
the partition; a per-group "Enter lab calibration…" expander writes
`initial_calibration` (f, cx, cy, k1–k3, p1, p2 + fixed/prior choice) —
Metashape-parity precalibrated entry. (3) Ungrouped cameras: the panel lists
them with a badge "Intrinsics pinned — group to refine"; single-image
sessions get an explicit note. (4) Escape hatch honoring immutability:
"Duplicate as draft" clones a confirmed group's partition into a new
unconfirmed draft covering the same images (new group version, old one
retired on confirm) — no mutation of confirmed records. (5) Auto-grouping
evidence shows the session-gap rule ("split at >2 min gap") so splits are
explainable, plus a "merge these two proposals" action while both are
`needsReview`.

Acceptance criteria: lab-calibration entry lands in the COLMAP seed
(sidecar test); duplicate-as-draft round-trip; ungrouped badge renders;
english-ui green.

---

## Phase E — QC and reference-data depth

### WP-E1 — Camera-calibration inspector (Size L)

Problem. Adjusted intrinsics are shown nowhere — only seed focal + a
diagnostics string; the intrinsics policy doc promises before/after
residual-field and parameter-correlation snapshots
(`docs/photolab-intrinsics-policy.md`) that `processingReport.ts` never had.
No surveyor can defend the calibration to a checker.

Design (owner default: transparency-first, not manual gradual-selection
parity). Per calibration group, after alignment and after each optimization:
a Calibration tab (in CaptureGroupsPanel or a properties surface) showing
adjusted f, cx, cy, k1–k3, p1, p2 with sigmas, the parameter correlation
matrix (heatmap, design tokens), before/after deltas vs the seed, and a
radial residual-field plot. Data source: the GCP optimization solver already
computes covariance (`photolab_gcp_optimization.rs` condition-gating);
COLMAP-only runs show point estimates with "sigmas require GCP optimization".
Feed the same tables into the WP-A2 report.

Acceptance criteria: after the smoke optimization, the inspector shows
plausible sigmas and a symmetric correlation matrix; report section renders;
snapshot-hash provenance displayed.

### WP-E2 — Observation QC: show the solver's work (Size L, depends E1)

Problem. No gradual selection, no way to see or act on bad observations; the
robust solver downweights silently.

Design. Also publish per-observation residual magnitudes (px) in the
accuracy payload so the accuracy-row → image jump (WP-C8c) can target the
worst image instead of the first observation. Surface the robust-loss outcome per optimization run: a QC list of
observations ranked by final weight/residual (image, GCP, px residual,
weight, flag "downweighted/rejected"), worst tie-point clusters, with actions
"open in image" (WP-C8 threading) and "exclude observation and re-optimize"
(writes an explicit exclusion record — journaled, undoable per WP-C9's
conventions). This delivers the QC loop without importing Metashape's
tie-point-deletion model; a full gradual-selection editor stays a reserved
follow-up if the owner rejects transparency-first.

Acceptance criteria: seeded-outlier fixture shows the outlier at the top with
a downweight flag; exclude → re-optimize improves checkpoint RMSE in the
fixture; exclusion recorded in report lineage.

### WP-E3 — Per-point GCP accuracy + code columns (Size S)

Problem. One default σ pair applies to the whole CSV
(`GcpImportPanel.tsx:245`); mixed RTK/total-station files are mis-weighted.

Design. Optional column mappings σH/σV (or σE/σN/σH) and code/description in
the CSV wizard (auto-detected like the coordinate columns); per-point values
freeze into the import; defaults remain the fallback for unmapped rows; the
accuracy panel shows the per-point σ used.

Acceptance criteria: mixed-σ fixture optimizes with per-point weights
(solver test asserts weight ratio); wizard preview shows the mapped columns.

### WP-E4 — Coverage/overlap visualization (Size M)

Problem. No way to judge block health at a glance (Metashape report page 2).

Design. Derive an overlap raster from sparse observations (per ground cell:
number of observing cameras), render as a viewport overlay layer after
alignment and as a figure in the WP-A2 report; camera footprints from
poses + mean ground plane. Pure read-model — no new job kind; computed on
demand and cached by alignment hash.

Acceptance criteria: smoke dataset shows an overlap map matching flight
geometry; report figure renders; toggle in the viewport layer list.

---

## Phase F — Tests, CI, packaging

### WP-F1 — Make the renderer test suite real (Size M)

Problem. `apps/photolab` has no `test` script; `alignmentPreset/batchRecipe/
importFreeze` tests are orphaned and unrunnable (`tsx` not a dependency);
`pnpm -r test` skips the app; `test-photolab-himmelcap-import` fails
pre-existing (asserts `apps/cap` must not exist — stale assumption).

Design. Add a `test` script (node `--experimental-strip-types --test` runner
matching the repo's script-test style, or vitest if the workspace already
ships it — prefer the existing pattern); fix module resolution in the three
orphaned tests; fix the himmelcap-import assertion to match reality (cap
exists); add the WP-A2 report golden test and WP-C1/C6 test extensions here.
Wire into the GitLab `node:test` job implicitly via `pnpm -r test`.

Acceptance criteria: `pnpm --filter @himmelcad/photolab test` runs and
passes locally and in the GitLab job; all previously orphaned tests execute.

### WP-F2 — CI executors for the release tier (Size M, infra-bounded)

Problem. `verify:release` (browser-gpu, real-data, linux-package,
windows-package) has no CI executor anywhere; the visual-regression audit is
hook-only with no pixel baselines; the real cancellation matrix is manual.

Design. Wire what CI can honestly run: a scheduled GitLab job for
`photolab-visual-regression.mjs` (headless chrome exists in the runner
image?) and the deterministic contract gates; add pixel-baseline comparison
(store baseline PNGs in-repo, compare with a pixelmatch threshold, explicit
update flow). `real-data` and native-windows stay operator-run — document the
cadence in TEST-TIERS.md instead of claiming CI. Do not overreach: an
honest "manual, documented" beats an aspirational CI claim.

Acceptance criteria: visual job green in CI on an unchanged tree and red on
a seeded layout regression; TEST-TIERS.md updated to match reality.

### WP-F3 — Accessibility baseline (Size S)

Problem. Zero a11y coverage.

Design. Add an axe-core pass to the visual-regression walk (each panel/tab
snapshot also runs axe with a filtered ruleset: contrast, labels, focus
order); fix the findings it reports in shared UI where trivial, list the
rest as tracked exceptions.

Acceptance criteria: axe pass wired and green with a documented exception
list; keyboard focus visibly reaches every ribbon tab and panel control.

### WP-F3b — Accessibility remediation at the root causes (Size M)

First full axe-core run (2026-09-02, 84 surfaces, both viewports): 766
critical + 2 035 serious findings, collapsing into four root causes —
`aria-required-parent` (588, 5 selectors: the shared entity tree nests
`treeitem` without `role="group"`), `label` (178, 14 selectors: shared
checkbox/radio/toggle inputs without accessible names), `color-contrast`
(2 033, 163 selectors: muted text, inactive tabs, panel headings and status
text below 4.5:1 — a theme-token issue), and `aria-progressbar-name` (2).
Remediation lives in `@himmelcad/ui` and `@himmelcad/theme` (shared with
Builder; behaviour-preserving). Exceptions are recorded only by the
reviewer. Acceptance: serious + critical at or near zero with every remainder
justified; layout invariants and pixel baselines regenerated afterwards.

### WP-F4 — Windows delivery and signing (owner decision, not codable)

Native-Windows install certification needs a Windows machine (ADR 0013
records Wine cannot certify NSIS); Authenticode/code signing needs a
certificate purchase. Both are operator/owner actions; the plan's only code
change: `sync_dir` Windows best-effort flush (folded into WP-B5) and keeping
the updater contract test green. Flagged for the owner; no Codex run.

---

## Phase G — Doctrine and gate closures (added 2026-09-02)

### WP-G1 — PhotoLab products open in Builder and WeltView (R1 gate 8)

Contract (accepted 2026-09-02, Builder program):
`docs/builder-program/specs/import-formats/import-formats.md` section
"PhotoLab product datasets — 2026-09-02", decision records IF-D19–IF-D25;
review `import-formats-photolab-review-2026-09-02.md` (4 blockers resolved,
0 owner questions). Implementation follows that text unchanged; contract gaps
are messaged to the Builder session (doctrine rule 2), never worked around.

Sequenced into three parts:

**WP-G1a — admission + PhotoLab publication (Size L, blocked on admission).**
IF-D22 requires DATA-MODEL, PROJECT-FORMAT and an accepted ADR to admit
`hcad.product-import-package-manifest@1` and
`hcad.photolab-product-provenance@1` before implementation (DATA-MODEL pending
item 8). Step 1: ADR 0030 drafted as a cite-and-adopt of the spec's exact
`ProductImportPackageManifestV1` / `ProductLineageV1` shapes, the
`package_sha256` canonicalization rule (sorted UTF-8 keys, no whitespace, no
floats, hash over the payload minus `package_sha256`), the ready-record
atomicity, fail-closed compatibility (`unsupported_package_schema`) and the
`complete | partial | unknown` states — reviewed by the Builder session.
Step 2 (after acceptance): every PhotoLab publication freezes
`ProductLineageV1` before the ready record and product record become visible
(mandatory fields per IF-D19: project id + fingerprint, product identity,
alignment id + version/content hash, processing-set tagged union with frozen
camera-selection hash, mask scope, GCP choice, exact spatialReference +
`ProjectReferenceFrame` or `local_frame`, ordered algorithm/config/tool
identities, registration audit); writes the candidate package, fsyncs manifest
and artifacts, then the small ready record with `package_sha256` last; the
product record mirrors the summary. `photolab.products.list` exposes
`provenanceStatus` and `missingFieldIds`; pre-contract publications report
`partial`/`unknown` and are never decorated from current state. Adopted
ingress formats only: `potree@2` (sparse/dense) and
`himmelcad-prepared-hierarchy@1` (DEM as canonical Grid, complete tiled mesh);
orthomosaic waits for RA-D11 `PlanGrid2D`, splat for Pointcloud ownership;
binary PLY, incomplete tiled meshes, standalone MVS depth and raw Brush PLY
stay unavailable with the spec's reasons.

**WP-G1b — Builder registration + WeltView (Size L, after WP-G2).** The two
P11 rows `io.import.product_dataset.list/register` with the exact
`ProductDatasetList/RegisterRequest/ResultV1` schemas (IF-D20) in the
generated command table; the existing registration island gains the product
chooser and the bounded, lock-scoped `.hcad`/`.hcadx` catalog reader
(IF-D23/24); Builder commits the declared entity plus the
`hcad.photolab-product-provenance@1` component journal-last; WeltView opens
the resulting `.hcadx` read-only through the canonical store/kernel (IF-D25).

**WP-G1c — gate test (Size M).** Per IF-D21: for every Available product row,
Builder registers and reopens, performs canonical Save As to a complete
`.hcadx`, WeltView opens it read-only; the test compares entity ids,
version/content hashes, prepared bindings, exact provenance bytes and the
row's render/pick/snap semantics. Gate 8 stays open until this passes for
every renderable product kind in the release.

### WP-G2 — PhotoLab automation parity (doctrine P11, re-scoped 2026-09-02)

Problem unchanged (no `photolab.*` operation reaches the agent or the Python
SDK; console vocabulary is hand-listed). Per `COORDINATION.md`, the one
generated command table is implemented once in the Builder lane. This
package therefore delivers PhotoLab's inputs and gates, not the table:

1. **Command rows** — for every UI-reachable PhotoLab operation (import
   inspect/commit, CRS discover/freeze, capture groups create/confirm/draft/
   merge, alignment start/resume/cancel, merge plan/preflight/run, GCP
   preview/commit/observation/optimize, product resolveInputs/start/export,
   report surveyData/export, project open/close/diagnostics, jobs list/status/
   cancel/resume): id, request/result schema (from the existing serde
   structs), job-or-transaction kind, cancel route, ADR 0024 trust class
   (user-only confirmation where a destination is overwritten). Delivered as
   `docs/photolab-automation-command-rows.md` (this lane's path) in the
   spec's row format.
2. **Gates** — a test that enumerates ribbon/panel actions against the row
   list (every UI-reachable operation has a row), and a Python-client smoke
   (import → align → optimize → product on the smoke dataset) that the
   Builder lane must run before the table is "done".
3. After the table lands: replace the hand-listed console switch in `App.tsx`
   with the generated vocabulary and remove any PhotoLab-private RPC exposure
   the table supersedes.

**Decision:** unchanged (P11: one generated table; no raw-RPC allowlisting;
approval/credential surfaces user-only). **Ownership:** rows and gates here;
table, router and SDK generator in the Builder lane.

## Tunables register (doctrine X6)

Every numeric threshold introduced by this plan is a delegated calibration
value: chosen with a rationale, recorded here, tightened with evidence, never
escalated. Constants in code should cite this section.

| Package | Value                                                                                                              | Rationale                                                                                                                                    | Evidence to tighten                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| WP-A1   | LAS scale 0.001 m, offset = bbox minimum                                                                           | Millimetre quantization matches survey deliverable precision; bbox offset keeps i32 range for 7-digit eastings                               | Compare against Metashape LAZ headers on the golden dataset                                              |
| WP-B3   | Drain deadline 20 s; Electron before-quit wait 25 s                                                                | Every worker kill loop is sub-second; 20 s covers checkpoint flush on slow disks; Electron waits slightly longer than the sidecar            | Measure drain latency in the cancellation matrix runs                                                    |
| WP-B2   | Job polling 500 ms (existing)                                                                                      | Interactive feel without saturating the RPC channel                                                                                          | Profile RPC load with 10+ terminal jobs listed                                                           |
| WP-C3   | Recent projects MRU 10; Untitled litter: > 14 days and zero images                                                 | Reference desktop products keep ~10 recents; two weeks is beyond any active session, zero images means no work                               | Owner usage; adjust if litter prompts annoy                                                              |
| WP-D3   | Preflight neighbour distance = mean nearest-neighbour spacing × 3; low-overlap warning < 10 candidate pairs        | ×3 spans two flight-line spacings on a regular grid; < 10 pairs cannot yield ≥ 3 verified tracks reliably                                    | Correlate preflight counts with actual verified cross-run tracks on merged datasets                      |
| WP-D2   | Triangulation-consistency bound after pinned re-adjustment (set in code)                                           | Registered images and 3D points must not collapse after re-bundling                                                                          | Golden-dataset before/after counts                                                                       |
| WP-A4   | SMRF cell size, slope, max window (to be set)                                                                      | Standard SMRF defaults for UAV GSD                                                                                                           | Synthetic scene precision/recall                                                                         |
| WP-F2   | Pixel diff threshold ≤ 0.1 % pixels, per-channel tolerance 16                                                      | Tolerates antialiasing jitter, catches layout shifts                                                                                         | False-positive rate over 20 CI runs                                                                      |
| WP-F2   | Baseline set: 2 viewports × 42 surfaces = 84 PNGs, ≈ 11 MB in-repo                                                 | Both layouts matter for the design system; measured run-to-run noise is 0 px                                                                 | Move baselines to Git LFS once their history exceeds ≈ 50 MB or churn exceeds one regeneration per week  |
| WP-B6   | Durable job-history retry tick 500 ms (`job_runtime.rs`); cancellation timing tests serialized behind a test mutex | Bounds memory-only terminal state without hot-looping a failing disk; strict deadline assertions stay meaningful only without CPU contention | Observe persist latency on slow disks; keep the mutex until the tests measure their own scheduling delay |

## Integration evidence — 2026-09-02 (Waves 1–4 on a fresh sidecar)

`scripts/photolab-e2e.mjs`, Sulzberg `01_Photos`, 24 images, `--smoke
--profile fast`, target `EPSG:31468+7837`, sidecar built from HEAD after
WP-A2 (all Wave 1–4 packages included):

| Stage                                                                 | Result                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import wizard → CRS freeze (WP-C2 height path) → atomic commit        | completed, 24 images, 17.9 s                                                                                                                                                                |
| Fast alignment (SIFT + mapper)                                        | completed, 727 s, published                                                                                                                                                                 |
| GCP preview → CRS discovery → freeze → commit                         | completed (optimization skipped: only 2 of the dataset's GCPs are measurable with 24 images; the script requires ≥ 3 — use all 135 images for the GCP scope)                                |
| Depth maps                                                            | completed, 1 379 s, job record `lastCheckpointSequence: 120`                                                                                                                                |
| Dense point cloud                                                     | completed, 52 s, 2 098 118 points, `lastCheckpointSequence: 120`                                                                                                                            |
| Dense export via `photolab.jobs.startProductExport { format: 'laz' }` | LAS 1.4 PF2, 2 098 118 points, 12.7 MB, scale 0.001, offsets = bbox min, COMPOUNDCRS DHDN/GK4 + DHHN2016 WKT, RGB present, finite coordinates, no leftover processes (laspy 2.7 validation) |

Alignment job records carry `lastCheckpointSequence: None` (honest: no
cross-restart resume). Not exercised in this run: kill-and-resume, merge, GCP
optimization (needs the 135-image scope), DEM/ortho/mesh/splat products.

### Robustness note — load-sensitive cancellation test (2026-09-02)

`brush_runtime::tests::cancellation_is_forced_within_the_interactive_deadline`
fails under concurrent CPU load (observed twice while an e2e run and a Codex
build ran) and passes 3/3 in isolation. Its deadline is a calibration value
(X6): either widen the fake-worker deadline with a rationale or serialize the
timing-sensitive tests behind a test-group lock. Tracked under WP-B6.

## R1-gate triage — 2026-09-02 late

Authority, stated precisely: the owner stated "PhotoLab production-ready in
the next two days" (`docs/CURRENT-DIRECTION.md`, Q1 section) and a hard
concern about token spend (`docs/builder-program/OWNER-DECISIONS.md` D8).
"R1 without scope growth, PhotoLab as a free funnel for Builder" is the
architect's recommendation (D9, strategy candidate awaiting the owner's go),
not yet an owner decision. The triage below is the sensible reading of the
owner's two statements; the owner can reverse any line, and D9's outcome will
be reflected here when it lands.

Reasoning effort for Codex dispatches (D8 derived decision, vetoable; the
owner's earlier instruction to this session was `high`): `medium` for
mechanical packages; `high` for design-heavy sidecar work (WP-G1a-2, WP-A3,
WP-B5) and for every review by the coordinating session.

| Package                                                                 | R1 gate                                                        | Decision                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| WP-F3 commit + pixel-baseline regeneration + `ConfirmationDialog` focus | gate 7 (accessibility, visual tests)                           | keep — next                                                                           |
| Hands-on re-test of the changed surfaces                                | gate 1 evidence                                                | keep                                                                                  |
| WP-E1 calibration inspector (in flight)                                 | gate 2 (accuracy evidence must be inspectable)                 | finish, no extension                                                                  |
| WP-A5 golden-gate levers (spatial pair selection)                       | gate 2                                                         | keep — evidence-bounded                                                               |
| WP-B4 same-target admission; WP-B5 journal ordering + orphan GC         | gate 3 + completion discipline (conflicts, recovery)           | keep                                                                                  |
| WP-A4 SMRF ground classification (DTM)                                  | gate 1 (DSM/DTM is a declared primary product)                 | keep                                                                                  |
| WP-A3 mesh from dense cloud, stage 1                                    | gate 1 ("textured terrain and spatial meshes" primary product) | keep, stage 1 only                                                                    |
| WP-G1a-2 / G1b / G1c                                                    | gate 8                                                         | keep — after the import-formats revision and the Builder-lane command table           |
| WP-G2 rows + gates (re-scoped)                                          | gate 8 prerequisite                                            | keep (document + G-1 test only)                                                       |
| WP-C6b batch stages (optimize/export/report)                            | none (convenience)                                             | **parked** — batch already runs unattended for the R1 product chain                   |
| WP-E2 observation QC editing                                            | none (Metashape parity)                                        | **parked** — per-observation residuals stay in the accuracy payload scope of WP-E1/A2 |
| WP-E4 overlap visualization                                             | none (parity)                                                  | **parked**                                                                            |
| WP-A6 GPU runtimes, WP-F4 Windows signing                               | owner decisions                                                | unchanged                                                                             |

## Execution order and review protocol

Waves (sequential Codex runs; the reviewing session verifies each before the
next starts):

1. **Wave 1 (quick wins + top deliverable):** WP-C7 → WP-C1 → WP-A1.
2. **Wave 2 (trust + robustness core):** WP-C2 → WP-B1 → WP-B2 → WP-B3.
3. **Wave 3 (product UX):** WP-C4 → WP-C3 → WP-C9.
4. **Wave 4 (multi-mission):** WP-D1 → WP-D3 → WP-D4 → WP-D2 (riskiest last).
5. **Wave 5 (QC + report):** WP-A2 → WP-E1 → WP-E2 → WP-E3 → WP-E4.
6. **Wave 6 (products depth):** WP-A4 → WP-A3 → WP-C5 → WP-C6.
7. **Wave 7 (foundation + tests):** WP-F1 (early parts pulled forward as
   needed) → WP-B4 → WP-B5 → WP-B6 → WP-F2 → WP-F3.
8. **Continuous/manual:** WP-A5 (accuracy runs), WP-A6 (GPU memo), WP-F4
   (owner).

Per-run review checklist (the reviewing session):

- `git diff` read in full; no `apps/builder` changes; no new deps unless
  declared; English UI check; typecheck; the package's named acceptance
  tests; `cargo test -p himmelcad-sidecar` for sidecar-touching packages
  (expect lock contention with the Builder agent — waiting is fine);
  targeted hands-on re-test for UX packages.
- Fix-forward small issues directly; re-dispatch to Codex with the review
  notes for structural misses; every package ends in one commit.
- Before any end-to-end run (`scripts/photolab-e2e.mjs`, export drivers):
  `cargo build -p himmelcad-sidecar --bins` from a clean HEAD. `cargo test`
  does not refresh `target/debug/himmelcad-sidecar` or
  `himmelcad-portable-mvs` (the package has no integration-test directory),
  so a stale binary silently tests old code; `cargo clean -p` removes the
  MVS worker entirely. Write e2e logs outside the `--output` directory —
  the script recreates that directory and unlinks anything inside it.

Owner-decision flags encoded as defaults in this plan (veto reverses the
package design, not the finding): report identity (WP-A2: one document),
batch surface (WP-C6: configurator wins), QC philosophy (WP-E1/E2:
transparency-first), pause UI removal (WP-B2), Untitled GC prompt (WP-C3).
