# Himmel:CAD data model

ADR 0016 and the Rust canonical contracts are authoritative. This document
explains the model without duplicating generated schemas.

## Entity model

An entity is a stable, user-visible semantic identity. Its versioned `type_id`
describes meaning; representations describe geometry or other renderable forms.

```text
Entity
  id
  revision
  type_id
  name
  owner?
  layer_ids[]
  placement?
  representations[]
  components
  attributes
  relations[]
  style?
  schema_version
  version_hash
```

The Rust schema validates built-in types. Unknown namespaced extensions are
preserved losslessly. TypeScript contracts are generated from Rust rather than
maintained as a parallel model.

An entity has one canonical owner direction. Child indexes are derived rather
than persisting conflicting parent and child authority.

## Semantics and representations

Built-in semantic families include organizational entities, points, curves,
areas, planes, elevation surfaces, spatial surfaces, rasters, point clouds,
Gaussian splats, panoramas, solids and BIM objects, alignments, blocks, text,
labels, and dimensions.

Geometry forms such as line, polyline, circle, arc, spline, clothoid, triangle
mesh, BRep, CSG, extrusion, and sweep are representations, not an ever-growing
transport enum.

PhotoLab jobs, processing sets, calibration groups, alignments, and product runs
are domain records. They create or reference entities but do not become render
entities merely because they appear in a project UI.

## Coordinates and dimensionality

Canonical positions use `f64` and optional Z:

```text
Position { x: f64, y: f64, z: Option<f64> }
```

Missing Z means unknown. It never means zero. Geometry with unresolved height is
valid plan geometry but is not silently flattened, draped, interpolated, or
shown as complete 3D geometry.

Resolving height is an explicit, versioned command that produces a new revision
and preserves measured values unless the chosen operation explicitly changes
them.

An `ElevationSurface` is 2.5D with at most one elevation per XY position. A
`Surface3D` is an arbitrary open spatial surface. An `Object3D` is a validated
solid. Rendering form does not erase semantic meaning.

## Immutable resources

Large geometry, images, materials, attributes, definitions, selection masks,
prepared datasets, and provenance are immutable content-addressed resources.
Entities reference exact resource revisions and hashes.

Derived representations identify their inputs and algorithm. They never claim
canonical source authority. Rebuildable indexes and render caches are not
canonical resources.

Point-cloud editing and segmentation use masks, filters, and derived entities
instead of duplicating complete point payloads.

## Commands and document authority

Commands are the only canonical write path. A command declares its actor,
expected revisions, deterministic payload, affected entities, and result.

- Validation happens before publication.
- Stale revisions or hashes fail without partial mutation.
- Undo and redo append compensating commands.
- UI, Python, and AI automation use the same command contracts.
- Viewer attachment and residency are projections, not document commands.

Atomic multi-entity edits are one command transaction and therefore one undo
step. Commands that produce immutable artifacts publish them before linking the
new entity revision.

## Properties, styles, and specifications

Required semantic properties, imported source properties, free user attributes,
and geometry-driving parameters remain distinguishable. Casual metadata must
not accidentally change geometry.

Styles are versioned resources and style changes are commands. Layers organize
entities without becoming a second entity authority. The exact long-term
specification model remains an owner decision in `docs/OPEN-QUESTIONS.md`.

## Blocks and derivations

Blocks reference versioned definitions with stable member identities. Instances
compose placements and explicit inheritance without copying definition geometry.

Generated Civil geometry, conversions, resolved heights, sections, and other
products retain derivation links to exact inputs and parameters. Materializing a
derived result creates a deliberate entity revision or new entity; transient
viewer output is not canonical by itself.

## Automation and bulk data

Queries are paginated and writes use expected revisions. Large point, mesh,
image, raster, and table payloads cross automation boundaries through bounded,
typed bulk-data leases rather than unbounded JSON copies.

The generated contract and current Rust implementation are the schema source of
truth. Examples in documentation are explanatory and must not be copied as
independent type definitions.
