# PhotoLab lane — handoff

Document class: live status, one page. Updated 2026-09-23. The previous,
longer handoff (last updated 2026-09-11) is archived at
`docs/history/photolab/PHOTOLAB-HANDOFF-2026-09-11.md`.

## Where PhotoLab work happens

- Branch `release/photolab-r1` (cut at `02683e0`, 2026-09-23). Release fixes
  and evidence land there and are pushed; they are ported to `main` after the
  ADR 0032 module split.
- `main` is being restructured (ADR 0032). Do not base release evidence on
  `main` until the split is complete.
- Rust builds for PhotoLab use `CARGO_TARGET_DIR=target/photolab`.

## State

- Functionally complete for R1. Landed 2026-09-19: import packages for
  orthomosaic, mesh and splat (PL-I1), generated Python methods with a
  brokered smoke (PL-I2), console from the generated command table (PL-I3),
  Linux and Windows release inventories green (PL-R1).
- H01 full product smoke green on real data (24 images, all eight products,
  six import packages; `docs/builder-program/evidence/H01-*`).
- Acceptance checklist: `docs/photolab-release-acceptance-status-2026-09-19.md`
  (45 items: 4 executed, 37 partial, 4 parked) with the ordered path to release.
- Owner decisions 2026-09-19: Windows is a supported platform (WP-F4
  unparked); WP-A6, WP-E2, WP-E4 stay parked.

## Open before release

1. H03 cancellation rows `mapper`, `splat` (stage not observed by the
   harness) and `mesh` (stopped with "no completed raster product") —
   `docs/builder-program/evidence/H03-*`.
2. Gate 8: fix exact picks on sparse clouds, then H05 for sparse, dense, DSM,
   DTM and mesh incl. Save As/reopen and WeltView.
3. Hands-on candidate pass by a human (owner): complete evaluation, close and
   Force quit recovery, visual check (M01, M03, M04).
4. 135-image accuracy run H02 on the Windows PC (10–14 h).
5. Windows install and signing (R10): owner decides on a code-signing
   certificate.
6. CI evidence R09, then one freeze and ledger run R23 on a single commit.

## Windows PC

Vega 8: the GPU process is lost even for a blank Electron window when started
over SSH; the viewer is not the cause. Deciding test: start Builder once from
the PC desktop. The Builder "Hardware rendering" chip is untruthful (ADR 0032
hardware-profile step fixes it).
