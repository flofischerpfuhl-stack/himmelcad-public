# SLPK/I3S import boundary

## Decision

SLPK is an import provider for the shared canonical IO and viewer pipeline. It
does not get an application-specific viewer or renderer.

```text
SLPK (Zip64)
  -> bounded I3S inspection and node-page traversal
  -> per-node mesh/texture/feature conversion
  -> CanonicalImportPackage + PreparedHierarchyManifest
  -> canonical project store
  -> global hierarchy scheduler/cache
  -> the same glTF/material/picking renderer used by other mesh entities
```

The prepared hierarchy is physical streaming metadata, not a second entity
model. Its one canonical entity and representation remain selectable,
measurable, clip-able and visible alongside every other entity.

## Implemented conformance slice

The canonical provider `hcad.io.slpk-i3s@1` targets tiled textured meshes:
I3S store versions 1.7 through 1.10 `IntegratedMesh` and `3DObject` scene
layers using node pages. Each I3S node becomes a shared
`TileDescriptor`; parent/child relations, bounding volumes and LoD thresholds
become the provider-neutral hierarchy fields. Node geometry and selected
texture encodings are converted to immutable glTF/GLB artifacts and therefore
use `ContentKind::Gltf` in the existing renderer.

This first slice consumes the mandatory uncompressed triangle representation
from `geometryDefinitions[].geometryBuffers[0]`. Float32 positions, normals
and UV0 plus RGBA8 vertex colors are mapped to glTF. Per-feature UInt16/32/64
IDs and inclusive face ranges become a local `_FEATURE_ID_0` attribute and
`EXT_mesh_features`; original I3S IDs remain in immutable GLB metadata. PBR
base-color factors and one declared JPEG/PNG base-color texture enter the
common material decoder. Unsupported profiles, Draco-only/non-conforming
geometry, UV-region atlases, DDS/KTX-only textures and non-triangle topology
fail explicitly; they never create a visual-only overlay.

Point and point-cloud I3S profiles are deliberately a separate conformance
slice because they require feature-data or LEPCC decoding rather than the mesh
path. This does not alter the canonical provider or scheduler boundary.

The provider is import-only. SLPK export is not advertised until an independent
application corpus proves store construction, LoD, feature and material
round-trip fidelity.

Primary references (the OGC editions define I3S specification revisions, not
the `layer.version` strings above):

- OGC I3S/SLPK 1.2: <https://docs.ogc.org/cs/17-014r8/17-014r8.html>
- OGC I3S/SLPK 1.3: <https://docs.ogc.org/cs/17-014r9/17-014r9.html>

## Archive safety

Probe reads only the caller-provided bounded prefix. Full import
applies explicit limits to archive/source size, entry count, per-entry and
aggregate uncompressed bytes, compression ratio, JSON depth/size, node count,
texture dimensions and mesh primitives. Absolute paths, parent traversal,
duplicate normalized paths, encrypted entries, special files and unsupported
compression methods are rejected; only ZIP STORE and DEFLATE enter the parser.
Gzip-compressed resources are decompressed
under a second independent limit.

SLPK's optional special hash index is an optimization only. Every artifact
published into Himmel:CAD is SHA-256 verified by the canonical object store;
neither the Zip CRC nor the historical SLPK MD5 index is treated as a trust
boundary.

## Spatial and LoD semantics

- Source spatial reference metadata is preserved. Projected/local coordinates
  enter the shared registration workflow unchanged. WKID 4326 is refused in
  this slice because silently treating degrees as project-world units would be
  spatially wrong; the later geographic slice must supply the explicit shared
  CRS/ECEF transform.
- I3S minimum bounding spheres and oriented boxes map to the viewer's existing
  f64 bounding volumes.
- The source `maxScreenThresholdSQ` value is retained in provider metadata;
  OBB half-size supplies the conservative shared geometric-error value.
- Mesh-pyramid parents use source replacement semantics. Reveal remains stable
  because the shared scheduler keeps a parent until all selected replacement
  children are GPU-ready.
- Texture alternatives are selected by declared capability and transcoded at
  import only when the source encoding cannot enter the common material path.

## Import lifecycle

The provider freezes source SHA-256/length, I3S version, layer profile, CRS,
archive totals, node totals, converter identity and every emitted object hash.
Conversion checks cancellation while hashing, between node pages and between
tiles. Completed GLBs live below a source-content-addressed private root and
are reused only when their exact SHA-256 matches, so a restart resumes safely.
Publication is one canonical import transaction after the prepared hierarchy
validates; a cancelled or invalid conversion exposes no half-imported entity.

## Verification fixtures

The checked-in unit fixture is a real STORE SLPK with projected large
coordinates, a node-page hierarchy, textured uncompressed triangle content and
UInt64 I3S feature metadata. Its gate imports the canonical package, parses the
emitted bytes through `PreparedHierarchySource`, resolves the GLB tile through
the ordinary hierarchy contract, decodes it with `decode_glb_intrinsic`, and
asserts material image plus `EXT_mesh_features` triangle picking. Separate
tests cover bounded probe, STORE, DEFLATE and forced-Zip64 metadata,
independently gzipped JSON resources, path traversal, a compression-ratio bomb,
a truncated central directory, cancellation and exact-hash resume.

Before broadening the advertised slice, add application corpora for multi-page
trees, both common mesh profiles, malformed topology and duplicate normalized
names; the synthetic archive gates above remain necessary but are not a real
producer corpus. Draco, UV-region atlases, geographic CRS, Building/Point/
PointCloud profiles and export each require their own positive conformance
gate; parser success alone does not expand the support claim.
