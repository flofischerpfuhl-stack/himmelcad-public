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
- Hands-on runs: `pnpm dev` for PhotoLab hardcodes
  `target/debug/himmelcad-sidecar` (`apps/photolab/electron/sidecar.ts`); the
  default lane is deleted to save disk, so symlink the lane binary there
  (`target/debug/himmelcad-sidecar → target/photolab/debug/…`) before a
  hands-on session. Do not "fix" the hardcoded path without the lane rule.

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

```text
Footer
- A1 outcome: The user exports survey-grade LAS/LAZ point clouds or COLMAP camera data from a published PhotoLab product.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Exports"
- A3 siblings: product tree export, raster export, and Builder product-dataset registration
- B1 reachability: ribbon — absent; context menu — present; console — absent; automation — P11 row `photolab.products.export` pending; shortcut — absent
- B2 open/close: the entity context action opens the native save dialog, which closes on Save or Cancel; Escape follows the platform dialog rung per UIP-D14
- B3 surface: inline + export needs a format choice and native destination dialog, not persistent viewport interaction
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: scale is fixed by the export contract and has no direct-manipulation peer; one selected published product is captured at launch; n/a because export reads immutable data; destination output is external and non-undoable while project state is unchanged
- D1 performance class: long-running + `pointcloud_export` cancellation tests and R1 gate 4; D2 degradation: streaming bounds memory and may reduce throughput, never coordinates, RGB, CRS, or atomicity
- E1 visual reference: `right-panel-properties.png`
- E2 conflicts/failure/crash: same-target admission rejects conflicting exports and atomic temp-to-destination publication leaves no partial file
- E3 verification: transcoder header/scale/offset/CRS, cancellation, camera round-trip, `product_export` regression, and R1 gates 1/4
- Decision record: cited unchanged: X1/X4/P11 and ADR 0030 lineage
- Evidence: `2163b67`; Integration evidence row "Dense export via photolab.jobs.startProductExport"; open — not executed: camera round-trip and destination-cancellation acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user exports one deterministic survey report whose readable evidence leads and whose audit lineage remains available as an annex.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Report"
- A3 siblings: bottom Report tab, GCP Accuracy panel, calibration inspector, and product lineage views
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.report.surveyData` and `photolab.report.export` pending; shortcut — absent
- B2 open/close: the ribbon toggles the report function and its explicit close action follows the function-tab rung per UIP-D14; the native export dialog closes on Save, Cancel, or Escape
- B3 surface: right panel + report configuration coexists with viewport and bottom-panel evidence
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: displayed survey values are read-only evidence with no manipulation peer; the frozen project snapshot rather than live selection is reported; the snapshot freezes report inputs for deterministic rendering; export is external and non-undoable while the pinned generation and lineage remain canonical
- D1 performance class: bounded + `photolab:test:processing-report`; D2 degradation: large tables/maps may paginate or simplify drawing density, never omit evidence or change values
- E1 visual reference: `function-report.png`
- E2 conflicts/failure/crash: report generation reads one frozen snapshot and atomic destination publication prevents mixed-generation or partial output
- E3 verification: `pnpm photolab:test:processing-report`, `pnpm photolab:check:english-ui`, smoke-report manual check, and R1 gate 3 byte comparison
- Decision record: inline Decision: ship one report with survey content first and the audit ledger as annex; Derivation: X1 and P7 require defensible evidence while treating layout as editable user convention; Rejected: two independently versioned reports because they can diverge and obscure one audit identity; Tunable: yes — section order and presentation are P7 defaults
- Evidence: `ec9cba0`, `90b4ddc`; adoption-audit executed evidence `photolab:test:processing-report` and `photolab:check:english-ui`; open — not executed: all sections on the smoke dataset
- Status: landed
```

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

```text
Footer
- A1 outcome: The user builds, views, and exports a true 3D mesh from a dense cloud for facade and close-range work.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Mesh / texture"
- A3 siblings: DEM terrain mesh, dense-cloud product, prepared mesh viewer, and Builder mesh registration
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 row `photolab.products.start.mesh` pending; shortcut — absent
- B2 open/close: the ribbon toggles the mesh function and explicit close follows the function-tab rung per UIP-D14; closing keeps an admitted job in the global jobs flow
- B3 surface: right panel + source, decimation, lineage, progress, and cancellation remain visible beside the viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: decimation is typed configuration with no drag peer; the chosen dense or DEM source is frozen at admission; the published prepared hierarchy is the baked immutable result; publication is canonical and journaled while cancelling before publication changes no project state
- D1 performance class: long-running + mesh smoke/cancellation gate and R1 gates 1/4; D2 degradation: decimation may reduce display density, never topology validity, lineage, or cancellation bounds
- E1 visual reference: `function-textured-mesh.png`
- E2 conflicts/failure/crash: same-target admission serializes publication, supervised child termination handles cancel, and ready-record-last atomic publication hides partial meshes
- E3 verification: dense-mesh smoke publish/render/export, child-reaping cancellation, lineage validation, DEM golden viewer regression, and G1c
- Decision record: cited unchanged: ADR 0021 and IF-D19–IF-D25
- Evidence: open — not executed
- Status: queued
```

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

```text
Footer
- A1 outcome: The user creates a DTM that excludes elevated objects and carries reusable ground classifications into LAZ export.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Depth maps / dense"
- A3 siblings: DSM/DTM product configuration, dense-cloud publication, raster generation, and LAZ export
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 row `photolab.products.start.dem` pending; shortcut — absent
- B2 open/close: the ribbon toggles the DEM function and explicit close follows the function-tab rung per UIP-D14; closing keeps an admitted job in the global jobs flow
- B3 surface: right panel + classification parameters and DTM/DSM intent must remain visible beside the viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: cell size, slope, and window are typed values with no drag peer; one frozen dense-cloud input is used; classification bakes an immutable class array for downstream reuse; product publication is canonical and journaled with no partial result on cancel
- D1 performance class: long-running + SMRF synthetic/determinism/cancellation gate and R1 gates 1/4; D2 degradation: weak hardware may take longer or use smaller chunks, never substitute DSM values for DTM
- E1 visual reference: `function-dem.png`
- E2 conflicts/failure/crash: same-target admission and atomic publication coordinate DEM writers; cancellation discards the candidate while immutable input survives
- E3 verification: plane-plus-box precision/recall, two-run hash equality, cancellation, smoke DTM-vs-DSM inspection, and G1c
- Decision record: inline Decision: use deterministic SMRF for release DTM and defer ML multi-class classification; Derivation: X1/X2 and the dossier "Depth maps / dense" row prioritize a truthful class-based DTM with bounded preprocessing; Rejected: labeling an unclassified DSM as DTM and adding an unlicensed opaque ML runtime; Tunable: yes — cell size, slope, and maximum window are X6 values
- Evidence: open — not executed
- Status: queued
```

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

```text
Footer
- A1 outcome: The user can select reference-aware quality processing and receive an accuracy result measured against the frozen 135-image gate.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Align photos" and `docs/photolab-agisoft-golden-dataset.md`
- A3 siblings: factory alignment presets, per-group intrinsics policy, and the golden-dataset evidence workflow
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 row `photolab.alignment.start` pending; shortcut — absent
- B2 open/close: the Align Photos ribbon toggle and close action follow the function-tab rung per UIP-D14; closing keeps the long job in the global jobs flow
- B3 surface: right panel + profile and opt-in levers must remain visible while the viewport and evidence update
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: feature budgets and mapper settings are typed preset values; the processing-set camera selection is frozen at start; frozen GNSS pair plans eliminate interactive recomputation; preset changes persist as named configuration while published runs are canonical and journaled
- D1 performance class: long-running + frozen 135-image Quality Hybrid R1 gate 2; D2 degradation: weak hardware extends preprocessing only and may not lower the frozen acceptance profile
- E1 visual reference: `function-align-photos.png`
- E2 conflicts/failure/crash: admission freezes inputs and rejects conflicting targets; supervised workers publish atomically or leave no canonical run
- E3 verification: reference-preselection unit tests, recorded `result.json` iterations, and the 135-image Quality Hybrid thresholds
- Decision record: cited unchanged: X1/X4/X6 and ADR 0014
- Evidence: open — not executed: Quality Hybrid 135-image acceptance; the recorded Fast diagnostic is a failed non-equivalent run
- Status: queued
```

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

```text
Footer
- A1 outcome: The user keeps deterministic CPU processing until a complete, licensed, cross-platform GPU runtime can accelerate it without changing results.
- A2 reference: unresearched
- A3 siblings: hardware capability probe, offline runtime inventory, COLMAP alignment, DeDoDe matching, and portable MVS
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — absent; shortcut — absent
- B2 open/close: n/a because this package is a runtime feasibility decision, not a user surface
- B3 surface: inline + any future execution-mode choice belongs inside existing processing configuration, not a separate surface
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: n/a until a GPU runtime is admitted; n/a because no entity selection is involved; capability probing is frozen per job; a future kill-switch is global configuration and not journaled
- D1 performance class: long-running + CPU/GPU parity, cancellation, inventory, and native-platform gates; D2 degradation: capability failure must fall back to identical CPU output, never change correctness
- E1 visual reference: none — open
- E2 conflicts/failure/crash: runtime selection freezes at admission and the existing supervised-job atomic publication contract remains binding
- E3 verification: non-GPU no-change CI, GPU smoke parity, kill-switch, license inventory, and Linux/Windows native runtime startup
- Decision record: cited unchanged: ADR 0013
- Evidence: `7c3fdbb` read-only probe record; open — not executed: GPU runtime parity, fallback, and kill-switch acceptance
- Status: parked (R1 triage: GPU runtimes require payload, licensing, and cross-platform admission and are not release-scope code)
```

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

```text
Footer
- A1 outcome: After a crash, the user sees whether each interrupted job can resume from a real committed checkpoint or must restart.
- A2 reference: adopted from UIP-D10/UIP-D11 and P5
- A3 siblings: durable Jobs list, MVS/raster/batch checkpoints, brush recovery, and project recovery banner
- B1 reachability: ribbon — absent; context menu — absent; console — present; automation — P11 rows `photolab.jobs.list` and `photolab.jobs.status` pending; shortcut — absent
- B2 open/close: the Jobs bottom tab opens from status/progress and closes through the bottom-panel toggle or function close rung per UIP-D14
- B3 surface: right panel + recovery state and actions must coexist with the project viewport and global job status
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: checkpoint sequence is read-only; the job row rather than entity selection is targeted; frozen config/input hashes determine resumability; job history and checkpoints persist across restart but do not enter document undo
- D1 performance class: bounded + checkpoint-recording unit tests and R1 gate 3; D2 degradation: slow disks may delay durable acknowledgement, never claim a checkpoint before its write commits
- E1 visual reference: `bottom-jobs.png`
- E2 conflicts/failure/crash: durable checkpoint recording and resume identity make crash state explicit; failed persistence is logged and retried
- E3 verification: per-kind checkpoint unit tests, kill-MVS/reopen classification, kill-alignment classification, and cancelled-checkpoint retry
- Decision record: cited unchanged: P5 and UIP-D10/UIP-D11
- Evidence: `068fdcd`; Integration evidence rows "Depth maps" and "Dense point cloud" record checkpoint sequence 120; open — not executed: kill/reopen classification acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user resumes a recoverable interrupted job with one action and gets an exact mismatch explanation when its frozen identity changed.
- A2 reference: adopted from UIP-D10/UIP-D11 and P5
- A3 siblings: Jobs bottom tab, checkpoint records, Brush recovery, raster markers, and batch resume
- B1 reachability: ribbon — absent; context menu — absent; console — present; automation — P11 row `photolab.jobs.resume` pending; shortcut — absent
- B2 open/close: Resume acts inline on a durable Jobs row; the Jobs surface closes through the panel toggle or function close rung per UIP-D14 while the resumed job continues
- B3 surface: inline + resume is a single capability-gated row action with mismatch feedback in place
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: checkpoint iteration is read-only; the selected history job is captured by id; config/input hashes are immutable resume identity; resume creates durable job history but does not alter document undo until atomic publication
- D1 performance class: long-running + kill/relaunch/resume R1 gate 3; D2 degradation: weak hardware only slows resumed work and cannot loosen identity validation
- E1 visual reference: `bottom-jobs.png`
- E2 conflicts/failure/crash: resume reloads frozen sidecar state, rejects identity mismatch, and publishes atomically after another interruption
- E3 verification: splat kill/relaunch/resume log, mismatch-field rejection, e2e contract, and report/lineage byte comparison
- Decision record: inline Decision: remove Pause from the UI until a worker advertises a real pause capability; Derivation: X1 requires truthful state and P6 preserves only affordances with an honest effect; Rejected: displaying inert pauseRequested/paused states because they misrepresent lifecycle control; Tunable: no
- Evidence: `320977c`; open — not executed: kill-and-resume, splat continuation, and changed-config rejection acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user can close a project or the app without orphaned workers, false clean-shutdown state, or partial canonical results.
- A2 reference: adopted from UIP-D10/UIP-D11 and P5
- A3 siblings: project Open/New/Close, Electron before-quit, Jobs cancellation, archive save, and external-worker supervision
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — P11 row `photolab.project.close` pending; shortcut — present
- B2 open/close: Close/quit enters the UIP-D14 close flow, drains work, and closes only after acknowledgement; failure is handed to WP-H1 Retry/Cancel close/Force quit
- B3 surface: island + non-instant drain needs focused progress and recovery choices without losing viewport context
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: drain deadline is an X6 typed constant; all active jobs and side operations are in scope, not selection; admitted job identity is frozen during drain; terminal history and clean-shutdown truth persist while close itself is not undoable
- D1 performance class: long-running + 20 s drain bound and real cancellation matrix R1 gate 4; D2 degradation: slow shutdown may reach the refusal surface, never force success or leave children intentionally
- E1 visual reference: `confirmation-remove-image.png`
- E2 conflicts/failure/crash: drain cancels and awaits owners, process-group termination reaps children, and clean shutdown is written only after success
- E3 verification: long-MVS close, SIGTERM mid-alignment, no-child checks, terminal-before-clean assertion, and cancellation regressions
- Decision record: cited unchanged: P5, UIP-D10/UIP-D11, and SYSTEM-001
- Evidence: `566ef80`; open — not executed: close-during-MVS and SIGTERM/COLMAP child-reaping acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user cannot accidentally run conflicting publications to one target and sees all release-critical work participate in close and cancellation.
- A2 reference: adopted from SYSTEM-001, UIP-D10, and P5
- A3 siblings: JobManager admission, product publication, archive/image commit, CRS, LAS import, capture, and automation operations
- B1 reachability: ribbon — absent; context menu — absent; console — present; automation — P11 rows `photolab.jobs.list`, `photolab.jobs.status`, and `photolab.jobs.cancel` pending; shortcut — absent
- B2 open/close: conflict feedback is inline at Start; global job/drain status closes through the Jobs/function rung per UIP-D14
- B3 surface: inline + admission errors belong beside the initiating control while durable work remains in the shared jobs surface
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: disk estimates are read-only; publication target is derived from frozen input rather than live selection; the target key and job identity freeze at admission; rejected jobs create no journal state and successful publication remains one canonical command
- D1 performance class: bounded + target-key unit gate and R1 gates 3/4; D2 degradation: insufficient disk fails before admission and weak hardware changes throughput only
- E1 visual reference: `bottom-jobs.png`
- E2 conflicts/failure/crash: frozen target keys reject queued/running collisions and drain adapters cover every side-operation owner
- E3 verification: duplicate-DEM rejection, archive-save close cancellation, target-key units, side-operation drain matrix, and disk-preflight errors
- Decision record: cited unchanged: SYSTEM-001, P5, and UIP-D10
- Evidence: open — not executed
- Status: queued
```

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

```text
Footer
- A1 outcome: After a crash, the user reopens a coherent project while unpublished datasets are quarantined and missing audit evidence is repaired explicitly.
- A2 reference: adopted from P5, `docs/PROJECT-FORMAT.md`, and `docs/DATA-MODEL.md`
- A3 siblings: canonical project store, journal replay/diagnostics, atomic product publication, archive Save, and project maintenance/GC
- B1 reachability: ribbon — absent; context menu — absent; console — present; automation — P11 row `photolab.project.diagnostics` pending; shortcut — absent
- B2 open/close: reconciliation runs during Open and reports through diagnostics; the diagnostics surface closes by its function close rung per UIP-D14
- B3 surface: inline + automatic recovery needs a concise diagnostic outcome, not a blocking editor
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: journal sequence/generation are read-only; the whole opening project is the affected set; manifest generation freezes the committed state; repair is durable recovery metadata and quarantine is outside ordinary undo but retained for maintenance
- D1 performance class: bounded + fault-injection reconciliation gate and project-runtime suite; D2 degradation: large stores may scan incrementally, never treat directory existence as publication truth
- E1 visual reference: `function-metadata.png`
- E2 conflicts/failure/crash: manifest-first commit, recovered journal emission, and orphan quarantine reconcile each crash boundary without inventing lineage
- E3 verification: journal/manifest crash injection, dataset-rename crash injection, quarantine assertions, 41 project-runtime tests, and Windows directory-flush check
- Decision record: cited unchanged: P5 and `docs/PROJECT-FORMAT.md`
- Evidence: open — not executed
- Status: queued
```

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

```text
Footer
- A1 outcome: The user gets actionable diagnostics instead of silently degraded alignment inputs, missing records, or lost job history.
- A2 reference: adopted from X1 and P5
- A3 siblings: Project Diagnostics, alignment preparation, checkpoint persistence, and durable Jobs history
- B1 reachability: ribbon — absent; context menu — absent; console — present; automation — P11 row `photolab.project.diagnostics` pending; shortcut — absent
- B2 open/close: failures open or link to diagnostics/console, which close through their panel toggles and UIP-D14 function rung
- B3 surface: right panel + persistent diagnostics must remain inspectable beside the affected project
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: retry interval is a tunable constant; diagnostics describe project records rather than live selection; corrupt input freezes job preparation in a failed state; warnings/history persist but do not enter document undo
- D1 performance class: bounded + corruption fixture tests and serialized cancellation timing test; D2 degradation: persistence retries at 500 ms without hot-looping and never replace corrupt inputs with empty values
- E1 visual reference: `function-metadata.png`
- E2 conflicts/failure/crash: hard preparation errors prevent invalid jobs and the independent retry tick preserves terminal history across transient writes
- E3 verification: corrupt-record diagnostics fixture, camera-map hard-failure test, retry-tick unit test, and isolated cancellation timing test
- Decision record: cited unchanged: X1/P5; X6 tunable register row WP-B6
- Evidence: `f295c50`, `e4d26d9`; open — not executed: diagnostics fixture and camera-map actionable-error acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: A first-time user can start alignment immediately from a visible, explainable built-in quality preset.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Align photos"
- A3 siblings: Align Photos panel, batch alignment stage, named preset library, and processing report
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 row `photolab.alignment.start` pending; shortcut — absent
- B2 open/close: the Align Photos ribbon button toggles the function and explicit close follows the function-tab rung per UIP-D14
- B3 surface: right panel + presets, disabled reasons, and frozen inputs remain visible while inspecting the viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: preset parameters are typed/editable in user copies with no drag peer; processing-set cameras are frozen at start; a chosen preset freezes the job configuration; factory presets are read-only and user presets persist globally while published alignment is journaled
- D1 performance class: bounded + alignment-preset renderer tests for configuration and long-running + alignment R1 gates 1/2 for execution; D2 degradation: hardware affects runtime, never silently changes the selected preset
- E1 visual reference: `function-align-photos.png`
- E2 conflicts/failure/crash: job admission freezes the preset/input hashes and atomic publication exposes only completed alignments
- E3 verification: fresh-profile first-run test, provenance display, batch preset picker, alignmentPreset suite, and 135-image gate
- Decision record: cited unchanged: X4, P7, and P11
- Evidence: `aaa29b7`; open — not executed: complete first-run UI acceptance and 135-image selected-preset run
- Status: landed
```

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

```text
Footer
- A1 outcome: The user either transforms GCP heights through the frozen vertical operation or knowingly preserves values labeled with their source CRS.
- A2 reference: adopted from `docs/PHOTOLAB-CONCEPT.md` and the image-import CRS freeze contract
- A3 siblings: image import CRS discovery/freeze, GCP CSV import, grid coverage errors, and reference-frame status
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.crs.discover`, `photolab.crs.freeze`, and `photolab.gcp.commit` pending; shortcut — absent
- B2 open/close: the GCP import island closes on explicit Cancel/close or commit; Escape follows the detached-function/modal rung per UIP-D14 without committing entered values
- B3 surface: island + multi-step CRS discovery, grid resolution, preview, and commit need focused progression
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: heights and accuracies are typed with project units and no drag peer; imported rows rather than entity selection are the affected set; the resolved CRS operation and grids freeze before commit; source values and transformed values persist canonically and the import is one undoable command
- D1 performance class: bounded + golden vertical-transform sidecar/renderer gate; D2 degradation: missing grids block commit rather than preserve or approximate heights
- E1 visual reference: `gcp-import-review.png`
- E2 conflicts/failure/crash: one frozen operation hash governs every row and atomic commit prevents mixed transformed/preserved state
- E3 verification: DHHN2016 test vector, preserve-values label test, sidecar transform test, renderer wizard test, and 24-image import evidence
- Decision record: cited unchanged: X1/X3 and ADR 0023
- Evidence: `2762b5f`; Integration evidence row "Import wizard → CRS freeze → atomic commit"; open — not executed: golden vertical-vector and explicit no-transform UI acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user reopens recent work, sees recoverable crash state, and can explicitly remove only demonstrably empty stale Untitled projects.
- A2 reference: adopted from FP-D2/FP-D19 for truthful status while retaining PhotoLab archive semantics per FP-D14
- A3 siblings: Project Open/New/Save, MRU welcome state, autosave recovery, and Builder file/project lifecycle
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — P11 rows `photolab.project.open` and `photolab.project.diagnostics` pending; shortcut — present
- B2 open/close: welcome/recovery actions open inline; banners and dialogs close explicitly and Escape follows UIP-D14; the obsolete dirty close guard is superseded by WP-C3b/WP-H1
- B3 surface: inline + welcome/recovery context belongs in the empty viewport and non-modal banner, with destructive cleanup in a modal confirmation
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: MRU limit/age are tunables, not direct manipulation; project replacement clears and revalidates project-local selection; recovery generation freezes before Keep/Discard; MRU is global, recovery is project-local, and destructive discard/GC require explicit confirmation outside ordinary undo
- D1 performance class: bounded + project-files/dialog-policy gates and crash-reopen R1 gate 3; D2 degradation: slow storage delays acknowledgement and never silently discards recovery state
- E1 visual reference: `workspace-view-restored.png`
- E2 conflicts/failure/crash: open/close drains owners, recovery binds to a durable generation, and cleanup targets only validated zero-image Untitled projects
- E3 verification: relaunch restoration, kill-9 recovery banner, MRU persistence, explicit GC confirmation, english-ui, dialog-policy, and project-files tests
- Decision record: inline Decision: offer explicit cleanup only for Untitled projects older than 14 days with zero images; Derivation: X1 protects user data and X6 delegates the age threshold while explicit confirmation preserves control; Rejected: silent deletion because age does not prove dispensability, and never cleaning because known empty litter impairs discovery; Tunable: yes — 14 days and MRU size 10
- Evidence: `c720bb8`; adoption-audit executed evidence `photolab:test:project-files` and `photolab:test:dialog-policy`; open — not executed: relaunch with images/GCPs, kill-9 recovery, and stale-Untitled cleanup acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user closes without a false dirty-state prompt while Save retains an honest archive effect and any failed drain refuses ordinary close.
- A2 reference: adopted from FP-D14 and `docs/builder-program/PHOTOLAB-ADOPTION-AUDIT-2026-09-02.md` F01/F05
- A3 siblings: PhotoLab archive Save/Save As, Builder journal-implicit lifecycle, durability indicator, and WP-H1 close refusal
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — P11 row `photolab.project.close` pending; shortcut — present
- B2 open/close: close runs drain/flush and closes only on acknowledgement; Escape cancels the H1 refusal dialog rung per UIP-D14
- B3 surface: island + a failed/timed-out drain needs Retry, Cancel close, and explicit Force quit choices
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: durability lag/deadline are tunables; the whole project and active-work set are affected, not selection; the acknowledged working-copy generation and archive source identity freeze before close; archive Save remains real until the coherent FP-D14 migration and close is not undoable
- D1 performance class: long-running + close/drain R1 gates 3/4; D2 degradation: storage delay may keep the window open and may never be reported as successful durability
- E1 visual reference: `workspace-view-restored.png`
- E2 conflicts/failure/crash: drain refusal preserves the live sidecar/window, archive Save publishes atomically, and Force quit never writes clean shutdown
- E3 verification: project-lifecycle tests, real archive Save hash, drain timeout/failure choices, Force-quit recovery truth, and crash reopen
- Decision record: cited unchanged: FP-D14 and adoption-audit F01/F05 supersede the package's earlier D1/X7 archive-copy derivation
- Evidence: `9593bd9`; open — not executed: real archive Save, drain refusal choices, and Force-quit recovery acceptance
- Status: landed — close prompt removed; Save semantics superseded by WP-H1 (F01)
```

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

```text
Footer
- A1 outcome: The user sees why a product cannot start and explicitly chooses the converged GCP revision that the run will freeze.
- A2 reference: adopted from `docs/PHOTOLAB-CONCEPT.md` frozen-input contract
- A3 siblings: alignment selector, merge selector, batch product stages, report lineage, and product Start controls
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.products.resolveInputs` and `photolab.products.start` pending; shortcut — absent
- B2 open/close: each product ribbon button toggles its function and explicit close follows the function-tab rung per UIP-D14
- B3 surface: right panel + prerequisites, GCP choice, frozen hashes, and errors must remain visible beside the viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: product parameters are typed with no drag peer; source alignment/GCP are explicit selectors independent of incidental selection; resolved ids/hashes freeze before Start; configuration may persist while successful publication is canonical and journaled
- D1 performance class: bounded + resolve-inputs/disabled-state tests before long-running product gates; D2 degradation: unavailable prerequisites disable Start and never fall back to an implicit latest revision
- E1 visual reference: `ribbon-products.png`
- E2 conflicts/failure/crash: admission revalidates the displayed frozen inputs and atomic publication prevents a stale or partial product
- E3 verification: empty-project disabled logic, two-revision selection/report lineage, explicit-revision sidecar test, and renderer test
- Decision record: cited unchanged: X1/X3/X5 and P11
- Evidence: `bf27605`; open — not executed
- Status: landed
```

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

```text
Footer
- A1 outcome: The user extracts selected video frames, previews them, and imports them through the same truthful image workflow as still photos.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Add photos"
- A3 siblings: Images ribbon import, image inspect/commit wizard, capture runtime, and local-metric reference handling
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.capture.video.prepare` and `photolab.capture.cancel` pending; shortcut — absent
- B2 open/close: Video Frames opens a floating island that closes on explicit Cancel/close or handoff; Escape follows the detached-function rung per UIP-D14
- B3 surface: island + frame extraction is a focused multi-step flow before the normal import island takes over
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: interval, frame cap, and sharpness are typed values; the chosen video file is captured at launch; extraction settings/input identity freeze before work; temporary frames are discarded on cancel and the eventual image commit is one canonical undoable import
- D1 performance class: long-running + video fixture/cancellation gate and R1 gate 4; D2 degradation: extraction may run slower or preview fewer thumbnails, never alter selected frame identity or partially commit
- E1 visual reference: `image-import-preview.png`
- E2 conflicts/failure/crash: capture cancellation owns temporary output and normal atomic image commit is the only canonical publication
- E3 verification: MP4 N-frame fixture, mid-extraction cleanup, english-ui, and mixed-picker exclusion
- Decision record: cited unchanged: ADR 0023 and P11
- Evidence: `f075056`; open — not executed
- Status: landed
```

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

```text
Footer
- A1 outcome: The user configures one understandable pipeline, previews dependencies, and runs the release product chain unattended.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Automation"
- A3 siblings: individual Align/Optimize/Product/Export/Report functions, Jobs tab, named presets, and batch recipe migration
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 row `photolab.batch.start` pending; shortcut — absent
- B2 open/close: the ribbon toggles the configurator; preview closes back to it and Escape follows modal then function-tab rungs per UIP-D14; admitted batches continue in Jobs
- B3 surface: right panel + configuration must coexist with project context, while the dependency graph is a read-only island preview
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: all stage parameters are typed and reuse individual-function units; scope is explicitly configured rather than taken from live selection; the pipeline and all stage inputs freeze at queue time; named pipelines persist and each presented batch is journaled/undoable as one action per X3
- D1 performance class: long-running + unattended smoke-chain and R1 gates 1/3/4; D2 degradation: weak hardware changes scheduling/throughput only and never skips configured stages silently
- E1 visual reference: `function-configure-batch.png`
- E2 conflicts/failure/crash: the job owner serializes dependencies, checkpoints resumable stages, and publishes each canonical result atomically
- E3 verification: optimize-to-report smoke chain, legacy recipe migration notice, batchRecipe tests, resume/cancel matrix, and output lineage
- Decision record: inline Decision: the functional configurator is the sole editable batch surface and the node canvas is a read-only preview; Derivation: X1 favors an executable, comprehensible workflow and X5 rejects two asymmetric editors for one command model; Rejected: retaining two editable surfaces/formats because they diverge and the node canvas cannot execute its own model; Tunable: no
- Evidence: `3c277c4`; open — not executed: unattended full smoke chain and legacy migration acceptance; optimize/export/report stage extension is parked by R1 triage as convenience scope
- Status: landed
```

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

```text
Footer
- A1 outcome: The user can open Agent safely and receives a clear configuration empty state instead of a crash.
- A2 reference: adopted from ADR 0024 and truthful-copy rules
- A3 siblings: Automation ribbon, agent discovery handler, console error surface, and Builder agent panel
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — absent; shortcut — absent
- B2 open/close: the Agent ribbon button toggles the function and explicit close follows the function-tab rung per UIP-D14
- B3 surface: right panel + agent conversation/configuration remains available beside the project viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: n/a because no numeric manipulation is exposed; project context may be read but selection is not consumed on discovery; configuration presence is sampled per request; credentials/configuration remain user/system state outside project undo
- D1 performance class: bounded + empty-config handler regression; D2 degradation: missing runtime returns a typed unavailable state and never throws or exposes credentials
- E1 visual reference: `ribbon-automation.png`
- E2 conflicts/failure/crash: typed discovery failure contains the fault at the automation boundary and preserves renderer/app state
- E3 verification: empty-configuration handler test, panel open with zero console errors, and ADR 0024 trust-boundary check
- Decision record: cited unchanged: ADR 0024
- Evidence: `2b14c9e`; open — not executed: hands-on zero-console-error acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user moves directly from a suspicious residual to its image/marker, navigates large image sets smoothly, and knows exactly which alignment is optimized.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` rows "Reference" and "Optimize cameras"
- A3 siblings: GCP Accuracy table, Image workspace, filmstrip/tree selection, marker tool, and Optimize panel
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — P11 rows `photolab.gcp.observation` and `photolab.gcp.optimize` pending; shortcut — present
- B2 open/close: ribbon and row actions open the related workspace/function; explicit close and Escape consume exactly the tool, detached-function, or function-tab rung per UIP-D14
- B3 surface: right panel + selectors/actions stay visible during viewport work, with the filmstrip inline below the image canvas
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: marker coordinates can be placed and numerically inspected using image coordinates; GCP/image/tree/filmstrip selection stays synchronized and revalidated; optimization freezes alignment, GCP revision, and observations at Start; navigation is view-local while observations/optimization publications are canonical and journaled
- D1 performance class: continuous + 800-image virtualized-filmstrip frame gate; D2 degradation: thumbnail work may defer/offscreen-cache, never block input or change selected image
- E1 visual reference: `workspace-images.png`
- E2 conflicts/failure/crash: shared selection identity coordinates consumers and frozen optimization input prevents mid-run navigation changes from altering the solve
- E3 verification: residual-to-worst-image assertion, marker highlight, 800-image frame gate, alignment pinning, selection-threading tests, and checkpoint suggestion test
- Decision record: cited unchanged: UIP-D14–D18 and X3
- Evidence: `41c1d09`, `6fd5e33`, `46e7d66`; open — not executed: 800-image performance and full residual-to-highlight workflow acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user encounters consistent English copy, predictable imports/jobs/toggles, useful empty-state markers, and stable calibration drafts across the polished workflow.
- A2 reference: adopted from `docs/DESIGN-SYSTEM.md` and the existing PhotoLab workflow semantics
- A3 siblings: image/GCP import, Jobs tab, entity tree, viewport markers, ribbon toggles, properties panels, and Capture Groups
- B1 reachability: ribbon — present; context menu — present; console — present; automation — P11 rows for each underlying canonical operation pending; shortcut — present
- B2 open/close: corrected ribbon actions toggle their functions and dialogs/islands follow UIP-D14 with explicit close/cancel behavior
- B3 surface: inline + each correction stays in its owning existing surface rather than adding another workflow
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: orientation and sigma values use typed/readable project-unit fields; sorting and multi-file routing preserve/revalidate selection; selected calibration drafts remain frozen across unrelated selection changes; workflow files persist canonically while view/job presentation changes remain view-local
- D1 performance class: continuous + visual-regression interaction walk for tree/viewport/ribbon; D2 degradation: sorting, labels, and state truth do not degrade, while marker detail may follow the viewport governor
- E1 visual reference: `00-main-view.png` and the affected named surfaces in `manifest.json`
- E2 conflicts/failure/crash: operations retain their canonical owners, terminal job clearing affects history presentation only, and workflow writes acknowledge success/failure
- E3 verification: english-ui, actual visual regression, dialog-policy, targeted assertions, and hands-on import/jobs/tree/markers/error pass
- Decision record: cited unchanged: `docs/DESIGN-SYSTEM.md`, UIP-D14–D18, and P5
- Evidence: `32cc69a`; adoption-audit executed evidence `photolab:check:english-ui` and `photolab:test:dialog-policy`; open — not executed: actual pixel comparison and complete hands-on acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user gets the same correct NTv2 grid interpretation in image and GCP imports, including mislabeled `.gsb` files.
- A2 reference: adopted from the image-import CRS freeze contract
- A3 siblings: image import grid normalization, GCP import grid selection, and shared import-freeze helpers
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.crs.discover` and `photolab.crs.freeze` pending; shortcut — absent
- B2 open/close: both import wizards close on explicit Cancel/close or commit and Escape follows the detached-function/modal rung per UIP-D14
- B3 surface: island + the correction remains within the existing multi-step import surfaces
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: n/a because grid kind is detected metadata; imported file rows rather than entity selection are affected; normalized grid identity freezes into the operation payload; the frozen operation is canonical and follows the parent import command's undo
- D1 performance class: bounded + shared grid-normalization unit gate; D2 degradation: unknown/missing grids block or request resolution and never masquerade as another transform
- E1 visual reference: `gcp-import-review.png`
- E2 conflicts/failure/crash: both consumers call one normalizer before atomic import commit, preventing divergent payloads
- E3 verification: mislabeled-GSB parity test plus `gcpImportDecision` and `importFreeze` suites
- Decision record: cited unchanged: X1/X5
- Evidence: `587c94d`, `3192d36`; open — not executed: complete named test-suite acceptance has no attached execution evidence
- Status: landed
```

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

```text
Footer
- A1 outcome: The user can georeference an overlap-merged mission and is blocked from creating falsely georeferenced DEM/ortho outputs before doing so.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Chunks / merge" with deliberate ADR 0014 deviation
- A3 siblings: alignment merge, GCP Optimize selector, product prerequisite validation, report lineage, and local-metric projects
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.gcp.optimize` and `photolab.products.resolveInputs` pending; shortcut — absent
- B2 open/close: Merge/Optimize/Product ribbon buttons toggle their functions and explicit close follows the function-tab rung per UIP-D14
- B3 surface: right panel + source-frame warnings, alignment choice, and blocked-product reason remain visible beside the viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: optimization parameters are typed with no drag peer; the merged run is explicitly selected and captured; its model/GCP revision freeze into optimization; optimization and downstream products publish as canonical journaled entities
- D1 performance class: long-running + merged-run optimization/DEM lineage gate and R1 gates 1/2; D2 degradation: no hardware tier may bypass the arbitrary-frame block
- E1 visual reference: `function-optimize.png`
- E2 conflicts/failure/crash: frozen merged-run identity and atomic optimization publication prevent products from observing half-georeferenced state
- E3 verification: merged-run resolution sidecar tests, optimized-overlap DEM lineage/report, and unoptimized block message
- Decision record: cited unchanged: ADR 0014 and ADR 0023
- Evidence: `5c25590`; open — not executed: merge and 135-image GCP scope were not exercised
- Status: landed
```

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

```text
Footer
- A1 outcome: The user can combine mixed camera groups while fixed calibrations stay pinned and unseeded groups are actually refined.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Camera calibration"
- A3 siblings: Capture Groups intrinsics policy, alignment, merge, GCP optimization, and calibration inspector
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.alignment.start` and `photolab.merge.run` pending; shortcut — absent
- B2 open/close: policy is edited in Capture Groups and consumed by Align/Merge; each ribbon surface toggles and closes by the function-tab rung per UIP-D14
- B3 surface: right panel + group policy and resulting strategy must remain inspectable beside cameras/results
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: calibration values/policies are typed and have no drag peer; all cameras in selected groups are covered, including ungrouped warnings; confirmed group policy freezes at job admission; policies and result strategy persist canonically and publications are journaled
- D1 performance class: long-running + mixed-group refinement and golden before/after gates; D2 degradation: a worker without `bundle_adjuster` fails actionably rather than applying an unverified fallback
- E1 visual reference: `function-capture-groups-calibration-split.png`
- E2 conflicts/failure/crash: one frozen per-group strategy governs joint solve/rebundle and atomic publication exposes no mixed-policy partial result
- E3 verification: policy-to-strategy units, mixed embedded/unseeded merge, pinned-tolerance assertion, and single-mission golden comparison
- Decision record: cited unchanged: ADR 0014 revision 3
- Evidence: `31c9949`, `c14b107`, `a1dc449`; open — not executed: mixed real-data merge and golden before/after acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: Before and after merging, the user sees whether missions overlap and the quantitative connection quality that supports the result.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Chunks / merge" with deliberate ADR 0014 evidence-first deviation
- A3 siblings: Merge Alignments panel, alignment presets, processing report, and product lineage
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.merge.preflight`, `photolab.merge.plan`, and `photolab.merge.run` pending; shortcut — absent
- B2 open/close: the Merge ribbon button toggles the function and explicit close follows the function-tab rung per UIP-D14; closing keeps a running merge in Jobs
- B3 surface: right panel + preflight, profile, lineage, and post-merge statistics remain visible beside spatial context
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: RMS/misclosure are read-only and profile thresholds are typed; selected runs are captured as an explicit merge set; profile and run hashes freeze into the plan; merge evidence and result persist canonically and publication is journaled
- D1 performance class: bounded + GPS-footprint preflight gate, then long-running + merge-quality gate; D2 degradation: missing GPS reports preflight unavailable and never fabricates overlap evidence
- E1 visual reference: `function-merge-alignments.png`
- E2 conflicts/failure/crash: preflight is a bounded read; admitted merge freezes all inputs and publishes result/evidence atomically
- E3 verification: RMS/misclosure fixture, disjoint-footprint warning, visible/frozen profile, report rendering, and R1 gate 2 evidence
- Decision record: cited unchanged: ADR 0014; X6 tunable register row WP-D3
- Evidence: `4ec3e27`; open — not executed: merge acceptance and real-data quality evidence
- Status: landed
```

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

```text
Footer
- A1 outcome: The user understands calibration groups, can enter lab calibration, repair group drafts without mutating confirmed history, and sees cameras that cannot refine.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Camera calibration"
- A3 siblings: Capture Groups auto proposals, per-group refinement, calibration inspector, and alignment seed preparation
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — P11 rows `photolab.captureGroups.create`, `.confirm`, `.draft`, and `.merge` pending; shortcut — absent
- B2 open/close: Capture Groups toggles from the ribbon; expanders close inline and Escape follows editor then function-tab rungs per UIP-D14
- B3 surface: right panel + grouping, help, lab values, and draft lifecycle require continued camera/viewport context
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: lab intrinsics are typed with units/precision and no drag peer; create-from-selection captures the explicit camera set and mixed membership is shown; confirmed groups are immutable and edits duplicate to a draft; group versions/seeds persist canonically and confirmation/retirement are journaled
- D1 performance class: bounded + capture-group sidecar/renderer tests; D2 degradation: large camera sets may virtualize rows, never hide ungrouped cameras or mutate confirmed groups
- E1 visual reference: `function-capture-groups.png`
- E2 conflicts/failure/crash: versioned draft/confirm publication prevents concurrent edits from mutating confirmed records and alignment consumes one frozen version
- E3 verification: lab-seed sidecar test, duplicate-draft round-trip, ungrouped badge, session-gap evidence, merge-proposals action, and english-ui
- Decision record: cited unchanged: X1/X3/X5 and ADR 0014
- Evidence: `631f7f7`; adoption-audit executed evidence `photolab:check:english-ui`; open — not executed: full lab-seed/draft/badge acceptance
- Status: landed
```

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

```text
Footer
- A1 outcome: The user can inspect adjusted calibration, uncertainty, correlations, residual structure, and exact snapshot provenance before defending a survey result.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Optimize cameras"
- A3 siblings: Capture Groups, GCP Optimize, processing report, and per-group alignment policy
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — P11 row `photolab.calibration.inspect` pending; shortcut — absent
- B2 open/close: Calibration opens from the group/function entry and closes explicitly or by the function-tab rung per UIP-D14
- B3 surface: right panel + dense tables/plots need persistent viewport and group-selection context
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: displayed calibration values are readable numeric evidence but not edited here; one or many selected groups show common/mixed state; the inspector binds to a frozen alignment/optimization snapshot hash; it is a read model over canonical results and creates no undo step
- D1 performance class: bounded + calibration-payload/plot renderer gate; D2 degradation: large matrices may scroll or rasterize, never omit parameters, uncertainty provenance, or exact values
- E1 visual reference: `function-capture-groups-calibration-split.png`
- E2 conflicts/failure/crash: the inspector reads one immutable snapshot and distinguishes unavailable sigmas from zero values
- E3 verification: smoke optimization sigmas, symmetric correlation matrix, residual plot, report section, and snapshot-hash display
- Decision record: inline Decision: ship transparency-first calibration evidence before manual gradual-selection editing; Derivation: X1 makes defensible correctness evidence prior to broader editing and the dossier "Optimize cameras" row establishes the evidence set; Rejected: hiding solver behavior or prioritizing a mutation-heavy gradual-selection clone before the evidence is inspectable; Tunable: yes — plot scales/color thresholds only
- Evidence: `90b4ddc`, `0def57a`, `43a1b30` partial payload/provenance work; open — not executed: inspector smoke acceptance
- Status: in flight
```

Landed 2026-09-02 (171791b): per-group intrinsic covariance (sigma_0^2 N^-1, log-focal mapped to pixels, unit-diagonal correlation, `uncertainty: null` with reason when singular/condition-gated), eight-bin before/after radial profiles, read-only `photolab.gcp.calibrationReport` (P11 row `photolab.gcp.calibration_report`, Electron allowlist admitted), calibration inspector in the capture-groups panel, processing-report evidence. Review fixes: direct sidecar bridge call (Codex had guessed a `window.invoke` API), helper tests, and a test-isolation defect found on the way — sidecar unit tests queued behind the machine-wide compute lease held by the running golden e2e sidecar (every 2 s cancellation timing test failed); `job_runtime.rs` now uses a per-process lease for `cfg(test)` and cargo-launched processes. Verified: core 208, sidecar 260+13+84, renderer 80.

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

```text
Footer
- A1 outcome: The user sees which observations the solver distrusted, opens them in context, and can explicitly exclude one and re-optimize with auditable lineage.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Optimize cameras"
- A3 siblings: calibration inspector, GCP Accuracy row navigation, Image workspace, Optimize command, and report lineage
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — P11 rows `photolab.gcp.observation.exclude` and `photolab.gcp.optimize` pending; shortcut — absent
- B2 open/close: QC opens from Calibration/Accuracy and closes explicitly or by the function-tab rung; observation exclusion confirmation uses the modal rung per UIP-D14
- B3 surface: right panel + ranked errors and actions must stay synchronized with viewport/image inspection
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: residual/weight values are inspectable but not directly edited; row selection drives the exact image/GCP observation and survives navigation; the ranked list binds to one frozen optimization snapshot; exclusions are canonical journaled records, undoable, and the new optimization freezes their set
- D1 performance class: bounded + seeded-outlier QC fixture before long-running re-optimization; D2 degradation: large lists virtualize/filter, never hide rejected observations or change ranking values
- E1 visual reference: `bottom-accuracy.png`
- E2 conflicts/failure/crash: exclusion and re-optimize serialize through canonical commands; a failed solve leaves the prior snapshot and exclusion lineage recoverable
- E3 verification: seeded-outlier ranking, downweight flag, image jump, exclude/re-optimize RMSE improvement, undo, and report lineage
- Decision record: inline Decision: expose robust-loss evidence and explicit exclusions, deferring a general tie-point gradual-selection editor; Derivation: X1 and X3 require transparent, journaled corrections while the dossier "Optimize cameras" row supplies the reference behavior; Rejected: silent downweighting and destructive tie-point deletion because neither gives an auditable reversible QC loop; Tunable: yes — ranking/filter thresholds only
- Evidence: open — not executed
- Status: parked (R1 triage: per-observation editing is non-release Metashape parity; accuracy payload evidence remains in WP-E1/A2 scope)
```

### WP-E3 — Per-point GCP accuracy + code columns (Size S)

Problem. One default σ pair applies to the whole CSV
(`GcpImportPanel.tsx:245`); mixed RTK/total-station files are mis-weighted.

Design. Optional column mappings σH/σV (or σE/σN/σH) and code/description in
the CSV wizard (auto-detected like the coordinate columns); per-point values
freeze into the import; defaults remain the fallback for unmapped rows; the
accuracy panel shows the per-point σ used.

Acceptance criteria: mixed-σ fixture optimizes with per-point weights
(solver test asserts weight ratio); wizard preview shows the mapped columns.

```text
Footer
- A1 outcome: The user imports mixed-quality control points with per-point accuracies and codes that visibly drive the solver weights.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Reference"
- A3 siblings: GCP CSV mapping/preview, optimization weights, Accuracy panel, and processing report
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `photolab.gcp.preview` and `photolab.gcp.commit` pending; shortcut — absent
- B2 open/close: the GCP import island closes on Cancel/close or commit and Escape follows the detached-function/modal rung per UIP-D14
- B3 surface: island + column mapping and preview form a focused import sequence
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: σH/σV or σE/σN/σH values are typed/mapped with project units; all preview rows are in scope and row selection does not alter mapping; mapped values freeze per point at commit; import is canonical and undoable while solver results record the used values
- D1 performance class: bounded + mixed-sigma solver/import fixture; D2 degradation: missing row values use the visible default and malformed values block commit, never silently become zero
- E1 visual reference: `gcp-import-preview.png`
- E2 conflicts/failure/crash: one atomic import freezes mappings/defaults and downstream optimization reads immutable per-point weights
- E3 verification: mixed-sigma weight-ratio solver test and mapped-column wizard preview
- Decision record: cited unchanged: X1/X3 and P7
- Evidence: `e8d0aa8`; open — not executed: mixed-sigma fixture and preview acceptance
- Status: landed
```

### WP-E4 — Coverage/overlap visualization (Size M)

Problem. No way to judge block health at a glance (Metashape report page 2).

Design. Derive an overlap raster from sparse observations (per ground cell:
number of observing cameras), render as a viewport overlay layer after
alignment and as a figure in the WP-A2 report; camera footprints from
poses + mean ground plane. Pure read-model — no new job kind; computed on
demand and cached by alignment hash.

Acceptance criteria: smoke dataset shows an overlap map matching flight
geometry; report figure renders; toggle in the viewport layer list.

```text
Footer
- A1 outcome: The user sees where camera coverage is weak in the viewport and in the report before relying on downstream products.
- A2 reference: unresearched
- A3 siblings: sparse observations, viewport layer list, camera footprints, calibration QC, and processing report
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — P11 row `photolab.alignment.coverage` pending; shortcut — absent
- B2 open/close: the viewport layer toggle opens/closes the overlay and Escape is n/a because no modal/tool mode is armed
- B3 surface: inline + coverage is a viewport overlay with its legend beside existing layer controls
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: overlap count/legend values are inspectable with no drag peer; the active alignment is explicitly chosen and camera selection is not mutated; the cache freezes by alignment hash; overlay visibility is view-local while the report figure is an external read artifact
- D1 performance class: continuous + overlap-overlay frame gate after bounded cached derivation; D2 degradation: grid resolution may reduce under the quality governor, never camera counts or reported coverage values
- E1 visual reference: none — open
- E2 conflicts/failure/crash: pure read-model computation caches by immutable alignment hash and cannot publish canonical partial state
- E3 verification: smoke flight-geometry comparison, report figure, layer toggle, cache invalidation, and viewport frame gate
- Decision record: none consequential
- Evidence: open — not executed
- Status: parked (R1 triage: overlap visualization is non-release parity breadth)
```

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

```text
Footer
- A1 outcome: The user receives behavior backed by one runnable renderer test suite instead of orphaned checks.
- A2 reference: adopted from `docs/TEST-TIERS.md`
- A3 siblings: workspace package test scripts, GitLab node:test job, report golden, alignmentPreset, batchRecipe, importFreeze, and Himmelcap import tests
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — absent; shortcut — absent
- B2 open/close: n/a because this is verification infrastructure
- B3 surface: inline + failures report in CLI/CI logs and add no product UI
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: n/a because no product interaction is introduced; n/a because tests do not consume user selection; fixtures freeze inputs/expected outputs; test configuration is repository state outside product undo
- D1 performance class: bounded + `pnpm --filter @himmelcad/photolab test`; D2 degradation: CI/local resource differences may change duration, never which tests are discovered
- E1 visual reference: none — open
- E2 conflicts/failure/crash: isolated fixtures and deterministic runners prevent shared mutable test state from hiding failures
- E3 verification: local filtered test command, GitLab node:test execution, and orphan-test discovery assertion
- Decision record: cited unchanged: `docs/TEST-TIERS.md`
- Evidence: `d6053bf`; adoption-audit executed evidence includes processing-report/project-files/dialog-policy tests; open — not executed: full filtered suite in local and GitLab contexts
- Status: landed
```

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

```text
Footer
- A1 outcome: The user receives releases whose deterministic visual/package contracts run automatically while real-data and native-platform gaps remain honestly manual.
- A2 reference: adopted from `docs/TEST-TIERS.md`
- A3 siblings: visual audit, baseline manifest, release-contract tests, auto-update tests, GitLab CI, and native certification
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — absent; shortcut — absent
- B2 open/close: n/a because this is CI/operator verification infrastructure
- B3 surface: inline + results live in CI/evidence artifacts rather than product UI
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: pixel thresholds are X6 tunables; n/a because no user selection is involved; exact baseline/build identities freeze per run; baselines are versioned repository artifacts outside product undo
- D1 performance class: bounded + deterministic contract/comparator gates and scheduled visual job; D2 degradation: unsupported runner capabilities are explicit skips and never reported as passes
- E1 visual reference: `00-main-view.png` and the named surface set in `manifest.json`
- E2 conflicts/failure/crash: matching-environment identity gates comparisons and CI artifacts preserve failures without mutating product state
- E3 verification: unchanged-tree CI green, seeded-layout CI red, visual comparator, release contract, auto-update, and TEST-TIERS consistency
- Decision record: cited unchanged: `docs/TEST-TIERS.md`; X6 tunable register rows WP-F2
- Evidence: `7a126db`; adoption-audit executed evidence `photolab:test:visual-baseline`, `photolab:test:release-contract`, and `desktop:test:auto-update`; open — not executed: actual CI green/red visual job
- Status: landed
```

### WP-F3 — Accessibility baseline (Size S)

Problem. Zero a11y coverage.

Design. Add an axe-core pass to the visual-regression walk (each panel/tab
snapshot also runs axe with a filtered ruleset: contrast, labels, focus
order); fix the findings it reports in shared UI where trivial, list the
rest as tracked exceptions.

Acceptance criteria: axe pass wired and green with a documented exception
list; keyboard focus visibly reaches every ribbon tab and panel control.

```text
Footer
- A1 outcome: Keyboard and assistive-technology users can reach and understand every ribbon tab and panel control.
- A2 reference: adopted from `docs/DESIGN-SYSTEM.md` accessibility rules
- A3 siblings: visual-regression walker, shared ribbon/tablist, FunctionPanel controls, form controls, and focus/Escape dispatcher
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — absent; shortcut — present
- B2 open/close: every audited surface uses explicit close plus the ordered UIP-D14 Escape rung and restores focus to its opener
- B3 surface: inline + accessibility behavior is intrinsic to every existing surface
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: all numeric controls retain keyboard entry; focus and selection semantics remain distinct/revalidated; n/a because accessibility adds no expensive live state; focus is view-local and accessibility fixes do not alter undo
- D1 performance class: continuous + keyboard-reachability and focus-order gate; D2 degradation: accessibility names, focus, contrast, and input reachability never degrade
- E1 visual reference: `00-main-view.png` and the named surface set in `manifest.json`
- E2 conflicts/failure/crash: one Escape/focus owner prevents multiple surfaces from consuming a keypress and modal focus is restored deterministically
- E3 verification: axe walk, empty exception list, keyboard reachability as a failing gate, focus-visible/manual pass, actual pixel comparison, and human screenshot review
- Decision record: cited unchanged: UIP-D14 and `docs/DESIGN-SYSTEM.md`
- Evidence: `7a126db`; adoption-audit axe run reports zero within bounded rules but keyboard-unreachable controls remain; open — not executed: passing keyboard reachability, actual pixel comparison, and human screenshot review
- Status: in flight
```

Gate evidence 2026-09-02 (6774990, 72aca4e): `pnpm photolab:test:a11y` run 16 — axe-core 4.13.0, 0 findings across 42 surfaces at 1440x900 and 1100x720, 0 keyboard-reachability failures (ribbon and panel controls reachable with a visible focus indicator), 0 native dialogs, 0 page errors; report `.build/visual-regression/a11y-report.json` + `a11y-summary.md`. Along the way the audit caught two real defects (renderer crash on optional GCP report fields; H3's closeable tabs violating aria-required-children) and one harness defect (auto-stubbed mock injected a syntax error).

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

```text
Footer
- A1 outcome: The user gets correctly grouped trees, named controls/progress, and readable contrast through shared fixes across Himmel:CAD.
- A2 reference: adopted from `docs/DESIGN-SYSTEM.md` and WCAG rules encoded by the repository axe gate
- A3 siblings: shared EntityTree, checkbox/radio/toggle controls, progress bars, theme tokens, Builder, and PhotoLab baseline surfaces
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — absent; shortcut — present
- B2 open/close: behavior is unchanged and every consuming surface remains governed by UIP-D14
- B3 surface: inline + remediation belongs in shared primitives/tokens rather than package-specific wrappers
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: keyboard/numeric behavior is preserved; tree role corrections preserve selection semantics; n/a because no expensive live mode is added; accessibility metadata/theme state is not document state or undoable
- D1 performance class: continuous + 84-surface axe/layout/pixel gate; D2 degradation: semantics and minimum contrast never degrade across hardware tiers
- E1 visual reference: `00-main-view.png` and the named surface set in `manifest.json`
- E2 conflicts/failure/crash: shared primitives establish one semantic source and layout regression gates protect all consumers
- E3 verification: serious/critical axe count with justified exceptions, layout invariants, regenerated baselines, actual pixel comparison, and Builder/PhotoLab smoke
- Decision record: cited unchanged: `docs/DESIGN-SYSTEM.md`
- Evidence: `7831b94`; adoption-audit current bounded axe run is zero with empty exception list; open — not executed: post-remediation layout invariants, matching-machine pixels, and full keyboard acceptance
- Status: landed
```

### WP-F4 — Windows delivery and signing (owner decision, not codable)

Native-Windows install certification needs a Windows machine (ADR 0013
records Wine cannot certify NSIS); Authenticode/code signing needs a
certificate purchase. Both are operator/owner actions; the plan's only code
change: `sync_dir` Windows best-effort flush (folded into WP-B5) and keeping
the updater contract test green. Flagged for the owner; no Codex run.

```text
Footer
- A1 outcome: A Windows user installs and starts the exact release candidate, with signing status stated truthfully and update behavior verified.
- A2 reference: adopted from ADR 0013
- A3 siblings: Linux packaging, offline runtime inventory, updater contract, canonical store flush, and release evidence ledger
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — absent; shortcut — absent
- B2 open/close: n/a because installer/startup/signing are platform delivery operations
- B3 surface: inline + installer and OS trust surfaces are native delivery UI, not an in-app function
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: n/a for delivery; n/a for selection; candidate binaries/runtime inventory freeze by build identity; installation state is OS-managed and outside project undo
- D1 performance class: long-running + native Windows install/startup and updater gates; D2 degradation: unsupported/signing-deferred status is declared and never represented as certified or signed
- E1 visual reference: none — open
- E2 conflicts/failure/crash: exact-candidate hashes and atomic installer/update contracts prevent mixed runtime payloads
- E3 verification: Windows inventory, native NSIS install/startup, updater contract, signature verification when in scope, and current-candidate evidence ledger
- Decision record: cited unchanged: ADR 0013
- Evidence: adoption-audit executed evidence `desktop:test:auto-update` and synthetic `photolab:test:release-contract`; open — not executed: exact-candidate Windows inventory and native install/startup
- Status: parked (R1 triage: signing requires certificate/operator action; native certification remains an open release gate if Windows is supported)
```

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

```text
Footer
- A1 outcome: The user carries each advertised PhotoLab product into Builder and WeltView with exact identity, provenance, and supported interaction semantics intact.
- A2 reference: adopted from IF-D19–IF-D25 and ADR 0030
- A3 siblings: PhotoLab publication, Builder product registration, canonical Save As/reopen, WeltView read-only loading, and P11 command rows
- B1 reachability: ribbon — present; context menu — absent; console — absent; automation — P11 rows `io.import.product_dataset.list` and `io.import.product_dataset.register` pending; shortcut — absent
- B2 open/close: consuming app import/open surfaces follow their own explicit close and UIP-D14 lifecycle; PhotoLab publication remains visible through Jobs
- B3 surface: island + product discovery/registration is focused, while opened products return to each app's canonical viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: package values are exact/read-only; one explicit Available row is captured; package/provenance and candidate build identity freeze before registration; Builder registration is canonical/journaled/undoable and WeltView remains read-only
- D1 performance class: long-running + R1 gate 8 `G1c`; D2 degradation: unavailable formats remain explicitly unavailable and no consumer may synthesize missing lineage
- E1 visual reference: none — open
- E2 conflicts/failure/crash: admission, lock-scoped reads, ready-record-last publication, and journal-last registration coordinate all producer/consumer boundaries
- E3 verification: G1a publication conformance, G1b registration/open flows, and every-row G1c identity/render/pick/snap matrix
- Decision record: cited unchanged: IF-D19–IF-D25 and ADR 0030
- ADR 0030 status 2026-09-02 evening: revision 6 (9d4d398) quotes IF-D26–IF-D34 verbatim as blockquotes and was checked CONFORMANT mechanically by the Builder lane (`docs/adr/0030-conformance-recheck5-2026-09-02.md`); no open contract item for WP-G1a-2. Method rule for any future cite-and-adopt ADR from either lane: quote the spec record's Decision text verbatim, never paraphrase, and verify by script diff.
- Evidence: `e5fc50a` partial PhotoLab publication; open — not executed: complete R1 gate 8
- Status: in flight
```

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

```text
Footer
- A1 outcome: The user publishes only complete, compatible PhotoLab product packages with frozen provenance that downstream apps can trust.
- A2 reference: adopted from IF-D19, IF-D22, ADR 0030, and `docs/photolab-metashape-reference-2026-09.md` product rows
- A3 siblings: PhotoLab product publication/list, canonical ready records, Builder product registration, and WeltView read-only opening
- B1 reachability: ribbon — absent; context menu — absent; console — present; automation — P11 rows `photolab.products.list` and product start rows pending; shortcut — absent
- B2 open/close: publication is part of product jobs; Jobs closes by its function rung per UIP-D14 while admitted publication continues
- B3 surface: inline + provenance status belongs in existing product/Jobs views rather than a separate editor
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: provenance values are exact/read-only; one admitted product source is captured; ProductLineageV1 freezes before visibility; publication is canonical, journaled, immutable, and undo retains referenced data per project policy
- D1 performance class: long-running + publication atomicity/provenance and G1c gates; D2 degradation: unsupported or incomplete formats remain unavailable and are never decorated from current state
- E1 visual reference: none — open
- E2 conflicts/failure/crash: target admission precedes candidate writes and manifest/artifact fsync plus ready-record-last provides atomic publication
- E3 verification: ADR 0030 conformance, package hash canonicalization, fail-closed compatibility, crash-boundary publication tests, product-list status, and G1c
- Decision record: cited unchanged: IF-D19–IF-D25 and ADR 0030
- Evidence: `e5fc50a` publication/provenance subset; open — not executed: admission collision and downstream all-kind gate acceptance
- Status: in flight
```

**WP-G1b — Builder registration + WeltView (Size L, after WP-G2).** The two
P11 rows `io.import.product_dataset.list/register` with the exact
`ProductDatasetList/RegisterRequest/ResultV1` schemas (IF-D20) in the
generated command table; the existing registration island gains the product
chooser and the bounded, lock-scoped `.hcad`/`.hcadx` catalog reader
(IF-D23/24); Builder commits the declared entity plus the
`hcad.photolab-product-provenance@1` component journal-last; WeltView opens
the resulting `.hcadx` read-only through the canonical store/kernel (IF-D25).

```text
Footer
- A1 outcome: The user registers an available PhotoLab dataset in Builder, saves a canonical project, and opens the same result read-only in WeltView.
- A2 reference: adopted from IF-D20, IF-D23–IF-D25, and ADR 0030
- A3 siblings: Builder import registration island, canonical project Save As, WeltView loader, entity/component schemas, and PhotoLab products.list
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — P11 rows `io.import.product_dataset.list` and `io.import.product_dataset.register` pending; shortcut — absent
- B2 open/close: Builder registration opens/closes by the import function and UIP-D14 rung; WeltView Open/Close follows its file lifecycle
- B3 surface: island + bounded catalog browsing and product choice are focused import steps before returning to the viewport
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: dataset metadata is exact/read-only; one package/product row is captured for registration; declared entity, prepared bindings, and provenance bytes freeze before commit; Builder registration is one canonical journaled/undoable command and WeltView is read-only
- D1 performance class: bounded + lock-scoped catalog reader/register gate; D2 degradation: large catalogs stream/page while preserving exact row identity and fail closed on unsupported schemas
- E1 visual reference: none — open
- E2 conflicts/failure/crash: lock-scoped bounded reads coordinate with writers and journal-last registration prevents partially canonical entities
- E3 verification: list/register schema tests, `.hcad`/`.hcadx` catalog locking, undo, Save As/reopen, WeltView open, and G1c
- Decision record: cited unchanged: IF-D20 and IF-D23–IF-D25
- Evidence: open — not executed
- Status: queued
```

**WP-G1c — gate test (Size M).** Per IF-D21: for every Available product row,
Builder registers and reopens, performs canonical Save As to a complete
`.hcadx`, WeltView opens it read-only; the test compares entity ids,
version/content hashes, prepared bindings, exact provenance bytes and the
row's render/pick/snap semantics. Gate 8 stays open until this passes for
every renderable product kind in the release.

```text
Footer
- A1 outcome: The user can trust that every advertised PhotoLab product survives Builder registration, canonical Save As/reopen, and WeltView read-only consumption without identity or behavior drift.
- A2 reference: adopted from IF-D21 and IF-D25
- A3 siblings: PhotoLab Available-product rows, Builder register/reopen/Save As, WeltView loader, renderer picking/snapping, and release evidence ledger
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — P11 gate rows `io.import.product_dataset.list/register` pending; shortcut — absent
- B2 open/close: n/a because this is an automated/operator release gate
- B3 surface: inline + gate results belong in immutable evidence artifacts, not product UI
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: exact hashes/bytes are compared rather than manipulated; every Available row is enumerated independent of UI selection; candidate commit/build and package bytes freeze per run; the test verifies canonical persistence/undo semantics without retaining mutations outside its fixture
- D1 performance class: long-running + R1 gate 8 `G1c`; D2 degradation: unavailable product kinds are explicitly dispositioned and no Available row may be skipped
- E1 visual reference: none — open
- E2 conflicts/failure/crash: isolated fixtures plus exact identity comparisons detect partial publication, stale bindings, and consumer divergence
- E3 verification: every-row register/reopen/Save As/WeltView flow with entity id, version/content hash, binding, provenance-byte, render, pick, and snap assertions
- Decision record: cited unchanged: IF-D21/IF-D25
- Evidence: open — not executed
- Status: queued
```

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

```text
Footer
- A1 outcome: The user, embedded agent, console, and Python client address the same PhotoLab capabilities and lifecycle without privileged raw-RPC shortcuts.
- A2 reference: `docs/photolab-metashape-reference-2026-09.md` row "Automation" with ADR 0006/0013 network-processing deviation
- A3 siblings: Builder generated command table/router/SDK, PhotoLab ribbon/panel actions, console vocabulary, and automation host trust boundary
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — P11 row set pending; shortcut — present
- B2 open/close: canonical commands preserve each owning surface's UIP-D14 lifecycle; user-only confirmation grants remain absent from automation
- B3 surface: inline + this package supplies command metadata/gates and reuses existing product surfaces
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: schemas expose the same typed numeric inputs as UI; commands take explicit entity/selection ids and reject stale ids; long operations freeze request/config/input identity; deliberate state is canonical/journaled and an agent-presented batch is one undo step
- D1 performance class: bounded + G-1 UI-action-to-row coverage, then long-running + Python smoke; D2 degradation: unavailable generated substrate keeps external automation closed and never widens raw allowlists
- E1 visual reference: none — open
- E2 conflicts/failure/crash: command rows name validation/status/cancel owners and all state changes retain atomic publication and durable job identity
- E3 verification: G-1 complete UI-action row enumeration, trust-class assertions, generated vocabulary consumption, and Python import→align→optimize→product smoke
- Decision record: cited unchanged: P11
- Evidence: `765c7fc` re-scope only; open — not executed: command-row document, G-1 coverage, generated console consumption, and Python smoke
- Status: in flight
```

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

## Adoption-audit disposition — 2026-09-02

Source: `docs/builder-program/PHOTOLAB-ADOPTION-AUDIT-2026-09-02.md` (12
findings). Each finding is dispositioned here; disagreements go back to the
audit's author, not into divergent code.

| Finding                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Package / evidence                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| F01 Save no longer saves the `.hcadx` archive (verified: Electron `project:save` calls only autosave for archive sources) | **fix before release** — restore the `photolab.project.save` route for archive-backed projects with success reported only after archive publication; keep the truthful stored/pending/failed indicator; Save As keeps its switch semantics; WP-C3b's lifecycle claim is superseded, the journal-implicit migration is FP-D14's post-release package                                                                                                                                    | WP-H1                                            |
| F02 38 packages without A1–E3 disposition and evidence ledger                                                             | **fix before release (documentation)** — this plan gains a per-package footer (A1–E3 compact disposition, decision-record citation or "cited unchanged", evidence id or "open"); no owner default is escalated                                                                                                                                                                                                                                                                         | WP-H4                                            |
| F03 Metashape claims not A2-grounded                                                                                      | **fix before release** — `docs/photolab-metashape-reference-2026-09.md` (this commit) carries the sourced reference table and marks unresearched items; non-release catalog breadth stays parked                                                                                                                                                                                                                                                                                       | done                                             |
| F04 jobs/imports do not consume UIP-D10 (verified: drain covers archives + image commits only)                            | **fix before release (adapters)**: complete drain coverage for inspections, masks and GCP operations, and a global jobs chip that rehydrates from the durable sidecar job list after renderer reload; **defer** ownership migration into the Builder-lane UIP-D10 registry until that substrate exists (COORDINATION.md) — no PhotoLab-private registry                                                                                                                                | WP-H2 (adapters); post-release migration         |
| F05 Close can quit after a failed/timed-out drain (verified: `finally` stops the sidecar and quits)                       | **fix before release** — on drain timeout or failure keep window and sidecar alive, show what is still active, offer Retry / Cancel close / Force quit (explicit, consequences stated, never sets clean shutdown)                                                                                                                                                                                                                                                                      | WP-H1                                            |
| F06 same-target admission and crash reconciliation incomplete                                                             | **fix before release** — already kept as WP-B4 and WP-B5 (fault-injected reconciliation, orphan quarantine)                                                                                                                                                                                                                                                                                                                                                                            | WP-B4, WP-B5                                     |
| F07 Escape/close ad hoc; text Escape can commit                                                                           | **fix before release** — one PhotoLab Escape dispatcher with UIP-D14 rungs replacing per-island window listeners (consume the shared dispatcher when the Builder lane lands it); rename Escape reverts without blur commit (shared EntityTree — announced); visible function close; import close shows Cancelling… until acknowledged                                                                                                                                                  | WP-H3                                            |
| F08 selection cleared on hide/rename/move                                                                                 | **fix before release** — preserve and revalidate selection across non-replacement snapshots, prune only deleted ids; viewport cloud/splat click selection not applicable (UIP-D15); D17 write-to-all not applicable until an editable common property exists                                                                                                                                                                                                                           | WP-H3                                            |
| F09 P11 inputs missing                                                                                                    | **fix before release at the PhotoLab boundary** — WP-G2 rows document + G-1 coverage test (in flight); table/router/SDK consumed from the Builder lane later; raw allowlist not widened                                                                                                                                                                                                                                                                                                | WP-G2                                            |
| F10 cursor record misidentified (UIP-D24, not D22)                                                                        | **not applicable before release** — local 2D semantic cursors stay; the citation fix is in COORDINATION.md (Builder session)                                                                                                                                                                                                                                                                                                                                                           | —                                                |
| F11 no R1 gate proven closed                                                                                              | **fix before release** — execute and archive the gates for the exact candidate: full product chain (gate 1), 135-image Quality Hybrid golden run (gate 2), kill/reopen/resume with byte comparison (gate 3), real cancellation matrix incl. close during every stage (gate 4), both-platform inventories + native startup (5/6; Windows support declared or deferred explicitly), keyboard/pixel/screenshot review (7), G1c (8); evidence ledger with commit, command, machine, hashes | WP-H5 (evidence ledger) + existing gate packages |
| F12 accessibility claim overstated; keyboard reachability informational                                                   | **fix before release** — keyboard reachability becomes a failing gate once the shared tablist lands (S-02) and immediately for panel controls; first-run counts labeled historical; current report attached to the ledger; matching-environment pixel comparison executed                                                                                                                                                                                                              | WP-H5, WP-F3 commit                              |

New packages from this disposition (all on R1 gates):

### WP-H1 (Size S, gates 1/3)

F01 archive Save route + F05 close refusal with Retry / Cancel close / Force
quit.

```text
Footer
- A1 outcome: The user knows Save updates the active `.hcadx` archive and a failed/timed-out drain keeps the app open with safe recovery choices.
- A2 reference: adopted from FP-D14, P5/P6, and adoption-audit F01/F05
- A3 siblings: PhotoLab Save/Save As, canonical archive publication, durability status, Electron close, and sidecar drain
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — P11 rows `photolab.project.save` and `photolab.project.close` pending; shortcut — present
- B2 open/close: Ctrl+S/ribbon Save publishes the archive; close drains and either closes on acknowledgement or opens Retry / Cancel close / Force quit, with Escape cancelling the dialog rung per UIP-D14
- B3 surface: island + drain refusal is a focused consequential choice while archive Save status remains inline
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: drain timeout is an X6 constant; whole-project/active-work state is affected, not selection; source archive identity and working generation freeze before Save/close; archive publication is durable but not document undo, and Force quit never writes clean shutdown
- D1 performance class: long-running + archive-save atomicity and close-failure R1 gates 1/3/4; D2 degradation: slow storage keeps truthful pending/failure state and may refuse close, never claim success
- E1 visual reference: `workspace-view-restored.png`
- E2 conflicts/failure/crash: archive candidate publication is atomic; drain failure preserves window/sidecar; explicit Force quit states recovery consequences and cannot mark clean shutdown
- E3 verification: archive bytes/hash after Save, Save As source identity, drain timeout/failure choices, Force-quit recovery record, and no-partial/no-child assertions
- Decision record: cited unchanged: FP-D14 and adoption-audit F01/F05
- Evidence: open — not executed
- Status: queued
```

### WP-H2 (Size M, gates 3/4)

Side-operation drain coverage (inspection, mask, GCP operations) + global jobs
chip rehydrating from the sidecar job list after reload (adapter, not a
registry).

```text
Footer
- A1 outcome: The user sees every release-critical long operation after reload and can cancel or safely drain it from one global jobs path.
- A2 reference: adopted from UIP-D10/UIP-D11, FP-D20, and adoption-audit F04
- A3 siblings: sidecar durable Jobs list, archive/image operations, inspection, masks, GCP, global status chip, Jobs island, toast, and console
- B1 reachability: ribbon — present; context menu — absent; console — present; automation — P11 rows `photolab.jobs.list`, `.status`, and `.cancel` pending; shortcut — absent
- B2 open/close: status chip opens the Jobs island; explicit close and Escape use the detached-function rung per UIP-D14 while operations continue; Cancel remains reachable after reload
- B3 surface: island + a global multi-job list needs focused status/actions without occupying the function panel
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: progress values are read-only; job identity rather than entity selection drives actions; admission/config/input/checkpoint identity is frozen; history rehydrates durably while canonical results publish/journal through their owning commands
- D1 performance class: bounded + reload-rehydration gate and long-running + complete side-operation cancellation matrix; D2 degradation: polling/adapters may update less often under load, never hide ownership or lose cancelability
- E1 visual reference: `bottom-jobs.png`
- E2 conflicts/failure/crash: adapters register every owner in drain, durable sidecar identity rehydrates presentation, and cancellation reaches the original owner
- E3 verification: reload during every operation family, chip→island→toast→console chain, cancel after reload, drain coverage, and bounded acknowledgement
- Decision record: cited unchanged: UIP-D10/UIP-D11; no PhotoLab-private registry per COORDINATION.md
- Evidence: open — not executed
- Status: queued
```

### WP-H3 (Size M, gate 7)

Escape dispatcher with rungs, rename Escape/blur fix (shared, announced),
function close action, cancelling state, selection
preservation/revalidation.

```text
Footer
- A1 outcome: The user gets exactly one predictable Escape action, visible close/cancelling feedback, and stable selection through hide/rename/move/delete flows.
- A2 reference: adopted from UIP-D14–D18 and adoption-audit F07/F08
- A3 siblings: shared Escape dispatcher, FloatingTaskIsland, Image marker tool, EntityTree rename, FunctionPanel, ImportChat, and project-local selection
- B1 reachability: ribbon — present; context menu — present; console — absent; automation — P11 rows for underlying entity commands pending; shortcut — present
- B2 open/close: every surface registers one UIP-D14 rung; text Escape reverts without blur commit, function controls close explicitly, and busy import stays “Cancelling…” until acknowledgement
- B3 surface: inline + lifecycle/selection corrections live in shared primitives and existing surfaces
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: Escape restores committed typed values; hide/rename/move retain selection, delete prunes only removed ids, project replacement revalidates project-local ids, and viewport cloud/splat click selection remains inapplicable under UIP-D15; n/a because no expensive preview is added; selection is project-local history while entity edits remain canonical/undoable
- D1 performance class: continuous + Escape/selection interaction gate; D2 degradation: key dispatch, focus, and selection correctness never degrade
- E1 visual reference: `right-panel-properties.png`
- E2 conflicts/failure/crash: the shared dispatcher admits one rung per keypress and snapshot acceptance revalidates ids before all passive consumers update
- E3 verification: two islands, focused dirty text, armed marker, modal, function, selection ladder, cancelling acknowledgement, hide/rename/move retention, delete pruning, and project-switch revalidation
- Decision record: cited unchanged: UIP-D14–D18
- Evidence: open — not executed
- Status: queued
```

Status 2026-09-02 20:35: the Builder lane delegated the UIP-D14 dispatcher to this package under four conditions (one dispatcher in `packages/@himmelcad/ui` with the rung order verbatim from UIP-D14 and no PhotoLab-specific rungs; FunctionPanel close and ImportChat "Cancelling…" per UIP-D7/UIP-D10; ui tests plus Builder typecheck before the landed announcement; a peer conformance check afterwards). The first run had placed the dispatcher under `apps/photolab` and was stopped; re-dispatched with the conditions in the brief. `FloatingTaskIsland.tsx` is PhotoLab-local and becomes a consumer, not a move (recorded in COORDINATION.md by the Builder lane). Landed 2026-09-02 (be8bc6e): dispatcher in `packages/@himmelcad/ui/src/escapeLadder.ts` (rung order verbatim from UIP-D14, product-neutral API `registerEscapeRung`/`installEscapeLadder`/`escapeFreeTextProps`/`revertEscapeField`), FunctionPanel opt-in closeable tabs (UIP-D7), ImportChat opt-in cancellation scope ("Cancelling…" until acknowledged), PhotoLab consumers for rungs 2/4/5/6/8, selection lifecycle in `selectionLifecycle.ts` (UIP-D18). Known deviation for the peer conformance check: UIP-D7 says `IslandTabs` items accept the close affordance; the implementation renders closeable tabs inside FunctionPanel behind `closeFunctionTabs` instead of extending IslandTabs. Verified: ui tests 11/11, Builder typecheck, renderer tests 77/77.

### WP-H4 (documentation)

Per-package A1–E3 footer and evidence ledger.

```text
Footer
- A1 outcome: A release reviewer can trace every package from user outcome and reference through lifecycle, quality, decision authority, landing commit, executed evidence, and open acceptance.
- A2 reference: adopted from `docs/FUNCTION-CONTRACT.md` A1–E3 and adoption-audit F02
- A3 siblings: implementation-plan package template, doctrine decision records, Integration evidence, R1 triage, and WP-H5 ledger
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — absent; shortcut — absent
- B2 open/close: n/a because this is repository documentation
- B3 surface: inline + identical fenced footers remain adjacent to the package they disposition
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: n/a because this package documents contracts; n/a because no product selection changes; the dated audit/commit evidence is immutable once cited; version control provides persistence/reversal
- D1 performance class: bounded + footer inventory and Prettier idempotence gates; D2 degradation: n/a because documentation has no runtime tier
- E1 visual reference: none — open
- E2 conflicts/failure/crash: one-file scope and identical machine-readable shape prevent divergent package ledgers
- E3 verification: package-id/footer bijection, required-key validation, status totals, two Prettier writes, and final Prettier check
- Decision record: none consequential
- Evidence: in-flight working tree; executed evidence `H4-footer-inventory` = 46/46 unique packages with 15/15 keys; `H4-prettier-idempotence` = two unchanged writes and final check pass
- Status: in flight
```

### WP-H5 (evidence)

Executed R1 gate ledger for the release candidate.

Acceptance checklist — every unchecked item is `open — not executed`:

- [ ] WP-A1: camera COLMAP round-trip and cancel-without-destination acceptance.
- [ ] WP-A2: render every report section from the smoke dataset.
- [ ] WP-A3: dense mesh publish/render/PLY export, child cancellation, lineage, and unchanged DEM mesh.
- [ ] WP-A4: smoke DTM-vs-DSM, synthetic precision/recall, two-run determinism, and cancellation.
- [ ] WP-A5: reference-preselection wiring tests and the frozen 135-image Quality Hybrid gate.
- [ ] WP-A6: GPU parity/fallback/kill-switch acceptance if runtime delivery is unparked.
- [ ] WP-B1: kill/reopen MVS and alignment interruption classification.
- [ ] WP-B2: splat kill/relaunch/resume and changed-config rejection.
- [ ] WP-B3: close during MVS and SIGTERM/COLMAP child reaping.
- [ ] WP-B4: same-target DEM rejection, archive cancellation on close, target-key units, and side-operation drain coverage.
- [ ] WP-B5: journal/manifest and dataset-rename crash injections, quarantine, project-runtime suite, and Windows flush.
- [ ] WP-B6: corrupt-record diagnostics and actionable camera-map failure fixtures.
- [ ] WP-C1: complete fresh-profile UI acceptance and selected-preset real-data run.
- [ ] WP-C2: golden vertical test vector and explicit no-transform labeling.
- [ ] WP-C3: relaunch with images/GCPs, kill-9 recovery, and guarded stale-Untitled cleanup.
- [ ] WP-C3b: real archive Save plus drain-refusal/Force-quit recovery semantics.
- [ ] WP-C4: empty-prerequisite, two-revision/report, explicit-revision, and renderer acceptance.
- [ ] WP-C5: MP4 frame import, extraction cancellation cleanup, and picker separation.
- [ ] WP-C6: unattended full smoke chain and legacy recipe migration; parked optimize/export/report stages require re-triage.
- [ ] WP-C7: hands-on Agent open with empty configuration and zero console errors.
- [ ] WP-C8: 800-image interaction gate and complete residual-to-highlight workflow.
- [ ] WP-C9: actual pixel comparison and complete hands-on import/jobs/tree/markers/error pass.
- [ ] WP-C10: execute the named grid parity and existing import suites.
- [ ] WP-D1: merged-run optimization, DEM block/lineage, report, and sidecar resolution tests.
- [ ] WP-D2: mixed real-data refinement and single-mission golden comparison.
- [ ] WP-D3: merge RMS/misclosure, disjoint preflight, frozen profile, and real-data evidence.
- [ ] WP-D4: lab-seed, duplicate-draft, ungrouped badge, session-gap, merge-proposal, and English acceptance.
- [ ] WP-E1: smoke inspector sigmas/matrix/residual/report/provenance acceptance.
- [ ] WP-E2: seeded-outlier ranking, exclusion/undo, improved RMSE, and report lineage if unparked.
- [ ] WP-E3: mixed-sigma solver weight ratio and mapped-column preview.
- [ ] WP-E4: smoke overlap map/report/toggle/frame/cache acceptance if unparked.
- [ ] WP-F1: full PhotoLab filtered suite locally and in GitLab.
- [ ] WP-F2: unchanged-tree CI visual pass and seeded-regression failure.
- [ ] WP-F3: passing keyboard reachability/focus, matching-machine pixel comparison, and human screenshot review.
- [ ] WP-F3b: post-remediation layout invariants, baseline regeneration/comparison, and full keyboard acceptance.
- [ ] WP-F4: exact-candidate Windows inventory and native install/startup if Windows is supported.
- [ ] WP-G1: complete all-kind Builder/WeltView R1 gate 8.
- [ ] WP-G1a: target admission plus crash-safe all-release-kind publication/provenance acceptance.
- [ ] WP-G1b: Builder list/register/undo/Save As/reopen and WeltView opening.
- [ ] WP-G1c: every Available row passes exact identity/provenance/render/pick/snap R1 gate 8.
- [ ] WP-G2: command-row document, G-1 coverage, generated console/SDK consumption, and Python smoke.
- [ ] WP-H1: archive Save and close-refusal/Force-quit acceptance.
- [ ] WP-H2: all-operation reload rehydration, global jobs chain, cancel, and drain bounds.
- [ ] WP-H3: complete Escape ladder, close/cancelling, and selection lifecycle matrix.
- [ ] WP-H5: immutable exact-candidate evidence ledger closes R1 gates 1–8 with explicit skips.

```text
Footer
- A1 outcome: The release reviewer receives one immutable exact-candidate ledger that distinguishes passes, failures, and explicit skips for all eight R1 gates.
- A2 reference: adopted from `docs/ROADMAP.md` R1 gates and `docs/TEST-TIERS.md`
- A3 siblings: Integration evidence, golden dataset, cancellation matrix, native runtime/package inventories, accessibility report, and G1c
- B1 reachability: ribbon — absent; context menu — absent; console — absent; automation — absent; shortcut — absent
- B2 open/close: n/a because this is operator-run release evidence
- B3 surface: inline + evidence is a repository ledger/artifact set, not product UI
- C1 numeric parity / C2 selection / C3 freezability / C4 persistence+undo: thresholds cite frozen gate definitions; exact inputs/capabilities are enumerated rather than selected interactively; commit/build/machine/input/output hashes freeze each run; evidence is immutable/versioned and never rewritten as product undo
- D1 performance class: long-running + R1 gates 1–8; D2 degradation: unsupported capability is an explicit skip/failure and never a pass
- E1 visual reference: `00-main-view.png` and the named surface set in `manifest.json`
- E2 conflicts/failure/crash: isolated candidate identity and artifact hashes prevent mixed-build evidence; partial runs remain partial
- E3 verification: full product chain, 135-image Quality Hybrid, kill/reopen/resume byte comparison, real cancellation/close matrix, both-platform runtime/package startup, keyboard/pixel/human visual review, and G1c
- Decision record: cited unchanged: R1 gates, X1, and adoption-audit F11/F12
- Evidence: open — not executed
- Status: queued
```

Landed 2026-09-02 (b5fec8e): `pnpm photolab:evidence:ledger --out <file> [--candidate <rev>] [--e2e <dir>…] [--a11y <dir>] [--baselines <dir>] [--cargo-log …] [--node-log …]` writes the R1 ledger from executed artifacts only (presence plus each artifact's own verdict; never certifies closure). 14 unit tests. Implemented by the Grok wrapper (mechanical work under D8).

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
