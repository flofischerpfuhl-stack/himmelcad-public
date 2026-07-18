# Open Product and Architecture Questions

These questions are intentionally explicit so future implementation work does
not smuggle in accidental product decisions.

## Resolved Direction

- The CAD product is **Builder**. User-facing text, app paths and package
  names use `builder`.
- Public/product wording may call HimmelCAD open source. Legal/license files
  still need exact wording before release.
- Gaussian/splat data tied to point clouds is primarily a point-cloud display
  attribute for CAD/Civil workflows. Standalone `GaussianSplatCloud` remains for
  splat-only assets.
- Surface meanings follow ADR 0016: `ElevationSurface` (2.5D) vs `Surface3D`
  (open spatial) vs solid `Object3D`. Older `Mesh`/`Solid` wording is migration
  prose until contracts fully cut over.
- Semantic BIM/IFC/Civil data is `BimObject` / classified `Object3D`, not an
  anonymous mesh, unless explicitly materialized.
- Python scripting should be a shared out-of-process scripting sidecar plus SDK,
  using the same command/entity contracts as UI and AI agents.
- **ChronoGit readiness tax (Q9):** only journal + immutable objects + stable
  IDs/revisions. No ChronoGit product work until Phase 7 decision gate. See
  `docs/CURRENT-DIRECTION.md`.
- **Reserved products:** Composer, TestFlight, and ChronoGit stay names-only
  until an explicit gate. Agents must not implement them.
- **Entity base model:** ADR 0016 — versioned `type_id`, representations,
  optional Z (`None` never means zero). Lines/circles/arcs are curve
  representations, not separate base kinds.
- **Renderer direction:** ADR 0017 — one Rust/wgpu-oriented render core with
  WebGPU and WebGL2 backends; no Three.js/Potree/Cesium provisional engine.

## Licensing

1. Is the intended license exactly **Business Source License 1.1**, or should
   the repo use a custom source-available non-commercial license?
2. What is the conversion date/change license, if BSL 1.1 remains the license?
   BSL normally requires a future change license.

## WeltView Distribution

3. For large projects, should WeltView prioritize full client-side download,
   HTTP range streaming from static hosting, or a future backend service?
4. Should WeltView support mobile from the first public release, or only keep
   the architecture mobile-compatible until later?

## Entity Semantics

5. ~~Should 2D and 3D polylines share one entity kind with optional Z?~~
   **Superseded by ADR 0016:** one `Curve` family with optional Z positions;
   missing Z is unknown, never zero. Remaining nuance: whether pure paper-space
   drafting needs a separate view-only kind (still open, low priority).
6. How strict should specifications be? Are they mostly styles/layers, or do
   they define geometry-generating behavior like Civil-style object types?

## Heavy Geometry

7. Which textured-mesh format should be the first target: 3D Tiles, glTF with
   meshopt/KTX2, Potree-adjacent custom tiling, or another permissive stack?
8. What transparency quality is acceptable for huge textured meshes: layer
   opacity, alpha-test, weighted OIT, or exact sorting only for small meshes?

## Deferred raster/depth conformance after Foundation A

11. Version the prepared streaming raster contract for camera- and planar-depth
    mappings, explicit planar U/V frames, validity/confidence bands and exact
    connectivity masks. The Foundation-A orthographic elevation path already
    has one pixel-centre convention; these additional imaging modes must reuse
    it rather than open a parallel renderer.
12. ~~Remove the remaining duplicate panorama depth authority and define one
    rigid camera-to-entity-local pose validation before panorama measurement is
    expanded.~~ **Resolved:** panorama image, depth and scan-station position
    now have one authority: the camera-mapped raster and its validated rigid
    camera-to-entity-local pose. A second serialized `station` is rejected.

## ChronoGit and TestFlight

9. ~~How much extra complexity may the MVP carry for ChronoGit readiness?~~
   **Resolved for now:** journal + immutable objects + stable IDs only.
   Diff UI, merge product, and ChronoGit-only schema growth are frozen until
   the Phase 7 feasibility gate. Tracked in `docs/CURRENT-DIRECTION.md`.
10. Which time-varying data model does TestFlight need: time-stamped attributes,
    event streams, simulation states, or all of them?
    **Deferred:** TestFlight is reserved/out of scope until its decision gate.
    Do not expand the core schema solely for this question.
