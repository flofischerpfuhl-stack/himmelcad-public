# ADR 0016 - Canonical Entity Model

## Status

Accepted for the new shared foundation.

## Date

2026-07-15

## Context

Builder, PhotoLab and WeltView currently share an `EntityKind` enum that mixes
user-visible geometry, semantic objects, generated products and PhotoLab process
records. The Rust and TypeScript kind lists are maintained separately. The
current coordinate value also requires every point to have a Z coordinate.

This cannot represent ordinary surveying work where one boundary is measured in
XYZ and another boundary is only known in XY. It also makes every new domain
concept a change to the renderer-facing core enum.

## Decision

### Stable entity envelope

An entity is a user-visible, stable semantic identity. Its type is a versioned
identifier such as `hcad.area@1`, not a growing transport enum.

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

The built-in types are validated strictly. Unknown namespaced components are
preserved losslessly so import, export and later domain modules do not destroy
data they do not understand. TypeScript contracts are generated from the Rust
schema rather than maintained by hand.

`owner` is the canonical hierarchy direction. Children are indexed instead of
persisting both parent and child links.

Canonical edits are absolute, replayable commands rather than mutations of a
viewer-side copy. `TransformEntity` carries the entity ID, exact expected
revision and version hash, and an exact optional affine placement. An absent
placement remains distinct from an explicit identity transform. An accepted
command preserves every other envelope field, advances the revision,
recomputes the canonical version hash and publishes every affected render slot
through compare-and-swap. A stale revision or hash, a duplicate command ID, or
a singular/non-finite transform changes neither entity, render state nor
journal.

The shared core owns the append-only entity-command journal. Undo and redo
append compensating forward commands with new monotonically increasing
revisions; they never republish an old entity snapshot. The journal is
serializable and replayable without introducing the deferred ChronoGit product
surface.

### Built-in entity types

- `Group`
- `Layer`
- `Point`
- `Curve`
- `Area`
- `Plane`
- `ElevationSurface`
- `Surface3D`
- `RasterImage`
- `PointCloud`
- `GaussianSplatCloud`
- `Panorama`
- `Object3D`
- `BimObject`
- `Alignment`
- `Block`
- `Text`
- `Label`
- `Dimension`

Lines, polylines, circles, arcs, ellipses, splines and clothoids are curve
representations, not separate entity base classes. Mesh, BRep, CSG, extrusions
and sweeps are geometry representations rather than entity types.

A control point is a `Point` with typed role attributes. Pipes and manholes are
classified `BimObject` or `Object3D` entities. PhotoLab jobs, processing sets,
calibration groups and alignment runs are domain records, not render entities.

### Mixed XY and XYZ geometry

Canonical positions have optional Z:

```text
Position { x: f64, y: f64, z: Option<f64> }
```

Missing Z means unknown. It never means zero.

An `Area` consists of an outer curve loop and zero or more inner loops. A loop
may contain inline curves and associative references to existing curve entities.
Its vertices and referenced curves may mix XY and XYZ positions.

An area is valid in plan even when some heights are unresolved. Geometry with
at least one unresolved height remains plan geometry and is not a complete 3D
representation. The viewer does not resolve, drape or interpolate missing Z for
display.

A later CAD operation may assign actual heights by:

- resolve missing Z against a referenced elevation surface;
- resolve missing Z on an explicit plane;
- resolve missing Z with a named, versioned interpolation algorithm; or
- leaving positions unresolved when the selected method has no valid result.

That operation is an ordinary validated, journalled and undoable document
command. It preserves existing surveyed Z unless the user explicitly invokes a
different editing operation, writes every successfully resolved Z into the
canonical geometry and commits a new entity revision. Only that complete new
revision may be displayed as 3D geometry. A resolver recipe or transient
derived representation is never sufficient viewer authority.

This directly supports a parcel area bounded by a tachymetrically measured XYZ
road edge and an XY cadastral boundary. Associative boundary references ensure
that the area updates when either source edge changes.

### Surface meanings

- `ElevationSurface` is a 2.5D height surface with at most one elevation for an
  XY position.
- `Surface3D` is an arbitrary open spatial surface and may contain overhangs or
  vertical parts.
- `Object3D` is a valid solid. Its representation may be a closed manifold
  mesh, manifold BRep, CSG, extrusion, sweep or another validated solid form.
  An open mesh is `Surface3D`, not `Object3D`.

Inline triangle meshes store an optional material-table slot for every triangle
in index order. The slot array is valid only with an immutable, typed
`hcad.resource.material-table@1` resource and must match the triangle count
exactly. Each table entry is an exact `(schemaId, resourceId, contentHash)`
reference to one canonical material revision; table order, not a mutable
"latest material" lookup, defines the compact slot number. Resource-backed formats
such as glTF keep the same association inside the content resource. This keeps
material boundaries authoritative for ordinary rendering, sections and
material-specific hatching instead of reconstructing them from viewer state.

### Raster images with height or depth

A `RasterImage` may contain typed bands for color, elevation/depth, validity and
confidence together with its mapping, pose and imaging model. The depth field
declares:

- whether samples mean world elevation, optical-axis depth or ray distance;
- nearest, bilinear or discontinuity-aware interpolation; and
- whether adjacent samples form a continuous height field or break at detected
  discontinuities.

An orthophoto with a height band and an elevation surface can share the same
tiled rendering path. The declared connectivity and interpolation remain part
of both display and picking, so pixel-height jumps are not bridged by invented
triangles.

Raster sample coordinates are unambiguous across inline and streamed
representations: integer column/row coordinates address pixel centres, while
the corresponding pixel footprint extends by one half sample step on every
side. Geometry, NoData handling, draping and exact raster picking use this same
convention.

### Blocks

`Group` organizes one-off entities. `Block` is a placed instance of a reusable
`BlockDefinition` project record. Changing a definition updates its instances;
exploding an instance produces independent entities.

### Alignments and views

Horizontal alignment, vertical alignment/gradient, stationing, width bands,
ramp/crossfall bands and slope rules are typed parts of one `Alignment` entity.
Generated corridor and slope geometry remains a derived representation until a
user explicitly materializes it as a separate surface.

Longitudinal profiles, cross-sections, section views, clipping boxes, local view
frames and camera projection are view state, not entity types.
The shared viewer therefore represents a local profile/section view as an
origin plus orthonormal normal/up axes and an orthographic span. Switching,
panning or zooming that frame does not mutate the canonical entity store. An
optional front/back viewing depth is likewise a scoped clip slab in view state;
the exact profile trace or hatch remains a derived section product rather than
a new canonical entity.

Vertical exaggeration and its datum are also view/presentation state. They do
not rewrite canonical entity heights, topology, attributes or section inputs.
Exact picking and measurement return source-world f64 coordinates, while
height-based styling and clip planes continue to evaluate authoritative source
heights.

### Semantic admission gate

Authoritative storage resolves a selected representation to its immutable
`GeometryObject` and validates the three objects together. For built-in entity
types, the canonical representation must contain the corresponding canonical
geometry kind (for example `Point` -> point geometry, `Object3D`/`BimObject` ->
solid geometry). Organizational `Group` and `Layer` entities cannot carry
geometry. Auxiliary roles have explicit geometry meanings: axes and boundaries
are curves, footprints are areas, and bodies are elevation surfaces, spatial
surfaces or solids on entity types that can own such a body.

Every geometric built-in has exactly one primary source: either one
authoritative `Canonical` representation or one opaque `Alternate` imported
fallback. A derived representation must carry the hash of its inputs and can
never claim the canonical role. Imported fallbacks are dependency-free,
alternate, opaque extension geometry; derived alternates may use a different
renderable geometry form without changing the entity's semantic type.

The resolved geometry's compact schema JSON hashes exactly to `geometryRef`.
The entity `versionHash` hashes the complete serialized envelope with
`versionHash` itself omitted; referenced geometry is included transitively by
`geometryRef`. This makes stale envelopes and content-address mismatches fail
before publication instead of surfacing later in the viewer.

The browser-side wire types are generated from these Rust types with the
optional `ts-bindings` feature. The generator owns
`packages/@himmelcad/viewer/src/kernel/generated/`, recursively exports every
type required by `CanonicalEntity` and `GeometryObject`, and emits an exact
literal union for the built-in type identifiers. Its `--check` mode compares a
fresh isolated export byte-for-byte, including the file set, so hand edits and
stale files fail the gate:

```text
cargo run -p himmelcad-core --features ts-bindings --bin generate_entity_bindings
cargo run -p himmelcad-core --features ts-bindings --bin generate_entity_bindings -- --check
```

JavaScript-facing `u64` fields use `number` because the serde JSON wire format
is numeric. Producers must keep those counters within JavaScript's safe integer
range until a later wire-version decision explicitly changes them to decimal
strings.

The viewer's `KernelGeometryObject` is an alias of the generated
`GeometryObject`, and entity, streamed-entity and block-member render requests
all use that alias. The WASM request structs already deserialize the Rust
`GeometryObject` directly, so the browser-to-kernel resolved-geometry boundary
cannot drift into a parallel discriminant list.

The first production importer now implements this boundary directly. LAS/LAZ
preparation produces a content-addressed Potree dataset manifest and returns a
validated `hcad.point-cloud@1` entity, its selected canonical representation,
the resolved streamed geometry and the immutable component/attribute/relation
objects it references. Entity identity is independent from dataset identity.
The browser bootstrap verifies the exact metadata object before the ordinary
registry transaction. Other importers must adopt the same admission contract;
they may not add another renderer-facing entity enum.

Prepared COLMAP triangle meshes, including `mesh.ply`/`texture.png` products,
now cross the same boundary in project dataset listing. The backend emits a
content-addressed prepared dataset identity,
provider identity, a validated resource-backed `hcad.surface-3d@1` admission
(or `hcad.object-3d@1` after closed-manifold proof), and the exact hashed
component/attribute/relation objects. The original PLY or textured directory
remains an export source; it is not mistaken for the renderer-ready hierarchy.

## Consequences

- Mixed-dimensional surveying geometry is represented without invented data.
- Renderers consume representations and do not need PhotoLab or BIM enums.
- Importers can preserve unsupported namespaced components.
- Associative areas, dimensions and alignment-derived geometry have explicit,
  versioned dependencies.
- The existing enum remains only as a migration boundary until all three apps
  consume the generated canonical contracts.

## Required follow-ups

1. Select the default UI suggestion for resolving missing area heights. The
   canonical model itself has no implicit default.
2. Migrate the remaining importers and persisted project snapshot from the
   legacy `EntityKind` boundary to the implemented canonical admission. LAS/LAZ
   and prepared COLMAP meshes already carry `CanonicalEntity`, selected
   `Representation` and resolved `GeometryObject`; the render DTO intentionally
   does not own entity selection.
3. Define migrations for every built-in type identifier and extend the
   semantic admission matrix when new representation roles are accepted.
4. Define when alignment-derived surfaces are materialized as entities.
