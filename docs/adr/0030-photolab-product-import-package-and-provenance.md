# ADR 0030: PhotoLab product import package and provenance

## Status

Proposed (architect-reviewed; owner acceptance pending). Drafted 2026-09-02 as
a cite-and-adopt of the Builder program's import-formats contract, section
"PhotoLab product datasets — 2026-09-02", decision records IF-D19 and IF-D22
(`docs/builder-program/specs/import-formats/import-formats.md`). Field names,
hash rules, and states are taken from that contract verbatim; this ADR adds no
design freedom. It admits the shapes that DATA-MODEL pending item 8 lists so
that PhotoLab may publish them and Builder and WeltView may consume them.

Scope: this ADR adopts IF-D19, IF-D22, and (revision 4) IF-D26–IF-D34. IF-D20 (generated command-table
rows), IF-D23, IF-D24 and IF-D25 (source locking and pinning, bounded listing
budgets, repeated-registration and update rules, passive consumers, `.hcadx`
WeltView parity) continue to govern unchanged by their record ids in the
import-formats specification; nothing in this ADR restates, abbreviates or
replaces them. Revision 2 (2026-09-02) applies the architect's conformance
check `docs/adr/0030-conformance-check-2026-09-02.md`. Revision 4
(2026-09-02) adopts IF-D26–IF-D34, which close the nine WP-G1a contract
gaps; where a record says "specified above", the spec's shape tables are
adopted by citation without paraphrase. Revision 6 (2026-09-02) replaces every IF-D26–IF-D34 paraphrase with the record's Decision text quoted verbatim under the ADR decision it governs; the ADR keeps only its own framing sentences around those quotes.

## Context

ROADMAP R1 gate 8 requires PhotoLab outputs to open through canonical
contracts in Builder and WeltView. Today Builder registers only `potree@2`
datasets, WeltView opens nothing, and PhotoLab's publication records cannot
supply a complete, immutable lineage (`crates/himmelcad-sidecar/src/
project_runtime.rs` product records; audit 2026-09-01). ADR 0018 requires
provider-neutral, validated canonical packages; ADR 0019 requires journal-last
commits; ADR 0012 requires lineage identity on every product; ADR 0025 owns
interactive registration; doctrine P11 requires product operations to reach
automation through one generated command table. The import-formats contract
defines the package profile and provenance component that connect these; it
states that the profile and component must be admitted by DATA-MODEL,
PROJECT-FORMAT, and an accepted ADR before implementation.

## Decision

1.  **Package profile.** PhotoLab publication produces a constrained
    `CanonicalImportPackage`-like transfer profile under ADR 0018 named
    `hcad.product-import-package-manifest@1`. It is not a product-private
    viewer bridge. The exact R1 shape is:

    ```text
    ProductImportPackageManifestV1 {
      schema_id: "hcad.product-import-package-manifest@1",
      manifest_id,
      producer { product_id, product_version, build_hash,
                 canonical_schema_versions[] },
      source { project_id, project_fingerprint, publication_generation },
      product { entity_id, entity_version_hash, content_hash, kind,
                label, dataset_label },
      lineage { schema_id: "hcad.photolab-product-lineage@1",
                lineage_object_sha256, payload: ProductLineageV1 },
      admissions[{ entity_id, type_id, schema_version,
                   entity_object_path, entity_object_sha256,
                   representation_slots[{ slot, kind, object_sha256 }] }],
      datasets[{ dataset_id, entity_id, slot, format_id, content_kind,
                 root_path, root_sha256, artifact_paths[] }],
      resources[{ resource_id, owner_entity_id, role, object_path,
                  sha256, byte_length, media_type }],
      artifacts[{ path, sha256, byte_length, media_type, role }],
      required_features[],
      counts { object_count, artifact_count, total_bytes },
      package_sha256
    }
    ```

    `admissions` contains the exact canonical entity envelope or objects that
    Builder validates and commits; the product key is not permission to
    synthesize an entity. Dataset `entity_id`, `slot`, `format_id`, and root
    bindings must equal those in the admission object. Every reachable
    non-streamed resource appears once in `resources` and `artifacts`; every
    streamed dataset root and descendant appears once in
    `datasets[].artifact_paths` and `artifacts`. Hashes are SHA-256, lengths
    are exact non-negative byte counts, media types are registered nonempty
    values, and counts equal the complete declared inventory.

2.  **Package hash.** `package_sha256` is the one SHA-256 over the canonical
    manifest payload with only the `package_sha256` member omitted: UTF-8 JSON,
    object keys sorted by UTF-8 byte order, declared array order retained, no
    insignificant whitespace, strings emitted by the shared generated JSON
    serializer, integers in base-10 without leading zeroes, and no floating-point manifest values. Because every object, resource, and
    artifact hash is inside that payload, it binds the complete package without
    depending on filesystem enumeration order.

    Adopted verbatim (import-formats IF-D34, quoted):

    > **Decision:** every logical `f64` in a package manifest or lineage payload, including `FrozenCrsEndpointV1.horizontal.coordinateEpoch.decimalYear`, is a canonical JSON `Decimal64` string: the finite binary64 value's shortest round-tripping, ties-to-even decimal expanded without exponent notation and normalized by the exact rule above. Packages preserve the original lineage bytes and never round, normalize, or write the projected epoch back into the authoritative transformation model.

3.  **Immutable package truth.** The admission object's semantic body,
    geometry and resource references, type, schema version, and representation
    slots are immutable package truth. ADR 0025 may compose only the host-owned
    destination entity id, destination placement, and the destination
    registration/provenance component named in the reviewed plan; the final
    envelope and version hash are validated before commit. This identity
    composition is recorded in provenance and cannot alter product bytes,
    mapping, topology, sampling, CRS, or package-local ids; it permits a later
    product version to import as a new destination entity without colliding
    with the earlier destination id.

4.  **Paths.** Artifact paths are normalized UTF-8 relative POSIX paths. Empty
    or absolute paths, `.` or `..` segments, backslashes, NUL, duplicate
    normalized paths, and platform case-fold collisions are rejected before any
    copy. A declared path must remain under its operation-owned package root
    after canonical resolution; undeclared files are ignored and never staged,
    while a declared missing or changed file fails the operation. Builder
    stages only declared hash-addressed bytes, validates all objects through
    ADR 0016 and ADR 0018, and commits the declared entity plus its provenance
    component in one journal-last transaction.

5.  **Publication atomicity.** PhotoLab publication creates a candidate
    package, fsyncs its manifest and declared artifacts, and writes a small ready record, `ProductImportPackageReadyRecordV1` (schema id `hcad.product-import-package-ready@1`), whose members are exactly `schema_id`, `manifest_id`, `product_id`, `product_version_hash`, `publication_generation`, `normalized_format_id`, `manifest_sha256`, `lineage_object_sha256`, `provenance_status`, `missing_field_ids`, `artifact_count`, `object_count`, `total_bytes`, and `package_sha256`, the last written last. The product publication record mirrors that summary;
    it and the ready record become visible atomically and must agree. Listing
    reads only this bounded summary. Builder never accepts an inventory
    assembled by walking a product directory after publication.

    Adopted verbatim (import-formats IF-D29, quoted):

    > **Decision:** `publication_generation` is the checked next PhotoLab journal command sequence and is identical in lineage, manifest, ready record, publication record, and committed journal entry. `publication_id` and a non-null package's `manifest_id` equal `"product-" + sha256(canonical_json([source_project_id, product_entity_id, product_entity_version_hash, publication_generation]))`. The ready record uses `hcad.product-import-package-ready@1`; dataset ids are copied from admitted prepared datasets; resource ids equal their SHA-256; and resource/artifact roles use only the closed role enumerations above.

6.  **Lineage payload.** For publications made after this contract exists, PhotoLab freezes `ProductLineageV1` (`hcad.photolab-product-lineage@1`) before the ready record and product record become visible. Its serialized shape is IF-D26, quoted below. The mandatory payload is:
    - source project stable id and the exact archive/manifest fingerprint;
    - product entity id, exact entity version and content hash, publication generation, kind, label, dataset label, and `source_format`; `normalized_format_id` is optional (`?`): present exactly when a canonical prepared format is known, otherwise omitted without making the publication incomplete;
    - source alignment entity id and exact version/content hash;
    - processing-set choice as the tagged union `selected { id, version_hash, membership_sha256 } | none | all_imported_cameras`, with the frozen camera-selection SHA-256 in every case;
    - image-mask scope as `selected { scope_sha256 } | none`;
    - GCP choice as `selected { entity_id, entity_version_hash, snapshot_sha256 } | none`;
    - the exact source `spatialReference` plus the frozen `ProjectReferenceFrame` (`FrozenCrsEndpoint` and `establishedByTransformationSha256`), or the explicit `local_frame` marker; `unknown` is not legal for a new complete publication;
    - `algorithms`, `configurations`, and `tools` as always-present ordered identity arrays of `ProductLineageIdentityV1 { id: string, sha256: Sha256 }`, repeated invocations kept as repeated entries; and
    - the accepted registration transform/audit, if one existed at publication.

    Adopted verbatim (import-formats IF-D26, quoted):

    > **Decision:** `ProductLineageV1` uses the exact field identifiers, JSON primitive types, tagged unions, and `ProductLineageIdentityV1 { id: string, sha256: Sha256 }` shape specified above. `algorithms`, `configurations`, and `tools` are always-present ordered identity arrays; repeated invocations remain repeated entries. A `?` member is omitted, never `null`, and every unmarked member is present.

7.  **Provenance component.** Builder creates
    `hcad.photolab-product-provenance@1` as a hash-bound envelope containing
    the exact lineage payload bytes, `lineage_object_sha256`, the source
    `package_sha256`, and the destination registration audit. It does not
    deserialize and reserialize away unknown optional fields. Properties and
    automation expose a read-only projection plus the exact component hash;
    generic property mutation rejects the component. For a complete
    publication, reopen, update, export, Properties, automation, and WeltView
    read the component verbatim; a newer CRS database, renamed source entity,
    changed GCP revision, later alignment, or missing source cannot change the
    meaning or bytes of the registered product.

8.  **Legacy state.** Records carry an explicit `provenanceStatus`:
    `complete` means every post-contract mandatory lineage field exists and
    validates, whether or not an import package exists (IF-D33); `partial` means at least one trustworthy
    publication-time lineage value exists but one or more mandatory field ids
    are absent; `unknown` means no trustworthy publication-time lineage
    payload exists. Missing fields are mandatory only for post-contract
    publications; legacy absence is not rewritten as corruption. `partial` and
    `unknown` rows list their available facts and exact `missingFieldIds`,
    show "Needs republish/recompute", and cannot register. Builder never reads
    the current alignment, processing set, GCP, masks, CRS, project manifest,
    or tool versions to fill history. Current PhotoLab publications are legacy until PhotoLab republishes or recomputes them. Missing-field ids (IF-D27), reason codes (IF-D28), and resident lineage without a package (IF-D33) are quoted below.

    Adopted verbatim (import-formats IF-D27, quoted):

    > **Decision:** `missing_field_ids` and its `missingFieldIds` projection contain only exact `ProductLineageV1` serialized member ids: top-level ids, dot paths for members of present objects, and zero-based bracket paths for members of present array items. Whole missing arrays use only their top-level id; inapplicable conditionals are not missing; values with invalid types or shapes are invalid rather than missing; the list is de-duplicated and UTF-8-byte-order sorted.

    Adopted verbatim (import-formats IF-D28, quoted):

    > **Decision:** the only reason codes are `available`, `needs_republish_recompute`, `needs_preparation`, `no_package`, `unsupported_format`, `invalid_package`, and `unsupported_package_schema`, with the disposition, meaning, precedence, and required base copy in the table above. UI may only append a product label or diagnostic id; it may not replace the base sentence or derive copy from an unknown string.

    Adopted verbatim (import-formats IF-D33, quoted):

    > **Decision:** every post-contract publication writes the complete hash-bound lineage envelope in `PhotoLabProductPublicationRecordV1`; if no package exists, the required member is exactly `package: null`, with no fabricated manifest id or zero hash. The legacy five-field relation is only a read-only projection and can produce `partial` or `unknown`, never `complete` or reconstructed history.

9.  **Compatibility.** Compatibility is fail-closed and lossless: an unknown
    manifest major or type id or an unknown `required_features` value returns
    `unsupported_package_schema`; unknown non-required fields in a recognized
    `@1` manifest and lineage payload are not semantic inputs, but the original
    canonical manifest and lineage bytes are retained byte-for-byte through
    import and native archive round-trip. Migration is owned by the shared
    DATA-MODEL/PROJECT-FORMAT canonical-I/O layer, emits a new package and
    provenance revision, preserves the source package, and requires its own
    ADR rule; neither Builder nor PhotoLab privately rewrites an old package in
    place.

10. **Publication and canonical-format dispositions (IF-D19, restated
    row by row).** PhotoLab's `ProjectProductDatasetRecord.format` values
    are inventory labels, not canonical prepared-dataset `formatId` values.
    Registration validates and normalizes an eligible label to one of the
    exact canonical formats below; it never passes a UI label into the
    renderer as a guessed format id.

    | PhotoLab publication / candidate format                    | Resulting canonical entity and sibling owner                                                    | Disposition                                                                                                                                                   |
    | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `potreeV2` sparse point cloud                              | `hcad.point-cloud@1`; Pointcloud                                                                | Eligible after package/provenance admission and Pointcloud acceptance; not implementation-ready; normalized to `potree@2`                                     |
    | `potreeV2` prepared dense point cloud                      | `hcad.point-cloud@1`; Pointcloud                                                                | Eligible after package/provenance admission and Pointcloud acceptance; not implementation-ready; normalized to `potree@2`                                     |
    | `binaryPly` dense fallback                                 | none until prepared                                                                             | Deferred — not a prepared dataset and no canonical non-splat PLY dataset admission exists in the current render path; the chooser reports "Needs preparation" |
    | `rasterPyramid` DEM                                        | `hcad.elevation-surface@1` with `ElevationSurfaceGeometry::Grid`; Raster                        | Eligible after package/provenance admission and Raster acceptance; not implementation-ready                                                                   |
    | `rasterPyramid` orthomosaic                                | `hcad.raster-image@1`; Raster RA-D11                                                            | Needs canonical `PlanGrid2D` admission; not implementation-ready until RA-D11's DATA-MODEL/generated-reader delta lands                                       |
    | `tiledMesh` with `preparedMesh.canonicalDataset`           | `hcad.surface-3d@1`, or `hcad.object-3d@1` when the verified topology is closed; Mesh & Terrain | Eligible after package/provenance admission and Mesh acceptance; not implementation-ready; using `himmelcad-prepared-hierarchy@1`                             |
    | legacy `tiledMesh` without that complete prepared contract | none                                                                                            | Deferred — a legacy display manifest is not a complete ADR 0018 canonical package; registration fails closed                                                  |
    | `mvsDepth`                                                 | none as a standalone Builder product                                                            | Deferred — a PhotoLab MVS artifact index, not a render-core prepared-dataset format; may remain a lineage input                                               |

    | Gaussian-splat `prepared` | `hcad.gaussian-splat-cloud@1`; Pointcloud (authoritative arrival ownership at `docs/builder-program/specs/pointcloud/pointcloud.md:65-74`; IF-D31) | Eligible after the data-model and package/provenance admission; no unresolved owner choice remains |
    | Gaussian-splat `brushPly` | none until prepared | Deferred — a monolithic fallback is not interaction-ready prepared data |
    | canonical `potree@2` | point-cloud rows above | Eligible ingress format after package admission; not a product disposition by itself |
    | canonical `himmelcad-prepared-hierarchy@1` | eligible raster, mesh, and Pointcloud-owned prepared-splat rows above; gated by matching canonical geometry and content kind | Eligible ingress format after package admission; not blanket adoption |
    | claimed canonical `mesh@1` | none | Deferred as an unverified identifier; do not emit or accept it |
    | published overlap or shared-control merged alignment | `hcad.point-cloud@1`; Pointcloud | Ordinary product-import manifest as any eligible `potree@2` point cloud with ordered merge lineage (IF-D32, quoted below) |

    All otherwise eligible rows remain unavailable until the common
    package/provenance admission and their named owner acceptance land; they
    are not independently Adopted product rows.

    Adopted verbatim (import-formats IF-D30, quoted):

    > **Decision:** `product_kind: "dem"` requires `PhotoLabDemFactsV1` with `elevationZ`, exact `RasterInterpolation`, exact `RasterConnectivity`, explicit source NoData semantics, the mandatory validity resource, and a connectivity resource for mask connectivity. The canonical Grid and prepared Raster root bind the same facts and resources. Until all are frozen, the publication has `package: null` and is not Available.

    Adopted verbatim (import-formats IF-D31, quoted):

    > **Decision:** the Pointcloud specification's PhotoLab-arrival registry row is authoritative for `hcad.gaussian-splat-cloud@1`. A prepared splat becomes eligible only after common data-model and package/provenance admission; no owner choice remains. ADR 0030 Decision 10 revision 4 must follow that registry row and remove revision 3's stale unresolved-owner wording.

    Adopted verbatim (import-formats IF-D32, quoted):

    > **Decision:** a published overlap or shared-control merged alignment uses the same product-import manifest as every other eligible `potree@2` point cloud. Its lineage identifies the merge entity with id, version hash, and `lineage_sha256`, and `source_alignment_inputs` contains at least two `{id, sha256}` identities in published input-alignment order. V1 does not represent a mixed overlap/shared-control merge.

### IF-D19 validation constraints (restated)

- DEM: the admission object must declare `Grid { raster: GeometryResource, mapping: OrthoGridMapping, sampling: DepthSampling }`. The immutable height/validity resource includes hash, media type, and byte length; mapping carries finite source pixel-center origin, column, and row vectors; sampling explicitly carries `ElevationZ`, interpolation, and connectivity/NoData semantics. Nothing is inferred. Its representation slot binds the same entity and grid resource to a hash-verified `himmelcad-prepared-hierarchy@1` Raster root. This is the existing canonical Grid shape and Raster-owned behavior, not a second Import model.
- Orthomosaic: the only R1 arrival is `RasterImageGeometry` plus `RasterMapping::PlanGrid2D`, carrying the source pixel-grid affine XY transform, frozen CRS, no depth, no entity placement, and `z: null`. A zero-height orthomosaic `OrthoGrid` is rejected; `PlanGrid2D` has no Z, depth, or placement authority.
- Prepared hierarchy: `himmelcad-prepared-hierarchy@1` is not blanket permission to accept arbitrary contents. Validation requires the canonical entity kind, representation slot, geometry/resource hash, root manifest, every referenced artifact, and every tile `ContentKind` to agree. Unsupported or mixed semantics fail before review; registration never relabels Raster, glTF mesh, or GaussianSplats content.
- A renderer decoder or an inventory label is never semantic admission. Complete lineage is captured by PhotoLab at publication and copied byte-for-byte; Builder never reconstructs missing history.
- DEM package facts: IF-D30, quoted under Decision 10.

## Release gates

IF-D21 governs R1 gate 8 and is restated here in full: the gate is not
satisfied by PhotoLab publication or a PhotoLab viewer. For every then-Available
product row, Builder registers and reopens the entity, performs canonical
FP-D3 Save As to a complete `.hcadx`, and WeltView opens that archive
read-only through the canonical store/kernel path. The gate compares entity
ids, version/content hashes, prepared bindings, exact provenance bytes, and
the row's render/pick/snap/no-coordinate semantics. Direct access to Builder's
mutable `.hcad` and R3 network/range-publication choices are out of scope.
Every renderable product kind in the PhotoLab release must reach Available;
missing owner or admission work cannot be used to remove it from the gate.
PhotoLab-side implementation is sequenced in
`docs/implementation-plans/2026-09-photolab-release-polish.md` (WP-G1a
publication, WP-G1b Builder/WeltView after the WP-G2 command table, WP-G1c
gate test).

## Consequences

- PhotoLab publication gains a package/ready-record step and a frozen lineage payload for every product; the existing five-field product lineage record is only a read-only projection (IF-D33, quoted under Decision 8).
- All current PhotoLab publications become `partial` or `unknown` and must be republished or recomputed to become registrable; the UI and listing say so instead of decorating old bytes.
- The consumer side — generated command-table rows, source acquisition and pinning, listing budgets, repeated registration and update rules, passive consumers, and `.hcadx` WeltView parity — is governed by import-formats IF-D20, IF-D23, IF-D24, and IF-D25 as written there; this ADR neither restates nor modifies them.

## Primary references

- `docs/builder-program/specs/import-formats/import-formats.md`, section
  "PhotoLab product datasets — 2026-09-02", IF-D19–IF-D25, IF-D26–IF-D34 (the
  WP-G1a contract-gap dispositions), and its review
  `import-formats-photolab-review-2026-09-02.md`.
- ADR 0012, ADR 0016, ADR 0018, ADR 0019, ADR 0021, ADR 0025;
  `docs/DECISION-DOCTRINE.md` X1, X2, X3, X7, P5, P11.
- `docs/DATA-MODEL.md` pending admission item 8; `docs/PROJECT-FORMAT.md`
  "Transactional publication" and "Product data".

## Normative document changes

Applied by the Builder program's single writer on 2026-09-02 after review of this ADR; this ADR does not edit those files.

`docs/DATA-MODEL.md`, "Immutable resources" (pending item 8 promoted), now reads:

> PhotoLab products are published as `hcad.product-import-package-manifest@1` packages (package id + version; per-dataset prepared format) carrying a frozen `hcad.photolab-product-lineage@1` payload (alignment id + hash, GCP revision + snapshot hash, frozen CRS). Builder registration stores it as the read-only `hcad.photolab-product-provenance@1` component (exact lineage bytes, `lineage_object_sha256`, source `package_sha256`, destination registration audit). Records carry `provenanceStatus: complete | partial | unknown`; legacy publications may only be `partial` or `unknown`, and registration behavior per status follows import-formats IF-D19 (missing provenance is surfaced, never silently downgraded). The chain is PhotoLab publishes → Builder registers → WeltView reads the registered product read-only from the project or its `.hcadx` archive. Shapes, hash canonicalization, and states are defined by ADR 0030 (Proposed, owner acceptance pending) and import-formats IF-D19/IF-D22.

`docs/PROJECT-FORMAT.md`, "Product data": the candidate-package, ready-record (`package_sha256` last), atomic-visibility, ready-summary-only listing, and package-immutability paragraph proposed by revision 1 of this ADR, applied unchanged.
