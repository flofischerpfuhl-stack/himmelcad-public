# Session coordination — Builder program and PhotoLab release work

Status: active protocol from 2026-09-02 (owner decision Q1 → Branch A: both
efforts run in parallel). Two agent sessions work in this repository at the
same time; this file keeps them from interfering and makes them share one
workflow.

## Ownership by path

| Owner                                   | Paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PhotoLab session                        | `apps/photolab/**`, `photolab/**`, `docs/photolab-*`, `docs/implementation-plans/2026-09-photolab-*`, `scripts/photolab-*`, PhotoLab test tooling under `scripts/lib/{a11y-audit,png-compare,renderer-ts-resolve}*.mjs` (Builder reuses by citation, no rename needed), PhotoLab-only sidecar modules (`crates/himmelcad-sidecar/src/{project_runtime,mvs_runtime,brush_runtime,raster_runtime,job_runtime,product_export,colmap_runtime,alignment_merge_runtime,gcp_runtime,gcp_optimization_runtime,dedode_runtime,capture_runtime,pointcloud_export,camera_export,process_group,image_commit,image_mask_runtime}.rs`, the portable MVS bin, and their tests), `crates/himmelcad-core/src/{photolab_*,product_import_package,canonical_json}.rs` | Owns PhotoLab release gates R1 and their evidence. `crs_runtime.rs` / `crs_service.rs` are **shared** (Builder import registration depends on them) — single-lane rule applies.                                                                                                                                                                                      |
| Builder session (architect)             | `apps/builder/**`, `docs/builder-program/**`, `docs/FUNCTION-CONTRACT.md`, `docs/DECISION-DOCTRINE.md`, `.claude/**`, Builder-only sidecar modules (`import_registration_runtime`, `automation_runtime`, `canonical_app_runtime`, `canonical_project_store`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Owns the registry, specs, master plan.                                                                                                                                                                                                                                                                                                                               |
| **Shared substrate — single lane**      | `packages/@himmelcad/{ui,viewer,app,data,console,agent,automation-host,theme}/**`, `crates/himmelcad-render/**`, `crates/himmelcad-core/src/{entity_model,canonical_document,property_schema,app_protocol}.rs`, `crates/himmelcad-io/**`, `crates/himmelcad-sidecar/src/main.rs`, `schemas/**`, `sdk/**`, `scripts/verification/**`, root configs                                                                                                                                                                                                                                                                                                                                                                                                  | Changes announced before editing (cross-session message: files + intent); one editor at a time per file; the other session rebases/consumes after the change lands. Substrate work that both products need (P11 command table, job registry, base controls, gesture map) is implemented once, in the Builder lane, with PhotoLab gates run before it is called done. |
| **Normative documents — single writer** | `docs/DESIGN-SYSTEM.md`, `docs/DATA-MODEL.md`, `docs/PROJECT-FORMAT.md`, `docs/CURRENT-DIRECTION.md`, `docs/ROADMAP.md`, `docs/README.md`, `docs/adr/*` acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The architect applies; either session may propose exact text (as ADR 0030 did).                                                                                                                                                                                                                                                                                      |

## Rules

1. **One workflow.** Both sessions specify against `docs/FUNCTION-CONTRACT.md`, decide by `docs/DECISION-DOCTRINE.md` (X1–X7, P1–P11), and run the `demanding-user` review before the owner sees a surface. PhotoLab surfaces consume the ui-platform substrate records (gesture map §3.6, UIP-D10 job registry, UIP-D14 Escape ladder, UIP-D15–D18 selection, UIP-D22 cursor vocabulary, P5/P6 affordances) — cite-and-revise, never a parallel design.
2. **Cargo lanes.** Each session builds in its own target directory (`CARGO_TARGET_DIR=target/<session>`), so cargo never serializes across sessions; incremental-corruption guidance in the build-env notes applies per lane. Release gates run from a clean lane.
3. **Shared files.** Announce → edit → announce landed. No two sessions edit the same shared file concurrently. Small, self-contained changes; no drive-by reformatting outside the change.
4. **Findings, not divergence.** If an implementation finds a spec or contract wrong, the implementer messages the finding; the owning spec is revised first (doctrine rule 2), then implementation follows.
5. **Commits.** Each session commits only its owned paths and announced shared changes; nothing under `docs/builder-program/` is committed except by the architect on the owner's word.
6. **Daily sync.** One cross-session message per session per day: landed packages, shared-file intents for the next day, open findings.
7. **Priority on contention.** A failing PhotoLab release gate takes precedence on shared resources; Builder slices yield.

## P11 command rows from PhotoLab

PhotoLab supplies its automation command rows (ids, request/result schemas,
job-or-transaction mapping, cancel routes) and the gate tests that must pass
before the Builder-lane command table is "done" in
`docs/photolab-automation-command-rows.md`; the agent spec's P11 table
consumes that file by citation. WP-G1b consumes the generated table.

## Workflow adoption for PhotoLab

A demanding-user adoption audit of the PhotoLab release plan and its
surfaces against the contract/doctrine/substrate is run by the architect and
delivered to the PhotoLab session as a finding list; the PhotoLab session
dispositions each finding (fix / defer with reason) in its plan. Recurring
classes become doctrine precedents.

## Delegations (dated)

- 2026-09-02 late — WP-H3 (PhotoLab lane) implements the shared UIP-D14 Escape
  dispatcher in `packages/@himmelcad/ui` (consumed by EntityTree,
  FunctionPanel, ImportChat, and PhotoLab's app-local FloatingTaskIsland) as the single implementation for both products,
  verbatim to ui-platform UIP-D14 / UIP-D7 / UIP-D10 and the design-system
  input rule; Builder typecheck + shared tests before "landed"; architect
  conformance check afterwards. Reason: unblock the PhotoLab release; the
  Builder lane's S-03 consumes it instead of re-implementing.

- 2026-09-02 night: WP-H3 landed (be8bc6e) — the shared UIP-D14 Escape dispatcher lives in `packages/@himmelcad/ui/src/escapeLadder.ts`; Builder consumes it in S-03 and must enable `closeFunctionTabs` (UIP-D7 revision). E1 landed (171791b, additive `@himmelcad/data` types). Builder lane landed I-04 (parallel verifier, cargo lane keys) and runs I-03b (tsconfigs) with the PhotoLab lane holding WP-H2's `PhotolabJob.kind` edit until "I-03b landed". H3 landed be8bc6e.

## Hooks on a multi-lane tree (2026-09-05)

The pre-commit (`verify:commit`) and pre-push (`verify:push`) hooks verify the _working tree_, which is mid-edit by two to four Codex lanes at any time; they fail on lane noise (stale generated SDK, half-written packages) unrelated to the commit being made. Rule: an architect landing commit is gated by the slice's evidence file plus the architect's independent re-run of the affected gates (recorded in the commit message), and is committed and pushed with `--no-verify`. Owner instruction 2026-09-05: every landing is committed **and pushed**. Hooks stay in place for single-writer human commits. Follow-up (queued, I-08): a `verify:clean` job that checks out `HEAD` into a scratch worktree with its own `CARGO_TARGET_DIR` and runs the commit-tier plan there, so pushed commits get a hook-equivalent verdict without lane noise.
