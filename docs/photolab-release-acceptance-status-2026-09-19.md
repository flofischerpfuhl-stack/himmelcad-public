# PhotoLab release acceptance status — 2026-09-19

Document class: executed-evidence reconciliation. This document compares the 45
items in WP-H5's acceptance checklist with the exact acceptance text in each
work package. A landed implementation, a passing adjacent test, or an inferred
consumer behavior is not counted as execution. The candidate inspected and
used for the 2026-09-19 cheap runs is `52ba2de4ac8d4865811ed9826a435b46db00ddba`
(`2026-09-19`); the working tree was dirty before this package and was not
committed.

Status totals: **4 EXECUTED**, **37 PARTIAL**, **0 NOT EXECUTED**, **4 PARKED**.
`EXECUTED` means every clause in the checklist item has a named successful run.
`PARTIAL` means at least one clause has direct evidence and at least one exact
clause remains. `PARKED` cites the 2026-09-05 R1 triage/owner-decision boundary
in the implementation plan. Evidence generated on 2026-09-19 is recorded in
this file; older evidence retains its own candidate identity.

Lane compliance: no repository or dataset copy was made. Rust used the absolute
`CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab`;
future run output below is confined to `.build/codex-scratch/photolab-h5r/`
until evidence is deliberately retained.

## Acceptance status

| WP     | Checklist item                                                                                                   | Status       | Executed evidence and exact-text match                                                                                                                                                                                                                                                                                                                                                                                                                                               | Missing acceptance                                                                                                                             | Closing run (estimate; machine; owner/human)                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| WP-A1  | Camera COLMAP round-trip and cancel-without-destination acceptance.                                              | **EXECUTED** | [2026-09-19 runs](#wp-a1): camera round-trip 1/1; point-cloud cancellation 4/4 includes removal of partial output; product-export atomicity 2/2. Code commit `2163b67` (2026-09-02), run candidate `52ba2de` (2026-09-19). **Exact match: yes.**                                                                                                                                                                                                                                     | None for this checklist line. The broader WP still has release-workflow evidence elsewhere.                                                    | Closed.                                                                                                                          |
| WP-A2  | Render every report section from the smoke dataset.                                                              | **PARTIAL**  | `pnpm --filter @himmelcad/photolab test` passed 87/87 plus both contract scripts; `processing_report_and_calibration_query_return_frozen_accuracy_evidence` passed in the 103/103 sidecar binary run. Commits `ec9cba0`, `90b4ddc`; current run 2026-09-19. **Exact match: no**—fixtures are not the smoke dataset.                                                                                                                                                                  | Export and inspect one report from the 24-image smoke with every section populated and record byte comparison.                                 | [R11](#r11-smoke-report) (20–30 min; laptop; human inspection).                                                                  |
| WP-A3  | Dense mesh publish/render/PLY export, child cancellation, lineage, and unchanged DEM mesh.                       | **PARTIAL**  | `.build/photolab-evidence/a3/mesh-smoke/result.json` (success, 2026-09-04, ledger candidate `ea66991`); `.build/photolab-evidence/g1a3/mesh-smoke-result.json` (complete/available package, 2026-09-10); 2026-09-19 Poisson supervision 2/2. Commits `108e20f`, `601efde`, `1148ffd`. **Exact match: no**—no named viewer-render + PLY-export run and no named unchanged-DEM-mesh comparison.                                                                                        | Execute dense and DEM mesh variants, open each in PhotoLab, export dense mesh as PLY, and compare DEM output hash/baseline.                    | [H01](#h01-full-product-smoke) + [R12](#r12-mesh-view-export) (1–2 h; laptop; human for view/export).                            |
| WP-A4  | Smoke DTM-vs-DSM, synthetic precision/recall, two-run determinism, and cancellation.                             | **EXECUTED** | `.build/photolab-evidence/a4/{dtm-smoke,dsm-smoke}/result.json` and `docs/photolab-release-evidence-2026-09-04.md` (successful 24-image pair at ledger candidate `ea66991`, 2026-09-04); 2026-09-19 `ground_classification::tests` 5/5 names quality, hash equality, and cancellation. Commits `3e05da1`, `6b87d00` (2026-09-04). **Exact match: yes.**                                                                                                                              | None.                                                                                                                                          | Closed.                                                                                                                          |
| WP-A5  | Reference-preselection wiring tests and the frozen 135-image Quality Hybrid gate.                                | **PARTIAL**  | Core alignment/matching suite 247/247 + 1/1 schema test passed on 2026-09-19; `.build/photolab-evidence/a7/smoke5-result.json` and `.build/photolab-evidence/win16-report.md` prove smaller runs only. **Exact match: no.**                                                                                                                                                                                                                                                          | The 135-image Quality Hybrid threshold run has never completed; existing Fast/24-image and 16 GB evidence is non-equivalent.                   | [H02](#h02-frozen-135-image-golden) (10–14 h; Windows PC preferred; owner reviews metrics).                                      |
| WP-A6  | GPU parity/fallback/kill-switch acceptance if runtime delivery is unparked.                                      | **PARKED**   | Plan §R1 triage, owner decision 2026-09-05: “WP-A6 GPU runtimes … owner decisions”; WP-A6 status parks payload/licensing/cross-platform admission. Read-only probe commit `7c3fdbb`. **Exact match: conditional and not run.**                                                                                                                                                                                                                                                       | Owner must unpark CUDA runtime delivery before parity, fallback, inventory, and kill-switch can run.                                           | [H04](#h04-gpu-runtime-parity) (2–4 h after runtime build; CUDA-capable PC; owner decision required).                            |
| WP-B1  | Kill/reopen MVS and alignment interruption classification.                                                       | **PARTIAL**  | 2026-09-19 job runtime 49/49 and sidecar binary 103/103 include durable per-kind checkpoints and recoverable-kind classification; old smoke rows record checkpoint sequence 120. Commit `068fdcd`. **Exact match: no**—no process kill/reopen run.                                                                                                                                                                                                                                   | Kill a real MVS job after a durable checkpoint, reopen, verify `interruptedRecoverable`; repeat during alignment and verify plain interrupted. | [H03](#h03-cancellation-recovery-matrix) (2–4 h; laptop; no owner, human process kill).                                          |
| WP-B2  | Splat kill/relaunch/resume and changed-config rejection.                                                         | **PARTIAL**  | 2026-09-19 E2E cancellation/recovery contract passed; job runtime 49/49 and binary 103/103 include resume submission and field-by-field identity rejection. Commit `320977c`. **Exact match: no**—no real splat continuation.                                                                                                                                                                                                                                                        | Cancel/kill a real splat after checkpoint, relaunch/resume to completion, then rerun with one changed field and require typed rejection.       | [H03](#h03-cancellation-recovery-matrix) (2–5 h; laptop; no owner).                                                              |
| WP-B3  | Close during MVS and SIGTERM/COLMAP child reaping.                                                               | **PARTIAL**  | 2026-09-19 process-group 2/2 proves grandchild kill; sidecar binary 103/103 proves clean-shutdown drain ordering. Commit `566ef80`. **Exact match: no**—named real MVS close and SIGTERM alignment runs absent.                                                                                                                                                                                                                                                                      | Run MVS then close project; separately SIGTERM the sidecar during COLMAP and assert terminal-before-clean plus no surviving process.           | [H03](#h03-cancellation-recovery-matrix) (1–3 h; laptop; human close/signal).                                                    |
| WP-B4  | Same-target DEM rejection, archive cancellation on close, target-key units, and side-operation drain coverage.   | **PARTIAL**  | 2026-09-19 job runtime 49/49 includes target collision; sidecar binary 103/103 includes archive cancellation, jobs adapters, and all-owner drain. Commit `fcf75c8`; H2 commit `2ef29d5`. **Exact match: no**—the collision run is generic, not a named two-DEM admission run through the public route.                                                                                                                                                                               | Queue two DEMs for the same alignment, close during an archive save, and preserve the public RPC/UI results.                                   | [R13](#r13-admission-and-archive-integration) (10–20 min; laptop; no human if scripted).                                         |
| WP-B5  | Journal/manifest and dataset-rename crash injections, quarantine, project-runtime suite, and Windows flush.      | **PARTIAL**  | 2026-09-19 sidecar binary 103/103 includes exact re-emission/orphan/quarantine tests; commit `b66a66b` (2026-09-04). `WIN-16` proves later native Windows publication; `docs/builder-program/evidence/PL-B1b-durable-sync-dem-residency-2026-09-11.md` proves 13/13 durable filter but explicitly says no native Windows run. **Exact match: no**—no named B5 native Windows directory-flush run on the current candidate.                                                           | Run the B5 fault suite natively on Windows and exercise journal/manifest recovery after a forced boundary crash.                               | [R14](#r14-windows-durability) (20–40 min; Windows PC; no GUI owner).                                                            |
| WP-B6  | Corrupt-record diagnostics and actionable camera-map failure fixtures.                                           | **EXECUTED** | 2026-09-19 sidecar binary 103/103 includes `corrupt_record_fixture_surfaces_in_project_diagnostics` and `corrupt_camera_map_fails_job_with_its_path_and_recovery_action`. Commits `f295c50`, `e4d26d9` (2026-09-02); run candidate `52ba2de` (2026-09-19). **Exact match: yes.**                                                                                                                                                                                                     | None.                                                                                                                                          | Closed.                                                                                                                          |
| WP-C1  | Complete fresh-profile UI acceptance and selected-preset real-data run.                                          | **PARTIAL**  | PhotoLab renderer 87/87 includes six preset tests; Electron 10/10. Commit `aaa29b7`. **Exact match: no**—no fresh-profile hands-on path or 135-image selected-preset run.                                                                                                                                                                                                                                                                                                            | Fresh profile hands-on check, then select Quality Hybrid and execute the frozen 135-image gate.                                                | [M01](#m01-photolab-hands-on) + [H02](#h02-frozen-135-image-golden) (30 min + 10–14 h; laptop/Windows PC; human + owner review). |
| WP-C2  | Golden vertical test vector and explicit no-transform labeling.                                                  | **PARTIAL**  | Renderer 87/87 includes five height-decision tests; GCP runtime 11/11 includes fail-closed transform behavior; English UI passed. Commit `2762b5f`. **Exact match: no**—no DHHN2016 golden-coordinate result was executed.                                                                                                                                                                                                                                                           | Add/run the named `photolab/01_Transformation` vector and capture the preserve-values label.                                                   | [R15](#r15-vertical-golden) (5–15 min; laptop; no owner, one UI capture if label is not component-tested).                       |
| WP-C3  | Relaunch with images/GCPs, kill-9 recovery, and guarded stale-Untitled cleanup.                                  | **PARTIAL**  | Electron 10/10 covers MRU and validated litter selection; project-file and dialog-policy contracts passed. Commit `c720bb8`. **Exact match: no**—hands-on relaunch and kill-9 absent.                                                                                                                                                                                                                                                                                                | Import images/GCPs, relaunch, kill Electron during autosave, relaunch/recover, then exercise guarded cleanup.                                  | [M02](#m02-project-lifecycle) (45–60 min; laptop; human).                                                                        |
| WP-C3b | Real archive Save plus drain-refusal/Force-quit recovery semantics.                                              | **PARTIAL**  | Electron 10/10 covers honest Save routing and drain acknowledgement; sidecar binary 103/103 covers archive atomicity. Commit `9593bd9`. **Exact match: no**—real archive bytes plus refusal/Force-quit recovery not run.                                                                                                                                                                                                                                                             | Save and hash a real archive, force drain timeout/failure, test Retry/Cancel/Force quit, then reopen recovery.                                 | [M02](#m02-project-lifecycle) (45–60 min; laptop; human).                                                                        |
| WP-C4  | Empty-prerequisite, two-revision/report, explicit-revision, and renderer acceptance.                             | **PARTIAL**  | Renderer 87/87 includes six prerequisite tests; sidecar binary 103/103 includes explicit revision honored/wrong-lineage and processing-report evidence. Commit `bf27605`. **Exact match: no**—two selectable real revisions and report pinning were not run end-to-end.                                                                                                                                                                                                              | Build two converged revisions in one fixture, select each through UI, start product, and inspect report lineage.                               | [R16](#r16-gcp-product-integration) (20–40 min with prepared fixture; laptop; human only for UI acceptance).                     |
| WP-C5  | MP4 frame import, extraction cancellation cleanup, and picker separation.                                        | **PARTIAL**  | Renderer 87/87 covers video-plan and picker separation; capture runtime result was 3 passed/1 ignored. Commit `f075056`. **Exact match: no**—the real FFmpeg MP4 gate was explicitly ignored.                                                                                                                                                                                                                                                                                        | Run the ignored FFmpeg fixture with explicit tool paths, then cancel mid-extraction and inspect no partial commit.                             | [R08](#r08-ffmpeg-video-fixture) (5–10 min; laptop; no human if fixture assertion is complete).                                  |
| WP-C6  | Unattended full smoke chain and legacy recipe migration; parked optimize/export/report stages require re-triage. | **PARTIAL**  | Renderer 87/87 includes four legacy/current pipeline and four execution tests. Commit `3c277c4`. Plan §R1 triage (2026-09-05) parks optimize/export/report convenience stages. **Exact match: no**—no unattended full product-chain smoke.                                                                                                                                                                                                                                           | Run the existing depth→dense→DEM→ortho→mesh→splat chain; owner must re-triage the parked extra stages before they can be required.             | [H01](#h01-full-product-smoke) (1–4 h; laptop; owner only for parked stage decision).                                            |
| WP-C7  | Hands-on Agent open with empty configuration and zero console errors.                                            | **PARTIAL**  | Automation-host 48 passed/1 pinned-version skip includes both missing and empty PATH “not configured” tests. Commit `2b14c9e`. **Exact match: no**—no visible panel/console run.                                                                                                                                                                                                                                                                                                     | Start PhotoLab with agent variables absent, open Agent through ribbon, capture empty state and zero page/console errors.                       | [M01](#m01-photolab-hands-on) (10 min; laptop; human).                                                                           |
| WP-C8  | 800-image interaction gate and complete residual-to-highlight workflow.                                          | **PARTIAL**  | Renderer 87/87 covers worst-residual selection, filmstrip virtualization, and keyboard navigation. Commits `41c1d09`, `6fd5e33`, `46e7d66`. **Exact match: no**—no 800-image frame trace or complete UI path.                                                                                                                                                                                                                                                                        | Load the 800-image fixture, record filmstrip frame/input trace, click a residual, and verify exact image + highlighted marker.                 | [M03](#m03-large-image-qc) (45–90 min; laptop; human).                                                                           |
| WP-C9  | Actual pixel comparison and complete hands-on import/jobs/tree/markers/error pass.                               | **PARTIAL**  | English UI passed; dialog policy passed; comparator unit 10/10; 2026-09-09 handoff records 90 dark + 90 light captures with zero a11y findings. Commit `d201b3a`. **Exact match: no**—baseline refresh/capture is not a matching-environment pixel comparison, and no complete current hands-on pass exists.                                                                                                                                                                         | Run exact-candidate pixel comparison in the matching environment and the full hands-on workflow.                                               | [M01](#m01-photolab-hands-on) + [M04](#m04-visual-accessibility) (1–2 h; laptop/private Xvfb; human screenshot review).          |
| WP-C10 | Execute the named grid parity and existing import suites.                                                        | **EXECUTED** | 2026-09-19 PhotoLab renderer 87/87 includes GCP `.gsb`→`ntv2`, image-import `.gsb`→`ntv2`, `containsArea`, and the full `gcpImportDecision`/`importFreeze` groups. Commits `587c94d`, `3192d36` (2026-09-02), run candidate `52ba2de` (2026-09-19). **Exact match: yes.**                                                                                                                                                                                                            | None.                                                                                                                                          | Closed.                                                                                                                          |
| WP-D1  | Merged-run optimization, DEM block/lineage, report, and sidecar resolution tests.                                | **PARTIAL**  | Sidecar binary 103/103 includes merged source resolution, overlap block, exact lineage and report-query tests. Commit `5c25590`. **Exact match: no**—no real two-mission optimize→DEM→report run.                                                                                                                                                                                                                                                                                    | Execute the two-mission overlap fixture twice: blocked before optimization, then optimized with DEM/report lineage.                            | [R17](#r17-real-merge-quality) (2–4 h; laptop; no owner).                                                                        |
| WP-D2  | Mixed real-data refinement and single-mission golden comparison.                                                 | **PARTIAL**  | Core 247/247 and sidecar binary 103/103 include policy→strategy and pinned/refined behavior. Commits `31c9949`, `c14b107`, `a1dc449`. **Exact match: no**—no mixed real data or golden before/after.                                                                                                                                                                                                                                                                                 | Run embedded+unseeded mixed mission and single-mission before/after, recording parameter deltas and output hashes/metrics.                     | [R17](#r17-real-merge-quality) + [H02](#h02-frozen-135-image-golden) (2–4 h + golden; laptop/Windows PC).                        |
| WP-D3  | Merge RMS/misclosure, disjoint preflight, frozen profile, and real-data evidence.                                | **PARTIAL**  | Sidecar binary 103/103 includes disjoint/overlap preflight and persisted connection evidence structures; alignment-merge fixture passed. Commit `4ec3e27`. **Exact match: no**—no real merged RMS/misclosure run.                                                                                                                                                                                                                                                                    | Run shared-control and disjoint fixtures through visible profile selection and record report values.                                           | [R17](#r17-real-merge-quality) (2–4 h; laptop; human for visible profile acceptance).                                            |
| WP-D4  | Lab-seed, duplicate-draft, ungrouped badge, session-gap, merge-proposal, and English acceptance.                 | **PARTIAL**  | Lab-calibration 4/4; capture-group fixture passed; sidecar binary 103/103 names lab seed, duplicate draft, session grouping, and proposal merge; English UI passed. Commit `631f7f7`. **Exact match: no**—ungrouped badge was not rendered in a named acceptance run.                                                                                                                                                                                                                | Open Capture Groups with ungrouped cameras and exercise all five visible flows while preserving sidecar assertions.                            | [M01](#m01-photolab-hands-on) (20–30 min; laptop; human).                                                                        |
| WP-E1  | Smoke inspector sigmas/matrix/residual/report/provenance acceptance.                                             | **PARTIAL**  | Core 247/247 includes covariance/correlation/radial-profile tests; renderer 87/87 includes heatmap/radial helpers; sidecar binary 103/103 includes frozen accuracy evidence. Commit `171791b`. **Exact match: no**—no inspector after smoke optimization.                                                                                                                                                                                                                            | Optimize the smoke project, open inspector, verify plausible sigmas/symmetric matrix/residual plot/hash and exported report.                   | [R18](#r18-calibration-inspector) (30–60 min with existing alignment; laptop; human).                                            |
| WP-E2  | Seeded-outlier ranking, exclusion/undo, improved RMSE, and report lineage if unparked.                           | **PARKED**   | Plan §R1 triage (2026-09-05) parks per-observation QC editing as non-release Metashape parity; WP-E2 status repeats that decision. **Exact match: conditional and not run.**                                                                                                                                                                                                                                                                                                         | Owner must unpark; then run seeded-outlier fixture through exclude→optimize→undo and compare RMSE/report lineage.                              | [R19](#r19-parked-qc) (20–40 min after implementation; laptop; owner decision required).                                         |
| WP-E3  | Mixed-sigma solver weight ratio and mapped-column preview.                                                       | **PARTIAL**  | Core 247/247 includes `mixed_point_accuracy_uses_inverse_variance_weights`; renderer 87/87 includes sigma/code header detection and parsed/fallback row labels. Commit `e8d0aa8`. **Exact match: no**—no named rendered wizard preview assertion.                                                                                                                                                                                                                                    | Open/import the mixed-σ CSV fixture and capture mapped columns/row values while retaining solver ratio test.                                   | [R20](#r20-mixed-sigma-preview) (10–15 min; laptop; human unless component capture is automated).                                |
| WP-E4  | Smoke overlap map/report/toggle/frame/cache acceptance if unparked.                                              | **PARKED**   | Plan §R1 triage (2026-09-05) parks overlap visualization as non-release parity breadth; WP-E4 status repeats it. **Exact match: conditional and not run.**                                                                                                                                                                                                                                                                                                                           | Owner must unpark, then execute smoke geometry comparison, report, toggle, cache invalidation and frame gate.                                  | [R21](#r21-parked-overlap) (30–60 min after implementation; laptop; owner decision required).                                    |
| WP-F1  | Full PhotoLab filtered suite locally and in GitLab.                                                              | **PARTIAL**  | Local exact command passed on 2026-09-19: renderer 87/87, Electron 10/10, processing-report and Cap contract scripts passed. Commit `d6053bf`; candidate `52ba2de`. **Exact match: no**—no GitLab job for this candidate.                                                                                                                                                                                                                                                            | Push an exact candidate and require the GitLab node-test job to show the same discovered suites/counts.                                        | [R09](#r09-ci-jobs) (5–15 min CI; external GitLab; no owner unless runner unavailable).                                          |
| WP-F2  | Unchanged-tree CI visual pass and seeded-regression failure.                                                     | **PARTIAL**  | Comparator unit passed 10/10 and release contract passed on 2026-09-19. Commit `7a126db`. **Exact match: no**—neither actual CI green nor seeded CI red exists.                                                                                                                                                                                                                                                                                                                      | Run two GitLab visual jobs from the same environment: unchanged candidate and temporary seeded layout mutation, archiving both results.        | [R09](#r09-ci-jobs) (15–30 min CI; external GitLab; human reviews seeded failure).                                               |
| WP-F3  | Passing keyboard reachability/focus, matching-machine pixel comparison, and human screenshot review.             | **PARTIAL**  | Plan gate evidence (2026-09-02, commits `6774990`, `72aca4e`) records 0 axe and 0 keyboard failures across 42 surfaces; handoff records 90+90 captures/0 a11y on 2026-09-09. **Exact match: no**—no named matching-machine comparison plus complete human review.                                                                                                                                                                                                                    | Run current a11y/keyboard/pixel gates under the private display launcher and review every changed/required screenshot.                         | [M04](#m04-visual-accessibility) (1–2 h; laptop/private Xvfb; human).                                                            |
| WP-F3b | Post-remediation layout invariants, baseline regeneration/comparison, and full keyboard acceptance.              | **PARTIAL**  | Current comparator unit 10/10; historical bounded axe zero; commit `7831b94`. **Exact match: no**—post-remediation full layout/keyboard run and matched comparison absent.                                                                                                                                                                                                                                                                                                           | Same exact-candidate visual run, with invariant report and a deliberate reviewed baseline regeneration followed by clean comparison.           | [M04](#m04-visual-accessibility) (1–2 h; laptop/private Xvfb; human).                                                            |
| WP-F4  | Exact-candidate Windows inventory and native install/startup if Windows is supported.                            | **PARKED**   | Plan §R1 triage (2026-09-05) parks signing/operator work and explicitly leaves native certification open **if Windows is supported**. [PL-R1](builder-program/evidence/PL-R1-release-inputs-2026-09-19.md) built the exact cross-target Rust binaries and passed the Windows inventory with **2,612 files**. WIN-02 opened only a dev shell; WIN-16 is a sidecar workflow, not installer evidence. **Exact match: no**—inventory is closed, native installation is not.              | Owner decides Windows support/signing. If supported: install NSIS, launch native app and verify signature/update policy.                       | [R10](#r10-windows-release) (1–3 h; Windows PC unlocked; owner decision + GUI).                                                  |
| WP-G1  | Complete all-kind Builder/WeltView R1 gate 8.                                                                    | **PARTIAL**  | `docs/builder-program/PHOTOLAB-G1C-MATRIX.md`; sparse identity/render pass but pick/snap fail, dense not run, DSM/DTM pass after PL-B1b, mesh not run, unavailable rows explicit. Commits `437789f` and PL-B1b evidence dated 2026-09-11. **Exact match: no.**                                                                                                                                                                                                                       | Fix/retest sparse exact picks, run dense and mesh, then Save As/reopen and WeltView for every Available row.                                   | [H05](#h05-g1c-matrix) (4–8 h; Windows PC/laptop with RAM and GPU; human Builder/WeltView pass).                                 |
| WP-G1a | Target admission plus crash-safe all-release-kind publication/provenance acceptance.                             | **PARTIAL**  | G1a DSM/DTM/mesh result files show complete/available real packages; current sidecar/core suites cover collision, ready-last, hashes and lineage. Commits `3c6f4d0`, `c7bb505` and follow-ups. **Exact match: no**—not every release kind publishes an Available package; splat/ortho/merged remain unavailable or absent.                                                                                                                                                           | Execute full product smoke, crash at package boundaries, and verify every advertised release kind or explicit unavailable disposition.         | [H01](#h01-full-product-smoke) + [H03](#h03-cancellation-recovery-matrix) (2–5 h; laptop).                                       |
| WP-G1b | Builder list/register/undo/Save As/reopen and WeltView opening.                                                  | **PARTIAL**  | `docs/builder-program/evidence/G1b-product-registration-2026-09-08.md`, `G1b-fix-2026-09-09.md`, and PL-B1b prove registration, idempotence, undo/reopen and DEM residency. **Exact match: no**—WeltView opening and complete Available-row sweep absent.                                                                                                                                                                                                                            | Execute the canonical `.hcadx` Save As/reopen and WeltView read-only open for every Available package.                                         | [H05](#h05-g1c-matrix) (2–4 h; Windows PC/laptop; human GUI).                                                                    |
| WP-G1c | Every Available row passes exact identity/provenance/render/pick/snap R1 gate 8.                                 | **PARTIAL**  | Matrix evidence is explicit: DSM/DTM pass all four behavior cells; sparse pick/snap fail 4/7; dense and mesh cells not run. **Exact match: no.**                                                                                                                                                                                                                                                                                                                                     | Close all failing/unrun cells without weakening the oracle; repeat exact identities after fixes.                                               | [H05](#h05-g1c-matrix) (4–8 h; machine with ≥8 GB free RAM and working GPU; human).                                              |
| WP-G2  | Command-row document, G-1 coverage, generated console/SDK consumption, and Python smoke.                         | **PARTIAL**  | [PL-I2](builder-program/evidence/PL-I2-photolab-automation-sdk-2026-09-19.md) closes R22: 72 generated typed sync plus 72 async methods; SDK **16/16**; app/freshness **83/83**; automation host **49 passed/1 pinned-version skip**; PhotoLab renderer **88/88** plus Electron/contracts; real brokered-grant sync and async smokes passed in 1.7 s each at about 75 MiB host+sidecar RSS. **Exact match: no**—the PhotoLab `App.tsx` console adapter remains hand-listed. | Replace the hand-listed PhotoLab console dispatcher with generated command-table dispatch and rerun G-3. | R22 SDK/smoke closed by PL-I2; remaining G-3 console adapter is a bounded local follow-up. |
| WP-H1  | Archive Save and close-refusal/Force-quit acceptance.                                                            | **PARTIAL**  | Archive and project-lifecycle unit/contract coverage passed on 2026-09-19; H1/H1b implementation evidence exists. **Exact match: no**—no real archive hash and no live refusal/Force-quit recovery run.                                                                                                                                                                                                                                                                              | Execute the same real lifecycle scenario as C3b and record archive bytes, refusal choices and recovery truth.                                  | [M02](#m02-project-lifecycle) (45–60 min; laptop; human).                                                                        |
| WP-H2  | All-operation reload rehydration, global jobs chain, cancel, and drain bounds.                                   | **PARTIAL**  | Sidecar binary 103/103 covers all side-operation owners/cancel/drain; app 80/80 covers generic reload/cancel; H2/H2b screenshots and commits `2ef29d5`, `6cc334b`. **Exact match: no**—not every PhotoLab operation family was reloaded in a named run and toast/console chain is not evidenced end-to-end.                                                                                                                                                                          | For each operation family, reload the renderer, open chip→Jobs→toast→console, cancel, and record acknowledgement/drain bound.                  | [M05](#m05-jobs-rehydration) (60–90 min; laptop; human).                                                                         |
| WP-H3  | Complete Escape ladder, close/cancelling, and selection lifecycle matrix.                                        | **PARTIAL**  | Commit `be8bc6e`; PhotoLab renderer 87/87 includes four selection-lifecycle tests; historical shared UI 11/11. **Exact match: no**—complete two-island/text/marker/modal/function/cancelling matrix not executed on the candidate.                                                                                                                                                                                                                                                   | Execute the full UIP-D14 rung sequence and selection hide/rename/move/delete/project-switch matrix.                                            | [M06](#m06-escape-selection) (30–45 min; laptop; human).                                                                         |
| WP-H5  | Immutable exact-candidate evidence ledger closes R1 gates 1–8 with explicit skips.                               | **PARTIAL**  | Generator tests passed 14/14; `docs/photolab-release-evidence-2026-09-04.md` is immutable but belongs to candidate `ea66991` and leaves gates 2–6/8 not executed. **Exact match: no.**                                                                                                                                                                                                                                                                                               | After all release runs, generate a new ledger for one frozen candidate with commands, machine identities, hashes, verdicts and explicit skips. | [R23](#r23-final-ledger) (10–20 min after evidence collection; laptop; owner signs release disposition).                         |

## Executed command evidence

All commands below ran once on 2026-09-19 unless an environmental retry or a
PL-R1 progressive fail-closed inventory attempt is explicitly stated. Rust commands used
`CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab`
and `-j 4`. The first ground-classification attempt did not start because Cargo
was absent from the tool shell's `PATH`; the permitted environmental retry used
`/home/oem/.cargo/bin/cargo` and is the recorded run.

- `pnpm --filter @himmelcad/photolab test`: renderer **87/87**, Electron
  **10/10**, processing-report contract passed, Cap import contract passed.
  The 87 include both G-1 assertions, legacy recipe migration, grid parity,
  prerequisite logic, filmstrip/QC helpers, and selection lifecycle.
- `pnpm photolab:check:english-ui`: passed.
- Fixture/contract scripts: project files passed; capture groups passed;
  lab calibration **4/4**; alignment merge passed; dialog policy passed;
  release contract passed; E2E cancellation/recovery contract passed; visual
  comparator **10/10**; evidence ledger **14/14**.
- Generated surfaces: command-table staleness check passed; app **83/83**;
  automation host **48 passed, 0 failed, 1 skipped** (real Codex probe version
  pin expected 0.144.5, installed 0.155.1).
- Python SDK: [PL-R1](builder-program/evidence/PL-R1-release-inputs-2026-09-19.md)
  regenerated a manifest-only contract pin and passed **14/14**; the generated
  Python tree is current.
- Rust: sidecar ground classification **5/5**; point-cloud export **4/4**;
  product export **2/2**; job runtime **49/49**; sidecar binary **103/103**;
  camera export **1/1**; Poisson mesh **2/2**; process group **2/2**; GCP
  runtime **11/11**; capture runtime **3 passed, 1 ignored** (explicit FFmpeg
  executables required); core **247/247** plus automation-schema **1/1**.
- Release inventory: [PL-R1](builder-program/evidence/PL-R1-release-inputs-2026-09-19.md)
  passed Linux with **4,876 files** and Windows with **2,612 files**. The
  Windows Geo source tree remains absent on this laptop, so deterministic
  aggregate restaging stops at `gdal_grid.exe`; the restored staged Geo worker
  passed the complete inventory.

### WP-A1

The exact current-run tests are
`camera_export::tests::camera_package_round_trips_through_mvs_colmap_reader`,
`pointcloud_export::tests::cancellation_removes_partial_output_and_preserves_existing_destination`,
and the two atomic `product_export` tests. These directly satisfy both clauses
of the checklist line.

### WP-A4

The dated smoke pair is retained under `.build/photolab-evidence/a4/`; its
numeric comparison is recorded in the implementation plan and release ledger.
The current 5-test filter directly names synthetic quality, two-run SHA-256
identity, and cancellation.

### WP-B6

The current sidecar binary run directly names the corrupt-record diagnostics
fixture and the camera-map path/recovery-action failure fixture.

### WP-C10

The current renderer run executes both wizard normalizers and the existing
`gcpImportDecision`/`importFreeze` groups, including the same mislabeled `.gsb`
file becoming `ntv2` in both payloads.

## Closing-run catalog

These are run definitions, not evidence. A row referencing one of these ids
stays PARTIAL/PARKED until the run produces a retained result.

### H01 full product smoke

See [Heavy runs](#heavy-runs-do-not-start-as-part-of-pl-h5r). This is the
24-image `depth,dense,dem,ortho,mesh,splat` run. Estimate 1–4 h on the laptop,
depending on MVS load.

### H02 frozen 135-image golden

See [Heavy runs](#heavy-runs-do-not-start-as-part-of-pl-h5r). Preferred host is
the Windows PC; estimate 10–14 h on its 16 GB CPU-only configuration. The owner
reviews the frozen 0.8299 px reference and final release disposition.

### H03 cancellation/recovery matrix

See [Heavy runs](#heavy-runs-do-not-start-as-part-of-pl-h5r). Execute one fresh
run per `--cancel-stage` (`aliked`, `sift`, `dedode`, `mapper`, `mvs`, `raster`,
`mesh`, `splat`), then `--reuse --verify-resume` where supported and
`--expect-incompatible-checkpoint <field>` once per identity field. Add the
separate Electron close and sidecar SIGTERM observations. Estimate 6–12 h total.

### H04 GPU runtime parity

No command is valid until the owner admits a CUDA COLMAP/ONNX runtime and its
license inventory. Then run the same 24-image input CPU, GPU, forced fallback,
and kill-switch variants and compare exact contract metrics. Current Windows PC
has Vega 8 and no CUDA, so another machine is required.

### H05 G1c matrix

Run `pnpm photolab:g1c:oracle -- --project <fixture.hcad> --out
.build/codex-scratch/photolab-h5r/g1c/<row>` for each available fixture, then
use the Builder chooser, Save As/reopen, exact oracle picks/snaps, and WeltView
read-only open. No row may be skipped; current sparse failures must be fixed,
not re-toleranced.

### M01 PhotoLab hands-on

Start only through `scripts/ui-test-display.sh photolab --ready-file
.build/codex-scratch/photolab-h5r/ui/pl-release.env --timeout 7200`; use the
reported private CDP endpoint. Perform fresh-profile Align, Agent-empty,
Capture Groups, complete import/jobs/tree/markers/error, and record
page/console errors. Estimate 1–2 h; human review required.

### M02 project lifecycle

Under the same private launcher: import images/GCPs, archive Save + SHA-256,
relaunch, kill Electron during autosave, recover, provoke drain timeout/failure,
exercise Retry/Cancel/Force quit, reopen, then run guarded stale-Untitled
cleanup. Estimate 45–60 min; human required.

### M03 large-image QC

Open the 800-image fixture through the private launcher, record an interaction
trace while scrolling, click the worst residual, and retain the image id +
marker-highlight assertion. Estimate 45–90 min; human required.

### M04 visual accessibility

Launch PhotoLab through `scripts/ui-test-display.sh`, run the visual walker in
both themes with a matching Chromium/font provenance, compare against reviewed
baselines, run axe/keyboard reachability, and inspect every required screenshot.
Never use `DISPLAY=:0`. Estimate 1–2 h; human review required.

### M05 jobs rehydration

For archive, image inspection, image commit, image mask, GCP, alignment, MVS,
raster, mesh, and splat: begin work, reload renderer, traverse chip→Jobs→toast→
console, cancel, and record acknowledgement/drain bounds. Estimate 60–90 min;
human required.

### M06 Escape selection

Under the private launcher exercise, in order, two islands, dirty text, armed
marker, modal, function, selection and cancelling acknowledgement; then
hide/rename/move/delete/project-switch selection cases. Estimate 30–45 min;
human required.

### R08 FFmpeg video fixture

`HIMMELCAD_FFMPEG=/usr/bin/ffmpeg HIMMELCAD_FFPROBE=/usr/bin/ffprobe
CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab
/home/oem/.cargo/bin/cargo test -p himmelcad-sidecar --lib
capture_runtime::tests::real_ffmpeg_video_gate -- --ignored --exact`, followed
by the cancellation variant through the public capture route. Estimate 5–10
min; laptop; no owner.

### R09 CI jobs

Run the GitLab node-test job for the exact candidate, then the visual job twice:
unchanged and with the documented temporary seeded layout regression. Archive
logs/screenshots and discard the seed commit. Estimate 15–30 min; external CI.

### R10 Windows release

If the owner declares Windows supported: on the Windows PC build the exact
candidate, run `node scripts/check-photolab-release-inventory.mjs win32-x64`,
build/install NSIS, start PhotoLab natively, and verify update/signature status.
PC must be unlocked for GUI. Estimate 1–3 h plus signing work.

### R11 smoke report

Open the completed 24-image smoke project in PhotoLab, export the report twice
without mutation, compare SHA-256, and assert every survey/calibration/GCP/
product/memory/lineage section contains smoke-derived values. Estimate 20–30
min; laptop; human inspection.

### R12 mesh view/export

After H01, open dense and DEM mesh outputs, capture renders, export dense mesh
as PLY through the product command, validate it, and compare the DEM mesh with
its frozen baseline/hash. Estimate 20–30 min; laptop; human.

### R13 admission and archive integration

Use one prepared alignment, submit two DEM starts to the same target, require
the second `conflictingTarget`, begin archive Save, close project, and require
cancel + bounded drain. Estimate 10–20 min; laptop; scriptable.

### R14 Windows durability

On the Windows PC run the B5/project-runtime crash fixtures and durable filters
with `CARGO_TARGET_DIR=C:\himmelcad\target\photolab`, then force the
journal/manifest and dataset-rename boundaries and reopen. Estimate 20–40 min;
no GUI needed.

### R15 vertical golden

No existing test executes the named DHHN2016 coordinate vector. Add that exact
fixture assertion, then run
`CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab
/home/oem/.cargo/bin/cargo test -p himmelcad-sidecar --bin himmelcad-sidecar
gcp_runtime::tests::dhhn2016_vertical_golden -- --exact` (using that exact test
name when adding the fixture) and retain the renderer preserve-label assertion.
Estimate 5–15 min after the test exists.

### R16 GCP product integration

Use a prepared project containing two converged GCP revisions; select each,
start a product, and compare the report's frozen revision id/hash. Estimate
20–40 min; laptop.

### R17 real merge quality

Run disjoint and shared-control two-mission fixtures; record preflight, selected
profile, RMS/misclosure, mixed-intrinsics deltas, optimize→DEM lineage and
report. Estimate 2–4 h; laptop.

### R18 calibration inspector

Open the smoke optimization result, capture inspector values and report, and
assert symmetric correlation, plausible sigmas, residual profile and snapshot
hash. Estimate 30–60 min; laptop; human.

### R19 parked QC

Only after owner unpark: run the seeded outlier through rank, open, exclude,
re-optimize, undo and report-lineage comparison. Estimate 20–40 min.

### R20 mixed-sigma preview

Open the mixed-σ CSV fixture, map σ/code columns, retain the preview values, and
run optimization to preserve the already-proven weight ratio. Estimate 10–15
min; laptop; human unless component capture is added.

### R21 parked overlap

Only after owner unpark: compute the smoke overlap cache, compare flight
geometry, render report, toggle the layer, invalidate cache, and measure frame
time. Estimate 30–60 min.

### R22 Python automation

PL-I2's architect-takeover acceptance replaced the heavy alignment smoke for
this implementation gap with a bounded real-sidecar sequence: create → image
inspect/commit → jobs list → cancellable image-quality start/cancel → close,
once through each generated client. [PL-I2 evidence](builder-program/evidence/PL-I2-photolab-automation-sdk-2026-09-19.md)
closes that R22 scope: SDK 16/16, 72 typed sync and async methods, connection-
bound filesystem grants, typed grant refusal, and both smokes under two seconds
and 75 MiB sampled host+sidecar RSS. The broader WP-G2 console adapter remains
open under G-3; no alignment/COLMAP/ALIKED/MVS smoke was run.

### R23 final ledger

After freezing the candidate and collecting every retained artifact, run
`pnpm photolab:evidence:ledger --out
docs/photolab-release-evidence-<candidate-date>.md --candidate <rev> ...` with
all e2e, cancellation, inventory, package, a11y, pixel, keyboard and G1c inputs.
Every unsupported gate is an explicit skip, never an inferred pass.

## Heavy runs — do not start as part of PL-H5r

The following commands were intentionally **not** executed. They contain
COLMAP, MVS, the 135-image golden, or ALIKED. The Linux fallback commands use
the required isolated 18 GB user unit and the PhotoLab cargo target. The
Windows PC remains the preferred host for the 135-image run; its execution is
dispatched through a remote Codex brief, not an ad-hoc SSH command.

```bash
systemd-run --user --unit=photolab-h5r-full-smoke-20260919 --wait --collect \
  -p MemoryMax=18G -p MemorySwapMax=0 -p LimitCORE=0 \
  --working-directory=/home/oem/Dokumente/003_Projekte/10_himmelcad \
  /usr/bin/env CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab \
  node scripts/photolab-e2e.mjs \
  --source 'photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos' \
  --output .build/codex-scratch/photolab-h5r/release-full-smoke \
  --max-images 24 --smoke --profile fast \
  --products depth,dense,dem,ortho,mesh,splat --dem-surface dsm \
  --sidecar target/photolab/release/himmelcad-sidecar

systemd-run --user --unit=photolab-h5r-golden-135-20260919 --wait --collect \
  -p MemoryMax=18G -p MemorySwapMax=0 -p LimitCORE=0 \
  --working-directory=/home/oem/Dokumente/003_Projekte/10_himmelcad \
  /usr/bin/env CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab \
  node scripts/photolab-e2e.mjs \
  --source 'photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos' \
  --output .build/codex-scratch/photolab-h5r/agisoft-quality-hybrid-golden \
  --golden-agisoft --sidecar target/photolab/release/himmelcad-sidecar

systemd-run --user --unit=photolab-h5r-cancel-aliked-20260919 --wait --collect \
  -p MemoryMax=18G -p MemorySwapMax=0 -p LimitCORE=0 \
  --working-directory=/home/oem/Dokumente/003_Projekte/10_himmelcad \
  /usr/bin/env CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab \
  node scripts/photolab-e2e.mjs \
  --source 'photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos' \
  --output .build/codex-scratch/photolab-h5r/cancel-aliked --max-images 24 \
  --profile qualityHybrid --cancel-stage aliked --cancel-after-units 1 \
  --sidecar target/photolab/release/himmelcad-sidecar
```

For the remaining cancellation stages, use a fresh unit/output name and replace
`aliked` with exactly one of `sift`, `dedode`, `mapper`, `mvs`, `raster`,
`mesh`, or `splat`; add the minimum prerequisite `--products` list needed to
reach that stage. Never reuse an output directory between independent verdicts.

## Path to PhotoLab release

1. **Owner scope decisions:** declare whether Windows is a supported release
   platform (WP-F4/R10) and whether WP-A6, WP-E2, or WP-E4 are unparked. Keep
   them parked if no decision expands scope.
2. **Release inventory gates completed by PL-R1:** Linux was restaged and passed
   with 4,876 files; the Windows cross-target binaries were built and the
   retained/restored runtime passed with 2,612 files. The absent multi-GB
   Windows Geo source tree remains a deterministic-restage gap for the Windows
   PC lane, not an inventory failure.
3. **R22 SDK and brokered smoke completed by PL-I2:** the regenerated SDK is
   current and 16/16; all 72 exposed PhotoLab rows have sync/async methods; the
   bounded real-sidecar sync and async smoke passed. Generated PhotoLab console
   dispatch remains the separate WP-G2/G-3 follow-up.
4. **Finish real-data product evidence:** H01, R11, R12, R13, R15–R18, R20.
   Expect 4–8 h aggregate plus compute; mostly laptop, with short human UI
   checks.
5. **Run crash/cancel/resume evidence:** H03 plus M02/M05/M06. Expect 6–12 h
   compute and 2–3 h hands-on; laptop. The owner is not needed, but a human must
   drive close/Force quit and verify recovery.
6. **Close gate 8:** fix sparse exact picks without changing the oracle, then
   execute H05 for sparse, dense, DSM, DTM and mesh, including Save As/reopen
   and WeltView. Expect 4–8 h; use the Windows PC or a laptop window with ≥8 GB
   free RAM; GUI machine must be unlocked and a human must review.
7. **Visual/accessibility and hands-on candidate pass:** M01, M03 and M04 under
   the private display launcher. Expect 2–4 h; human required. `DISPLAY=:0` is
   forbidden.
8. **CI evidence:** R09 on the frozen candidate. Expect 15–30 min if runners are
   available; human reviews the deliberate red visual job.
9. **Accuracy gate last:** H02 on the Windows PC, matching the owner’s
   2026-09-05 sequencing decision. Expect 10–14 h; the owner reviews the final
   metrics. Keep the 16 GB WIN-16 run as complementary, not a substitute for
   the 135-image gate.
10. **Windows certification if supported:** R10 with the PC unlocked; decide
    signing/certificate status explicitly. Expect 1–3 h plus signing work.
11. **Freeze and ledger:** run R23 once, against one commit/build only, and have
    the owner disposition every explicit skip. Only then can WP-H5 and R1 gates
    1–8 be claimed closed.
