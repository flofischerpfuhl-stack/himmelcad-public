# Viewer performance evidence dossier — V-00

Status: research and current-kernel assessment, 2026-09-04  
Owner: view-domain  
Scope: point clouds and every other renderable entity in the shared Builder viewer; no renderer implementation in V-00

## 0. Finding

Himmel:CAD should copy the reference architecture, not a reference product's
marketing number: preserve raw scans as authority, spend import time on a
multi-resolution working representation, select a visibility-ordered frontier
under hard frame/resource budgets, keep a resident coarse fallback, reduce work
while the camera moves, and refine progressively after it stops. The shared
frame must reserve latency and visibility for lines, points, text, grips and UI
overlays before cloud density. The camera is one continuous double-precision
state that can morph between perspective and top-down orthographic views; “2D”
is not a second renderer.

This follows X4 because every credible reference uses some combination of
preprocessed spatial hierarchy, bounded visible detail and progressive
refinement. It follows X2 because the hierarchy, samples, visibility hints and
optional occluders are baked once instead of rediscovered during every gesture.
The proposed numbers are decisions, not external norms; their derivation and
tunability are in `specs/view/viewer-core-addendum.md` (VC-D1…VC-D12).

No “beats Trimble RealWorks” claim is supported by V-00. The first real baseline
run was blocked before a browser process started (§5), so there are no frame
percentiles to publish. That is an evidence result, not permission to substitute
CPU render-call duration or a synthetic logical hierarchy.

## 1. Evidence method and confidence

Primary sources were preferred: vendor help/release notes, specifications,
project source/release notes, and research papers by the implementation authors.
Product internals that a vendor does not document are marked **unverified**.
Reference evidence chooses candidate mechanisms under X4; only a same-machine
capture under VC-D12 can establish comparative speed.

Source reconciliation: the task names `AGENTS.md` §2 performance budgets, but
the current root `AGENTS.md` has no numbered §2. Its active principle is still
performance > intuitive UX > aesthetics after correctness/data/security, plus
bounded, incremental large-data handling (`AGENTS.md:16-19`). Historical
budgets quoted by ADR 0003 were therefore not imported as current requirements;
the addendum chooses and marks new thresholds under X6.

### 1.1 Reference-product evidence

| Reference                      | Verified behavior relevant to 10⁸–10⁹ points                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What is not verified                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trimble RealWorks              | RealWorks 12.2 accepts a single structured or unstructured scan above four billion points without limiting import to available RAM, but explicitly recommends keeping data as acquired scans for display and processing performance ([official 12.2 notes](https://help.fieldsystems.trimble.com/realworks/12.2.htm)). Its import exposes per-station sampling, Scan Explorer retains a station-centric route to raw scans, and Limit Box Extraction can pull a fresh full- or sampled-density subset from raw TZF scans (`dossiers/realworks.md:38-47`, `dossiers/realworks.md:89-99`). The local RealWorks dossier therefore characterizes the pattern as a sampled working cloud backed by authoritative raw scans (`dossiers/realworks.md:279-285`). | Trimble does not publish its render hierarchy, point budget, GPU culling, occlusion or exact station-display algorithm. “Station-based display” here means preserving individual scans/stations and their dedicated view, not a claim about a hidden renderer. Practitioner reports of 5.6 billion points are useful scale evidence but not controlled performance evidence (`dossiers/realworks.md:244-260`). |
| Potree                         | Potree preprocesses a multi-resolution octree, frustum-tests nodes, traverses by projected importance and stops at a hard point budget/minimum projected size. Its adaptive point-size mode uses LOD spacing to hide density changes; EDL is a screen-space pass; splatting/interpolation trade fill quality for cost. The author measured near-linear point-budget cost and about 15.2 ms for three million points on the thesis notebook; that is historical evidence, not a Himmel:CAD target ([TU Wien thesis](https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/SCHUETZ-2016-POT-thesis.pdf), [project](https://www.potree.org/)).                                                                                            | The old notebook result is not comparable to WebGPU or current hardware. It does not establish mixed CAD/text/raster latency.                                                                                                                                                                                                                                                                                  |
| PotreeConverter 2 / “Potree 2” | The Potree project cites the 2020 fast out-of-core octree construction work; its converter builds a streamed hierarchy without holding the whole source in memory ([project bibliography](https://www.potree.org/), [paper DOI metadata](https://doi.org/10.1111/cgf.14134)). The current repository's prepared Potree 2 files likewise contain `metadata.json`, chunked `hierarchy.bin`, and `octree.bin`.                                                                                                                                                                                                                                                                                                                                              | No primary source located for a separately released product called “Potree 2” that guarantees a distinct progressive-refinement renderer. Claims beyond the converter-2 hierarchy and the published Potree techniques are **unverified** and are not used as decisions.                                                                                                                                        |
| CloudCompare                   | CloudCompare introduced display LOD for big clouds: motion first shows a low octree level and an idle view refines regularly ([official 2.6 release notes](https://www.cloudcompare.org/release/notes/20151008/)). Its LOD builder is asynchronous ([official class reference](https://cloudcompare.org/doc/qCC_db/html/classcc_point_cloud_l_o_d.html)). The project also exposes point-cloud ambient occlusion and OpenGL filters ([official presentation](https://www.cloudcompare.org/presentation.html)).                                                                                                                                                                                                                                           | CloudCompare's calculation octree is explicitly optimized for spatial queries rather than display LOD ([official wiki](https://cloudcompare.org/doc/wiki/index.php/CloudCompare_octree)); no supported hard frame-time guarantee or current billion-point navigation protocol was found.                                                                                                                       |
| Leica Cyclone / TruView        | Leica describes TruView as opening and navigating an unlimited number of points at “ultra-high-speed,” backed by Cyclone ENTERPRISE, JetStream Enterprise or portable LGS/LGSx, and co-displaying IFC/OBJ/COE models ([official TruView help](https://rcdocs.leica-geosystems.com/truview/2025.0.0/tv-leica-truview-introduction)). This verifies a prepared/server-or-package streaming architecture and mixed cloud/model product intent.                                                                                                                                                                                                                                                                                                              | “Unlimited” is vendor language, not a resource invariant. Leica does not disclose LOD selection, budgets, occlusion, point sizes or frame distributions on that page. Those internals remain **unverified**.                                                                                                                                                                                                   |
| Autodesk ReCap                 | ReCap projects reference indexed scan files and also support unified scans ([official getting-started help](https://help.autodesk.com/cloudhelp/ENU/Reality-Capture/files/recap_get_started.html)). Autodesk's ReCap engine integration in Navisworks exposes a maximum interactive point count (default 500,000), memory ceiling, and density expressed as points per pixel; higher density improves fill but extends refinement time ([official Navisworks ReCap reader](https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks/files/GUID-8330AD1D-B45D-4457-A919-A0087CBCB5D4.htm)).                                                                                                                                                                | The desktop ReCap viewer's internal hierarchy and whether its current defaults match the Navisworks reader are not documented. The 500,000 value is evidence for a tunable interaction budget, not a Himmel:CAD default.                                                                                                                                                                                       |
| Bentley Pointools / Vortex     | Bentley's historical product sheet verifies dynamic LOD, adaptive navigation display, mixed 3D models/drawings, up to 128 point layers, orthographic output and a user-visible frame-rate control ([archived Bentley Pointools sheet](https://www.sccssurvey.co.uk/downloads/bentley/Pointools_ProductDataSheet.pdf)). A historical guide describes density reduction during navigation, adaptive point-size compensation and a separate static-view optimizer ([archived guide mirror](https://manualzilla.com/doc/6904091/user-guide)).                                                                                                                                                                                                                | Public primary evidence found says “real-time, high-performance streaming,” but the often-repeated stronger phrase **visibility-ordered streaming** was not found in an accessible Bentley primary source. Treat the exact ordering as **unverified**; this program independently chooses benefit/SSE ordering because Potree and 3D Tiles substantiate it.                                                    |
| Cesium 3D Tiles                | 3D Tiles defines spatial hierarchies for heterogeneous point clouds, photogrammetry, BIM/CAD and models. Runtime geometric error becomes pixel SSE; `REPLACE` and `ADD` refinement, bounding volumes, viewer request volumes and implicit quad/octrees make demand-driven refinement explicit ([official specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc), [implicit tiling](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc)).                                                                                                                                                                                                                                          | The format specifies selection semantics, not one universal point/triangle budget or frame-time governor. CesiumJS behavior must not be attributed to the format without separate evidence.                                                                                                                                                                                                                    |

### 1.2 What the references agree on

1. **Total source size is not per-frame work.** RealWorks preserves scans,
   Potree/CloudCompare bake hierarchy samples, ReCap indexes scans, Leica
   streams prepared packages, and 3D Tiles traverses a hierarchy.
2. **Motion and rest are different quality states.** CloudCompare explicitly
   coarsens while moving then refines; Pointools exposes navigation reduction
   and a static optimizer; ReCap exposes an interactive point cap; Potree makes
   the point budget an explicit performance/quality lever.
3. **Quality is screen-relative.** Potree and 3D Tiles use projected error;
   ReCap describes point density relative to pixels; adaptive point size fills
   the holes created by a smaller budget.
4. **A hierarchy alone is insufficient.** Frame/resource ceilings, fallback
   residency, request/decode/upload scheduling and a refinement policy determine
   fluidity. Mixed CAD/text interaction adds a fairness requirement absent from
   most point-only viewers.

## 2. Technique inventory

The “Decision” column forecasts the addendum; it does not claim implementation.
Compute-based point rasterization research reports up to order-of-magnitude
gains over classic point primitives ([Schütz and Wimmer 2019](https://arxiv.org/abs/1908.02681)),
while later work combines adaptive precision, visibility buffers and LOD for
two-billion-point scenes ([Schütz, Kerbl and Wimmer 2022](https://arxiv.org/abs/2204.01287)).
Those papers justify a GPU-driven slice under X4; their hardware/results are not
adopted as Himmel:CAD acceptance numbers. Progressive WebGL research likewise
shows progressive drawing can complement rather than replace out-of-core LOD
([TU Wien progressive-rendering thesis](https://www.cg.tuwien.ac.at/research/publications/2019/Rumpler-2019-PPC/Rumpler-2019-PPC-thesis.pdf)).

| Technique                                                           | What it buys                                                                                 | Cost / failure mode                                                                                                | V-00 disposition                                                                                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hierarchical LOD plus pixel SSE                                     | Source-size-independent visible frontier; common rule for points, meshes, rasters and splats | Bake time/storage; poor samples make parent/child changes obvious; traversal can itself become unbounded           | **Adopt** (VC-D2). Bake representative parent samples and geometric error; cap traversal.                                                                                 |
| Hard points / triangles / splats / draw calls / bytes per frame     | Predictable GPU fill, draw and upload work                                                   | A single global point cap can starve CAD or over-spend on tiny distant points                                      | **Adopt** per class and per content lane (VC-D3), with protected interaction geometry.                                                                                    |
| Benefit-ordered, fair admission                                     | Useful tiles arrive before merely nearby tiles; multiple clouds progress                     | Priority churn can cancel useful work; strict benefit order can starve a dataset                                   | **Adopt** SSE/coverage benefit with round-robin dataset fairness, stale grace and coarse fallbacks (VC-D3/VC-D8).                                                         |
| GPU frustum/clip/occlusion culling and indirect draw                | Removes CPU draw-loop scaling and avoids rasterizing hidden indoor scans                     | Extra buffers/passes; stale occlusion can hide newly visible content; WebGPU feature variance                      | **Adopt in stages** (VC-D5): GPU compact/indirect first, conservative previous-depth HZB second; never use uncertain occlusion for picking authority.                     |
| Progressive refinement at rest; reduced new work in motion          | Low gesture latency without giving up final detail                                           | Visible popping, density “breathing,” repeated I/O on direction changes                                            | **Adopt** (VC-D4): keep resident frontier, throttle new decode/upload in motion, refine in bounded coverage increments at rest.                                           |
| Hold-last-frame / temporal reprojection                             | Masks an occasional missed cloud frame during camera motion                                  | Ghosting/disocclusion; stale CAD, grips or pick feedback would be dishonest                                        | **Restricted adopt** (VC-D4): cloud/raster background only, at most two presents/50 ms; vectors, text, selection and overlays render current state; no stale hit testing. |
| Adaptive point size / splats                                        | Fills holes at coarse LOD and low point budgets                                              | Overdraw and occlusion; large squares obscure linework; Gaussian splats cost sorting/blending                      | **Adopt bounded adaptive diameter** (VC-D6); cap diameter/overdraw and preserve line/text contrast.                                                                       |
| Eye-Dome Lighting (EDL)                                             | Depth discontinuity cues without normals, especially for monochrome scans                    | Full-screen depth sampling cost scales with pixels; halos                                                          | **Adopt as quality tier**, default on at rest where calibrated, reduced samples/off during overload (VC-D6).                                                              |
| Ambient occlusion                                                   | Stronger cavity/interior shape cues                                                          | More expensive and temporally unstable than EDL; can darken survey detail                                          | **Optional idle tier**, never required for the fluidity gate (VC-D6).                                                                                                     |
| Depth/HZB occlusion for indoor scans                                | Large reduction when walls/floors hide rooms and station scans                               | False occlusion if bounds/depth are not conservative; little benefit outdoors                                      | **Adopt conservatively** after a depth prepass/previous-frame HZB exists (VC-D5); two-frame visibility grace.                                                             |
| RTE / camera-relative coordinates / origin rebasing                 | Millimetric local precision with large georeferenced coordinates                             | Rebase invalidates cached GPU transforms if ownership is fragmented                                                | **Retain and test** one f64 world camera plus grid-snapped floating origin (VC-D7).                                                                                       |
| Asynchronous range fetch/decode and explicit residency stages       | Keeps file/network/decompression off the interaction thread; bounds RAM/VRAM                 | Transfer and ingest still cost main-thread time; cancellation races; cache duplication                             | **Retain, instrument and tighten** (VC-D8), including decoded-ready and upload debt.                                                                                      |
| Multi-cloud batching                                                | Avoids per-station/per-cloud submission explosion                                            | Batching across incompatible styles/pick ids can destroy semantics                                                 | **Adopt compatible-key batching**, preserve entity/dataset ids in pick metadata (VC-D9).                                                                                  |
| Multi-entity batching (lines, areas, text, meshes, rasters, splats) | One depth-coherent scene, fewer state changes                                                | Transparent order, glyph/texture churn and pick passes can dominate; clouds can starve tiny interactive primitives | **Adopt protected lanes** (VC-D3/VC-D9): interaction primitives and overlays have reserved work and residency.                                                            |
| Top-down orthographic 2D / 2.5D                                     | Plan drawing on the same scene and coordinates; section-aware depth ordering                 | Coincident geometry, labels and cloud fill fight for depth; “2D” can silently discard Z truth                      | **Adopt one camera/scene** (VC-D10): 2D changes presentation/pick reporting only; 2.5D preserves source Z; active sections remain authoritative.                          |
| Animated perspective→orthographic transition                        | Spatial continuity and learnability; avoids teleporting context                              | Projection-matrix interpolation can distort; input during blend can target a moving mapping                        | **Adopt a 180 ms cancellable semantic transition** with matched scale, north/up lock and cursor anchor (VC-D10).                                                          |
| Runtime hardware governor                                           | Same interaction contract across integrated, workstation-laptop and desktop GPUs             | Oscillation and unexplainable quality loss if too reactive; a CPU-only signal misdiagnoses GPU stalls              | **Adopt hysteretic multi-signal governor** (VC-D11), expose effective quality and reason.                                                                                 |

## 3. Hardware-class adaptation

The classes describe acceptance floors, not product editions:

- **I — integrated/entry:** hardware WebGPU, 8 GB system RAM, integrated GPU or
  2 GB effective graphics budget. The governor prioritizes 30 Hz motion,
  0.70–0.85 render scale, smaller point/splat and upload budgets, EDL with two
  taps or off under pressure, and sorted transparency where weighted OIT exceeds
  its measured budget.
- **W — laptop workstation floor:** Quadro M2200-class discrete GPU with 4 GB
  VRAM and four physical/eight logical CPU threads. This is the mandatory
  Builder floor used by V-00/V-01. It targets near-60 Hz presentation while
  retaining EDL at rest and a larger resident working set.
- **D — desktop:** discrete GPU with at least 8 GB effective graphics memory and
  calibration throughput meeting the V-01 desktop fixture. It targets 60 Hz at
  native render scale and shorter settle time; it does not change correctness.

Classification uses measured usable memory/throughput, not adapter-name lists.
The class thresholds and p95 guarantees are tunable only through checked-in
policy fixtures and gates; users can inspect effective density, render scale,
effect tier and the reason for a reduction. No class may invent coordinates,
hide protected vector/text interaction, or relax selection correctness.

The governor's response order is: reduce new fetch/decode/upload during motion;
reduce cloud/splat detail and optional effects; reduce render scale; only then
reduce non-protected mesh detail. It raises quality in reverse after sustained
headroom. Residency pressure evicts unpinned distant detail before coarse
fallbacks, glyphs, interactive linework or current selection.

## 4. Current-kernel assessment

“Current” means executable implementation found in this checkout. ADR 0003 is
architectural history; a statement in the ADR is not counted as implementation.

### 4.1 What exists

- ADR 0003's **PotreeConverter/format** half is live: LAS import launches the
  vendored converter, verifies `metadata.json`, builds/publishes the immutable
  manifest and canonical point-cloud admission
  (`crates/himmelcad-io/src/las_import.rs:455-572`). The accepted
  `@pnext/three-loader` source also remains in the repository, but it is wired to
  the legacy Three.js `Viewport` and its legacy snap provider
  (`packages/@himmelcad/viewer/src/Viewport.tsx:1-53`,
  `packages/@himmelcad/viewer/src/Viewport.tsx:722-740`,
  `packages/@himmelcad/viewer/src/snapping/PotreeSnapProvider.ts:1-24`). Builder
  now imports the shared `KernelViewport`/WASM path instead
  (`apps/builder/renderer/src/BuilderKernelViewport.tsx:14-55`). Therefore the
  presence of three-loader is not evidence that its LRU/renderer runs in the
  current Builder kernel; the current implementation evidence below is Rust.
- The Rust Potree provider parses range-addressed hierarchy pages into child
  bounds/content ranges and validates/decodes DEFAULT, UNCOMPRESSED and BROTLI
  node payloads into camera-relative points
  (`crates/himmelcad-render/src/providers/potree.rs:390-510`,
  `crates/himmelcad-render/src/providers/potree.rs:535-610`). This is the live
  ADR 0003 format boundary behind the shared selector, not a wrapper around the
  legacy three-loader renderer.
- The Rust selector is provider-neutral and combines transformed bounds,
  frustum/clip tests, projected SSE, ADD/REPLACE refinement, resident fallback,
  lazy hierarchy pages and hard traversal/unloaded-work bounds
  (`crates/himmelcad-render/src/tile_selector.rs:1-5`,
  `crates/himmelcad-render/src/tile_selector.rs:33-52`,
  `crates/himmelcad-render/src/tile_selector.rs:298-426`). This is materially
  more general than ADR 0003's original Potree-only plan.
- One coordinator plans mixed datasets, retains stale wanted tiles for four
  frames, pins render fallbacks, coalesces auxiliary demand and emits explicit
  hierarchy/fetch/decode/upload/evict actions
  (`crates/himmelcad-render/src/streaming.rs:14-80`,
  `crates/himmelcad-render/src/streaming.rs:116-133`,
  `crates/himmelcad-render/src/streaming.rs:221-381`).
- Admission shares resource and per-frame budgets, groups candidates per
  dataset, orders by benefit, round-robins datasets, and lets one oversized item
  progress rather than deadlocking
  (`crates/himmelcad-render/src/scheduler.rs:77-197`).
- Residency has explicit unloaded/fetch/decode/upload/resident/failed stages and
  budget-dimensional LRU enforcement
  (`crates/himmelcad-render/src/residency.rs:17-30`,
  `crates/himmelcad-render/src/residency.rs:461-520`).
- The host driver executes the Rust plan with request permits, transferable
  decode workers, a RAM-warm artifact cache, range-page coalescing, cancellation
  and cumulative fetch/decode/upload diagnostics
  (`packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:76-177`,
  `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:459-497`,
  `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:659-702`,
  `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:855-1088`,
  `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:1282-1331`,
  `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:1391-1503`).
- The session asks Rust for one mixed-provider streaming plan and deliberately
  reduces new streaming work during interaction without selecting a coarser
  resident render frontier
  (`packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts:750-815`).
- Hardware policy resolves memory, point/triangle/splat/draw, upload, request,
  decode-worker, traversal, render-scale, detail and transparency ceilings; its
  interaction policy reduces decode/upload/traversal work
  (`crates/himmelcad-render/src/hardware_policy.rs:188-216`,
  `crates/himmelcad-render/src/hardware_policy.rs:232-353`). Runtime calibration
  measures upload and point/triangle/splat throughput
  (`crates/himmelcad-render/src/hardware_policy.rs:27-39`,
  `crates/himmelcad-render/src/hardware_policy.rs:74-136`).
- `RuntimeQualityGovernor` exists and applies hysteresis to an EMA of effective
  CPU/GPU frame time, lowering render scale and detail after repeated overload
  and recovering after sustained headroom
  (`crates/himmelcad-render/src/hardware_policy.rs:584-710`). The exposed state,
  however, is only `renderScale` and `detailScale`
  (`packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:895-901`).
- The shared renderer admits points, meshes/CAD, rasters, splats and text into
  one depth-coherent color pass, with sorted alpha or weighted OIT and a
  separate pick pass when requested
  (`crates/himmelcad-render/src/frame_graph.rs:7-77`,
  `crates/himmelcad-render/src/gpu_frame.rs:4781-5006`).
- Whole-frame GPU timestamp queries are asynchronous and triple-buffered, so
  reading diagnostics does not synchronously stall the frame
  (`crates/himmelcad-render/src/gpu_frame_timing.rs:1-25`,
  `crates/himmelcad-render/src/gpu_frame_timing.rs:139-225`). Rust keeps bounded
  CPU/GPU distributions and workload peaks
  (`crates/himmelcad-render/src/hardware_policy.rs:401-580`), exposed by the TS
  viewer as p50/p95/p99/max CPU/GPU/effective time plus peak points, triangles,
  splats and draws
  (`packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:903-933`,
  `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:3266-3297`).
- Precision is already based on an f64 world camera and f64 subtraction into a
  grid-snapped floating origin before f32 GPU coordinates
  (`crates/himmelcad-render/src/precision.rs:42-54`,
  `crates/himmelcad-render/src/precision.rs:78-197`). The camera math supports
  reverse-Z projection, cursor rays and matched top-down orthographic endpoints
  (`crates/himmelcad-render/src/camera.rs:37-145`,
  `crates/himmelcad-render/src/camera.rs:166-245`).
- The product controller already supplies cursor-anchored pan/zoom and a
  180 ms projection morph path
  (`packages/@himmelcad/viewer/src/kernel/KernelCameraController.ts:232-315`,
  `packages/@himmelcad/viewer/src/kernel/KernelCameraController.ts:341-364`,
  `packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:195-218`,
  `packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:336-390`).

### 4.2 What is missing or insufficient for V-00

- **Closed by V-01:** the kernel now owns a fixed 2,048-frame ring whose exact
  presented-frame records include completion cadence, input correlation,
  CPU phase timings, sequence-correlated asynchronous GPU time, primitive/draw
  counts, policy reasons, queues, residency and freshness
  (`packages/@himmelcad/viewer/src/kernel/KernelFrameDiagnostics.ts:104-204`,
  `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts:294-308`,
  `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts:809-884`).
  `view.diagnostics.get` and the private-window, immutable
  `view.diagnostics.sample` query are callable through the Builder owner
  (`apps/builder/renderer/src/App.tsx:315-335`). The declared present source is
  `raf-render-complete`: the rAF callback timestamps scheduling, while a sample
  is committed only after a successful surface present returns. It is not an
  OS compositor/display timestamp and is not represented as one.
- The current governor observes the maximum of CPU and latest GPU time but can
  tune only two scalar values; it cannot directly tier point diameter, EDL/AO,
  occlusion, MSAA, transparency, protected entity lanes or upload debt
  (`crates/himmelcad-render/src/hardware_policy.rs:584-710`). Its nominal target
  is 16.7 ms, falling to 33.3 ms only for low CPU core count, rather than the
  three measured hardware classes in this program
  (`crates/himmelcad-render/src/hardware_policy.rs:276-292`).
- Draw submission is a CPU loop issuing direct `draw`/`draw_indexed`; there is
  no GPU-generated indirect command stream
  (`crates/himmelcad-render/src/gpu_frame.rs:6254-6313`). Every shown render pass
  sets `occlusion_query_set: None`, so there is no HZB/depth-query occlusion
  system in the current frame encoder
  (`crates/himmelcad-render/src/gpu_frame.rs:4832-4845`,
  `crates/himmelcad-render/src/gpu_frame.rs:4922-4935`,
  `crates/himmelcad-render/src/gpu_frame.rs:4993-5006`).
- The point shader supports native points or quad sprites scaled by a global
  point-size value, but does not derive a per-point adaptive diameter from LOD
  spacing (`crates/himmelcad-render/src/shaders/mixed.wgsl:646-696`). The shader
  directory contains the mixed, OIT composite and presentation shaders only;
  no EDL or point-cloud ambient-occlusion pass exists
  (`crates/himmelcad-render/src/shaders/mixed.wgsl:1`,
  `crates/himmelcad-render/src/shaders/oit_composite.wgsl:1`,
  `crates/himmelcad-render/src/shaders/presentation.wgsl:1`). The mesh material's
  occlusion texture is not point-cloud screen-space AO
  (`crates/himmelcad-render/src/shaders/mixed.wgsl:1051-1097`).
- 2D and 2.5D currently share the same top-down camera and switching between
  those two modes does not move it
  (`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:63-63`,
  `packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:195-218`).
  The semantic mode is committed before the animation settles, and cancellation
  is generation-based rather than an explicit restore/continue-from-current
  user contract
  (`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:336-390`).
  In 2D, picked Z is omitted; in 2.5D it is retained
  (`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:707-733`).
- The single mixed plan provides dataset fairness but has no explicit reserved
  per-frame lane saying clouds may never delay line/point/text interaction. The
  logical pass order alone is not a latency reservation
  (`crates/himmelcad-render/src/scheduler.rs:77-197`,
  `crates/himmelcad-render/src/frame_graph.rs:7-77`).
- No temporal reprojection/hold-last policy, disocclusion mask, progressive
  projected-coverage limiter or idle time-to-density metric was found in the
  implemented frame encoder, transition and streaming-plan paths
  (`crates/himmelcad-render/src/gpu_frame.rs:4781-5006`,
  `packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:336-390`,
  `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts:750-815`). This
  is a bounded source audit, not evidence that a similarly named stub is a
  capability.

### 4.3 Where frame time goes today

Before measurement, the code path supports this attribution model:

1. **CPU selection/planning:** transform bounds, frustum/clip/SSE traversal and
   build the mixed plan (`crates/himmelcad-render/src/tile_selector.rs:298-426`,
   `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:2552-2571`).
2. **Host streaming:** execute planned fetch/decode/upload transitions; worker
   decode is asynchronous, but decoded-result ingest and GPU publication are
   main-thread work (`packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:543-581`,
   `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:1014-1031`,
   `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:1282-1331`).
3. **CPU encoding:** iterate visible batches and issue direct draw calls
   (`crates/himmelcad-render/src/gpu_frame.rs:6254-6313`).
4. **GPU:** color/depth point/mesh/raster/splat/text work, optional weighted OIT,
   optional full pick pass, then presentation
   (`crates/himmelcad-render/src/gpu_frame.rs:4781-5006`).
5. **Browser/compositor/display:** currently outside the kernel telemetry. The
   asynchronous GPU timer measures submitted whole-frame GPU work, not the
   interval at which the user actually sees frames
   (`crates/himmelcad-render/src/gpu_frame_timing.rs:139-225`,
   `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:921-940`).

Which term dominates on the M2200 is **not measured** because the executable did
not build. V-01 must not turn this attribution model into a conclusion without a
successful capture.

## 5. Baseline run on this machine

Command:

```sh
node scripts/perf/viewer-baseline.mjs --date 2026-09-04
```

Host and fixture:

- Intel Core i7-7820HQ, 8 logical cores; NVIDIA Quadro M2200, 4096 MiB,
  driver 580.173.02; Linux x64; Node 22.18.0.
- Largest real LAS/LAZ found in the repository:
  `libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las`, LAS 1.2
  point format 2, 3,111,413,830 bytes, **103,713,735 points**. This exceeds the
  requested 50-million-point floor.
- The vendored converter successfully produced an uncompressed Potree 2
  hierarchy in `.build/perf/viewer-baseline-datasets/…`: `octree.bin`
  3,215,125,785 bytes, `hierarchy.bin` 759,286 bytes and metadata preserving
  103,713,735 points. This derived data is repeatable and outside source control.

Result: **blocked before Chromium/Electron started; no p50/p95/p99 exists.**
Builder's required dev WASM staging failed to compile `himmelcad-wasm` because
the match at `crates/himmelcad-wasm/src/lib.rs:14067` does not cover the current
`GeometryObject::Measurement` variant declared at
`crates/himmelcad-core/src/entity_model.rs:1136`. V-00 did not patch renderer or
WASM code, per scope. The exact compiler output and host/dataset identity are in
`.build/perf/viewer-baseline-2026-09-04.json`; the short result is in the adjacent
Markdown file.

Needed to obtain numbers: make the existing WASM geometry match exhaustive (or
run a known-good commit with matching core/WASM schemas), stage the viewer WASM,
then rerun the same command in a hardware-backed Electron session. The script
rejects SwiftShader/llvmpipe/software adapters. On success it drives orbit, pan,
zoom, fly-through and a 3D→2D→3D transition at 1440×900; writes rAF interval
p50/p95/p99, kernel CPU/GPU distributions, runtime-quality reductions, decode
backlog and the current rolling peak point-count proxy. The proxy is explicitly
labelled because exact per-frame point counts and OS-present intervals await
VC-D1.

For an external real cloud:

```sh
node scripts/perf/viewer-baseline.mjs --dataset /absolute/path/project.laz
```

For a previously converted Potree 2 dataset, avoid another bake:

```sh
node scripts/perf/viewer-baseline.mjs \
  --dataset /absolute/path/source.laz \
  --metadata /absolute/path/potree/metadata.json
```

### V-01 rerun attempt

V-01 repaired and restaged the Builder WASM path and upgraded the baseline to
consume the exact presented-frame ring rather than the former rAF/rolling-peak
proxies. A valid numeric rerun was **not started** on 2026-09-04 because the
machine was not idle: at 18:16 CEST an unrelated PhotoLab/COLMAP feature
extraction was using one CPU continuously, after an earlier PhotoLab worker had
used roughly four cores. The V-01 brief requires the baseline to run alone;
terminating or pausing that other lane was outside this work package. GPU load
was 0% at the check, but CPU contention alone invalidates a Class W latency
capture. Consequently there are still no defensible new p50/p95/p99 values,
and adapter support for runtime GPU timestamp queries was not observed in a
browser session. The implementation keeps GPU timings asynchronous and
sequence-correlated when supported, and retains `raf-render-complete` as the
measured present source otherwise. See
`docs/builder-program/evidence/V-01-measure-2026-09-04.md` for the validation
record and the precise remaining gate item.

## 6. Implications for the program

- V-01 begins with measurement authority and a buildable browser-gpu gate; no
  optimization slice can claim success using the current CPU/effective window
  alone.
- V-02 keeps ADR 0003's prepared hierarchy but generalizes the sampled-working
  representation and bake quality across point, mesh, raster and splat sources.
- V-03/V-04 protect interaction and remove CPU/draw scaling before adding visual
  effects.
- V-05 adds point-cloud quality tiers only after budgets are enforceable.
- V-06 finishes the 3D↔2D/2.5D user contract on the same camera and scene.
- V-07 qualifies I/W/D hardware and V-08 runs the controlled D-RW-07 comparison.

The complete slices and gates are normative in the addendum. This dossier is
evidence, not a second specification.

## 7. Source index

- Trimble RealWorks 12.2 release notes — https://help.fieldsystems.trimble.com/realworks/12.2.htm
- Trimble RealWorks product and help portal — https://geospatial.trimble.com/en/products/software/trimble-realworks ; https://help.fieldsystems.trimble.com/realworks/home.htm
- Potree project and thesis — https://www.potree.org/ ; https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/SCHUETZ-2016-POT-thesis.pdf
- Potree out-of-core octree paper — https://doi.org/10.1111/cgf.14134
- CloudCompare LOD release notes/class/wiki — https://www.cloudcompare.org/release/notes/20151008/ ; https://cloudcompare.org/doc/qCC_db/html/classcc_point_cloud_l_o_d.html ; https://cloudcompare.org/doc/wiki/index.php/CloudCompare_octree
- Leica TruView help — https://rcdocs.leica-geosystems.com/truview/2025.0.0/tv-leica-truview-introduction
- Autodesk ReCap and Navisworks ReCap reader — https://help.autodesk.com/cloudhelp/ENU/Reality-Capture/files/recap_get_started.html ; https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks/files/GUID-8330AD1D-B45D-4457-A919-A0087CBCB5D4.htm
- Bentley Pointools archived material — https://www.sccssurvey.co.uk/downloads/bentley/Pointools_ProductDataSheet.pdf ; https://manualzilla.com/doc/6904091/user-guide
- 3D Tiles specification — https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc
- PresentMon metric definitions for the eventual RealWorks capture — https://github.com/GameTechDev/PresentMon/blob/main/README-CaptureApplication.md
- NVIDIA FrameView description — https://www.nvidia.com/en-us/geforce/technologies/frameview/
