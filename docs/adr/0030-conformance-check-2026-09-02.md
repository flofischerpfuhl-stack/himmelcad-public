# ADR 0030 conformance check — 2026-09-02

Document class: report / verification evidence

Review date: 2026-09-02

Review target: `docs/adr/0030-photolab-product-import-package-and-provenance.md`

Authoritative comparison text: `docs/builder-program/specs/import-formats/import-formats.md`, section “PhotoLab product datasets — 2026-09-02,” including IF-D19–IF-D25

Method: static documentation comparison against the current working-tree text; no ADR or specification was edited

## Verdict

**Non-conformant.**

The manifest shape, package-hash canonicalization, safe-path rules, publication
atomicity, lineage payload, provenance envelope, legacy-state definitions, and
fail-closed compatibility rules are exact copies or strict restatements of the
specification. The ADR nevertheless fails the required zero-design-freedom
standard because it:

1. changes several Deferred or Needs-preparation formats into a broader
   producer-and-consumer prohibition (“not emitted or accepted”);
2. adds an authority/migration rule for the existing five-field
   `ProductLineage` that the specification does not state;
3. does not carry forward all non-tunable IF-D19 constraints, most notably the
   exact DEM binding and the explicit zero-height orthomosaic rejection;
4. restates IF-D21 without its guard that every renderable PhotoLab release
   product must become Available and that missing owner/admission work cannot
   shrink R1 gate 8; and
5. proposes replacing DATA-MODEL pending item 8 with a shorter paragraph that
   is compatible with the specification but drops several architect-written
   admission particulars from the DATA-MODEL text itself.

These are normative scope and disposition differences, not spelling-only
differences. The ADR must be corrected before acceptance.

## Comparison conventions

- **Match** means verbatim or a strict restatement with no additional choice.
- **Partial** means the ADR is compatible but omits a constraint needed to
  preserve the specification's closed decision.
- **Divergence** means the ADR adds, weakens, or changes a rule.
- In the manifest pseudo-schema, absence of `?` is treated as required in both
  documents. Neither document assigns primitive scalar types to most fields;
  the ADR therefore matches the specification's stated type information but
  does not make it more precise.
- `ProductLineageV1` is specified as a mandatory prose payload rather than a
  serialized pseudo-schema. The names in that table are the specification's
  own terms, not inferred wire identifiers.

## Field-by-field comparison

### `ProductImportPackageManifestV1`

| Spec name / shape | ADR name / shape | Result |
| --- | --- | --- |
| `ProductImportPackageManifestV1` | `ProductImportPackageManifestV1` | Match |
| `schema_id: "hcad.product-import-package-manifest@1"` | Same literal field and value | Match |
| `manifest_id` | `manifest_id` | Match |
| `producer` object | `producer` object | Match |
| `producer.product_id` | `producer.product_id` | Match |
| `producer.product_version` | `producer.product_version` | Match |
| `producer.build_hash` | `producer.build_hash` | Match |
| `producer.canonical_schema_versions[]` | Same array | Match |
| `source` object | `source` object | Match |
| `source.project_id` | `source.project_id` | Match |
| `source.project_fingerprint` | `source.project_fingerprint` | Match |
| `source.publication_generation` | `source.publication_generation` | Match |
| `product` object | `product` object | Match |
| `product.entity_id` | `product.entity_id` | Match |
| `product.entity_version_hash` | `product.entity_version_hash` | Match |
| `product.content_hash` | `product.content_hash` | Match |
| `product.kind` | `product.kind` | Match |
| `product.label` | `product.label` | Match |
| `product.dataset_label` | `product.dataset_label` | Match |
| `lineage` object | `lineage` object | Match |
| `lineage.schema_id: "hcad.photolab-product-lineage@1"` | Same literal field and value | Match |
| `lineage.lineage_object_sha256` | Same field | Match |
| `lineage.payload: ProductLineageV1` | Same field and referenced shape | Match |
| `admissions[]` | `admissions[]` | Match |
| `admissions[].entity_id` | Same field | Match |
| `admissions[].type_id` | Same field | Match |
| `admissions[].schema_version` | Same field | Match |
| `admissions[].entity_object_path` | Same field | Match |
| `admissions[].entity_object_sha256` | Same field | Match |
| `admissions[].representation_slots[]` | Same array | Match |
| `admissions[].representation_slots[].slot` | Same field | Match |
| `admissions[].representation_slots[].kind` | Same field | Match |
| `admissions[].representation_slots[].object_sha256` | Same field | Match |
| `datasets[]` | `datasets[]` | Match |
| `datasets[].dataset_id` | Same field | Match |
| `datasets[].entity_id` | Same field | Match |
| `datasets[].slot` | Same field | Match |
| `datasets[].format_id` | Same field | Match |
| `datasets[].content_kind` | Same field | Match |
| `datasets[].root_path` | Same field | Match |
| `datasets[].root_sha256` | Same field | Match |
| `datasets[].artifact_paths[]` | Same array | Match |
| `resources[]` | `resources[]` | Match |
| `resources[].resource_id` | Same field | Match |
| `resources[].owner_entity_id` | Same field | Match |
| `resources[].role` | Same field | Match |
| `resources[].object_path` | Same field | Match |
| `resources[].sha256` | Same field | Match |
| `resources[].byte_length` | Same field | Match |
| `resources[].media_type` | Same field | Match |
| `artifacts[]` | `artifacts[]` | Match |
| `artifacts[].path` | Same field | Match |
| `artifacts[].sha256` | Same field | Match |
| `artifacts[].byte_length` | Same field | Match |
| `artifacts[].media_type` | Same field | Match |
| `artifacts[].role` | Same field | Match |
| `required_features[]` | `required_features[]` | Match |
| `counts` object | `counts` object | Match |
| `counts.object_count` | Same field | Match |
| `counts.artifact_count` | Same field | Match |
| `counts.total_bytes` | Same field | Match |
| `package_sha256` | `package_sha256` | Match |

All shown manifest members have the same requiredness. Array/object structure,
literal schema identifiers, and `ProductLineageV1` reference are unchanged.

### Manifest field invariants

| Spec rule | ADR rule | Result |
| --- | --- | --- |
| `admissions` contains exact canonical envelope/object(s), not permission to synthesize an entity | Same rule | Match |
| Dataset entity/slot/format/root bindings equal the admission object | Same rule | Match |
| Every reachable non-streamed resource occurs once in both `resources` and `artifacts` | Same rule | Match |
| Every streamed root and descendant occurs once in `datasets[].artifact_paths` and `artifacts` | Same rule | Match |
| Hashes are SHA-256 | Same rule | Match |
| Lengths are exact non-negative byte counts | Same rule | Match |
| Media types are registered, nonempty values | Same rule | Match |
| Counts equal the complete declared inventory | Same rule | Match |
| Admission semantic body, references, type, schema version, and slots are immutable package truth | Same rule | Match |
| Host may compose only destination entity id, placement, and reviewed registration/provenance component | Same rule | Match |
| Final envelope and version hash validate before commit | Same rule | Match |
| Composition cannot alter bytes, mapping, topology, sampling, CRS, or package-local ids | Same rule | Match |

### `ProductLineageV1`

The specification does not give serialized field identifiers or primitive
types for this payload. It gives mandatory semantic fields and exact tagged
unions. The ADR repeats that level of definition; it must not be treated as
permission for an implementation to choose wire names independently.

| Spec name / required shape | ADR name / required shape | Result |
| --- | --- | --- |
| Source project stable id | Same term | Match |
| Exact source archive/manifest fingerprint | Same term | Match |
| Product entity id | Same term | Match |
| Exact product entity version | Same term | Match |
| Product content hash | Same term | Match |
| Publication generation | Same term | Match |
| Product kind | Same term | Match |
| Product label | Same term | Match |
| Dataset label | Same term | Match |
| Normalized canonical format id | Same term | Match |
| Source alignment entity id | Same term | Match |
| Exact alignment version/content hash | Same term | Match |
| Processing-set union | Same tagged union | Match |
| `selected { id, version_hash, membership_sha256 }` | Same tag and fields | Match |
| `none` | Same enum value | Match |
| `all_imported_cameras` | Same enum value | Match |
| Frozen camera-selection SHA-256 in every processing-set case | Same rule | Match |
| Image-mask `selected { scope_sha256 }` | Same tag and field | Match |
| Image-mask `none` | Same enum value | Match |
| GCP `selected { entity_id, entity_version_hash, snapshot_sha256 }` | Same tag and fields | Match |
| GCP `none` | Same enum value | Match |
| Exact source `spatialReference` | Same term | Match |
| Frozen `ProjectReferenceFrame` | Same term | Match |
| `FrozenCrsEndpoint` | Same term | Match |
| `establishedByTransformationSha256` | Same field spelling | Match |
| Explicit `local_frame` marker alternative | Same enum marker | Match |
| `unknown` forbidden for a new complete publication | Same rule | Match |
| Ordered algorithm identities with stable id/version/hash where applicable | Same rule | Match |
| Ordered configuration identities with stable id/version/hash where applicable | Same rule | Match |
| Ordered tool identities with stable id/version/hash where applicable | Same rule | Match |
| Accepted registration transform/audit, if one existed at publication | Same optional condition | Match |

### Provenance component and state fields

| Spec name / shape | ADR name / shape | Result |
| --- | --- | --- |
| Component id `hcad.photolab-product-provenance@1` | Same literal id | Match |
| Exact lineage payload bytes | Same content | Match |
| `lineage_object_sha256` | Same field | Match |
| Source `package_sha256` | Same field | Match |
| Destination registration audit | Same content | Match |
| Unknown optional fields retained rather than lost through reserialization | Same rule | Match |
| Read-only Properties/automation projection plus exact component hash | Same rule | Match |
| Generic property mutation rejects the component | Same rule | Match |
| `provenanceStatus` | Same field spelling | Match |
| `complete` | Same enum and definition: all post-contract mandatory fields and package hash exist and validate | Match |
| `partial` | Same enum and definition: at least one trustworthy publication-time fact exists and mandatory field ids are missing | Match |
| `unknown` | Same enum and definition: no trustworthy publication-time lineage payload exists | Match |
| `missingFieldIds` | Same field spelling and exact-list requirement | Match |
| **Needs republish/recompute** | Same disposition text | Match |

The command schema elsewhere in the specification uses the wire spelling
`provenance_status` and `missing_field_ids[]`; ADR 0030 does not reproduce that
command schema and does not define a conflicting spelling. Its record-level
spellings match the publication/legacy-state section it adopts.

## IF-D19 rule-by-rule conformance

| IF-D19 rule | ADR treatment | Result |
| --- | --- | --- |
| `potree@2` and validated `himmelcad-prepared-hierarchy@1` are eligible only after IF-D22 admission and owner acceptance | Package admission is adopted; owner acceptance is required per row | Match |
| Eligible ingress formats are not independently Adopted product rows | ADR calls eligibility per product row but does not explicitly retain “not independently Adopted” | Partial |
| DEM uses the exact canonical Grid shape | ADR names `ElevationSurfaceGeometry::Grid` but omits `Grid { raster: GeometryResource, mapping: OrthoGridMapping, sampling: DepthSampling }`, immutable resource metadata, pixel-center vectors, `ElevationZ`, interpolation, connectivity/NoData, and matching prepared binding | Partial |
| Orthomosaic requires RA-D11 `PlanGrid2D` | ADR says it waits for `PlanGrid2D` admission | Match |
| Zero-height `OrthoGrid` is rejected | Not stated | Omission |
| Gaussian splat remains Deferred pending Pointcloud ownership | Same owner gate | Match |
| Prepared splat also remains gated by package/provenance admission and uses prepared hierarchy only after ownership | Package admission is global, but the ADR does not explicitly bind a future admitted splat to `himmelcad-prepared-hierarchy@1` | Partial |
| `binaryPly` remains unavailable to registration and is **Needs preparation** | ADR groups binary PLY under “not emitted or accepted” | Divergence: consumer deferral is broadened into an unsupported producer prohibition |
| Unprepared products remain unavailable to registration / Deferred | ADR says they are “not emitted or accepted” | Divergence: “not emitted” is not in IF-D19 |
| Standalone `mvsDepth` remains unavailable as a Builder product but may remain lineage input | ADR says standalone MVS depth is “not emitted or accepted” | Divergence: it drops the allowed lineage-input role and adds a producer prohibition |
| Raw `brushPly` remains Deferred until prepared | ADR says raw Brush PLY is “not emitted or accepted” | Divergence: “not emitted” is not in IF-D19 |
| Unverified `mesh@1` is Deferred and must not be emitted or accepted | Same prohibition | Match |
| Legacy/`partial`/`unknown` provenance remains unavailable to registration | ADR says `partial` and `unknown` cannot register | Match |
| Complete lineage is captured at publication | Same rule | Match |
| Complete lineage is copied byte-for-byte | Same rule | Match |
| Builder never reconstructs missing history | Same rule, including the prohibited current-state sources | Match |
| Legacy `partial`/`unknown` is visibly **Needs republish/recompute** | Same rule | Match |
| A renderer decoder or inventory label is not semantic admission | Same rule | Match |
| PhotoLab-format branching is rejected | The package is explicitly not a product-private viewer bridge, but format-branch rejection is not stated | Partial |
| Reading current alignment/GCP/CRS to decorate old bytes is rejected | Same prohibition, broadened consistently to processing set, masks, manifest, and tools already named by the detailed spec | Match |
| Partial or viewer-only entities are rejected | Partial provenance cannot register; viewer-only entities are not explicitly rejected | Partial |
| Claiming `mesh@1` from a test proxy label is rejected | The id is called unverified and prohibited, but the test-proxy reason is omitted | Partial |
| Tunable: none | ADR does not identify any IF-D19 rule as tunable | Match in effect |

## IF-D22 rule-by-rule conformance

| IF-D22 rule | ADR treatment | Result |
| --- | --- | --- |
| DATA-MODEL, PROJECT-FORMAT, and an accepted ADR must all admit the package and provenance schemas before implementation | Context states the same three-part prerequisite; ADR remains Proposed | Match |
| Admit `hcad.product-import-package-manifest@1` | Exact id and manifest shape | Match |
| Admit `hcad.photolab-product-provenance@1` | Exact id and envelope content | Match |
| Exact schema shape | Manifest and prose lineage/provenance shapes match at the specification's own precision | Match |
| Exact hash boundary | Same one-hash boundary with only `package_sha256` omitted | Match |
| Safe-path rules | Exact rejection and containment rules | Match |
| Complete inventory and counts | Exact once-only inventory and exact-count rules | Match |
| Atomic ready record | Exact fields, last-write rule, mirrored summary, atomic visibility, and equality rule | Match |
| Fail-closed compatibility | Exact unknown-major/type/required-feature behavior and error id | Match |
| Lossless unknown non-required field handling | Exact semantic exclusion and byte preservation | Match |
| Shared migration ownership | Same DATA-MODEL/PROJECT-FORMAT canonical-I/O owner | Match |
| Migration emits new package and provenance revision, preserves source, and needs an ADR | Same rule | Match |
| No Builder or PhotoLab private in-place rewrite | Same rule | Match |
| Until admission, every eligible row and both commands remain non-implementation-ready | Context blocks implementation generally, but the Decision does not expressly name both command rows or every format row | Partial |
| Reject PhotoLab-private adapter | Package is explicitly not a product-private viewer bridge | Match |
| Reject directory walk as manifest | Listing/inventory walk is explicitly prohibited | Match |
| Reject unversioned component JSON | Versioned component id is exact; rejection is implicit rather than express | Partial |
| Reject permissive future-version guessing | Explicit fail-closed rule | Match |
| Reject Builder-owned in-place migration | Explicit rejection | Match |
| Package/list count and size ceilings may be X6-calibrated | ADR fixes no numeric ceiling and does not contradict calibration, but omits the stated tuning boundary | Partial |
| Schema identity, complete inventory, hash/path checks, and atomicity are not tunable | ADR states exact rules but does not expressly label the boundary non-tunable | Partial |

### `package_sha256` canonicalization

Every step matches exactly:

| Step | Spec | ADR | Result |
| --- | --- | --- | --- |
| Hash | One SHA-256 | One SHA-256 | Match |
| Input | Canonical manifest payload | Canonical manifest payload | Match |
| Omitted member | Only `package_sha256` | Only `package_sha256` | Match |
| Encoding | UTF-8 JSON | UTF-8 JSON | Match |
| Object order | Keys sorted by UTF-8 byte order | Same | Match |
| Array order | Declared order retained | Same | Match |
| Whitespace | No insignificant whitespace | Same | Match |
| Strings | Shared generated JSON serializer | Same | Match |
| Integers | Base 10, no leading zeroes | Same | Match |
| Floating point | No floating-point manifest values | Same | Match |
| Filesystem enumeration | Not part of hash meaning/order | Same | Match |

### Ready-record atomicity

| Rule | Spec | ADR | Result |
| --- | --- | --- | --- |
| Candidate package first | Required | Required | Match |
| Manifest and declared artifacts synchronized | `fsyncs` | `fsyncs` | Match |
| Ready record is small/bounded | Small record | Small record; listing calls its summary bounded | Match |
| Ready fields: `schema_id`, `manifest_id` | Required | Required | Match |
| Ready fields: product id/version | Required | Required | Match |
| Ready field: publication generation | Required | Required | Match |
| Ready field: normalized format | Required | Required | Match |
| Ready fields: manifest hash, lineage hash/status | Required | Required | Match |
| Ready fields: `artifact_count`, `object_count`, `total_bytes` | Required | Required | Match |
| `package_sha256` written last | Required | Required | Match |
| Publication record mirrors summary | Required | Required | Match |
| Publication record and ready record become visible atomically | Required | Required | Match |
| Both records must agree | Required | Required | Match |
| Listing reads only precomputed summary | Required | Required | Match |
| No post-publication directory walk can become accepted inventory | Required | Required | Match |

## IF-D20–IF-D25 coverage outside the two declared cite-and-adopt records

ADR 0030's Status says it cite-and-adopts IF-D19 and IF-D22, while its Primary
references cite IF-D19–IF-D25. The following rules therefore remain external
citations or partial summaries, not full admissions in the ADR.

| Decision | ADR coverage | Conformance finding |
| --- | --- | --- |
| IF-D20 generated list/register command schemas, grants, replay, lifecycle, and private-RPC boundary | Context cites the one generated command table; Consequences names the two command ids | Compatible but incomplete. The exact request/result fields, optionality, enums, grants, cursor binding, replay, validation/status/cancel, and journal boundary are not restated. No conflicting command schema is added. |
| IF-D21 complete Builder Save As/WeltView R1 parity gate | Release gates restates Builder registration/reopen, complete `.hcadx`, WeltView read-only, ids/hashes/bindings/provenance/render-pick-snap comparison | Divergence by omission: it drops `no-coordinate` semantics and, materially, the rule that every renderable product kind in the PhotoLab release must reach Available and cannot be removed from the gate because ownership/admission is missing. |
| IF-D23 snapshot Import, exact duplicate, update, undo, and Relocate | Immutable-package text permits a later version to become a new destination entity; Consequences says an ordinary canonical entity is created | Compatible but incomplete. It does not restate Import-not-Attach/not-recipe, the exact duplicate tuple/outcome, explicit update boundary, undo roots, or locator-only Relocate rule. |
| IF-D24 pinned non-mutating source and bounded complete listing | Atomicity says listing reads only the bounded summary and never walks a product directory | Compatible but incomplete. It omits `.hcad` exclusive-lock acquisition, busy-before-staging action, declared-root pin duration, `.hcadx` held immutable handle, no source mutation, paging budgets, and the requirement never to filter legacy/unsupported rows. |
| IF-D25 owner-controlled arrival/consumer matrix and provenance export | Ingress requires owner acceptance; Consequences adopts exact native/external provenance preservation/loss behavior | Compatible but incomplete. It does not reproduce per-result render/pick/snap/select/edit/Properties/Plan/WeltView/automation behavior or the explicit unsupported-consumer rule. |

Because these decisions remain authoritative in the cited specification, an
implementation must not use the shorter ADR summaries to relax them. If ADR
0030 is intended to be the standalone admission point for the whole
IF-D19–IF-D25 amendment, these omissions must be replaced with an explicit
wholesale adoption clause or exact restatements.

## Additions not authorized by the specification

### 1. Broader format emission prohibition

ADR Decision 10 says binary PLY, unprepared products, standalone MVS depth,
raw Brush PLY, and `mesh@1` “are not emitted or accepted.” The specification
uses that exact producer-and-consumer prohibition only for the unverified
`mesh@1` identifier. Its other dispositions are:

| Format | Specification | ADR |
| --- | --- | --- |
| `binaryPly` dense fallback | Deferred; chooser says **Needs preparation** | “not emitted or accepted” |
| Legacy/incomplete prepared product | Deferred; no registration | “unprepared products” are “not emitted or accepted” |
| Standalone `mvsDepth` | Deferred as a Builder product; may remain lineage input | “not emitted or accepted” |
| Gaussian-splat `brushPly` | Deferred until prepared | “not emitted or accepted” |
| `mesh@1` | Deferred as unverified; do not emit or accept | “not emitted or accepted” |

The added “not emitted” rule regulates PhotoLab production, contradicts the
specification's explicit boundary that the amendment does not define
PhotoLab-side production work, and erases the distinction between Deferred,
Needs preparation, and unsupported emission. This is a defect.

Required correction: reproduce the per-row dispositions. Reserve “do not emit
or accept” for `mesh@1`; say the other formats cannot register in their current
form and preserve their exact Deferred/Needs-preparation/lineage-input status.

### 2. New legacy `ProductLineage` authority rule

ADR Consequences says the existing five-field `ProductLineage` “becomes a
projection of `ProductLineageV1`, not a second authority.” The specification
states that current records are incomplete, must not be used to reconstruct
history, and require republish/recompute. It does not define the old structure
as a projection, specify its migration, or authorize keeping it as a derived
second representation.

That sentence is a new data-model and migration decision. Under the requested
zero-design-freedom standard it is a defect even if the intended direction is
plausible.

Required correction: remove the sentence or obtain an explicit specification
decision that defines the projection, generation point, persistence,
compatibility, and migration behavior.

## Omissions that leave design freedom

1. Preserve IF-D19's exact per-publication disposition table rather than the
   compressed format sentence.
2. Restate the exact DEM Grid/resource/mapping/sampling/prepared binding or cite
   the exact table row as adopted without modification.
3. State expressly that zero-height orthomosaic `OrthoGrid` is rejected and
   that `PlanGrid2D` has no Z, depth, or placement authority.
4. State that prepared hierarchy is not blanket format permission and requires
   entity kind, slot, resource hash, root, every artifact, and every
   `ContentKind` to agree.
5. Preserve IF-D21's non-shrinking release-gate rule and `no-coordinate`
   comparison.
6. If the ADR is meant to govern more than schema admission, explicitly adopt
   the complete IF-D20, IF-D23, IF-D24, and IF-D25 decisions rather than relying
   on abbreviated consequences.

## Proposed normative document changes

### DATA-MODEL pending item 8 promotion

**Finding: consistent in direction, but incomplete as a replacement and
therefore not conformant as written.**

The proposed paragraph correctly names:

- `hcad.product-import-package-manifest@1`;
- frozen `hcad.photolab-product-lineage@1`;
- read-only `hcad.photolab-product-provenance@1`;
- exact lineage bytes, `lineage_object_sha256`, source `package_sha256`, and
  destination registration audit;
- `complete | partial | unknown`; and
- the prohibition on registering anything other than `complete`.

Those points are consistent with IF-D19/IF-D22. The explicit reference to ADR
0030 and IF-D19/IF-D22 also leaves the detailed shape in its intended owner.

However, deleting pending item 8 and inserting the proposed paragraph removes
from `docs/DATA-MODEL.md` the architect's explicit list of:

- package id plus version;
- per-dataset prepared format;
- alignment id plus hash;
- GCP revision plus snapshot hash;
- frozen CRS; and
- the explicit producer/consumer ownership chain: PhotoLab publishes, Builder
  registers, WeltView reads.

Most of those requirements remain elsewhere in ADR 0030, but the proposed
replacement is not a strict promotion of item 8 as written. It also describes
shapes by circular reference to an ADR that currently contains the two defects
above. The promotion text should retain item 8's particulars verbatim and add
the exact admitted schema/component identifiers and state rules; it should not
replace the architect's list with a shorter summary.

### PROJECT-FORMAT Product data paragraph

**Finding: consistent.**

The proposed paragraph is a strict summary of IF-D22's candidate-package,
synchronization, ready-record-last, mirrored-summary atomicity, complete hash
binding, bounded-listing, immutable migration, new-revision, and
source-preservation rules. It is also consistent with the current
PROJECT-FORMAT rules for immutable objects, transactional publication, no
partial visibility, and new-object migration.

PROJECT-FORMAT's general statement that unknown future content opens read-only
“when safe” does not conflict with rejecting an unknown package major/type or
required feature from registration: registration would create canonical state
and is not a safe unknown-content read. Byte-for-byte retention still permits
lossless read-only preservation.

The paragraph is not a complete standalone statement of IF-D22 because it does
not repeat safe paths or fail-closed compatibility, but its ADR citation can
carry those rules once ADR 0030 is corrected. No contradictory project-format
rule was found.

## Required edit set for conformance

1. Replace Decision 10 with the exact publication/canonical-format disposition
   matrix or a strict row-by-row restatement; remove the unauthorized “not
   emitted” rule from every format except `mesh@1`.
2. Remove or separately specify and approve the five-field `ProductLineage`
   projection rule.
3. Add the omitted IF-D19 exact Grid, orthomosaic/no-Z, prepared-content
   validation, and no-independent-adoption constraints.
4. Restore IF-D21's complete, non-shrinking R1 gate language.
5. Make the scope of adoption unambiguous: either explicitly adopt IF-D20–IF-D25
   in full by citation, or keep the ADR limited to IF-D19/IF-D22 and remove any
   abbreviated wording that could be mistaken for a replacement of the other
   decisions.
6. Revise the proposed DATA-MODEL promotion so it retains every architect-listed
   item-8 particular while adding the admitted identifiers and exact state rule.

## Verification performed

Read and compared:

- `docs/CURRENT-DIRECTION.md`
- `docs/README.md`
- `docs/AGENT-FEEDBACK.md`
- `docs/adr/0030-photolab-product-import-package-and-provenance.md`
- `docs/builder-program/specs/import-formats/import-formats.md`, the complete
  PhotoLab amendment and IF-D19–IF-D25
- `docs/builder-program/specs/import-formats/import-formats-photolab-review-2026-09-02.md`
- `docs/DATA-MODEL.md`, including current pending item 8
- `docs/PROJECT-FORMAT.md`

No build, test, formatter, application, or network operation was needed for
this documentation-only conformance check. The only repository write made by
this check is this report.
