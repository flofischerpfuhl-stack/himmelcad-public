# ADR 0018: Canonical import/export provider contract

## Status

Accepted, implementation in progress (2026-07-17).

Clarified by ADR 0021: provider execution, interactive import registration and
unattended PhotoLab batch execution are separate lifecycles.

## Context

The unified viewer and canonical entity registry no longer accept product-owned
legacy entity shapes. Import may be expensive and format-specific, but its
result must enter the project through the same immutable objects, canonical
entity envelopes and prepared-dataset bindings as native authoring. Export must
consume that same semantic package and declare loss explicitly.

The previous `himmelcad-io::Importer` trait returns only a source name and point
count. LAS/Potree already produces a substantially stronger canonical contract,
but that contract is local to the LAS module. Adding DXF, IFC, E57, raster,
mesh and panorama paths on top of the old trait would create incompatible
publication and provenance rules.

## Decision

`himmelcad-io` owns one versioned provider boundary with four layers:

1. A stable provider descriptor declares provider/version identity, exact
   format IDs, extensions, media types and import/export capabilities.
2. Import probing examines a bounded prefix plus path metadata. Selection is
   deterministic; equal-confidence providers are an explicit ambiguity, never
   resolved by registration order.
3. Import execution returns one `CanonicalImportPackage`. The package contains
   complete validated canonical admissions, content-addressed small JSON
   objects, prepared-dataset descriptors whose entity/slot/format/root metadata
   binding is exact, and provider-neutral immutable resource sets for
   non-streamed binary geometry. A resource set carries safe relative paths and
   exact `GeometryResource` descriptors for raster/panorama pixels, depth,
   validity, confidence and connectivity bands, mesh material/texture payloads,
   fonts and equivalent binary resources. Streamed point-cloud, splat and tiled
   mesh metadata remains in prepared datasets. Large artifacts remain
   file/range resources and are never copied into one in-memory result.
4. Export first produces a plan declaring output files, selected entities and
   every lossy conversion. Execution consumes the same canonical package and
   reports progress/cancellation through the common operation context.

The provider does not mutate the active project. A host supplies one source root
for every prepared dataset and resource set. The canonical project store stages
and verifies all JSON objects, resolved geometry, dataset artifacts and resource
set artifacts, synchronizes their inventories, and publishes the entity command
journal record last. A synchronized `ready.json` is the recovery boundary: once
it exists, reopen completes the same journal-last transaction or reports
corruption. Cancellation or failure before that boundary leaves no visible
partial import. Rebuildable render indexes are not canonical unless a canonical
entity representation explicitly binds their immutable descriptor.

Provider code may preserve unsupported source semantics through namespaced
components, attributes, relations and imported-fallback representations. It
may not invent a renderer-only entity model.

An interactive registration host may transform a staged candidate before the
single canonical publication transaction. Providers expose source metadata and
options but never own point picking, CRS dialogs, manual placement or ICP UI.

The DWG provider is built from a pinned `acadrust` source fork under `vendor/`.
MPL-2.0 file-level attribution, a modifications log, bounded parsing and
corpus/fuzz gates are mandatory. The fork publishes only through this package
contract and has no direct entity-store or viewer authority.

The SLPK/I3S provider maps hierarchy nodes, geometry, materials and metadata to
the shared prepared hierarchy and canonical semantics. It renders through the
unified renderer and global residency coordinator; it does not embed or create
a second I3S renderer.

## Invariants

- Provider IDs and format IDs are namespaced and versioned.
- Probe work and prefix size are bounded independently of source size.
- Package entity IDs, object hashes, dataset IDs, resource-set IDs and dataset
  bindings are unique. Resource-set IDs are also unique across the project.
- Every selected geometry validates through ADR 0016 before the package is
  accepted.
- Every streamed geometry's format and root metadata resource equal its
  prepared-dataset binding.
- Every `GeometryResource` reachable from an admitted geometry object is
  traversed. Streamed metadata must be declared by a prepared dataset; every
  other binary resource must be declared exactly by either a dataset artifact
  or a resource set. Required undeclared resources fail closed.
- Resource-set artifacts may be content-address deduplicated only when hash,
  byte length and media type are identical. A resource-set payload not
  referenced by admitted geometry is rejected.
- Relative artifact paths cannot escape their prepared dataset or resource-set
  root. Hashes, exact positive byte lengths and media types are checked before
  project publication.
- Old schema-version-1 packages that omit `resourceSets` deserialize as an
  empty list; this compatibility does not weaken validation of referenced
  geometry.
- Progress is monotone per phase and cancellation is observable in all
  expensive providers.
- Export plans enumerate semantic loss; an undeclared lossy export is invalid.

## Consequences

Existing LAS/Potree output is adapted into the common package first. New
providers can then share atomic publication, provenance, progress, tests and
viewer admission. The same contract covers a shared mesh texture and all bands
of a measurable panorama without pretending either is a streamed dataset.
Format-specific preprocessing remains separate and can use a Rust sidecar or
worker, but no provider gains authority to bypass canonical validation or the
command journal.

## DXF provider boundary

The production ASCII DXF provider pins `dxf-rs`/`dxf` 0.6.1 under MIT. Its
lossless canonical subset covers POINT, LINE, LWPOLYLINE/POLYLINE (including
bulge segments as analytic circular arcs), ARC, CIRCLE, ELLIPSE, SPLINE,
3DFACE, INSERT/BLOCK, TEXT and MTEXT. Simple text becomes canonical
`TextGeometry`; its DXF STYLE font name and metrics are stored as an immutable
font-reference descriptor because DXF commonly references an external SHX or
TTF file instead of embedding font bytes. The exact source entity remains
hash-bound provenance for round-trip preservation of DXF-only text fields.
DIMENSION is retained as a namespaced exact source extension until its
associative anchors and style can be mapped without inventing semantics.

`dxf-rs` 0.6.1 has no HATCH entity implementation. Its REGION value exposes
opaque ACIS custom data rather than reliable boundary loops. The provider
therefore never advertises either as a decoded area: import fails closed with
`hcad.loss.dxf.unsupported-hatch@1` or
`hcad.loss.dxf.opaque-region@1` unless the caller explicitly accepts that
loss, and the accepted loss remains in package provenance and later export
plans. Binary DXF is likewise rejected because a complete unsupported-entity
preflight cannot be guaranteed by this dependency version.

DXF also has no provider-independent slot for Himmel:CAD entity IDs or version
hashes. Every DXF export therefore declares
`hcad.loss.dxf.canonical-identity@1` unless a future extension writes and
revalidates that identity explicitly; geometry/style round-trip equivalence is
not misreported as stable canonical identity.

## GeoTIFF/COG provider boundary

The canonical GeoTIFF provider pins the pure-Rust `geotiff-rust` reader/writer
family at 0.7.0 under MIT/Apache-2.0. Import first streams the complete source
through SHA-256 into a content-addressed immutable resource, then parses that
staged file with explicit IFD/tag/allocation budgets. The canonical
`OrthoGridMapping` addresses pixel centers in source/display `f64` coordinates;
no CRS transformation, axis swap or display placement is invented. Horizontal
and vertical CRS metadata, the normalized affine transform, raster type,
storage layout, overviews, sample layout, compression and exact NoData string
remain in provenance, while the complete GeoKey/TIFF content remains in the
hash-bound source resource.

Raster imagery becomes `RasterImageGeometry`; a caller must explicitly request
`ElevationSurfaceGeometry::Grid` for a single-band DEM because one-band imagery
is not inherently an elevation surface. DEM NoData is accepted only as a finite
numeric sentinel or NaN. Its validity remains part of the authoritative TIFF
band contract and `DiscontinuityAware` sampling; no interpolated bridge across
invalid samples is implied.

TIFF tiles, strips and COG overview IFDs are not expanded during import. The
original file remains locally seekable/range-readable, so later preparation can
read windows or tiles without constructing a package-sized RAM blob. The first
lossless export subset is exact passthrough of one preserved canonical TIFF
resource; its hash and length are verified again during an atomic new-file
write. A synthetic or edited raster without that preserved resource reports
`hcad.loss.geotiff.not-exact-passthrough@1`; multiple raster entities report
`hcad.loss.geotiff.multiple-entities@1` instead of silently selecting one.

## E57 embedded-image boundary

The E57 provider preserves every referenced PNG/JPEG image blob and PNG image
mask byte-for-byte in a canonical resource set. Pinhole representations become
canonical raster images with focal lengths converted from metres to pixels.
Full-coverage spherical representations become equirectangular panoramas only
when both angular pixel sizes were explicitly present in the source XML;
non-full spherical and cylindrical representations retain their exact source
parameters in versioned camera-model objects. Visual-reference images remain
canonical raster entities explicitly marked unprojectable. They are never
silently discarded or assigned fabricated calibration.

`associatedData3DGuid` is copied exactly. A panorama links directly to the
canonical point-cloud entity only when that entity represents the single named
source scan. If several scans were merged for streaming, the exact member GUID
and `hcad.e57.scan-member-not-entity-addressable@1` remain in provenance rather
than claiming an entity-level association. Missing named scans similarly retain
their GUID with `hcad.e57.associated-scan-missing@1`.

An E57 image and an associated station point cloud do not constitute a source
depth map. Imported rasters therefore have no depth field. A future measurable
depth image is an explicit, versioned
`hcad.derivation.e57-station-pointcloud-depth@1` recipe result and must retain
its own algorithm inputs and immutable output resources. Image extraction is
bounded, streamed, cancellable and hash-verified; the complete package is
validated before publication.

## Gaussian-splat PLY boundary

Gaussian-splat PLY import recognizes two complete schemas without field
defaults: INRIA/3DGS (`scale_*` logarithms, WXYZ `rot_*`, logit `opacity`, SH
DC and a complete degree-0..3 `f_rest_*` set) and the Himmel:CAD prepared RGBA8
schema (linear scale, XYZW quaternion and RGBA bytes). Partial schemas,
unknown vertex fields, non-finite values, zero quaternions, invalid SH sets,
list properties and non-vertex payloads fail closed. PLY carries neither CRS
nor pose semantics, so import preserves XYZ exactly and invents no axis, CRS or
placement conversion.

The unchanged source PLY is the authoritative, content-addressed artifact.
Preparation streams it into bounded recursively partitioned PLY tiles and a
`himmelcad-prepared-hierarchy@1` manifest consumed by the global residency
scheduler. Every tile declares conservative f64 bounds, geometric error,
splat count, exact byte length and SHA-256. Internal deterministic samples are
render derivations only. For INRIA input the prepared RGBA approximation uses
the specified degree-zero SH basis and opacity sigmoid; all original SH
coefficients remain byte-exact in the authoritative source for future
view-dependent evaluation.

Import staging, partitioning and hashing are cancellable and unpublished until
the complete canonical package validates. Export is lossless only when the
unchanged authoritative source artifact is still present and verifies by hash
and length; otherwise the plan reports
`hcad.loss.gaussian-splat-ply.not-exact-passthrough@1` rather than silently
exporting a render tile or reduced SH representation.

## IFC/BIM provider boundary

The IFC provider follows buildingSMART IFC 4.3.2.0 rather than treating IFC as
a generic mesh container. In particular, `IfcTriangulatedFaceSet` indices are
one-based and may be redirected through `PnIndex`; `IfcPolygonalFaceSet` faces
may be non-convex and may contain inner loops; mapped representations compose
`IfcRepresentationMap`, `IfcMappedItem` and Cartesian transformation operators;
and georeferencing is explicit through `IfcMapConversion` and
`IfcProjectedCRS`. The normative entity contracts and official examples are:

- https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcTriangulatedFaceSet.htm
- https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcPolygonalFaceSet.htm
- https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcMappedItem.htm
- https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcMapConversion.htm
- https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcExtrudedAreaSolid.htm

`ifc_rs` 0.1.0-alpha.9 is MIT but does not provide the required broad IFC4.3
tessellated, mapping and Civil geometry path. IfcOpenShell's parser/geometry
stack is LGPL-3.0-or-later and therefore excluded by repository policy. The
provider consequently has no IFC geometry dependency. A bounded
ISO-10303-21 record index stores byte offsets, lengths and entity type only;
records are decoded lazily so forward references work without retaining a
second full-model AST in memory. File size, record count, record length,
nesting, per-record values, product count and per-product mesh cardinality have
independent fail-closed budgets.

Every imported `IfcRoot` product uses its valid 22-character `GlobalId` as the
stable canonical identity. `IfcLocalPlacement` chains, spatial containment and
aggregation, property sets/single values, external classifications, IFC class,
units and exact projected-CRS/map-conversion arguments remain hash-bound
canonical metadata. Source coordinates remain display coordinates until an
explicit CRS operation is requested; import never silently applies
`IfcMapConversion`.

The first exact display subset covers IFC4/IFC4.3 triangulated face sets,
polygonal face sets without inner loops, representation maps/mapped items and
rectangle or `IfcPolyline`-bounded `IfcExtrudedAreaSolid`. Non-convex planar
polygons use deterministic ear clipping; indexed faces with voids and geometry
outside that subset are not fan-triangulated or otherwise approximated. The
complete IFC-SPF source is an immutable resource-set payload and the primary
representation remains an `ImportedFallback` bound directly to that source
hash. Exact decoded bodies are additional derived representations. Unsupported
body geometry therefore fails closed unless the caller accepts
`hcad.loss.ifc.unsupported-geometry@1`, after which it remains source-only and
is never presented as a decoded mesh.

Export is initially byte-exact source passthrough with source hash, length,
provider, entity revision and canonical version guards. There is no synthetic
IFC writer hidden behind a lossy plan. A changed or synthetic selection reports
`hcad.loss.ifc.not-exact-source@1` and execution still refuses to invent an IFC
model. The official buildingSMART IFC4 tessellated-item example is retained as
a checksum-pinned CC BY 4.0 parser/placement fixture with attribution in
`LICENSES/THIRD_PARTY.md`.
