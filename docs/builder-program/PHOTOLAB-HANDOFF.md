# PhotoLab lane — handoff

Document class: lane status (owner-readable, one page). Updated at every
landing by the PhotoLab session. Plan of record:
`docs/implementation-plans/2026-09-photolab-release-polish.md`. Lane protocol:
`docs/builder-program/COORDINATION.md`. Codex briefs live under
`.claude/codex/prompts/photolab/`, the token ledger under
`.claude/codex/logs/photolab/ledger.json`.

Last update: 2026-09-05 09:35 (A3 landed; golden relaunch pending the Builder GPU baseline).

## Current work packages

| WP                                        | State                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A4 SMRF ground classification (DTM)       | landed 2026-09-04 (3e05da1, 6b87d00) with DTM-vs-DSM evidence (median DSM−DTM 1.32 m, 25 % of cells > 3 m); G17 reviewed                                   |
| H2 jobs chip + side-operation drain       | landed 2026-09-04 (2ef29d5); adopt the shared `JobsStatusChip` (S-05) once the Builder lane commits it — brief `h2b.md` ready                              |
| B5 journal/manifest order + orphan GC     | landed 2026-09-04 (b66a66b): manifest-first commit with write-ahead intent, open-time repair, orphan quarantine                                            |
| B4 same-target admission + disk preflight | landed 2026-09-04 (fcf75c8): frozen publication targets, ConflictingTarget, InsufficientDisk, inline errors                                                |
| H1b cancellable archive Save              | landed 2026-09-04 (e0da2a8): params on `photolab.project.save`, phases, cancellation, Jobs-tab Cancel via H2                                               |
| A3 mesh from dense cloud, stage 1         | landed 2026-09-04/05 (108e20f, 1148ffd, 601efde/ea66991): dense-mesh smoke green, 4.19 M triangles / 99 tiles, provenance with degenerateFacesDropped 2582 |
| A5 golden-gate accuracy levers            | evidence-gated; golden run relaunched 2026-09-04 12:12 (`.build/logs/golden-qh-135.log`)                                                                   |
| G1a-2 / G1b / G1c                         | after the Builder-lane command table; ADR 0030 rev 6 conformant, no open contract item                                                                     |

Landed since 2026-09-02 evening: H3 Escape ladder (be8bc6e, UIP-D14
conformant; UIP-D7 deviation accepted), E1 calibration report (171791b), F3
accessibility audit (6774990, 72aca4e), H5 evidence ledger (b5fec8e), H1
close/durability (03bd235), ADR 0030 rev 6 (9d4d398), pixel baselines
(54a4392), data type extension for H2 (dfd1bc3, f2c0914).

## Open R1 gates (executed evidence only)

| Gate                                   | Status                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 complete workflows import → products | 24-image smokes green: waves 1–4 (LAZ validated), DTM + DSM (A4), dense mesh (A3)                                                                  |
| 2 real-dataset accuracy                | golden run died 2026-09-04 21:53 (lane binary relinked under it); relaunch on `.build/photolab-runtime/golden-bin/` after the Builder GPU baseline |
| 3 lineage/recovery                     | H1 close drain, B5 journal/manifest reconciliation, B4 same-target admission, H1b cancellable save landed                                          |
| 4 cancellation/reload                  | H2 landed: side operations drain, list, cancel; chip rehydrates from the sidecar after reload                                                      |
| 5 project format/journal               | B5 landed (crash-injection tests for both orders + dataset quarantine)                                                                             |
| 6 automation parity (P11)              | 72 rows documented + G-1 test; command table generation is Builder-lane (G2)                                                                       |
| 7 accessibility / visual               | executed: audit 22 clean (88 captures × 2 viewports, roving-tabindex ribbon walk), baselines refreshed 311c848                                     |
| 8 products open in Builder/WeltView    | G1a-2 pending; ADR 0030 rev 6 conformant                                                                                                           |

## Next three steps

1. Relaunch the golden run on `.build/photolab-runtime/golden-bin/` after the
   Builder's "baseline done" (never rebuild into a lane an e2e uses); message
   the Builder when started/finished.
2. Dispatch H2b (adopt the shared JobsStatusChip, brief `h2b.md`) once the
   Builder lane commits S-05; then A5 levers once the golden result is in.
3. G1a-2 after the Builder-lane command table; hands-on re-test of the
   changed surfaces; F13/F14 polish.

## Shared-substrate state (as known to this lane)

- Builder lane (address `10-himmelcad-a2` since 17:40): S-01, S-04 (selection
  store), S-05 (main-process job registry + shared chip/island in
  `@himmelcad/ui` JobsSurfaces.tsx) landed uncommitted; root `pnpm typecheck`
  consistent; V-01 (viewer measurement) next — avoid heavy cargo/e2e while its
  GPU baseline runs. PhotoLab adopts the shared jobs chip when S-05 is consumable.
- Builder lane fixed the `GeometryObject::Measurement` arms in render/io on
  2026-09-04 (uncommitted in its lane); sidecar tests compile again.
- Owner rules in force: D8 token discipline (medium default, high for
  reviews; Codex ≈ 70 % of the weekly budget for both lanes until ~Sep 9),
  G17 (pixel briefs before, light/dark screenshots after every Codex UI).

## Golden run (gate 2)

Command (detached, log outside the output dir because the script recreates it):

```
CARGO_TARGET_DIR=target/photolab setsid nohup node scripts/photolab-e2e.mjs \
  --source 'photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos' \
  --output .build/photolab-e2e/agisoft-quality-hybrid-golden --golden-agisoft \
  --sidecar target/photolab/debug/himmelcad-sidecar \
  > .build/logs/golden-qh-135.log 2>&1 < /dev/null & disown
```

The run holds the machine-wide compute lease; unit tests use a per-process
lease and are unaffected. Result: `result.json` in the output directory.

## Messages to the Builder session (sent 2026-09-04 17:45 to `10-himmelcad-a2`; kept for the record)

- H2 landed 2ef29d5 — G17 screenshots: `.build/photolab-ui/h2-{dark,light}/00-main-view.png` (chip "2 jobs running") and `bottom-jobs.png` (Jobs tab badge, side operation with Cancel). Chip spec for S-05 convergence: one button at the right end of the status bar, 18 px, 10 px UI font, 1 px tone border (progress = accent, warning, danger with error text, success), labels "n jobs running" / "1 job running · label pct%" / "Cancelling…" / "Job failed — label" / "Job completed — label" (4 s linger), aria-label "Jobs: label", click toggles the Jobs tab. Obligation: PhotoLab adopts the shared chip + jobs island when S-05 lands. Findings for the shared side: light theme viewport toolbar contrast (active "3D" segment, axis chip); jobs list shows "overall 0%" for unknown units — render "in progress".
- B4 landed: crates/himmelcad-sidecar/src/main.rs changed inside `handle_job_rpc` only (job-start handlers pass frozen publication targets and disk estimates); no routes added.
- A4 landed with evidence: DTM removes elevated objects (median DSM−DTM 1.32 m over the smoke area, 25 % of cells > 3 m, DTM never above DSM); screenshots `.build/photolab-ui/a4-{dark,light}/function-dem-dtm.png`.
- H1b landed: crates/himmelcad-sidecar/src/main.rs — `photolab.project.save` gained optional params `archiveOperationId`/`progressKey` (deny_unknown_fields, null-compatible); no new route.
- Blocker 2026-09-04 18:20: Builder-lane WIP `crates/himmelcad-sidecar/src/canonical_app_runtime.rs` calls `create_snapshot_marker`, missing from `release_05_admissions.rs` → sidecar does not compile; reported to `10-himmelcad-a2`. Rerun after their fix: rebuild in target/photolab-b5, copy to `.build/photolab-runtime/bin/`, then `node scripts/photolab-e2e.mjs --source '…/01_Photos' --output .build/photolab-e2e/a3-mesh-smoke --max-images 24 --smoke --profile fast --products depth,dense,mesh --mesh-source dense --target-epsg 31468 --target-vertical-epsg 7837 --sidecar .build/photolab-runtime/bin/himmelcad-sidecar` with `HIMMELCAD_COMPUTE_LEASE_PATH=/tmp/himmelcad-compute-a3-smoke.lock`.
- Incident 2026-09-04 (repaired): commit 601efde staged the whole sidecar main.rs and carried five uncommitted Builder-lane S-07 hunks (release_05_admissions import, project.flush/snapshot.\* routing, async handle_canonical_app_rpc with canonical.project.durability + flush response); HEAD stopped building standalone. ea66991 removed exactly those hunks from HEAD via an index-only reverse patch; the working tree was not touched (the Builder WIP shows as uncommitted again). Rule now: stage shared files hunk-by-hunk and grep the staged diff for foreign identifiers. Message to the Builder session pending (its address `10-himmelcad-a2` went offline at 19:00).
