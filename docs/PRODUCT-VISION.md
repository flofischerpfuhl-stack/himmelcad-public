# HimmelCAD Product Vision

## Mission

HimmelCAD is a family of 3D-first CAD and spatial tools for surveyors, civil
engineers, architects, planners and later possibly precision-mechanics and
3D-printing users.

The permanent priority order is:

```text
Performance > intuitive UX > aesthetics
```

Imports, conversions and pre-computation may be expensive. Once a project is
open, interaction must stay fast and predictable on standard professional
hardware.

## Licensing Model

HimmelCAD source is available under a license that forbids commercial use
without a commercial license from the rights holder. Users may fork and build
the software for private, hobby, research and non-commercial use.

Every incorporated dependency or vendored/forked codebase must allow this use
model. GPL-family code may be studied for algorithmic understanding only when
the law permits it; it must not be copied, ported or derived into product code.

The exact dependency rules live in `AGENTS.md` and
`LICENSES/THIRD_PARTY.md`.

## Product Family

The canonical product names are **HimmelCAD Builder**, **HimmelCAD Assembler**,
**HimmelCAD PhotoLab**, **HimmelCAD WeltView**, **HimmelCAD TestFlight**, and
**HimmelCAD ChronoGit**. Product UI, package metadata, release artifacts, and
current documentation use these names; the shorter names below are only
unambiguous prose shorthand.

### HimmelCAD Builder

The first implemented product foundation and the main 3D-first CAD. Further
productization is paused while PhotoLab becomes the current delivery target.
Builder starts point-cloud-first, but its architecture must already
allow tiled meshes, surfaces, CAD primitives, solids, BIM-like objects, photos, splats,
attributes, scripting and future read-only browser viewing.

### HimmelCAD PhotoLab

Current product focus: a near-full Agisoft Metashape alternative with an
additional Gaussian-splat pipeline. The first finished product target includes
image/RTK import, explicit horizontal and vertical CRS transformation, photo
alignment, GCP/checkpoint adjustment, measurable depth images, dense point
clouds, DSM/DTM, orthomosaics, textured terrain/meshes and Gaussian splats.

The binding product and implementation concept is documented in
`photolab/PHOTOLAB-CONCEPT.md` and `photolab/implementation-plan.html`.

PhotoLab outputs must become normal HimmelCAD entities, not a separate
one-off project type.

### HimmelCAD WeltView

Browser-based read-only viewer for Builder projects. It must show the same
entities and display modes as Builder where browser hardware allows it.

Allowed interactions:

- inspect entity properties,
- toggle visibility/display modes,
- measure interactively,
- later attach or view IoT/live data.

Disallowed by default:

- modifying canonical project entities.

Open decision: whether large projects are always downloaded client-side,
streamed over HTTP range requests, or served through a future backend. The
viewer architecture must keep all three possible until that decision is made.

### HimmelCAD ChronoGit

Possible future semantic version-control system for HimmelCAD projects. It is
not committed as a product yet, but Builder must remain compatible with it:
immutable objects, command journal, semantic entity IDs and meaningful diffs.

### HimmelCAD Assembler

Possible precision-mechanics / 3D-printing twin of Builder. Not currently
planned for implementation, but entity and command design should avoid
unnecessary civil/survey-only assumptions.

There is deliberately no Assembler application directory yet. The name is
reserved in product documentation until an implementation track is approved.

### HimmelCAD TestFlight

Possible simulation-oriented product: time-dependent 3D entities, interactive
entities, scripted behavior and game-engine-like simulation workflows.

Examples:

- terrain/runoff simulation,
- vehicle sweep paths,
- wind/solver integrations,
- entities with executable scripts.

Not currently committed as a product. The core model must still preserve a
future time dimension for attributes and simulation overlays.

## Shared Product Rules

- All products must remain visually compatible with the VSCode Dark Islands
  aesthetic already used in Builder.
- Electron is the desktop shell for product apps that need native file access.
- WeltView must run in browsers on desktop and eventually mobile.
- Shared renderer/data packages must not import Electron.
- Import is allowed to take time; runtime interaction is not.
- All long-running work must report useful console progress, not only jump
  from 0 to 100.
- Every feature callable from UI should have a command ID and be console-callable
  when the command system reaches that layer.
- Python scripting must call the same command/entity APIs as the UI, not bypass
  them.

## Builder Entity Roadmap

Entity types to keep in mind when designing the core model:

1. Point clouds.
   - Point attributes include intensity, confidence, classification, RGB,
     return info and optional Gaussian/splat display data.
   - For CAD/Civil workflows, Gaussian/splat data tied to a point cloud is
     primarily a point-cloud display attribute. A standalone
     `GaussianSplatCloud` entity is reserved for splat-only assets or PhotoLab
     outputs that are not semantically a point cloud.
2. 3D meshes.
   - Triangle meshes, optionally with tiled photo textures.
3. Surfaces.
   - 2.5D triangle meshes / terrain-like surfaces, optionally textured.
4. Polylines.
   - Two-point lines are a polyline special case.
   - Partially heightless polylines exist but only height-defined entities are
     drawn in the 3D view.
5. Points.
   - 2D points, points without numbers and survey points are variants of the
     same semantic point family.
6. Solids.
   - Computed volume bodies between meshes/surfaces, extruded 2D faces and
     other geometry-first volumetric results.
7. Objects.
   - Semantic BIM/IFC/Civil objects such as walls, pipes, manholes and shafts.
     Their display geometry may reference meshes, surfaces or solids, but the
     entity remains an object with attributes and behavior.
8. Labels / annotations.
9. 2D orthophotos.
   - Georeferenced raster images tiled into multiple resolutions at import.
10. 2D panoramic photos.
11. 3D panoramic photos.
    - Laser-scan panoramas with depth information, usable for measuring.
12. Dimensions.
13. Circles.
14. Arcs.
15. Splines.
16. Clothoids.
17. 3D variants of circles, arcs, splines and clothoids.
18. Alignments.
    - Alignment = tuple of polylines, arcs and clothoids.
    - With gradient: also 3D.
    - With ramp band: continuous surface-like representation.
    - With width band: continuous corridor/surface representation.
    - With slopes: generated slope geometry from the continuous alignment
      model.

Every entity has a nested custom attribute table in addition to its required
semantic/geometry properties.

## Specifications, Layers and Styles

Entities can be assigned to a specification or a free specification. A
specification may map to layer/style behavior. This area is intentionally not
fully designed yet.

The guiding constraint: free user attributes, imported attributes and
geometry/style-driving attributes must be separate enough that casual metadata
cannot accidentally mutate geometry.

Detailed data-model rules live in `docs/DATA-MODEL.md`.

## Scripting Direction

The complete app should eventually be controllable from Python through a shared
out-of-process scripting sidecar and SDK. Embedding Python directly into the
renderer or mutating project state from Python is not allowed.

Python/AI agents should be able to:

- call app commands,
- query entities and attributes,
- extract data into Python-native structures,
- work efficiently with point clouds as arrays,
- map polygonal/area data toward Shapely/GeoPandas-like structures where
  license and distribution constraints allow it,
- write modifications back through commands.

Scripts must not directly mutate the canonical store or bypass journaled
commands.
