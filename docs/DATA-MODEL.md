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

PhotoLab products are published as `hcad.product-import-package-manifest@1`
packages (package id + version; per-dataset prepared format) carrying a
frozen `hcad.photolab-product-lineage@1` payload (alignment id + hash, GCP
revision + snapshot hash, frozen CRS). Builder registration stores it as the
read-only `hcad.photolab-product-provenance@1` component (exact lineage
bytes, `lineage_object_sha256`, source `package_sha256`, destination
registration audit). Records carry `provenanceStatus: complete | partial |
unknown`; legacy publications may only be `partial` or `unknown`, and
registration behavior per status follows import-formats IF-D19 (missing
provenance is surfaced, never silently downgraded). The chain is
PhotoLab publishes → Builder registers → WeltView reads the registered
product read-only from the project or its `.hcadx` archive. Shapes, hash
canonicalization, and states are defined by ADR 0030 (Proposed, owner
acceptance pending) and import-formats IF-D19/IF-D22.

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

## Pending data-model admissions

ADR 0031 (Proposed) proposes the Release 0.5 subset of these admissions (items 1 basic profile, 3 0.5 profile, 5, 6, 7 without offset/parallel, 11, 12) and defers the rest; see `docs/adr/0031-release-0-5-data-model-admissions.md`.

Status: admitted as pending decisions by the Builder completion program
(registry 2026-09-02). These are not ADRs and do not authorize
implementation. Until their ADRs define schema versions, invariants,
migrations, persistence, undo/redo, cancellation/restart, and compatibility
bounds, specifications may define command/query contracts, but
implementation must not invent or persist substitute domain truth.

1. `hcad.measurement@1` — canonical saved measurement geometry with exact
   anchors, measurement plane, verification/provenance state, and role
   migration (measure-inspect spec).
2. Edit-lock component — canonical entity edit lock, distinct from layer
   lock, with effective-editability resolution and command rejection
   semantics (select-edit spec).
3. ViewState v2 — entity-referenced clips, pinned Plan-viewport state,
   independent visibility/filter predicates, update policy, exact captured
   revisions (view-domain and plan-editor specs).
4. Plan root — canonical project-root sheets, elements, viewports, bindings,
   schedules, libraries, and revision/CAS rules (plan-editor spec).
5. Snapshot markers — named project snapshot markers over journal
   generations, including restore linkage and retention semantics
   (file-project spec).
6. `hcad.derived-recipe@1` — the recipe component of derived entities
   (sources by id + revision + parameters, linked/detached state, last
   regeneration, DAG constraints) per doctrine P10 and mesh-terrain
   MT-D25; and `hcad.mesh-source-roles@1` — boundary / breakline / form-line
   / exclusion roles of surface sources (mesh-terrain spec).
7. Point-acquisition provenance (how a point was acquired: pick, typed,
   3D-target estimate, field code — draw DR-D21), a support-role component
   (defining points/lines of higher-order entities, draw/select-edit), and
   the offset/parallel recipe schema (a `hcad.derived-recipe@1` profile,
   draw).
8. (Promoted 2026-09-02 to ADR 0030, Proposed — see "Immutable
   resources".)
9. Journal actor metadata and Agent batch/root records — so an agent turn
   groups child commands, preserves per-command author/audit identity,
   resumes after restart, and retains heavy-undo inputs, while preserving
   human/SDK/agent command equivalence; transcript state never becomes
   project authority (agent spec).

## Release 0.5 admitted substrate

ADR 0031 authorizes the producer-narrow Release 0.5 contracts implemented by
`himmelcad-core::release_05_admissions`: basic Measurement and snapshot-marker
built-ins; ViewState v2 clip references and presentation; the shared derived
recipe and Mesh source-role resource; point-acquisition and support-role
components; curve-subentity references; and three independently stored local
history streams. Unknown future versions are retained only for read-only
forwarding or rejected for writable open. Absence remains absence.

The deferred profiles listed by ADR 0031 remain outside the built-in admission
and automation tables even where a shared envelope could technically carry
their bytes.
