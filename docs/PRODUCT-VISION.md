# Himmel:CAD product vision

## Mission

Himmel:CAD is a family of spatial applications primarily for construction,
civil engineering, surveying, planning, and the people who capture or consume
their data.

The family turns large real-world datasets into precise, interactive projects
without separating point clouds, photogrammetry, CAD, rasters, meshes, splats,
and browser delivery into incompatible products.

Correctness, data integrity, and security are non-negotiable. Within those
boundaries, the permanent product priority is:

```text
Performance > intuitive UX > aesthetics
```

Import, conversion, indexing, and preprocessing may take time. Once data is
available for work, interaction must remain fast and predictable.

## Product family

### Himmel:CAD Builder

Builder is the flagship product: a 3D-first Civil Engineering CAD optimized for
point clouds, Gaussian splats, terrain and elevation models, meshes, BIM/Civil
objects, and large spatial projects.

3D-first does not mean 2D-incomplete. Builder provides first-class 2D and 2.5D
construction, drafting, snapping, annotation, layout, and plan workflows on the
same canonical entities and commands. It must not become a separate 2D CAD with
3D attached later.

### Himmel:CAD PhotoLab

PhotoLab is the photogrammetric processing product. It turns image, camera,
control, and capture data into measurable depth products, point clouds,
elevation models, orthomosaics, meshes, and Gaussian splats with explicit
lineage and accuracy reporting.

PhotoLab is prioritized as the first finished product because its product
boundary is smaller than Builder's. Its outputs are normal Himmel:CAD entities
that Builder and WeltView can consume.

### Himmel:CAD Cap

Cap is the Android/iOS field-capture application. It packages phone imagery,
poses, sensor observations, and quality evidence into `.hcap` sessions for
PhotoLab. It is designed for simple field capture and honest quality feedback,
not as a professional survey controller or an on-device reconstruction suite.

### Himmel:CAD WeltView

WeltView is the browser viewer for shared Himmel:CAD projects. It supports
viewing, inspection, visibility and display control, measurement, and other
read-only project interactions without gaining canonical mutation authority.

### Reserved names

ChronoGit, Assembler, and TestFlight are reserved product concepts. They do not
authorize implementation work. Active products may retain generally useful
foundations such as immutable resources and journaled commands, but must not
pay speculative product complexity for reserved concepts.

## Shared product contract

- Products share canonical entities, commands, IO providers, renderer,
  automation protocol, design tokens, and UI patterns where applicable.
- Product-specific UX may differ, but it must not fork shared domain truth.
- Product UI is English and follows one Himmel:CAD visual language.
- Every product capability has a discoverable UI path. Contextually relevant
  entity commands should also be available from context menus.
- Canonical state changes are journaled commands. Python and AI agents use the
  same query and command contracts as product UI.
- Large datasets stay streamed and bounded; app renderers never become the
  permanent owner of complete datasets.
- Long-running work exposes meaningful progress, cancellation, recovery, and
  clear failure behavior.
- No product silently invents coordinates, height, scale, CRS, precision, or
  accuracy.
