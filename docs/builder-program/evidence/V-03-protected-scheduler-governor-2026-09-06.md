# V-03 — protected scheduler and explainable governor — 2026-09-06

Status: **IMPLEMENTED; model gates pass, hardware performance gates remain open.**
No timed baseline was run and no cursor-latency, frame-time, settle-time or real-dataset
performance claim is made.

## Outcome

V-03 makes the six Viewer Core lanes explicit in the shared Rust scheduler. Lanes 1–3
are always planned first and have no droppable lane ceiling. Lanes 4–6 receive only the
remaining global frame allowance and have hard point/splat, byte, draw, upload and
decode ceilings. Visible-frontier coarsening removes only background detail with a
resident coarse fallback; protected overload is retained and reported as
`protected_work_over_budget`.

Motion selects lower traversal/decode/upload work and a zero-new-refinement lane 6,
while preserving resident ADD detail. A 250 ms rest timer requests refinement and the
policy records a 100 ms first-refinement target. Cloud/raster hold-last state is bounded
to two presents or 50 ms; the current renderer continues to present fresh frames and
therefore uses zero stale presents in production.

The runtime governor now resolves I/W/D from usable memory plus measured calibration,
observes an eight-frame presented-interval p95 trend and CPU/GPU attribution, and accepts
upload debt, decode backlog and residency pressure through the WASM boundary. Four
discrete tiers change by at most one step per 250 ms, after 8 overload frames or 90
debt-free frames below 75% of target. Class, tier, effective hard budgets, thresholds
and current reasons are exposed by the immutable `view.quality.get` snapshot used by
the concurrent S-08b HUD consumer.

## Doctrine decisions

> **Decision:** Lanes 1–3 are structurally unbudgeted at the lane level and are iterated
> before lanes 4–6 on every admission pass. Background candidates are rejected by exact
> lane dimension before they can consume protected remainder.
> **Derivation:** VC-D3 and §1.3 require camera/clip, interaction/pick and canonical
> vector/text work to dominate cloud, mesh, raster and effect refinement.
> **Rejected:** a single global point limit, cloud-first arrival order, and reserving a
> percentage that can still be exhausted before protected work is known.
> **Tunable:** lane 4–6 numeric caps. Lane order and protected status are not tunable.

> **Decision:** Fairness is scoped to each lane and uses deterministic weighted virtual
> finish across visible datasets. The weight is the dataset's highest current visibility
> benefit; input order is not a tie-break.
> **Derivation:** VC-D3 and the V-02 visible-benefit contract require fair progress without
> erasing projected-error priority.
> **Rejected:** strict dataset priority, provider priority and arrival-order round robin.
> **Tunable:** benefit weights. Stable ties and progress for every visible dataset are not.

> **Decision:** Motion caps new work before touching resident detail. Lane 6 admission,
> decode and upload become zero during motion, but the rest frontier continues to govern
> already-resident rendering.
> **Derivation:** VC-D4 explicitly rejects dropping resident ADD detail on pointer-down.
> **Rejected:** swapping the render frontier to the motion admission frontier.
> **Tunable:** rest and look-ahead timing. Resident fallback continuity is not tunable.

> **Decision:** Governor reductions are discrete, presented-cadence driven, rate-limited
> and reason-coded. Recalibration applies lower ceilings immediately but never jumps
> upward; a higher ceiling requires the ordinary 90-frame recovery path.
> **Derivation:** VC-D11 requires measured, hysteretic, explainable adaptation and rejects
> adapter-name allowlists and oscillation.
> **Rejected:** hidden EMA-only scalar changes, device-name classification and an unlimited
> user mode.
> **Tunable:** class floors, tier scales, 8/90 counts, 75% recovery ratio, 250 ms rate
> limit and the eight-sample p95 trend window.

## Tunables

### Class and frame targets

| Class | Measured qualification used by policy                                                                   | Motion target | Rest target | Total points | Total bytes | Total draws |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------: | ----------: | -----------: | ----------: | ----------: |
| I     | below W measured floor, or calibration unavailable                                                      |       33.4 ms |     25.0 ms |    4,000,000 |      96 MiB |       1,000 |
| W     | ≥1.5 GiB usable GPU, ≥16 GiB RAM, upload ≥2 GiB/s, points ≥500 M/s, triangles ≥250 M/s, splats ≥150 M/s |       25.0 ms |     20.0 ms |    8,000,000 |     192 MiB |       2,000 |
| D     | ≥8 GiB usable GPU and at least 2× every W micro-workload floor                                          |       17.2 ms |     17.2 ms |   16,000,000 |     384 MiB |       4,000 |

The W throughput row is the checked-in M2200-equivalent calibration fixture. It is a
policy tunable, not a claim about an unmeasured adapter.

### Background lane caps

| Class | Lane | Point/splat samples |  Bytes | Draws | Upload/decode share             |
| ----- | ---: | ------------------: | -----: | ----: | ------------------------------- |
| I     |    4 |             500,000 | 28 MiB |   300 | 30% of measured frame allowance |
| I     |    5 |           2,000,000 | 34 MiB |   350 | 35% of measured frame allowance |
| I     |    6 |           1,500,000 | 34 MiB |   350 | 35% of measured frame allowance |
| W     |  4–6 |                2× I |   2× I |  2× I | same 30/35/35 split             |
| D     |  4–6 |                4× I |   4× I |  4× I | same 30/35/35 split             |

Motion keeps lane 4/5 coarse-fallback caps and sets lane 6 point, byte, draw, upload and
decode admission caps to zero. Governor budget scales are Full `1.00`, Balanced `0.75`,
Coarse `0.50`, Minimum `0.35`; render scales are `1.00/0.85/0.70/0.50`, and detail
scales are `1.00/0.75/0.50/0.35`. Rest begins 250 ms after camera input; first refinement
is targeted within 100 ms. Reprojection is capped at two presents and 50 ms.

## Synthetic mixed-load evidence

The Rust `g_vc_mixed_protected_work_is_first_and_cloud_density_degrades` fixture submits
camera, selection/pick, 5,000-line and 500-label protected candidates before mesh,
raster, two 4,000,000-point clouds and splat refinement. The Class-I-shaped lane-5 cap
admits one cloud and rejects the second with `lanePointBudget`; every rejected item is in
a background lane. The lane-3 draw count remains two.

The V-01 ring fixture records 60 saturated Class-I frames with these exact per-frame
values:

```text
selected points:              4,000,000 / 4,000,000
selected bytes:               80 MiB / 96 MiB
selected draws:               940 / 1,000
triangles:                    120,000
splats:                       250,000
protected lines:              5,000
protected text quads:         500
protected primitives dropped: 0
reason codes:                 budget:points, budget:lane5
frames retaining protection:  60 / 60
```

These are deterministic model values, not measured GPU timings. `G-VC-MIXED`'s
lane-order/no-suppression model portion passes. Its required browser-GPU cursor p95 under
cloud saturation remains open for V-07 qualification.

## Governor evidence

- Eight consecutive slow presented frames reduce exactly one tier; 90 consecutive
  debt-free headroom frames recover one tier.
- A 600-frame alternating slow/fast trace performs zero tier changes.
- Sustained upload debt reduces one tier and reports `upload_debt`.
- A compositor-delay fixture with fast CPU/GPU work and slow presents reports
  `present_deadline` and reduces through the presented p95 path.
- Pinning Coarse remains state-stable through 200 overload observations.
- Exact W/Balanced query output scales 8,000,000 points to 6,000,000 and a 40-byte lane
  upload cap to 30, while the motion lane-6 cap stays zero.

Reason families retained in the V-01 ring are global resource/frame limits, exact lane
point/byte/draw/upload/decode limits, `budget:lane4/5/6`, protected overload, CPU/GPU/
present deadlines, upload debt, decode backlog, residency pressure, recovery headroom
and invalid timing/benefit.

`G-VC-GOVERNOR`'s deterministic model/query/HUD agreement portion passes. A hardware
presented-frame qualification run was not requested and remains open.

## Implementation map

- Six lanes, protected-first admission, exact lane accounting and fair datasets:
  `crates/himmelcad-render/src/scheduler.rs:13-458`; gates at `:727-868`.
- Class frontier and lane caps, motion-only admission policy, protected overload and
  fallback-safe coarsening: `crates/himmelcad-render/src/streaming.rs:31-151` and
  `:460-692`; motion regression at `:1434-1484`.
- Provider/root/refinement lane classification:
  `crates/himmelcad-render/src/residency.rs:675-716`.
- Mixed frame scheduling metadata and exact protected primitive accounting:
  `crates/himmelcad-render/src/frame_graph.rs:31-125` and
  `crates/himmelcad-render/src/gpu_frame.rs:1810-1840`.
- Measured class policy, motion/rest policy and discrete governor:
  `crates/himmelcad-render/src/hardware_policy.rs:215-383`, `:631-1001` and
  `:1015-1048`; gates at `:1385-1665`.
- WASM motion and pressure transport:
  `crates/himmelcad-wasm/src/lib.rs:1409-1430`, `:1475-1495` and `:5618-5745`.
- Typed browser boundary, motion/rest lifecycle, quality query and ring reasons:
  `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:797-973`,
  `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts:352-381` and
  `:853-1018`, and
  `packages/@himmelcad/viewer/src/kernel/KernelFrameDiagnostics.ts:1-145`.
- Synthetic ring/freshness/query gates:
  `packages/@himmelcad/viewer/test/kernel-frame-diagnostics.test.ts:134-190` and
  `packages/@himmelcad/viewer/test/kernel-viewer-session-automation.test.ts:164-227`.
- Registry owner row: `docs/builder-program/REGISTRY.md:85`.

`KernelStreamingDriver.ts` was intentionally not changed. Its existing exact transport,
decode and backlog diagnostics are consumed by `KernelViewerSession`. The concurrent
S-08b `ViewState`/HUD and S-10 surface files were consumed and verified, not edited by
this package.

## Gate tests and checks

| Check                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARGO_TARGET_DIR=target/builder cargo check -p himmelcad-wasm --target wasm32-unknown-unknown`   | **PASS.**                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CARGO_TARGET_DIR=target/builder cargo check -p himmelcad-render --tests` after the one-run fixes | **PASS.**                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CARGO_TARGET_DIR=target/builder cargo test -p himmelcad-render` (single permitted run)           | **344 passed, 2 failed.** All new mixed/fairness/class/hysteresis/p95/debt/pinning tests passed. `recalibration_applies_lower_ceiling_without_upward_jump` exposed an upward-jump bug; `motion_pauses_new_refinement_without_dropping_resident_add_detail` compared a set using insertion order. Both were corrected afterward and the final test target compile-check passed; the test command was not repeated. |
| `pnpm --filter @himmelcad/viewer test`                                                            | **PASS — 139 passed, 0 failed.** Includes saturated protected-ring, bounded freshness, exact quality query and public-boundary gates.                                                                                                                                                                                                                                                                             |
| `pnpm --filter @himmelcad/builder typecheck`                                                      | **PASS.** Includes the concurrent `view.quality.get` automation route and HUD consumer.                                                                                                                                                                                                                                                                                                                           |
| `pnpm --filter @himmelcad/photolab typecheck`                                                     | **PASS; PhotoLab English UI check passed.**                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm registry:lint`                                                                              | **PASS — 7 checks, 0 findings.**                                                                                                                                                                                                                                                                                                                                                                                  |
| `CARGO_TARGET_DIR=target/builder node scripts/stage-builder-viewer-wasm.mjs --profile release`    | **PASS — final release renderer/viewer/decode WASM compiled and staged in 7m 09s.**                                                                                                                                                                                                                                                                                                                               |
| `git diff --check`                                                                                | **PASS.**                                                                                                                                                                                                                                                                                                                                                                                                         |

## Not verified

- No timed or real-dataset baseline was run.
- No hardware-backed browser GPU run measured mixed-scene cursor p95, present p95,
  rest refinement within 100 ms, class-full settle time, or reprojection image truth.
- I/W/D calibration floors are model-tested; they require the checked-in V-07 hardware,
  driver and five-run qualification before a user-visible performance claim.
- Temporal background reuse is bounded by policy and test, but production currently
  presents fresh backgrounds rather than performing reprojection. Picking therefore
  never consumes a stale depth/id buffer in this slice.
- The final two Rust source fixes were compile-checked but not rerun because the package
  explicitly allowed only one renderer `cargo test` invocation.
