# ADR 0030 conformance re-check — 2026-09-02

Document class: report / verification evidence

Revision checked: commit `b4bde6f` (`docs(adr): revise ADR 0030 per the
conformance check`) plus the actual current working-tree text of
`docs/DATA-MODEL.md` and `docs/PROJECT-FORMAT.md`.

Authoritative comparison text:
`docs/builder-program/specs/import-formats/import-formats.md`, section
“PhotoLab product datasets — 2026-09-02,” including IF-D19–IF-D25 and the
exact tables and package/provenance text those decision records reference.

## Overall verdict

**Non-conformant.** Claimed edits 1–4 are present and preserve the applicable
IF-D19/IF-D21 meaning. Claimed edits 5 and 6 are not complete under the same
zero-design-freedom standard:

1. the new scope sentence says that IF-D20/IF-D23/IF-D24/IF-D25 are not
   restated or abbreviated, while the ADR still carries abbreviated IF-D20 and
   IF-D25 consequences; and
2. the normative-change record says that every DATA-MODEL item-8 particular
   was retained, but its own list omits package id + version and the explicit
   PhotoLab → Builder → WeltView ownership chain, and the actual current
   DATA-MODEL promotion omits the WeltView reader part of that chain.

No new mismatch was found in the manifest fields, lineage fields, enums,
canonicalization, publication/commit atomicity, path validation, or
compatibility rules. The revision did introduce malformed Markdown around the
lineage and IF-D19 validation lists; the words and identifiers remain present,
so this report treats that as an editorial defect rather than an additional
schema divergence.

## Per-edit verdicts

### 1. Decision 10 disposition table

**Conformant.** Decision 10 restates all thirteen publication/candidate rows in
the same order and preserves their canonical entities, owners, and
dispositions. In particular:

- `binaryPly` is Deferred and the chooser reports “Needs preparation”;
- legacy `tiledMesh` fails closed;
- standalone `mvsDepth` is Deferred but “may remain a lineage input”;
- Gaussian-splat `brushPly` is Deferred until prepared; and
- only claimed canonical `mesh@1` says: “Deferred as an unverified identifier;
  do not emit or accept it”.

The earlier unauthorized producer prohibition is gone from every other row.
The table also preserves the distinction between inventory labels and exact
canonical `formatId` values.

### 2. Existing five-field product lineage

**Conformant.** The old projection decision is gone. Consequences now says:

> “How the existing five-field product lineage record relates to
> `ProductLineageV1` is not decided here”.

It also keeps current records legacy until republish/recompute. No remaining
text makes the five-field record a projection or a second authority.

### 3. IF-D19 validation constraints

**Conformant in normative content.** The restatement contains all requested
non-tunable constraints:

- exact DEM `Grid { raster: GeometryResource, mapping: OrthoGridMapping,
  sampling: DepthSampling }`;
- immutable height/validity resource hash, media type, and byte length;
- finite source pixel-center origin/column/row vectors;
- explicit `ElevationZ`, interpolation, connectivity, and NoData semantics,
  with nothing inferred;
- a representation slot binding the same entity and Grid resource to a
  hash-verified `himmelcad-prepared-hierarchy@1` Raster root;
- orthomosaic `RasterImageGeometry` plus `RasterMapping::PlanGrid2D`, frozen
  CRS, `z: null`, no depth, and no entity placement;
- explicit rejection of a zero-height orthomosaic `OrthoGrid` and the rule that
  `PlanGrid2D` has no Z, depth, or placement authority;
- prepared-hierarchy agreement across entity kind, representation slot,
  geometry/resource hash, root manifest, every referenced artifact, and every
  tile `ContentKind`, with mixed/unsupported semantics rejected before review
  and no Raster/glTF/GaussianSplats relabeling; and
- the no-independent-adoption rule: otherwise eligible rows remain unavailable
  until common admission and owner acceptance land and “are not independently
  Adopted product rows.”

The last rule is immediately before, rather than inside, the subsection headed
“IF-D19 validation constraints (restated)”; it nevertheless remains part of
Decision 10 and is unambiguous.

### 4. IF-D21 release gate

**Conformant.** Release gates restates the complete IF-D21 decision boundary:
PhotoLab publication/viewing alone is insufficient; every then-Available row
must register and reopen in Builder; Builder must perform FP-D3 Save As to a
complete `.hcadx`; WeltView must open that archive read-only through the
canonical store/kernel; the comparison includes ids, version/content hashes,
prepared bindings, exact provenance bytes, and render/pick/snap/no-coordinate
semantics; mutable `.hcad` and R3 delivery choices are excluded. It also
restores the non-shrinking rule exactly:

> “Every renderable product kind in the PhotoLab release must reach Available;
> missing owner or admission work cannot be used to remove it from the gate.”

### 5. Adoption scope

**Non-conformant.** The adoption boundary itself is explicit—IF-D19 and IF-D22
only—and IF-D20, IF-D23, IF-D24, and IF-D25 are named by record id. But the
stronger claimed statement is false. Status says:

> “nothing in this ADR restates, abbreviates or replaces them.”

The retained Consequences section still abbreviates IF-D20:

> “The Builder registration island, the generated command table
> (`io.import.product_dataset.list/register`), and WeltView's read-only archive
> path implement the consumer side”.

It also restates a normative slice of IF-D25:

> “Exporters must either preserve the provenance component through a declared
> extension or report `hcad.loss.photolab-product-provenance@1`; silent drops
> are not allowed.”

Those summaries are compatible with IF-D20 and IF-D25, but the contradiction
between their presence and the absolute “nothing ... abbreviates” disclaimer
leaves unclear whether they are informative consequences or partial normative
substitutes. The previous check required either full adoption or removal of
abbreviated wording; adding a disclaimer without removing the wording does not
satisfy that edit.

The scope parenthetical also assigns five topic summaries to only IF-D23,
IF-D24, and IF-D25 and includes “`.hcadx` WeltView parity,” which is primarily
IF-D21. This does not change the record-id authority, but it reinforces the
scope ambiguity.

### 6. Applied normative document changes

**Non-conformant.** The section now records both changes as applied, and the
actual current `docs/PROJECT-FORMAT.md` “Product data” paragraph matches that
record: it contains the candidate package, synchronized manifest/artifacts,
ready-record-last publication, mirrored-summary atomic visibility, complete
hash binding, bounded summary listing, immutable packages, new package and
provenance revisions on migration, and preservation of the source package.

The DATA-MODEL claim is incomplete. ADR 0030 says:

> “retaining every item-8 particular — per-dataset prepared format, alignment
> id + hash, GCP revision + snapshot hash, frozen CRS — plus the admitted
> identifiers and the `complete | partial | unknown` rule”.

That purported exhaustive list omits two architect-listed particulars from the
original item 8: package id + version and the explicit ownership chain. The
actual current `docs/DATA-MODEL.md` does retain package id + version and most of
the chain:

> “PhotoLab products are published as
> `hcad.product-import-package-manifest@1` packages (package id + version;
> per-dataset prepared format) carrying a frozen
> `hcad.photolab-product-lineage@1` payload (alignment id + hash, GCP revision +
> snapshot hash, frozen CRS). Builder registration stores it as the read-only
> `hcad.photolab-product-provenance@1` component”.

It does not retain the final reader named by original item 8:

> “PhotoLab publishes it, Builder registers it, WeltView reads it.”

ADR 0030's Status separately says Builder and WeltView may consume the shapes,
but neither that fact nor a cross-reference makes the actual Immutable
resources promotion a strict retention of item 8. The normative-changes
section also attributes application to “the Builder program's single writer,”
not to the architect; it says only that the application occurred after review
of the ADR.

## Residual conformance pass

### Fields and enums

All `ProductImportPackageManifestV1` fields and nesting match, including the
literal schema identifiers, producer/source/product/lineage blocks,
admissions, representation slots, datasets, resources, artifacts,
`required_features`, counts, and `package_sha256`. The full mandatory
`ProductLineageV1` facts remain present. The provenance envelope and
`provenanceStatus: complete | partial | unknown` meanings, exact
`missingFieldIds`, and registration prohibition for `partial`/`unknown` remain
unchanged. No new field, enum member, default, or projection was introduced.

### Canonicalization and hashes

The ADR still defines one SHA-256 over the canonical manifest with only
`package_sha256` omitted; UTF-8 JSON; UTF-8 byte-order object keys; retained
array order; no insignificant whitespace; shared generated string
serialization; base-10 integers without leading zeroes; no floating-point
manifest values; and no filesystem-enumeration dependency. Inventory hashes,
lengths, registered media types, once-only reachability, and exact counts also
match.

### Atomicity and paths

Candidate-package publication, fsync, ready-record fields,
`package_sha256`-last, mirrored summaries, atomic joint visibility, equality,
bounded-summary listing, and rejection of post-publication directory-walk
inventory match. Import still stages only declared hash-addressed bytes and
commits the entity and provenance in one journal-last transaction.

Path rules match: normalized UTF-8 relative POSIX paths; rejection of empty,
absolute, dot/dot-dot, backslash, NUL, normalized duplicate, and platform
case-fold collisions; containment after canonical resolution; ignored
undeclared files; and failure on declared missing/changed files.

### Compatibility and migration

Unknown manifest major/type id or required feature still returns
`unsupported_package_schema`; unknown optional fields are not semantic inputs,
while canonical manifest and lineage bytes survive byte-for-byte. Shared
DATA-MODEL/PROJECT-FORMAT canonical I/O retains migration ownership; migration
emits new package and provenance revisions, preserves the source, requires its
own ADR rule, and forbids private in-place rewriting.

### Revision-introduced editorial damage

The revision flattened the mandatory lineage list into text beginning
“`payload is: - source ...; - product ...`” and contains run-together validation
text such as “`himmelcad-prepared-hierarchy@1`Raster” and
“`content. - A renderer decoder`”. Every required fact remains recoverable and
the exact code identifiers remain delimited, so these are not counted as
additional normative divergences. They should nevertheless be repaired before
acceptance because the ADR claims verbatim, zero-design-freedom admission text.

## Required edits for conformance

1. Make the scope statement true: either remove the IF-D20/IF-D25 abbreviated
   consequences, mark them explicitly non-normative cross-references, or adopt
   the applicable decisions in full without claiming that nothing is
   abbreviated.
2. Make the normative-change record enumerate all item-8 particulars, including
   package id + version and “PhotoLab publishes it, Builder registers it,
   WeltView reads it”; make the actual DATA-MODEL Immutable resources paragraph
   retain the missing WeltView reader statement.
3. Correct the revision-introduced Markdown flattening and missing spaces
   without changing any normative content.

## Verification performed

Read and compared:

- `docs/CURRENT-DIRECTION.md`
- `docs/README.md`
- `docs/AGENT-FEEDBACK.md`
- commit `b4bde6f` and its parent diff
- `docs/adr/0030-photolab-product-import-package-and-provenance.md`
- `docs/adr/0030-conformance-check-2026-09-02.md`
- `docs/builder-program/specs/import-formats/import-formats.md`, the full
  PhotoLab amendment, disposition table, package/provenance sections, and
  IF-D19–IF-D25
- `docs/builder-program/REGISTRY.md` item 8
- the actual current `docs/DATA-MODEL.md` “Immutable resources” and pending-item
  promotion text
- the actual current `docs/PROJECT-FORMAT.md` “Product data” text

No source, build, test, formatter, application, or network operation was needed
for this documentation-only conformance re-check. The only repository write
made by this re-check is this report.
