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
- `Surface` is a separate entity kind from `Mesh`.
- `Solid` and `Object` are separate concepts: `Solid` is geometry-first
  volumetric data, `Object` is semantic BIM/IFC/Civil data.
- Python scripting should be a shared out-of-process scripting sidecar plus SDK,
  using the same command/entity contracts as UI and AI agents.

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

5. Should 2D and 3D polylines share one entity kind with optional Z, or should
   2D drafting entities be modeled separately?
6. How strict should specifications be? Are they mostly styles/layers, or do
   they define geometry-generating behavior like Civil-style object types?

## Heavy Geometry

7. Which textured-mesh format should be the first target: 3D Tiles, glTF with
   meshopt/KTX2, Potree-adjacent custom tiling, or another permissive stack?
8. What transparency quality is acceptable for huge textured meshes: layer
   opacity, alpha-test, weighted OIT, or exact sorting only for small meshes?

## ChronoGit and TestFlight

9. How much extra complexity may the MVP carry for ChronoGit readiness before
   ChronoGit is proven useful?
10. Which time-varying data model does TestFlight need: time-stamped attributes,
    event streams, simulation states, or all of them?
