# PhotoLab lane — handoff

Document class: lane status (owner-readable, one page). Updated at every
landing by the PhotoLab session. Plan of record:
`docs/implementation-plans/2026-09-photolab-release-polish.md`. Lane protocol:
`docs/builder-program/COORDINATION.md`. Codex briefs live under
`.claude/codex/prompts/photolab/`, the token ledger under
`.claude/codex/logs/photolab/ledger.json`.

Last update: 2026-09-04 15:40 (A4 landed with DTM evidence; H2, B5, B4 landed; H1b in flight).

## Current work packages

| WP                                        | State                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A4 SMRF ground classification (DTM)       | code committed; gates green (core 216, sidecar 263+84, renderer 77); DTM-vs-DSM 24-image smoke running (`.build/logs/a4-dtm-smoke.log`); G17 screenshot review pending |
| H2 jobs chip + side-operation drain       | brief ready (`h2.md`); dispatch after A4 lands (same cargo lane)                                                                                                       |
| B5 journal/manifest order + orphan GC     | brief ready (`b5.md`)                                                                                                                                                  |
| B4 same-target admission + disk preflight | brief ready (`b4.md`), scoped down (drain part moved to H2)                                                                                                            |
| H1b cancellable archive Save              | brief ready (`h1b.md`); needs a `photolab.project.save` params change in sidecar main.rs (announce)                                                                    |
| A3 mesh from dense cloud, stage 1         | queued                                                                                                                                                                 |
| A5 golden-gate accuracy levers            | evidence-gated; golden run relaunched 2026-09-04 12:12 (`.build/logs/golden-qh-135.log`)                                                                               |
| G1a-2 / G1b / G1c                         | after the Builder-lane command table; ADR 0030 rev 6 conformant, no open contract item                                                                                 |

Landed since 2026-09-02 evening: H3 Escape ladder (be8bc6e, UIP-D14
conformant; UIP-D7 deviation accepted), E1 calibration report (171791b), F3
accessibility audit (6774990, 72aca4e), H5 evidence ledger (b5fec8e), H1
close/durability (03bd235), ADR 0030 rev 6 (9d4d398), pixel baselines
(54a4392), data type extension for H2 (dfd1bc3, f2c0914).

## Open R1 gates (executed evidence only)

| Gate                                   | Status                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1 complete workflows import → products | 24-image smoke green (Waves 1–4, LAZ validated); DTM/mesh products pending A4/A3                          |
| 2 real-dataset accuracy                | 135-image Quality Hybrid golden run not completed (reboot); Fast diagnostic 0.9657 px vs 0.8299 reference |
| 3 lineage/recovery                     | H1 close drain landed; B5/B4 pending                                                                      |
| 4 cancellation/reload                  | H2 pending (side operations invisible to the jobs list)                                                   |
| 5 project format/journal               | B5 pending                                                                                                |
| 6 automation parity (P11)              | 72 rows documented + G-1 test; command table generation is Builder-lane (G2)                              |
| 7 accessibility / visual               | executed: audit 16 clean (42 surfaces × 2 viewports), baselines refreshed                                 |
| 8 products open in Builder/WeltView    | G1a-2 pending; ADR 0030 rev 6 conformant                                                                  |

## Next three steps

1. Get the sidecar gate green (Builder lane fixes `entity_compiler.rs`), run
   A4's full tests + the 24-image DTM-vs-DSM smoke, capture light/dark
   screenshots of the DEM panel (G17), commit A4, update this file.
2. Golden run is running (relaunched 12:12); next dispatch B5 (high) once the
   A4 smoke frees the lane binary — copy lane binaries to `.build/photolab-runtime/bin/`
   before any e2e (cargo relinks the lane binary and breaks running e2e publishes).
3. H1b (announce main.rs `photolab.project.save` params) → A3 stage 1 → A5
   levers once the golden result is in; one review each, ledger entry per run.

## Shared-substrate state (as known to this lane)

- Builder lane in flight: S-03 gesture arbiter (viewer + app; PhotoLab
  typecheck in its gate), ui component gallery (no component source change),
  S-01 landed uncommitted (core `release_05_admissions.rs`, generated TS,
  ViewState v2). `packages/@himmelcad/data/src/index.ts` is PhotoLab's for H2.
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

## Messages pending to the Builder session (peer was offline at 13:50)

- H2 landed 2ef29d5 — G17 screenshots: `.build/photolab-ui/h2-{dark,light}/00-main-view.png` (chip "2 jobs running") and `bottom-jobs.png` (Jobs tab badge, side operation with Cancel). Chip spec for S-05 convergence: one button at the right end of the status bar, 18 px, 10 px UI font, 1 px tone border (progress = accent, warning, danger with error text, success), labels "n jobs running" / "1 job running · label pct%" / "Cancelling…" / "Job failed — label" / "Job completed — label" (4 s linger), aria-label "Jobs: label", click toggles the Jobs tab. Obligation: PhotoLab adopts the shared chip + jobs island when S-05 lands. Findings for the shared side: light theme viewport toolbar contrast (active "3D" segment, axis chip); jobs list shows "overall 0%" for unknown units — render "in progress".
- B4 landed: crates/himmelcad-sidecar/src/main.rs changed inside `handle_job_rpc` only (job-start handlers pass frozen publication targets and disk estimates); no routes added.
- A4 landed with evidence: DTM removes elevated objects (median DSM−DTM 1.32 m over the smoke area, 25 % of cells > 3 m, DTM never above DSM); screenshots `.build/photolab-ui/a4-{dark,light}/function-dem-dtm.png`.
