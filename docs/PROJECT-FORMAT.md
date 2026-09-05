# Himmel:CAD project format

This document defines storage invariants and logical layout. Rust schemas,
format-version tests, and migrations are authoritative for exact serialized
fields.

## Formats

- `.hcad/` is the folder-based working project.
- `.hcadx` is the portable archive of the same logical project.
- `.hcap` is a separate Cap capture package imported through canonical IO; it is
  not a project format.

The working directory supports incremental writes, streaming, crash recovery,
and rebuildable indexes. The archive supports sharing, backup, and WeltView
publication.

## Logical layout

```text
project.hcad/
  manifest.json
  project.lock
  objects/
  canonical/
    journal/
    datasets/
    imports/
  product-data/
  index/
  previews/
  tmp/
```

Exact paths may evolve through versioned migrations. Code must not infer
canonical meaning from an undocumented path name.

## Manifest

The manifest identifies the project and its current committed snapshot. It
contains format version, project identity, canonical roots and references,
project metadata, view/layout references, and product extension references. It
does not embed large geometry.

Manifest publication is atomic. A manifest never references an object or
canonical transaction that has not been completely written and verified.

## Immutable object store

Objects are addressed by SHA-256 and never mutated in place. Examples include
geometry, attributes, styles, definitions, images, masks, material resources,
prepared dataset metadata, provenance, and command results.

- Identical content may deduplicate.
- Hash, byte length, media type, and safe relative path are validated where
  applicable.
- Garbage collection removes only unreachable content and is never implicit in
  an unrelated command.
- External or user-controlled paths never become trusted project-relative paths
  without canonicalization and containment checks.

## Canonical journal

The canonical journal is append-only. Each committed transaction records its
identity, actor, expected revisions, deterministic payload, affected entities,
and resulting revisions or references.

Undo and redo append compensating transactions. Journal sequence and entity
revisions never move backward.

Historical legacy journals may remain readable during migration, but new
canonical behavior must not create a second active command authority.

## Transactional publication

Imports and derived products stage immutable resources in a temporary
transaction area. Publication follows this order:

1. write and synchronize immutable artifacts;
2. verify hashes, lengths, paths, schemas, and complete references;
3. mark the transaction ready;
4. publish immutable inventories;
5. commit the canonical document transaction last.

Before the ready boundary, failure is discardable. After it, recovery completes
or rejects the transaction as corruption. Partial canonical visibility is not
allowed.

## Datasets and indexes

Large renderable data references prepared datasets with bounded hierarchies,
f64 bounds, content hashes, and render-ready artifacts. Point-cloud, mesh,
raster, texture, and splat formats may differ, but they share publication and
streaming invariants.

`index/` and runtime caches are rebuildable and never canonical. Deleting them
may cost time but must not lose project meaning.

## Product data

Product-specific records such as PhotoLab jobs, capture groups, calibration
groups, masks, processing lineage, reports, and checkpoints use versioned
product namespaces. They reference exact canonical entities and immutable
objects rather than mutating the entity store indirectly.

Interrupted work is recorded as interrupted or recoverable, never completed.
Cancellation leaves previously committed product state intact.

PhotoLab product publication additionally writes a candidate import package
(`hcad.product-import-package-manifest@1`, ADR 0030 — Proposed, owner
acceptance pending) whose manifest and declared artifacts are synchronized
before a small ready record is written with `package_sha256` last; the
product publication record mirrors that summary and the two become visible
atomically. The package binds every object, resource, and artifact hash
inside its canonical manifest payload, so listing reads only the ready
summary and never a directory walk. Packages are immutable: migration emits a
new package and provenance revision and preserves the source package.

## Temporary data

Temporary and scratch paths are never referenced by a committed manifest.
Operation ownership is explicit so cancellation, project close, sidecar restart,
and later cleanup cannot delete another operation's data.

## `.hcadx` archive

Archive creation and opening are streaming, cancellable, and transactional.

- Packing writes a sibling candidate and publishes by atomic replacement.
- Opening extracts into a staging directory and publishes only after complete
  validation.
- Existing recoverable projects or archives survive failure and cancellation.
- Progress reports real phases, bytes, and files where available.

WeltView may consume a complete archive, HTTP ranges, or an unpacked static
object layout according to the product delivery decision.

## `.hcadx` fragment profile (planned)

Status: planned by the Builder completion program (select-edit SE-D7,
cross-spec reconciliation and registry 2026-09-02); not implemented; its manifest schema requires an ADR
before implementation.

A fragment is a versioned transactional subset package, not a whole project.
Its manifest uses `hcad.fragment-manifest@1` and records `version`,
`sourceProjectId`, `sourceGeneration`, `sourceCrs`, `sourceUnits`, exact
source entity and dependency references with revisions/hashes, and an object
inventory with hashes and sizes. Paths are relative, normalized,
traversal-safe, and validated under bounded entry/size/count budgets. Objects
are staged into an operation-owned spool and the ready marker is written
last. Cancellation, crash, validation failure, or quota failure before that
marker publishes no fragment and creates no project entities. Same-project
clipboard operations may use a pinned internal token; cross-project copy uses
this fragment profile. Paste in place is allowed only for identical CRS and
units or after an explicit registered-transform preview and approval; numeric
coordinate identity without matching provenance is not sufficient. Attach
remains the separate linked-reference operation. Import collision/dependency
review and commit are one canonical transaction with no partial roots.

## Compatibility and migration

Every project declares a format version; versioned entity, object, dataset, and
product schemas evolve independently where needed.

- Unknown future content opens read-only when safe rather than being silently
  discarded.
- Destructive migration requires an explicit operation and a recoverable source.
- Migrations publish new immutable objects and journaled state.
- Fixture projects cover every supported migration boundary.

## Safety invariants

- Never mutate a content-addressed object.
- Never trust a rebuildable index as authority.
- Never publish a reference to missing or unverified content.
- Never silently transform coordinates or units.
- Never keep the only copy of persistent user-visible state in a renderer.
- Never let two concurrent writers publish to the same project or external
  target without explicit coordination.

## Release 0.5 additive records

ADR 0031 records are additive to the existing logical project/archive payload.
Canonical Measurement, snapshot-marker, derived-recipe, point-acquisition, and
support-role changes enter through ordinary expected-revision journal
transactions. Mesh source-role objects are immutable and hash-validated before
their linking transaction. ViewState v1 is projected in memory; only an
explicit v2 mutation persists v2. Selection, Display, and Camera local-history
streams publish independently and an absent stream is an unwritten in-memory
baseline. Passive open never rewrites a journal, resource, manifest, archive,
or capture input merely because an admitted record is absent.
