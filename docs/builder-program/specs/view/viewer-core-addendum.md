# Viewer Core addendum — V-00

Status: specified 2026-09-04  
Owner: view-domain  
Evidence: `../../dossiers/viewer-performance-2026-09-04.md`  
Applies to: `view-domain.md`, `../pointcloud/pointcloud.md`, `viewing-box.md`, ADR 0003, D-RW-07

## 0. Authority and boundary

This addendum specifies the shared Viewer Core program. It **cites and revises**
the affected owner decisions; it does not duplicate their full workflows:

- VD-D10 remains the owner of the diagnostics HUD/query. VC-D1 tightens its
  measurement authority from render work to presented frames and adds the
  counters required by D-RW-07.
- VD-D8 and PC-D11 remain the two-layer display and point-presentation owners.
  VC-D3/VC-D6 add budget ordering and adaptive quality; canonical entity style
  remains below unjournaled view overrides.
- PC-D5 remains the world-space fence/volume owner. VC-D2/VC-D5 require its
  volumes to participate in hierarchy selection and conservative GPU culling;
  they do not redefine volume truth.
- VB-D7 and VB-D8 remain the native and mixed Viewing Box interaction gates.
  VC-D1/VC-D3 replace their generic “≤2× target” interpretation with the class
  targets below and require the same protected entity lanes during box drag.
- VD-D9 remains the camera/preset owner. VC-D10 specifies the previously
  incomplete 3D↔2D/2.5D transition state and cancellation contract.

ADR 0003's accepted choice of prepared Potree hierarchy remains valid for scan
display. This addendum generalizes scheduling, measurement and co-rendering; it
does not make Potree files canonical source truth. Raw LAS/LAZ/E57/station data
remain authoritative until an explicit command changes them.

## 1. User-visible guarantees

### 1.1 Hardware classes and controlled viewport

The guarantee applies to a hardware-backed WebGPU adapter at 1440×900 physical
pixels on a fixed 60 Hz display, native OS scale, AC power/performance mode, and
the class's checked-in driver fixture. A gate records adapter, driver, display,
DPR, power mode, viewport and policy. Software adapters do not qualify.

| Class                      | Qualification floor                                                                                  | Motion presented-frame interval p95 | At-rest p95 after convergence | Warm time to full view density | Cursor input→present p95 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------: | ----------------------------: | -----------------------------: | -----------------------: |
| **I — integrated/entry**   | hardware WebGPU; ≥8 GiB system RAM; calibrated usable graphics budget ≥1.5 GiB                       |                            ≤33.4 ms |                      ≤25.0 ms |                      ≤1,500 ms |                 ≤50.0 ms |
| **W — laptop workstation** | Quadro M2200 4 GiB or a calibrated adapter no slower on the V-01 micro-workloads; ≥16 GiB system RAM |                            ≤25.0 ms |                      ≤20.0 ms |                      ≤1,000 ms |                 ≤33.4 ms |
| **D — desktop**            | ≥8 GiB usable discrete graphics memory and ≥2× W calibrated point/triangle throughput                |                            ≤17.2 ms |                      ≤17.2 ms |                        ≤600 ms |                 ≤25.0 ms |

All thresholds are **tunable** under X6, but only by editing this record with a
new same-fixture five-run result. “At rest” begins 250 ms after the last camera
input. “Full view density” means the selected, budget-converged visible frontier
for the class—not every raw source point. The warm timer starts at the last
motion present with required hierarchy pages and compressed tile bytes in the
RAM-warm cache; cold local-NVMe first-use is reported separately and may not be
substituted. Network latency is recorded, not hidden in this guarantee.

Motion scenarios are orbit, pan, cursor-anchored zoom, fly-through,
3D→2D→3D, native Viewing Box drag (VB-D7) and mixed cloud+CAD Viewing Box drag
(VB-D8). Every scenario runs at least five times; the gate uses the median run's
p95 and reports p50/p95/p99/max. Averages never decide pass/fail.

### 1.2 Continuity and degradation

- A resident parent/coarse tile remains rendered until all visible replacement
  children needed for the same coverage are resident. No refinement creates a
  blank tile boundary.
- A single LOD replacement may move a represented surface by at most **2
  physical pixels** (selected SSE) and may change at most **12% of viewport
  pixels** in one presented frame after excluding actual camera motion,
  selection highlight and animated overlays. The image-difference threshold is
  8/255 per RGB channel. These values are tunable.
- After motion stops, visible refinement begins within **100 ms** and reaches
  class-full density within the table's warm limit. Refinement is ordered from
  cursor/viewport center and largest projected error outward.
- Deadline pressure degrades cloud/splat density and optional shading before
  line, point, text, selection, cursor, grip or active-tool feedback. It never
  changes canonical coordinates, clipping, visibility, selection membership or
  export truth.
- A reused cloud/raster frame is labelled internally `reprojected`; it lasts no
  more than **two presents or 50 ms**, whichever comes first. Fresh vectors,
  text, selection and UI overlays are composited over it. Picking never reads a
  reprojected depth/id buffer.

### 1.3 Protected interaction and co-rendering

The shared frame has these priority lanes:

1. current camera, clear/depth and active clip volumes;
2. cursor, reticle, active tool preview, Viewing Box/section grips, selected
   entity highlight and pick ids;
3. canonical points/lines/areas/text and measurement/annotation graphics;
4. visible mesh/raster coarse fallbacks;
5. point-cloud/splat coarse fallbacks;
6. point-cloud/splat/mesh/raster refinement and optional effects.

Lanes 1–3 are **protected**. Cloud requests, decode, upload, draw count, EDL,
AO, splat overdraw and refinement may consume only their remainder. A cloud can
never delay a lane-2/3 input response past the class cursor limit. If protected
work alone exceeds the target, the frame reports `protected_work_over_budget`
rather than silently hiding it.

DOM/product UI overlays do not wait for streaming, GPU readback or pick mapping.
GPU viewport overlays use a pre-resident protected atlas/buffer budget. Missing
cloud detail does not disable line/text/entity picking; a pick whose source tile
is not resident returns bounded `pending_refinement` and leaves the current
selection unchanged.

## 2. Decision records

### VC-D1 — Presented frames are the performance authority

**Decision.** Revise VD-D10 and its D1 gates so the primary metric is the
interval between frames actually presented by the Builder surface. Each bounded
sample returns present timestamp/interval, input sequence id and input→present,
CPU plan/host/encode ms, asynchronous GPU ms, visible points/triangles/splats
and draws for that exact frame, render scale/detail/effect tier, upload bytes,
request/decode/upload backlogs, residency bytes, deadline/budget-hit reasons,
reprojected/fresh state and dropped/coalesced input count. The HUD reads the
same ring. Capacity is 2,048 frames; export is immutable JSON.

**Derivation.** D1 requires measurable interaction; VD-D10 already chose
presented-frame distributions; D-RW-07 compares products at presentation, not
inside their render functions. The current bounded CPU/GPU window lacks
present cadence and exact per-frame workload, as evidenced in the V-00 dossier.

**Rejected.** FPS averages, render-call duration, `requestAnimationFrame` alone,
or the latest GPU timestamp as the claim metric. They cannot prove displayed
cadence and can hide long-tail stalls.

**Tunable.** Ring capacity only (512–8,192); metric identity and per-frame
correlation are not tunable.

### VC-D2 — Sampled working representations backed by raw authority

**Decision.** Adopt the RealWorks/Potree/3D-Tiles pattern under X4/X2. Import
bakes immutable multi-resolution chunks with representative parent samples,
geometric error, tight f64 bounds, content/attribute summaries and chunked
hierarchy pages. Station scans remain separately addressable. Raw source hashes
and scan/station provenance back exact extraction, picking refinement and
rebuild. Point, mesh, raster and splat providers expose the same selector
contract; their encodings may differ. PC-D5 world-space volumes are applied at
node selection and content evaluation without coordinate invention.

**Derivation.** X2 spends the cost before interaction. Official RealWorks
guidance preserves scans; Potree and 3D Tiles validate hierarchy/SSE. ADR 0003
already accepts Potree preparation for clouds.

**Rejected.** Loading a monolithic GPU cloud, sampling afresh each frame, or
making the display sample canonical. Each either scales interaction with total
source size or loses source authority.

**Tunable.** Chunk target 1–8 MiB compressed (default 4 MiB), hierarchy page
64–512 KiB (default 256 KiB), parent sample method (default Poisson-disk/
coverage-preserving), and provider-specific attributes. Error bounds and hashes
are required.

### VC-D3 — Hard budgets with protected lanes and fair datasets

**Decision.** Every frame has hard points, triangles, splats, draw-call,
GPU-buffer, GPU-texture, staging, upload-byte, new-request, decode-time and
traversal-node ceilings resolved by hardware policy. Admission orders by
projected error reduction per byte/ms, round-robins visible datasets within a
lane, pins coarse fallbacks and reserves lanes 1–3 before refinement. This
revises only the performance ordering around VD-D8/PC-D11; their style
composition remains unchanged. VB-D7/VB-D8 execute with the same reservations.

**Derivation.** X1 puts performance ahead of aesthetics after correctness; D1
and D2 require bounded interaction and graceful weak-hardware degradation. A
single point budget cannot protect mixed CAD or text.

**Rejected.** Unlimited “draw everything,” one global primitive cap, strict
dataset priority, or cloud-first arrival order.

**Tunable.** Numeric budgets and per-lane reserve percentages. Lanes 1–3 and
fair progress for every visible dataset are not tunable.

### VC-D4 — Motion is coarse; rest refines; stale truth is bounded

**Decision.** Camera motion keeps the best resident frontier, prefetches the
predicted view, and reduces new traversal/decode/upload before lowering resident
detail. Rest refines progressively under the 12%-pixel-change and class settle
limits. When a fresh cloud/raster background will miss the deadline, temporal
reprojection/hold-last is allowed only under §1.2; all protected geometry is
fresh and picking waits for a fresh id/depth frame.

**Derivation.** X4 adopts CloudCompare/Pointools motion-versus-static behavior;
X1 prevents a quality technique from falsifying interaction.

**Rejected.** Dropping resident ADD detail on pointer-down, blocking for full
density, or reusing a complete stale frame including grips/picks.

**Tunable.** Motion detection 50–120 ms (default 80 ms), look-ahead 2–8 presents
(default 4), reprojection ceiling 1–2 presents (default 2). Fresh protected
layers are mandatory.

### VC-D5 — GPU-driven visibility is conservative and late-bound

**Decision.** Compact visible instances/tiles on GPU and emit indirect draw
commands for compatible batches. Add conservative previous-depth HZB occlusion
after frustum/SSE selection. Bounds touching uncertain depth, new/re-entering
tiles and tiles visible within the previous two frames remain visible. PC-D5
clip volumes apply before occlusion. Pick authority uses fresh exact geometry,
not an occlusion guess.

**Derivation.** CPU direct-draw loops scale with visible batches. Indoor scans
offer high occlusion, while conservative grace preserves correctness.

**Rejected.** Per-point CPU culling, synchronous occlusion readback, and
single-frame aggressive occlusion.

**Tunable.** HZB resolution (1/8–1/2, default 1/4), depth bias and two-frame
grace (2–4). Conservatism and no synchronous readback are not tunable.

### VC-D6 — Point quality is adaptive, bounded and subordinate to interaction

**Decision.** Revise PC-D11 by deriving point diameter from projected sample
spacing and LOD, multiplied by its existing entity×view value, clamped to
1–6 physical pixels during motion and 1–10 at rest. Use circular/elliptical
splats where supported. EDL has Off/2-tap/4-tap tiers; calibrated W/D default to
4-tap at rest and 2-tap in motion, I defaults to 2-tap. AO is an optional
idle-only tier and never part of the fluidity floor. Lines/text render after
point depth with a protected contrast/selection treatment.

**Derivation.** Potree demonstrates adaptive size and EDL; X1 and VD-D8 require
presentation to yield before interaction/canonical style.

**Rejected.** One fixed global pixel size, unlimited splat radius, mandatory AO,
or effects that change pick depth.

**Tunable.** Diameter clamps, EDL taps/radius/strength and AO availability.
Entity×view composition and pick-depth independence are not tunable.

### VC-D7 — One f64 world, camera-relative GPU data

**Decision.** Retain f64 camera/entity/volume truth. Choose a grid-snapped
floating origin near the view target, subtract in f64, and upload local f32 or
quantized tile coordinates plus a high/low placement as required. A rebase is
atomic for every entity kind and cannot change projected position by more than
0.25 physical pixel or a source-space millimetre on the georeferenced gate.

**Derivation.** X1 prohibits invented coordinates; the current RTE/floating
origin is the right shared seam.

**Rejected.** Global f32 coordinates, per-provider uncoordinated origins or
camera snapping visible to the user.

**Tunable.** Origin grid 256–4,096 project units (default 1,024). Error limits
are not tunable without a domain-accuracy revision.

### VC-D8 — Decode, upload and residency remain asynchronous and bounded

**Decision.** Keep explicit fetch→queued-decode→decode→queued-upload→upload→
resident stages. Range requests coalesce; decode uses transferable workers;
main-thread ingest and upload have per-frame debt ceilings; cancellation is
generation-safe. Residency evicts unpinned least-beneficial detail, never the
last coarse coverage, protected atlases or active interaction geometry. Warm
and cold posture are separate measurements.

**Derivation.** X2 and extreme D1 budgets; the current coordinator/driver already
provide the right stages but not full presentation correlation.

**Rejected.** Main-thread decompression, unbounded decoded-ready queues,
eager whole-file reads or eviction of the sole visible fallback.

**Tunable.** Worker/request counts, cache splits and upload debt per class.
Bounded queues, cancellation and fallback pinning are not tunable.

### VC-D9 — Compatible batching preserves entity semantics

**Decision.** Batch across clouds and entities only when pipeline, material/
style tier, clip set, depth mode and vertex layout match. Entity/dataset/
representation identity remains in draw metadata and pick ids. Text/glyph and
line/stroke batches are protected. Transparent surfaces use policy-selected
weighted OIT or stable sorted alpha; point/splat transparency cannot force
opaque CAD into its path.

**Derivation.** Shared renderer reuse and mixed-entity performance; VD-D8 still
owns presentation composition.

**Rejected.** One draw per entity/tile, batching that merges pick identity, or
a point-cloud-only frame followed by a delayed CAD frame.

**Tunable.** Batch size, pipeline cache and transparency strategy by calibrated
class. Semantic identity and protected lanes are not tunable.

### VC-D10 — 3D, 2.5D and 2D are one cancellable camera continuum

**Decision.** Cite/revise VD-D9. The transition state is
`{fromMode,toMode,progress,fromCamera,toCamera,cursorAnchor}`. A 3D→plan command
matches scale at the cursor (viewport center if no valid world point), blends
perspective to orthographic over 180 ms smoothstep, locks project north/up and
ends top-down. Plan→3D starts from the current interpolated camera and releases
the up constraint without a jump. 2.5D preserves source Z/depth ordering and
section effects; 2D uses the same geometry/depth for visibility but reports
plan coordinates and omits Z from ordinary picks after settlement.

During the blend, entity, grip, line, point and text picks use the exact
interpolated camera and remain available. Pan and cursor-anchored zoom retarget
the active transition. Orbit cancels toward 3D from the current interpolated
state. A new mode command retargets from the current state. Escape cancels and
returns to `fromMode` in at most 100 ms, preserving current cursor anchor and
scale. Projection-dependent creation commits are disabled with “Finish or
cancel view transition”; selection/inspection are not. The semantic mode
changes only when the transition settles. Cancellation publishes no history
entry; settled camera changes follow VD-D14/P8 camera history.

**Derivation.** X4 reference continuity, current matched top-down seam, VD-D9's
≤200 ms transition, and X1 pick truth.

**Rejected.** Teleporting, committing destination semantics before presentation,
stale-id picking, two independent renderers, or discarding Z to make 2D.

**Tunable.** Normal duration 120–200 ms (default 180), Escape return 60–100 ms.
Pick truth, same scene and cancellation are not tunable.

### VC-D11 — The governor is measured, hysteretic and explainable

**Decision.** Resolve class from usable memory and calibration, then observe
presented p95 trend, CPU/GPU split, upload debt, decode backlog and residency
pressure. Reduce quality in §3's order after 8 consecutive over-target fresh
frames; recover one tier after 90 consecutive frames below 75% of target and
no debt. Never change more than one tier per 250 ms. Expose class, target,
effective point/triangle/splat budgets, render/detail scales, effect tier,
backlogs and last adjustment reason through `view.quality_governor.get`; the HUD
uses the same query.

**Derivation.** D2 demands graceful weak-hardware behavior; X6 requires chosen
thresholds; the current 8/90-frame hysteresis is a usable starting point but its
two scalar outputs are insufficient.

**Rejected.** Adapter-name allowlists, quality oscillation, hidden automatic
changes, and a user “unlimited” setting that bypasses hard safety budgets.

**Tunable.** 8/90 counts, 75% recovery ratio, 250 ms rate limit and class
budgets. The numeric user guarantees and explainability remain gates.

### VC-D12 — D-RW-07 is an external, same-presentation comparison

**Decision.** `G-RW-VIEWER-COMPARE` retains MASTER-PLAN RW-VIEW-1 and adds the
capture details in §3. Builder's internal sample validates attribution; Windows
PresentMon or NVIDIA FrameView is the cross-product presented-frame authority.
No result may be generalized beyond named datasets/scenarios/classes.

**Derivation.** MASTER-PLAN D-RW-07 already forbids an unmeasured claim.
PresentMon defines displayed/presented frame intervals and dropped frames;
FrameView records the same analytics to logs.

**Rejected.** Side-by-side subjective viewing, vendor demo videos, FPS counters,
different density, or comparing RealWorks Windows with Builder on a different
machine/driver/display.

**Tunable.** Pinned product versions and datasets. Equivalence, same-machine
capture, five runs and strict every-scenario win are not tunable.

## 3. D-RW-07 comparison protocol

### 3.1 Frozen setup

Record hashes for source data, Builder prepared data and the RealWorks project;
pin Builder commit, RealWorks version/configuration, Windows build, GPU driver,
display EDID/refresh, 1440×900 viewport, DPR, power mode, cold/warm posture and
all quality controls. Use the same physical workstation, monitor and input
replay device. Disable overlays unrelated to the scenario in both products.

The demanding-user reviewer signs a content-equivalence sheet before timing:
same station/cloud set, visible bounds, clipping/section, projection, color/
point size, screen coverage and measured on-screen density. If exact budgets
cannot match, downsample the denser product to the lower visible count and
report the mismatch; never let Builder render less while claiming speed.

Datasets include at minimum:

- the pinned 103,713,735-point Orscholz LAS used by V-00;
- one checksum-pinned structured multi-station E57/TZF-compatible project above
  500 million points;
- one mixed scene containing cloud, mesh/BIM, lines, points, areas, text,
  raster and selection/Viewing Box graphics.

### 3.2 Replay

Replay identical duration/keyframes for orbit, pan, cursor zoom, fly-through,
3D→2D→3D, native/mixed Viewing Box drag, segmentation preview, classification
recolor and station view. Camera paths are defined in source coordinates and
validated by projected checkpoints (≤2 px difference). Each product gets one
untimed warm-up then five recorded runs per cold/warm posture; alternate product
order to reduce thermal/order bias.

### 3.3 External RealWorks capture

On Windows, target the RealWorks process with PresentMon Capture Application or
NVIDIA FrameView. Capture per-frame CSV including `MsBetweenPresents`,
`MsBetweenDisplayChange`/Displayed Time where available, `Dropped`, CPU/GPU time
and present latency. Start capture two seconds before replay and stop two seconds
after; analysis trims by injected start/end visual markers. Keep the dominant
RealWorks swap chain matching the viewport and record any additional swap
chains. FrameView is acceptable because NVIDIA documents that it uses
PresentMon analytics and logs frame times.

Builder is captured by the same external tool/process rules. Its VC-D1 JSON is
correlated by UTC monotonic markers and used for causal attribution only. If
external displayed-frame metrics are unavailable for either process, use
presented-frame time for both and say so; never mix displayed for one with rAF
or render time for the other.

### 3.4 Report and claim rule

For every run report p50/p95/p99/max presented interval, displayed interval when
available, input→present p95, dropped/coalesced inputs, displayed/reprojected
frames, first useful frame, full-density time, visible primitives/density,
CPU/GPU time, RAM/VRAM and quality deviations. Preserve raw CSV/JSON and the
analysis script.

“Viewer beats Trimble RealWorks” is allowed only if the median-of-five Builder
presented p95 is strictly lower for **every claimed scenario**, input→present is
no worse, neither product drops scripted input, the Builder meets its class
guarantee, and the reviewer accepts equivalence. Otherwise publish the measured
table without that sentence. This cites and narrows MASTER-PLAN RW-VIEW-1; it
does not weaken it.

## 4. Acceptance gates

| Gate                  | Acceptance                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `G-VC-MEASURE`        | Buildable browser-gpu run; 2,048-frame ring correlates each present/input/workload; synthetic pause and GPU load appear in expected p95/p99 fields; rAF/render-time substitution fails.                                                                                       |
| `G-VC-REAL-100M`      | Five runs of the pinned 103,713,735-point real LAS, all five camera paths, JSON+Markdown; class p95/cursor/settle limits pass and no source coordinate changes.                                                                                                               |
| `G-VC-EXTREME-1B`     | Checksum-pinned ≥1B-point or ≥500M multi-station real source; total source size never becomes resident; queues, traversal, RAM and VRAM remain within policy for 30 minutes. A synthetic 1.185B hierarchy may test bounded traversal but cannot discharge real decode/render. |
| `G-VC-MIXED`          | One frame contains cloud+splat+mesh/BIM+raster+line+point+area+text+selection/grips; lanes 1–3 meet cursor p95 while cloud saturates; cloud never suppresses protected entities.                                                                                              |
| `G-VC-LOD-CONTINUITY` | Camera/refinement image sequence has no blank boundary, ≤2 px SSE displacement and ≤12% thresholded pixel change per non-camera refinement present; full-density timer passes.                                                                                                |
| `G-VC-GPU-DRIVEN`     | CPU encode p95 does not grow more than 20% when compatible visible batches grow 10×; indirect count/culled count/HZB false-occlusion replay are reported; exact picking still passes.                                                                                         |
| `G-VC-PRECISION`      | Georeferenced real fixture at ≥10⁶-unit coordinates retains ≤1 mm source error and ≤0.25 px rebase shift across every entity kind, clip and pick.                                                                                                                             |
| `G-VC-TRANSITION`     | 3D↔2D/2.5D at 60 Hz meets class p95; scale/anchor deviation ≤2 px; picks use interpolated camera; pan/zoom retarget; orbit/Escape/new-mode cancellation follow VC-D10; no journal entry before settle.                                                                        |
| `G-VC-VB-NATIVE`      | Cite-and-run VB-D7 under each required class and VC-D1 metrics; no generic “2× target” escape.                                                                                                                                                                                |
| `G-VC-VB-MIXED`       | Cite-and-run VB-D8 with VC-D3 protected lanes; locked parity remains VB-D8's ≤1.1× native crop baseline and class p95 also passes.                                                                                                                                            |
| `G-VC-GOVERNOR`       | Deterministic overload/debt traces cause ordered reductions after 8 frames, no faster than one/250 ms; recovery after 90 headroom frames; query/HUD reason and effective budgets agree.                                                                                       |
| `G-VC-LONG`           | 30-minute mixed fly/orbit/plan loop on I/W/D: no unbounded queue/residency growth, device loss is recovered or explicit, no stale picks, and p95 in each 5-minute window passes.                                                                                              |
| `G-RW-VIEWER-COMPARE` | VC-D12/RW-VIEW-1 frozen same-machine five-run evidence; claim rule evaluated exactly.                                                                                                                                                                                         |

All browser-GPU gates reject software adapters. Unit/model checks may use
software rendering but cannot discharge D1 performance. Tests name current
fixture hashes, policy/class and output artifacts.

## 5. Slice plan

Sizes: S ≤3 focused days, M 4–7, L 8–14, XL requires staged sub-slices.

| Slice                                   | Deliverable and dependencies                                                                                                                                                                                                               | Gate                                                                                |                                     Size | Hardware                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------: | ------------------------------------------------------------------ |
| **V-01 — measurement authority**        | Implement VC-D1 presented/input/work rings, exact primitive counts, phase timers, budget reasons, immutable sample query/HUD seam. Depends on **S-08 ViewState/HUD** for surface; kernel instrumentation may land first.                   | `G-VC-MEASURE`                                                                      |                                        L | W first; I/W/D model fixtures                                      |
| **V-02 — prepared visible frontier**    | Generalize bake metadata/error/sample contract, station-preserving cloud preparation and real-fixture loader; retain ADR 0003 compatibility. Depends on **D-02 scan import/view subset** and prepared-data/CAS ownership.                  | `G-VC-REAL-100M`, preparation half of `G-VC-EXTREME-1B`                             |                                        L | W, then I/D                                                        |
| **V-03 — protected scheduler/governor** | Per-lane hard budgets, mixed benefit/fair admission, upload/decode debt, fallback pinning, class policy and explainable quality query. Depends V-01/V-02 and S-08 for HUD.                                                                 | `G-VC-MIXED`, `G-VC-GOVERNOR`, VB-D7/VB-D8 model gates                              | XL (3a scheduler, 3b governor, 3c mixed) | I/W/D                                                              |
| **V-04 — GPU-driven visibility**        | Compatible GPU compaction/indirect draws, then conservative HZB occlusion and visibility grace. Depends V-01/V-03; no new provider-specific renderer.                                                                                      | `G-VC-GPU-DRIVEN`, `G-VC-PRECISION` regression                                      |                 XL (4a indirect, 4b HZB) | W/D; I fallback path also passes class target                      |
| **V-05 — point/splat quality tiers**    | Adaptive LOD-spacing diameter, bounded splats, EDL tiers, optional idle AO, effect telemetry. Depends V-01/V-03; HZB integration may follow V-04. Cites PC-D11/VD-D8.                                                                      | `G-VC-LOD-CONTINUITY`, `G-VC-MIXED`                                                 |                                        L | I/W/D                                                              |
| **V-06 — 3D↔2D/2.5D continuum**         | VC-D10 transition state, interpolated picking, retarget/cancel/Escape, plan depth/text ordering and camera-history settlement. Depends **S-08**, V-01 and protected lanes from V-03.                                                       | `G-VC-TRANSITION`                                                                   |                                        M | I/W/D                                                              |
| **V-07 — qualification and endurance**  | Pin I/W/D machines/drivers/fixtures; real 100M and ≥1B/multi-station runs; native/mixed Viewing Box; 30-minute recovery/leak runs; publish baselines. Depends V-01…V-06 and D-02.                                                          | `G-VC-REAL-100M`, `G-VC-EXTREME-1B`, `G-VC-VB-NATIVE`, `G-VC-VB-MIXED`, `G-VC-LONG` |                                        L | I/W/D mandatory                                                    |
| **V-08 — RealWorks comparison**         | Freeze equivalent RealWorks projects/quality and camera replay; external PresentMon/FrameView capture; demanding-user equivalence sign-off and honest report. Depends V-07 plus completed M-RW scenarios (D-02/D-03/D-RW-01/D-RW-02/S-08). | `G-RW-VIEWER-COMPARE`                                                               |                                        M | Same W and D Windows workstations; I only if RealWorks supports it |

V-04 and V-05 may overlap after V-03 contracts freeze, but V-07 cannot begin
qualification until all claimed paths are integrated. V-08 is evidence work,
not an optimization slice. Failure to beat RealWorks creates a measured backlog;
it does not permit changing content equivalence or hiding the result.

## 6. Registry/automation additions

| Id                      | Access                                    | Surface                                           | Perf class          | Automation                                                         | Status                                                      |
| ----------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `view.quality-governor` | R C A                                     | View ▸ Diagnostics HUD detail / read-only popover | continuous observer | `view.quality_governor.get`                                        | specified; missing; view-local/effective state, no history  |
| `view.transition-3d-2d` | existing `view.mode` controls; Escape C A | View ▸ Camera / viewport camera blend             | continuous          | `view.transition_3d_2d.get/cancel`; start remains `view.state.set` | specified; current blend partial; no duplicate mode command |

Both are owner `view-domain`. The transition is user-visible but remains one
camera-state act; the registry row explicitly prevents a duplicate `view.mode`.
