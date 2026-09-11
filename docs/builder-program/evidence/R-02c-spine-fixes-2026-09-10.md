# R-02c spine fixes — literal road-scan replay (2026-09-10)

Status: the two R-02b spine stops and the reviewer's P1 source-admission
prerequisite are fixed. The literal Builder replay completed ground extraction,
Sample, Rasterize, boundary creation, and boundary-derived Viewing Box lock. It
then stopped at DGM publication; LandXML is consequently not claimed. No commit
was made.

## Method and start state

- Reused `target/r01-review-pass1.hcad` and its canonical
  103,713,735-point road cloud. No repository or dataset copy was made.
- The in-app-browser runtime reported `No browser is available`. Following the
  accepted Builder evidence fallback, the replay used the real Electron Builder
  on X11, CDP input for semantic UI interaction, and physical-window captures
  under `.build/r02c/`.
- The run used the NVIDIA/WebGPU development lane while other desktop/agent
  processes were active. The root filesystem was 95% full with about 24 GiB
  free during the measured full run. Timings are factual shared-machine results,
  not clean-machine benchmarks.
- The four boundary coordinates used below are exact extents from the already
  stored road-derived viewing box; no coordinate or height was invented.

## 1. Extract Ground capture, progress, runtime, and cancellation

### Root causes

The observed stall was cumulative rather than one missing progress update:

1. source capture held the canonical runtime mutex across multi-gigabyte I/O and
   re-hashed already verified canonical CAS objects;
2. hierarchy parsing cloned/rescanned every known node after every proxy page,
   making the 759,286-byte real hierarchy effectively quadratic;
3. hierarchy, node, output-description, and object-hash loops lacked bounded
   cancellation checks;
4. the renderer launched a second automatic ground preview beside extraction;
5. durable publication emitted one main/renderer progress event per 1 MiB. On
   the 3.2 GB classified source this produced thousands of events, reduced the
   observed copy rate to about 0.5–1.5 MiB/s, and starved Cancel; and
6. Sample/Raster had the same terminal-progress flood for hierarchy nodes that
   remained after their logical point total had reached 100%.

### Fix

- Canonical source capture is planned while the runtime is locked, then pinned
  outside the lock. Same-filesystem, already-verified CAS objects use an O(1)
  hard link plus length validation; cross-device fallback remains a single
  cancellable copy/hash pass.
- The hierarchy parser now returns discovered proxy pages directly instead of
  cloning and rescanning the accumulated node map. It checks cancellation every
  2,048 records.
- Node reads and file hashing check cancellation every bounded 8 MiB chunk;
  point loops check every 65,536 records.
- Extract no longer starts a concurrent automatic preview.
- Ground, Sample, Rasterize, and durable-publication progress is coalesced at
  phase changes and meaningful 1% local increments, including suppression of
  repeated terminal values.

### Literal UI acceptance

- The physical Builder window showed `Capturing visible point-cloud state` at
  1% within about one second of the Extract ground click:
  [capture visible within 2 s](../../../.build/r02c/23-ground-progress-within-2s.png).
- The phase sequence remained visible through grid, filter, classify, bake,
  store, commit, and ready:
  [bake at 77%](../../../.build/r02c/32-ground-final-progress.png) and
  [commit at 98%](../../../.build/r02c/33-ground-final-late.png).
- A fresh UI Cancel click was dispatched through the visible Cancel control.
  Scratch cleanup completed in **390 ms**, including 305 ms of CDP connection
  and dispatch overhead. This is below the S-05 two-second bound. The terminal
  UI returned to its idle action and recorded cancellation:
  [cancelled UI](../../../.build/r02c/29-ground-cancelled-under-2s.png).
- The uninterrupted real-cloud extraction completed in **211.0 s (3m31s)**.
  It read all 103,713,735 source points, scoped 419,462 points through the active
  box/class set, classified 145,390 ground points (34.6611%), and published the
  deterministic membership SHA-256
  `be5c5895b762465d9efc0618b4f58048516817016c144b37475e5a3db5621110`.
  Residual standard deviation was 0.154390 m:
  [completed ground cloud and console timing](../../../.build/r02c/34-ground-completed.png).
- This run did not repeat the 0.5-02 memory measurement. The prior real-data
  evidence remains the bounded-memory result: about 2.45 GiB peak RSS for the
  same 104 M source.

## 2. Viewing Box from canonical boundary bounds

### Root cause and fix

`From selection` previously consulted only resident renderer datasets. That is
correct for point clouds, but canonical curves and measurements have
authoritative positions without a resident dataset. Builder now derives and
unions exact canonical bounds for selected polylines, boundaries, and
measurements. It still uses resident bounds for clouds and refuses incomplete Z
rather than manufacturing height.

The literal boundary contained these four stored vertices:

```text
2538170.001  5486660.001  380.000
2538179.998  5486660.001  380.000
2538179.998  5486669.999  390.000
2538170.001  5486669.999  390.000
```

- [four canonical boundary vertices](../../../.build/r02c/50-boundary-four-vertices.png)
- [stored and selected Boundary polygon 1](../../../.build/r02c/51-boundary-stored.png)

With only that boundary selected, View → Viewing Box → From selection created
`Viewing Box 2`; no `no resident bounds` message appeared. The persisted state
is exact:

```text
center      2538174.9995, 5486665.0000, 385.0000
halfExtents 4.9985,       4.9990,       5.0000
```

- [boundary-derived Viewing Box 2](../../../.build/r02c/54-viewing-box-from-boundary.png)
- [prepared box locked in 33.7 s](../../../.build/r02c/57-boundary-box-locked.png)

Unit coverage includes reopened-style boundary geometry, measurements, unions,
and the unknown-Z refusal path.

## 3. Explicit point-cloud source predicates

Builder uses the explicit-source policy from S-01:

- Extract ground, Rasterize mean height, Segment, and Sample are disabled when
  selection contains no resident point cloud;
- each exposes the exact tooltip `Select one resident point cloud.` rather than
  accepting a silent click;
- a selected resident cloud enables all four actions; and
- entity-tree and viewport context actions pass the exact invoked point-cloud
  entity id rather than falling back to unrelated global selection.

The shared entity tree now dispatches the modern product callback before its
legacy command mapping, so a Builder context action is not dropped or remapped.

- [all four actions disabled for a non-cloud selection](../../../.build/r02c/01-pointcloud-no-cloud-source-disabled.png)
- [cloud-selected actions enabled](../../../.build/r02c/04-road-cloud-selected-source-actions.png)

Pure tests cover the exact disabled reason and exact contextual payload.

## 4. View placeholder cleanup

The unimplemented View → Color Mode and Background ribbon surfaces were
removed. Existing working display controls remain unchanged. The View ribbon
in the boundary/box acceptance screenshot shows the resulting honest surface:
[View ribbon](../../../.build/r02c/54-viewing-box-from-boundary.png).

## Scan-first spine replay and stops

1. **Import:** reused the reviewer's already-imported canonical road source, as
   explicitly permitted by the work package. The tree reports `103.7 M`.
2. **Box lock:** the inherited occupied road box was the extraction scope. The
   later boundary-derived Box 2 also locked successfully in 33.7 s (`57`).
3. **Extract ground:** PASS in 211.0 s; produced the selected 145,390-point
   ground cloud (`34`).
4. **Segment:** entry and source admission worked, but this replay stopped
   before execution. Four literal viewport clicks followed by Enter left
   `Vertices 0` and reported `A fence needs at least three vertices`; no fence
   or segmentation mutation was created:
   [segment fence stop](../../../.build/r02c/36-segment-fence.png).
5. **Sample:** PASS; the selected ground source produced and persisted a
   715-point sampled cloud. Reopen restored three point clouds:
   [sampled cloud restored](../../../.build/r02c/40-restarted-after-sample.png).
   The first replay also exposed the repeated-terminal progress flood described
   above; the final coalescing correction was compile-checked after that run.
6. **Rasterize mean height:** PASS at canonical publication; reopen restored a
   height-grid entity. **Display stop:** Builder then warned exactly
   `Canonical dataset ... uses unsupported bootstrap format
   hcad.pointcloud.height-grid@1`, so the grid did not enter the current viewer
   bootstrap path:
   [height grid persisted with exact warning](../../../.build/r02c/45-restarted-after-raster.png).
7. **Boundary:** PASS; stored `Boundary polygon 1` with four exact coordinates
   (`50`, `51`).
8. **DGM create:** source admission found Boundary polygon 1 as Boundary and
   the 145,390-point ground cloud as Points. Check passed with zero errors:
   [DGM Check passed](../../../.build/r02c/63-dgm-check-outcome.png).
   **Stop:** Create surface reached Bake 82%, then failed exactly with
   `canonical staged import is invalid: canonical provider output: canonical
   representation contract is invalid`:
   [DGM publication stop](../../../.build/r02c/64-dgm-create-progress.png).
   No partial surface entity was claimed.
9. **LandXML:** unreachable because DGM publication failed. The literal Output
   ribbon exposed only Specifications and Plan and no LandXML entry:
   [LandXML reachability stop](../../../.build/r02c/65-landxml-stop.png).

## Gates

| Gate | Result |
| --- | --- |
| `pnpm --filter @himmelcad/app test` | PASS, 79/79 |
| `pnpm --filter @himmelcad/builder test` | PASS, 46/46 on attempt 3; attempts 1–2 exposed concurrent viewer compilation and harness import issues that were resolved without a fourth run |
| `pnpm --filter @himmelcad/viewer test` | PASS, 164/164 |
| `pnpm --filter @himmelcad/builder typecheck` | PASS on attempt 2 |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS, including English-product-UI check |
| `pnpm --filter @himmelcad/photolab test` | PASS, renderer 86/86 and Electron 10/10; contracts passed |
| theme token lint | PASS |
| `pnpm registry:lint` | PASS, all seven checks |
| `cargo test -p himmelcad-sidecar pointcloud_ground -j 4` | PASS on its single permitted execution: 5 passed, 0 failed, 2 ignored, 350 filtered; binary filtered suites passed |
| `cargo check -p himmelcad-sidecar --tests --bins -j 4` | PASS in 19.36 s after all Rust edits; one pre-existing `adaptive_job_concurrency` dead-code warning |
| `cargo fmt --all -- --check` | PASS |
| `git diff --check` | PASS |

All Cargo invocations used `CARGO_TARGET_DIR=target/builder` and `-j 4`. The
single targeted test ran before the final hierarchy/progress refinements, as
required by the once-only gate. Those later Rust changes were checked by the
final all-tests/all-binaries Cargo check and exercised by the successful
211-second literal extraction.

## Scope and tree hygiene

- No PhotoLab-owned path was edited by this work package.
- Concurrent PhotoLab, viewer V-08, and renderer-fallback edits already present
  in the dirty tree were preserved and not claimed here.
- Temporary scratch and incomplete canonical transaction data from interrupted
  measurements were cleaned by their normal cancellation/process teardown;
  no partial ground entity was published by a cancelled run.
- No commit was made.
