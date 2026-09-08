# V-05 — point/splat quality tiers and renderer payloads — 2026-09-08

Status: **IMPLEMENTED; deterministic and CPU-WebGPU fixture gates pass, hardware LOD/performance qualification remains open.**

No timed baseline was run. No I/W/D discrete-GPU performance claim is made.

## Outcome

Prepared Potree nodes now carry V-02 `pointSpacing` through the viewer/WASM boundary and
render with a spacing-derived physical-pixel diameter. The reference identity is
`spacing × projected pixels per project unit × entity multiplier × view multiplier`,
clamped to 1–8 px. The D-02 cloud control is now an entity multiplier backed by a
renderer API that updates only that entity's resident point batches and is retained for
future streamed nodes. The existing serialized `pointSizePixels` field is retained for
Release-0.5 project compatibility but is documented and validated as a `0.25×–8×`
adaptive-diameter multiplier.

Eye-dome lighting is a bounded presentation effect selected from the landed V-03
hardware class, quality tier and motion state. Class I disables EDL during motion and
uses two directions at rest. W/D use two directions during motion and four at rest at
Balanced/Full. Minimum is off; Coarse is off in motion and two-direction at rest. EDL
is also disabled when the selected frontier has no point/splat content. WebGL receives
the original portable color-only presentation shader; depth texture loads exist only
in the WebGPU EDL shader.

The Gaussian-splat provider already exists, so V-05 preserves its covariance, stable
primitive identity, depth ordering and picking while bounding the submitted three-sigma
ellipse to 32 physical pixels per axis. This limits fill amplification without replacing
provider truth or changing compatible-batch identity.

Selection points, selected-polyline end arrows, support-role points/curves, measurement
anchor squares, measurement lines and label chips now have one typed, bounded renderer
payload. Builder selection and measurement producers submit that payload through the
session's protected-frame invalidation path. Lines/quads use the mixed frame and labels
use the existing glyph-atlas/text pipeline. The visible measurement DOM graphics were
removed; the remaining empty host supplies extent/theme values only and draws nothing.

V-01 frame reasons now include `effect:edl` when enabled and always record
`quality:tier` for the resolved tier.

## Doctrine decisions

> **Decision:** Derive point diameter from authoritative per-node spacing and the current
> projection; apply entity and view multipliers only after projection; clamp the final
> physical diameter to 1–8 px.
> **Derivation:** VC-D6 requires density compensation to remain bounded and subordinate
> to interaction. V-02 already records the exact spacing needed to avoid inventing a
> density estimate.
> **Rejected:** a global fixed pixel diameter, point-count-derived spacing, and changing
> selector truth to make coarse nodes appear denser.
> **Tunable:** base coverage `k` (initial `1.0`), entity multiplier `0.25×–8×`, and the
> existing view multiplier. The 1–8 px safety clamp and source spacing are not tunable.

> **Decision:** Resolve EDL at each frame boundary from V-03 class/tier/motion state and
> point-content visibility. Use a separate WebGPU presentation shader and report Off on
> WebGL.
> **Derivation:** VC-D6 makes effects subordinate to interaction; the implementation
> brief requires WebGL2 to remain a supported compatibility path.
> **Rejected:** always-on EDL, adapter-name allowlists, shared WGSL depth loads that Naga
> cannot lower to the WebGL path, and effects that alter picking/depth truth.
> **Tunable:** radius `1 px`, strength `80`, and Off/2/4-direction policy thresholds.
> Class-I motion-off and bounded tier selection are policy, not user overrides.

> **Decision:** Bound, but do not reinterpret, Gaussian covariance. The provider's
> existing splat kind remains the source of mean/covariance/color/identity.
> **Derivation:** VC-D6 permits bounded splats where a provider exists; VC-D9 requires
> batching to retain entity and primitive semantics.
> **Rejected:** synthesizing Gaussian data for ordinary point clouds or unbounded screen
> ellipses.
> **Tunable:** 32 px maximum three-sigma axis. Provider identity and covariance are not.

> **Decision:** Replace each overlay layer atomically with bounded world-anchored line,
> screen-quad and text-chip batches. Overlay batches are non-pickable and are appended
> after resident scene/move/clip work without participating in background admission.
> **Derivation:** V-03 protects lanes 2/3, while S-10 and 0.5-08 already define the
> orange/support-blue visual policy and exact DOM projection to replace.
> **Rejected:** continuing visible SVG/button graphics, per-frame DOM rasterization,
> mutating canonical geometry to draw selection, or merging batches across entity
> identity.
> **Tunable:** line width `0.5–16 px`, square/arrow size `2–32 px`, label height
> `6–64 px`. Payload ceilings are fixed safety bounds: 8,192 lines, 65,536 line points,
> 16,384 quads, 4,096 labels, 256 characters per label and ±4,096 px offsets.

> **Decision:** Resolve design tokens in Builder and submit linear RGBA: selection uses
> `--hc-geometry-selection`, support/measurement idle geometry uses
> `--hc-geometry-support`, and status text continues to use foreground tokens.
> **Derivation:** `docs/DESIGN-SYSTEM.md` owns visual semantics; the renderer must not
> know CSS or invent colors.
> **Rejected:** duplicated literal renderer colors and `--hc-error` as text color.
> **Tunable:** theme token values, not token roles.

## Implementation map

- Adaptive reference policy and EDL tier mapping:
  `crates/himmelcad-render/src/point_quality.rs:8-205`.
- Per-batch adaptive style, material update and independent-cloud test:
  `crates/himmelcad-render/src/gpu_frame.rs:111-175`, `:3483-3510`,
  `:5520-5522` and `:6608-6618`.
- Spacing projection/clamp and bounded splat ellipse:
  `crates/himmelcad-render/src/shaders/mixed.wgsl:678-693` and `:907-911`.
- Portable presentation split and EDL-capable surface path:
  `crates/himmelcad-render/src/gpu_surface.rs:367-425`, `:1084-1285`,
  `crates/himmelcad-render/src/shaders/presentation.wgsl`, and
  `crates/himmelcad-render/src/shaders/presentation_edl.wgsl`.
- Typed bounded overlay uploads through shared line/screen-quad/text batches:
  `crates/himmelcad-render/src/overlay.rs:1-442`.
- Per-entity multiplier, EDL state, atomic overlay layers and frame append:
  `crates/himmelcad-wasm/src/lib.rs:4751-4782`, `:5420-5475`, and `:7561-7597`.
- V-02 spacing transport, public entity/effect/overlay APIs, replay and frame reasons:
  `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:950-966`,
  `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:1730-1845`,
  `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts:738-760`,
  `:915-940`, `:1460-1485`, and
  `packages/@himmelcad/viewer/src/kernel/KernelFrameDiagnostics.ts:1-35`.
- Renderer-payload helpers and mono atlas:
  `packages/@himmelcad/viewer/src/kernel/KernelRendererOverlay.ts:1-210`.
- Builder selection and measurement producers:
  `apps/builder/renderer/src/BuilderKernelViewport.tsx:2700-2785` and
  `apps/builder/renderer/src/MeasurementViewportOverlay.tsx:1-180`.
- D-02 canonical compatibility-field range and UI semantics:
  `crates/himmelcad-core/src/canonical_resources.rs:80-135`,
  `packages/@himmelcad/app/src/clients.ts:294-305`, and
  `packages/@himmelcad/ui/src/PointCloudDisplayProperties.tsx:20-65`.
- Continuity, payload-position and browser evidence fixtures:
  `packages/@himmelcad/viewer/test/kernel-point-lod-continuity.test.ts`,
  `packages/@himmelcad/viewer/test/kernel-renderer-overlay.test.ts`,
  `packages/@himmelcad/viewer/test/browser/main.ts:4040-4132`, and
  `packages/@himmelcad/viewer/test/browser/kernel-browser-e2e.mjs:1400-1420`.

`scheduler.rs` and `hardware_policy.rs` were consumed unchanged. V-03 remains the owner
of class/tier/lane policy. V-02 remains the owner of prepared spacing metadata. The
concurrent 0.5-01, 0.5-02a and 0.5-03 worktree changes were preserved.

## Gate evidence

| Gate/check                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `G-VC-LOD-CONTINUITY` image-difference fixture                                                                                | **PASS for the deterministic fixture/model portion.** Nine orbit positions compare 4 px and 2 px prepared-plane LODs; each asserts ≤12% changed viewport pixels and ≤2 px maximum sample displacement. No real 100M-point hardware orbit was run.                                                                                                                                                                                                                                                        |
| Point-size identity                                                                                                           | **PASS.** Rust reference cases prove deterministic spacing/projection/multiplier identity and exact 1/8 px clamps; the WGSL mirrors the equation.                                                                                                                                                                                                                                                                                                                                                        |
| Per-entity point size                                                                                                         | **PASS.** Rust retains simultaneous `0.75×` and `1.5×` cloud material styles; viewer/WASM tests prove entity-targeted calls and streamed-node replay without sibling mutation.                                                                                                                                                                                                                                                                                                                           |
| Overlay payload positions                                                                                                     | **PASS.** Viewer fixtures prove 6 px squares remain centered, chip midpoint +12 px matches the former DOM calculation, and both selected-line arrow arms end within 1 px of the former projected endpoint. Support-role fixture produces both support-blue line and point payloads.                                                                                                                                                                                                                      |
| S-10 and 0.5-08 regressions                                                                                                   | **PASS.** Viewer selection-policy tests and UI measurement/selection visual tests remain green; Builder measurement/tree tests remain green.                                                                                                                                                                                                                                                                                                                                                             |
| V-01 effect reasons                                                                                                           | **PASS.** Ring fixture retains both `effect:edl` and `quality:tier`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs test -p himmelcad-render`                                         | **PASS — 353 passed, 0 failed; doc tests 0.** Run once after `free -g` showed 31 GiB total and 26 GiB available.                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm --filter @himmelcad/viewer test`                                                                                        | **PASS — 155 passed, 0 failed on attempt 3.** Attempts 1–2 failed only because the exact public export count/fingerprint had not yet included one concurrent fence export and then the three V-05 exports; behavior tests passed on both attempts. Final boundary: 323 exports, SHA-256 `e825dd17ff490b8fd15ed061f04e8397ad20f0a54b90b8d8eb0a1f4bdc171c96`.                                                                                                                                              |
| `pnpm --filter @himmelcad/app test`                                                                                           | **PASS — 69/69.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm --filter @himmelcad/builder test`                                                                                       | **PASS — 22/22.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm --filter @himmelcad/ui test`                                                                                            | **PASS — 46/46.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm --filter @himmelcad/builder typecheck`                                                                                  | **PASS.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm --filter @himmelcad/photolab typecheck`                                                                                 | **PASS; English UI check passed.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm --filter @himmelcad/theme test`                                                                                         | **PASS; shared CSS status text uses foreground tokens.**                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs check -p himmelcad-render --tests`                                | **PASS.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs check -p himmelcad-wasm --target wasm32-unknown-unknown`          | **PASS.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs check -p himmelcad-core --tests`                                  | **PASS** after aligning the canonical multiplier range.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs test -p himmelcad-core point_cloud_display_is_bounded_and_strict` | **PASS — 1 passed, 0 failed.** Proves `0.25×` and the default validate while `0.2×`/`8.5×` fail closed.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CARGO_TARGET_DIR=target/builder node scripts/stage-builder-viewer-wasm.mjs --profile release`                                | **PASS.** Final post-validation-change staging completed in 5m 07s; viewer and decode wasm artifacts are current.                                                                                                                                                                                                                                                                                                                                                                                        |
| CPU WebGPU browser harness                                                                                                    | **PASS on final permitted attempt.** Backend `webGpu`, device kind `cpu`, 38 entities/47 proxies, maximum CPU submit 2.7 ms, browser/GPU error assertions clear. The same-camera V-05 payload pair differs in 2,022 of 921,600 pixels. This is functional evidence, not a hardware timing qualification.                                                                                                                                                                                                 |
| WebGL2 browser harness                                                                                                        | **NOT VERIFIED after the three-attempt cap.** Attempt 1 found the harness's hard-coded missing `cargo`; attempt 2 found hard-coded missing `wasm-bindgen`; attempt 3 reached the page and found stale Potree fixture metadata without required `pointSpacing`. The harness now uses repository-compatible tool resolution and the fixture now carries `pointSpacing: 1`, but it was not run a fourth time. Portable-shader separation passes Rust/wasm compilation and its no-depth-load unit assertion. |
| `git diff --check`                                                                                                            | **PASS before evidence creation and rechecked at handoff.**                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Visual evidence

- Before, fixed camera and empty V-05 layer:
  `.build/v05/viewer-kernel-e2e-webgpu/screenshots/v05-renderer-overlay-webgpu-before.png`
  — SHA-256 `ebf5e3214c0611d870534cb697343440d94f38f9b1846deaaf270ca7aa16a9d4`.
- After, same camera with support line/square, selected anchor/end arrow and text chip:
  `.build/v05/viewer-kernel-e2e-webgpu/screenshots/v05-renderer-overlay-webgpu-after.png`
  — SHA-256 `3c2acac3f8bb94361406733f032714e233d4afe52bdebc6d0c9fbecf838a8a47`.

Both 1280×720 captures were inspected. The background/camera is identical, the
protected payload is visible without clipping, and ImageMagick absolute-error comparison
reports 2,022 changed pixels. The browser fixture uses a deliberately minimal glyph
atlas, so its chip is pipeline evidence rather than the Builder typography reference;
Builder registers the bounded mono atlas from `KernelRendererOverlay.ts`.

## Open qualification and follow-up

- `G-VC-LOD-CONTINUITY` still needs the architect's real-dataset full-density timer and
  hardware orbit/image-difference qualification; the synthetic fixture must not be
  reported as that hardware result.
- No cursor p95, presented-frame p95, settle time, EDL cost, overdraw cost or real
  100M-point/splat measurement was taken on I/W/D hardware. The timed baseline was not
  run by instruction.
- The WebGPU browser run initializes the EDL-capable presentation pipeline, while exact
  Off/2/4 policy and effect telemetry are unit-tested. The browser fixture does not make
  a visual EDL quality claim.
- S-10 did not land a canonical support-role component producer. V-05 supplies and tests
  the typed `helper_point` / `defining_point` / `defining_curve` renderer seam, but
  Builder must not infer roles from ordinary geometry. The first canonical role owner
  can feed this payload without another renderer change.
- Renderer-native measurement chips are non-pickable protected graphics. Measurement
  selection remains available through the project tree and Measurements panel; adding
  renderer overlay hit identities would be a separate canonical interaction contract,
  not an inferred transient pick slot.
- Ambient occlusion was not added; the requested tiered effect for this package is EDL.

## Architect acceptance (2026-09-09 00:10)

WebGL2 backend gate passed on the landed tree: PhotoLab visual harness (Chrome headless, WebGL2) dark run 90 captures and light run (`PHOTOLAB_VISUAL_THEME=light`) 90 captures, no GPU-device errors, non-blank viewports — the EDL depth read is split into a WebGL-safe path. Architect re-run: render 353/353, viewer 155/155, app 69/69, builder 22/22, root typecheck exit 0; before/after overlay screenshots inspected (renderer-native selection/support/anchor/text-chip payloads on the CPU-WebGPU harness scene). Accepted as landed; open for architect qualification on real datasets: LOD continuity on the 104 M-point fixture, EDL cost, class I/W/D timing.
