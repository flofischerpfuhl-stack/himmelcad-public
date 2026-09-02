# ADR 0030: PhotoLab product import package and provenance

## Status

Proposed (architect-reviewed; owner acceptance pending). Drafted 2026-09-02 as
a cite-and-adopt of the Builder program's import-formats contract, section
"PhotoLab product datasets — 2026-09-02", decision records IF-D19 and IF-D22
(`docs/builder-program/specs/import-formats/import-formats.md`). Field names,
hash rules, and states are taken from that contract verbatim; this ADR adds no
design freedom. It admits the shapes that DATA-MODEL pending item 8 lists so
that PhotoLab may publish them and Builder and WeltView may consume them.

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

1. **Package profile.** PhotoLab publication produces a constrained
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

2. **Package hash.** `package_sha256` is the one SHA-256 over the canonical
   manifest payload with only the `package_sha256` member omitted: UTF-8 JSON,
   object keys sorted by UTF-8 byte order, declared array order retained, no
   insignificant whitespace, strings emitted by the shared generated JSON
   serializer, integers in base-10 without leading zeroes, and no
   floating-point manifest values. Because every object, resource, and
   artifact hash is inside that payload, it binds the complete package without
   depending on filesystem enumeration order.

3. **Immutable package truth.** The admission object's semantic body,
   geometry and resource references, type, schema version, and representation
   slots are immutable package truth. ADR 0025 may compose only the host-owned
   destination entity id, destination placement, and the destination
   registration/provenance component named in the reviewed plan; the final
   envelope and version hash are validated before commit. This identity
   composition is recorded in provenance and cannot alter product bytes,
   mapping, topology, sampling, CRS, or package-local ids; it permits a later
   product version to import as a new destination entity without colliding
   with the earlier destination id.

4. **Paths.** Artifact paths are normalized UTF-8 relative POSIX paths. Empty
   or absolute paths, `.` or `..` segments, backslashes, NUL, duplicate
   normalized paths, and platform case-fold collisions are rejected before any
   copy. A declared path must remain under its operation-owned package root
   after canonical resolution; undeclared files are ignored and never staged,
   while a declared missing or changed file fails the operation. Builder
   stages only declared hash-addressed bytes, validates all objects through
   ADR 0016 and ADR 0018, and commits the declared entity plus its provenance
   component in one journal-last transaction.

5. **Publication atomicity.** PhotoLab publication creates a candidate
   package, fsyncs its manifest and declared artifacts, and writes a small
   ready record containing `schema_id`, `manifest_id`, product id and
   version, publication generation, normalized format, manifest hash, lineage
   hash and status, `artifact_count`, `object_count`, `total_bytes`, and
   `package_sha256` last. The product publication record mirrors that summary;
   it and the ready record become visible atomically and must agree. Listing
   reads only this bounded summary. Builder never accepts an inventory
   assembled by walking a product directory after publication.

6. **Lineage payload.** For publications made after this contract exists,
   PhotoLab freezes `ProductLineageV1` (`hcad.photolab-product-lineage@1`)
   before the ready record and product record become visible. The mandatory
   payload is:
   - source project stable id and the exact archive/manifest fingerprint;
   - product entity id, exact entity version and content hash, publication
     generation, kind, label, dataset label, and normalized canonical format
     id;
   - source alignment entity id and exact version/content hash;
   - processing-set choice as the tagged union
     `selected { id, version_hash, membership_sha256 } | none |
all_imported_cameras`, with the frozen camera-selection SHA-256 in every
     case;
   - image-mask scope as `selected { scope_sha256 } | none`;
   - GCP choice as `selected { entity_id, entity_version_hash,
snapshot_sha256 } | none`;
   - the exact source `spatialReference` plus the frozen
     `ProjectReferenceFrame` (`FrozenCrsEndpoint` and
     `establishedByTransformationSha256`), or the explicit `local_frame`
     marker; `unknown` is not legal for a new complete publication;
   - ordered algorithm, configuration, and tool identities, each with stable
     id, version, and configuration/binary hash where applicable; and
   - the accepted registration transform/audit, if one existed at
     publication.

7. **Provenance component.** Builder creates
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

8. **Legacy state.** Records carry an explicit `provenanceStatus`:
   `complete` means every post-contract mandatory field and package hash
   exists and validates; `partial` means at least one trustworthy
   publication-time lineage value exists but one or more mandatory field ids
   are absent; `unknown` means no trustworthy publication-time lineage
   payload exists. Missing fields are mandatory only for post-contract
   publications; legacy absence is not rewritten as corruption. `partial` and
   `unknown` rows list their available facts and exact `missingFieldIds`,
   show "Needs republish/recompute", and cannot register. Builder never reads
   the current alignment, processing set, GCP, masks, CRS, project manifest,
   or tool versions to fill history. Current PhotoLab publications are legacy
   until PhotoLab republishes or recomputes them.

9. **Compatibility.** Compatibility is fail-closed and lossless: an unknown
   manifest major or type id or an unknown `required_features` value returns
   `unsupported_package_schema`; unknown non-required fields in a recognized
   `@1` manifest and lineage payload are not semantic inputs, but the original
   canonical manifest and lineage bytes are retained byte-for-byte through
   import and native archive round-trip. Migration is owned by the shared
   DATA-MODEL/PROJECT-FORMAT canonical-I/O layer, emits a new package and
   provenance revision, preserves the source package, and requires its own
   ADR rule; neither Builder nor PhotoLab privately rewrites an old package in
   place.

10. **Ingress formats.** Only formats the shared render core admits are
    eligible: `potree@2` for sparse and dense point clouds and
    `himmelcad-prepared-hierarchy@1` for DEM (as the canonical
    `ElevationSurfaceGeometry::Grid`) and complete tiled meshes. Orthomosaic
    waits for the raster `PlanGrid2D` admission (RA-D11), Gaussian splats for
    an explicit Pointcloud owner record; binary PLY, unprepared products,
    standalone MVS depth, raw Brush PLY, and the unverified `mesh@1`
    identifier are not emitted or accepted. Eligibility is per product row and
    requires the named entity owner's acceptance; a renderer decoder or an
    inventory label is never semantic admission.

## Release gates

- R1 gate 8 stays open until, for every Available product row, Builder
  registers and reopens the entity, performs canonical Save As to a complete
  `.hcadx`, and WeltView opens that archive read-only through the canonical
  store and kernel, with entity ids, version/content hashes, prepared
  bindings, exact provenance bytes, and the row's render/pick/snap semantics
  compared (IF-D21).
- PhotoLab-side implementation is sequenced in
  `docs/implementation-plans/2026-09-photolab-release-polish.md` (WP-G1a
  publication, WP-G1b Builder/WeltView after the WP-G2 command table,
  WP-G1c gate test).

## Consequences

- PhotoLab publication gains a package/ready-record step and a frozen lineage
  payload for every product; the existing five-field `ProductLineage` becomes
  a projection of `ProductLineageV1`, not a second authority.
- All current PhotoLab publications become `partial` or `unknown` and must be
  republished or recomputed to become registrable; the UI and listing say so
  instead of decorating old bytes.
- The Builder registration island, the generated command table
  (`io.import.product_dataset.list/register`), and WeltView's read-only
  archive path implement the consumer side; none of them may synthesize
  entities or provenance.
- Exporters must either preserve the provenance component through a declared
  extension or report `hcad.loss.photolab-product-provenance@1`; silent drops
  are not allowed.

## Primary references

- `docs/builder-program/specs/import-formats/import-formats.md`, section
  "PhotoLab product datasets — 2026-09-02", IF-D19–IF-D25, and its review
  `import-formats-photolab-review-2026-09-02.md`.
- ADR 0012, ADR 0016, ADR 0018, ADR 0019, ADR 0021, ADR 0025;
  `docs/DECISION-DOCTRINE.md` X1, X2, X3, X7, P5, P11.
- `docs/DATA-MODEL.md` pending admission item 8; `docs/PROJECT-FORMAT.md`
  "Transactional publication" and "Product data".

## Normative document changes proposed

Applied by the Builder program's single writer after review; this ADR does not
edit those files.

**`docs/DATA-MODEL.md` — promote pending item 8.** Remove item 8 from
"Pending data-model admissions" and add under "Immutable resources":

> PhotoLab products are published as `hcad.product-import-package-manifest@1`
> packages carrying a frozen `hcad.photolab-product-lineage@1` payload;
> Builder registration stores it as the read-only
> `hcad.photolab-product-provenance@1` component (exact lineage bytes,
> `lineage_object_sha256`, source `package_sha256`, destination registration
> audit). Records carry `provenanceStatus: complete | partial | unknown`;
> only `complete` rows register. Shapes, hash canonicalization, and states
> are defined by ADR 0030 and import-formats IF-D19/IF-D22.

**`docs/PROJECT-FORMAT.md` — add under "Product data".**

> PhotoLab product publication additionally writes a candidate import package
> (`hcad.product-import-package-manifest@1`) whose manifest and declared
> artifacts are synchronized before a small ready record is written with
> `package_sha256` last; the product publication record mirrors that summary
> and the two become visible atomically. The package binds every object,
> resource, and artifact hash inside its canonical manifest payload, so
> listing reads only the ready summary and never a directory walk. Packages
> are immutable: migration emits a new package and provenance revision and
> preserves the source package (ADR 0030).
