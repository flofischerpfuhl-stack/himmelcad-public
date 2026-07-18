# PhotoLab Fast alignment — learnings (2026-07-18)

Context: Sulzberg SUMA (DJI M4E, EPSG:31468+7837). Agisoft reference has full GCP
optimization; Fast mode does **not** — expect residual gap vs Agisoft poses.

## Baseline results

### 24-image subset (old Fast)

| Metric | Value |
|--------|------:|
| Aligned cameras | 24 / 24 |
| Sparse points | 8 449 |
| Mean reprojection RMS | 0.73 px |
| Runtime (align only) | ~401 s |

### Full 135-image (old Fast: overlap=12, edge=2400)

| Metric | Value |
|--------|------:|
| Aligned cameras | **135 / 135** |
| Sparse points | 26 943 |
| Mean reprojection RMS | **0.97 px** |
| Runtime (align only) | **~1673 s (~28 min)** CPU-only SIFT |

### vs Agisoft dense LAS (sparse→LAS, centroid + Umeyama)

| Metric | Value |
|--------|------:|
| NN median after Umeyama | **~0.81 m** |
| NN p95 | **~1.23 m** |
| Scale | ~1.000 |

Note: Agisoft cloud is dense + GCP-optimized; we compare sparse without GCP BA.
Camera trajectory NN spacing ~4.1 m (no spatial outliers).

Agisoft report (full 135, with GCP optimization): ~0.83 px mean alignment error,
156k tie points. Not a direct apples-to-apples compare.

## Observed failure modes (user + code review)

1. **Sequential matching overlap too short for drone grids**  
   Fast used `SequentialMatching.overlap = 12`. In a serpentine strip, cameras
   that share **side-lap** are often >12 frames apart in capture order. That
   yields weak cross-strip constraints → a few cameras “float” or sit skewed
   while the bulk of a strip looks consistent.

2. **Aggressive downscale**  
   Fast `max_image_edge = 2400` on ~5280 px M4E frames throws away edge texture
   that SIFT needs on vegetation/roads.

3. **Keypoint budget**  
   4000 kp/MPx is light for low-texture lawn; bumping slightly helps without
   Quality Hybrid cost.

4. **Not a Save/Viewer issue**  
   Alignment quality is COLMAP pair graph + feature budget, not render path.

## Changes applied (Fast profile only)

| Knob | Before | After |
|------|-------:|------:|
| Sequential overlap | 12 | **20** |
| max_image_edge | 2400 | **3200** |
| keypoints_per_megapixel | 4000 | **5500** |

Files:
- `crates/himmelcad-core/src/photolab.rs` — resolve_alignment_profile Fast
- `crates/himmelcad-sidecar/src/main.rs` — `alignment_pair_selection` Fast

## Expected effect

- More cross-strip edges → fewer outlier cameras relative to the block
- Slightly denser sparse cloud / similar or slightly better RMS
- Runtime up ~20–40% vs previous Fast (still well under Quality Hybrid)

## Validation plan

1. `photolab-e2e --profile fast --max-images 24` (baseline already green)
2. Full 135 Fast before/after (compare `alignedCameraCount`, RMS, pointCount)
3. Optional: mean nearest-neighbour distance between our sparse (EPSG:31468)
   and Agisoft LAS after ICP/Umeyama — **after** both exist; do not treat as
   absolute quality without GCP BA on our side

## Gate: Fast 135 v2 (overlap=20, edge=3200) — 2026-07-18

| Metric | Baseline (12 / 2400) | v2 (20 / 3200) | Δ |
|--------|---------------------:|---------------:|--:|
| Aligned | 135 / 135 | 135 / 135 | = |
| Mean reproj RMS | **0.969 px** | 0.971 px | +0.002 (noise) |
| Sparse points | **26 943** | 25 959 | −984 |
| Observations | 171 097 | 169 534 | −1 563 |
| Align runtime | **1673 s** | 2100 s | **+25 %** |

**Conclusion:** the knob bump did **not** improve quality and made the run
slower. Full 135 is a poor place to search the knob space.

### Root cause: dead `keypoints_per_megapixel` knob

`resolve_alignment_profile` records `keypoints_per_megapixel`, but the sidecar
**never feeds it into COLMAP**. Actual budget is hard-coded:

```text
alignment_feature_budget(Fast) = 4096
→ SiftExtraction.max_num_features = 2048   (div_ceil/2 in colmap_runtime)
```

So only **overlap** and **max_image_edge** actually changed. Raising edge to
3200 with a fixed 2048 feature cap costs CPU without denser features — and
with more sequential pairs (overlap 20) matching got heavier for no RMS win.

Next experiments (24-image sandbox loops):

1. ~~Wire feature budget from resolved profile~~ **done** (`alignment_feature_budget`
   now uses `keypoints_per_megapixel × approx_MP`, Fast clamped 2 048–8 192 →
   COLMAP `max_num_features` up to **4096** stored orientations).
2. A/B: edge 2400 vs 3200 at **same** feature budget.
3. A/B: overlap 12 vs 16 vs 20 at fixed edge.
4. Only re-gate 135 after a 24-run wins on RMS + points.

### 24-image A/B (sandbox)

| Run | Knobs | Aligned | RMS | Sparse | Align s |
|-----|-------|--------:|----:|-------:|--------:|
| docs baseline | 12 / 2400 / feat~2048 | 24/24 | 0.730 | 8 449 | ~401 |
| v2 dead budget | 20 / 3200 / feat~2048 | 24/24 | 0.775 | 6 844 | (e2e incomplete) |
| budget-live 3200 | 20 / 3200 / feat~4096 | 24/24 | 0.673 | 15 599 | 905 |
| **budget-live 2400** | 20 / **2400** / feat~4096 | 24/24 | **0.662** | **16 851** | **878** |

**Winner for Fast (24-subset):** live feature budget + **edge 2400** + overlap 20.

- Doubling features (2048→4096 COLMAP cap) is the big quality lever.
- Edge 3200 with the same budget was **worse** (higher RMS, fewer points,
  slightly slower) — more pixels without more features dilutes SIFT.
- Matching time still dominates (~15 min / 24 imgs on CPU brute-force).
  CUDA matching would restore iteration speed.

### Current Fast defaults (after iteration)

| Knob | Value | Notes |
|------|------:|-------|
| Sequential overlap | 20 | kept (side-lap hypothesis still plausible) |
| max_image_edge | **2400** | better than 3200 at fixed feature budget |
| keypoints_per_megapixel | 5500 | now **wired** into budget (ceil 8192 → 4096 SIFT) |

**Not yet re-gated on full 135** with live budget — do that only after we are
happy with 24/48 loops (or after CUDA cuts runtime).

## Sparse cloud vs Agisoft (what we compared)

### What we compared

| Our product | Agisoft reference | Method | Result |
|-------------|-------------------|--------|--------|
| Fast sparse COLMAP (135, old knobs) | **Dense** LAS export `PW_GHT_ORIGINAL_…las` | Umeyama + NN | median ~0.81 m, p95 ~1.23 m |
| Camera trajectory | — | NN spacing | ~4.1 m (no outliers) |

This is **not** sparse↔sparse. The dense Agisoft cloud is denser and
GCP-optimized; residual gap is expected without our GCP BA stage.

### Agisoft sparse is extractable from the project tree

Under the Sulzberg `.files` folder:

```text
…/260706_Sulzberg_SUMA_UrGel.files/0/0/point_cloud/point_cloud.zip
  tracks.ply
  points0.ply          ← main sparse / tie-point cloud (~2.5 MiB)
  p0.ply … p134.ply    ← per-camera views
  doc.xml
```

So yes: the zipped project **does** contain the sparse cloud as PLY
(`points0.ply` + tracks). We have **not yet** run sparse↔sparse NN against
`points0.ply` (only dense LAS). That is the right next geometric check.

Dense remains at `dense_cloud/dense_cloud.oc3` (proprietary) plus the exported
LAS in `02_Export/`.

## Define Alignment presets (UI)

- Ribbon **Alignment → Define Alignment**
- Files: JSON body, extension **`.hcalign`** (not plain `.json`)
- Import coordinate workflows now save as **`.hcimport`** (legacy `.json` still opens)
- Strict parse on load (`kind`, `formatVersion`, knob ranges)
- Knobs wired into `startAlignment.overrides` (edge, kp/MPx, overlap, feature budget)
- Jobs UI: overall % + stage % + dual progress bars; console logs stage updates

## Why runs take so long (and CUDA)

Bundled COLMAP reports:

```text
COLMAP 4.1.0 … without CUDA
```

Alignment currently hard-codes `ColmapComputeDevice::Cpu` in
`prepare_alignment_job` (`main.rs`). Even if we switch to `Cuda { gpu_indices: [0] }`,
**this binary cannot use the Quadro M2200** until we ship a CUDA-built COLMAP
worker. Dense PatchMatch already requires CUDA and is gated the same way.

### Faster iteration loop (until CUDA COLMAP exists)

1. Use **`--max-images 24`** (or 48) for parameter sweeps (~7 min/run).
2. Full 135 only as gate after a promising 24-run.
3. Reuse feature cache when possible (same config hash / project).
4. Later: CUDA COLMAP package + set `device: Cuda { gpu_indices: [0] }` for Fast/QH.

### Align sandbox (2026-07-18)

Isolated playground (gitignored, no Codex/render touch):

```text
.build/align-sandbox/
  scripts/run-fast-subset.sh      # 24/48 e2e loops
  scripts/compare-results.py
  scripts/watch-v2.sh             # gate on full 135-v2
  scripts/build-colmap-cuda-sandbox.sh  # CUDA build → sandbox only
  notes/cuda-decision.md
  runs/                           # experiment outputs
```

Sidecar already supports `HIMMELCAD_COLMAP_EXECUTABLE` to point at a
sandbox CUDA binary without replacing `vendor/colmap/linux-x64`.

### CUDA decision (short)

**Worth it for speed**, not as a mid-run production cutover:

| Blocker now | Detail |
|-------------|--------|
| No `nvcc` | toolkit needs sudo (`nvidia-cuda-toolkit` or NVIDIA installer) |
| RAM | 135 feature extract ~18 GiB RSS; parallel rebuild would thrash |
| Vendor risk | keep CUDA build under `.build/align-sandbox/colmap-cuda-install/` first |
| GPU | Quadro M2200, **sm_52** — pin `CMAKE_CUDA_ARCHITECTURES=52` |

When toolkit is installed and a gate is idle: run
`./.build/align-sandbox/scripts/build-colmap-cuda-sandbox.sh`, smoke
`use_gpu=1`, then e2e with `HIMMELCAD_COLMAP_EXECUTABLE=…` and only then
flip production `ColmapComputeDevice`.

## Non-goals this pass

- Do not touch `himmelcad-render` / viewer
- Do not enable exhaustive matching on Fast
- Do not claim Agisoft parity without GCP optimization stage
- Do not overwrite production vendor COLMAP until sandbox CUDA smoke is green
