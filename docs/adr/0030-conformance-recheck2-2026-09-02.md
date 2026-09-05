# ADR 0030 final conformance re-check — 2026-09-02

Document class: report / verification evidence

Revision checked: commit `5e54e9f` (`docs(adr): ADR 0030 revision 3 —
record-id references and mirrored DATA-MODEL text`) plus the actual current
working-tree text of `docs/DATA-MODEL.md` and `docs/PROJECT-FORMAT.md`.

Authoritative comparison text:
`docs/builder-program/specs/import-formats/import-formats.md`, section
“PhotoLab product datasets — 2026-09-02,” including IF-D19–IF-D25 and the
package, provenance, disposition, consumer, and release-gate text governed by
those records.

## Overall verdict

**Conformant.** Revision 3 resolves both residual items from
`docs/adr/0030-conformance-recheck-2026-09-02.md`. Edits 1–4 retain their prior
conformant outcomes. No new design divergence or malformed Markdown was found.

## Per-item verdicts

### 1. Decision 10 disposition table

**Conformant; unchanged in substance.** All thirteen rows still preserve the
IF-D19 publication/candidate format, canonical entity and owner, and exact
disposition. The non-independent-adoption boundary remains:

> “All otherwise eligible rows remain unavailable until the common
> package/provenance admission and their named owner acceptance land; they are
> not independently Adopted product rows.”

In particular, only the unverified `mesh@1` row carries “do not emit or accept
it”; the Deferred and Needs-preparation rows do not acquire that prohibition.

### 2. Existing five-field product lineage

**Conformant; unchanged in substance.** The ADR still makes no projection,
migration, or second-authority decision for the old record:

> “How the existing five-field product lineage record relates to
> `ProductLineageV1` is not decided here”.

Current records remain legacy until PhotoLab republishes or recomputes them,
matching IF-D19.

### 3. IF-D19 validation constraints

**Conformant.** Revision 3 repairs the damaged Markdown without weakening the
previously conformant rule set. The DEM rule now cleanly states the exact
canonical shape and ownership:

> “`Grid { raster: GeometryResource, mapping: OrthoGridMapping, sampling:
DepthSampling }`”

and:

> “This is the existing canonical Grid shape and Raster-owned behavior, not a
> second Import model.”

The same list retains the immutable resource metadata, finite pixel-center
vectors, explicit sampling semantics, matching prepared binding, the sole
`RasterMapping::PlanGrid2D` orthomosaic arrival, rejection of zero-height
`OrthoGrid`, prepared-hierarchy agreement checks, and the prohibition on
decoder- or inventory-label admission. These match IF-D19 and the detailed
format rows without adding a choice.

### 4. IF-D21 release gate

**Conformant; unchanged.** The full non-shrinking gate remains: Builder must
register and reopen every then-Available row, perform FP-D3 Save As to a
complete `.hcadx`, and WeltView must open that archive read-only through the
canonical store/kernel. The comparison still covers ids, version/content
hashes, prepared bindings, exact provenance bytes, and each row's interaction
semantics. The ADR also retains:

> “Every renderable product kind in the PhotoLab release must reach Available;
> missing owner or admission work cannot be used to remove it from the gate.”

### 5. Adoption scope and Consequences

**Conformant; residual resolved.** The ADR adopts IF-D19 and IF-D22 only. Its
Consequences section no longer reproduces the prior partial IF-D20 command
vocabulary or IF-D25 exporter rule. It now gives only a non-substitutive
governing-record reference:

> “The consumer side — generated command-table rows, source acquisition and
> pinning, listing budgets, repeated registration and update rules, passive
> consumers, and `.hcadx` WeltView parity — is governed by import-formats
> IF-D20, IF-D23, IF-D24, and IF-D25 as written there; this ADR neither
> restates nor modifies them.”

Those topic labels accurately identify the collective subject matter of
IF-D20 and IF-D23–IF-D25 and introduce no fields, behavior, or shortened
replacement rule. IF-D21 remains separately restated in full under Release
gates.

### 6. Applied normative document changes

**Conformant; residual resolved.** The ADR's quoted DATA-MODEL paragraph is
verbatim after ignoring Markdown quote prefixes and line wrapping. Both
normalized texts have SHA-256
`d879eb62856eb9e543a1f3de4cdf47467b0a5089cea16d458bcac9d2f6c971e8`.
It includes every formerly missing particular:

> “packages (package id + version; per-dataset prepared format)”

> “The chain is PhotoLab publishes → Builder registers → WeltView reads the
> registered product read-only from the project or its `.hcadx` archive.”

It also matches the live identifiers, exact provenance contents,
`complete | partial | unknown` states, legacy behavior, and ADR
0030/import-formats authority references.

The PROJECT-FORMAT record is also accurate. The actual current “Product data”
paragraph contains the candidate package, synchronized manifest and artifacts,
ready record with `package_sha256` last, mirrored-summary atomic visibility,
complete manifest hash binding, ready-summary-only listing, and immutable
package migration that emits new package/provenance revisions and preserves the
source. The live paragraph adds the truthful proposal-status qualification
“ADR 0030 — Proposed, owner acceptance pending”; this is editorial status
metadata, not a change to the revision-1 publication contract or design
freedom.

## Residual conformance pass

The manifest fields and requiredness, lineage facts and tagged unions,
provenance envelope and states, canonical JSON/hash rules, inventory and count
rules, path validation, candidate/ready/commit atomicity, legacy handling,
unknown-field preservation, fail-closed compatibility, and shared migration
ownership remain aligned with IF-D19 and IF-D22. Revision 3 introduces no new
field, enum member, default, disposition, command schema, consumer behavior, or
migration authority.

The references to IF-D20 and IF-D23–IF-D25 remain governing references only;
their exact command-table schemas, snapshot/repeat/update behavior, acquisition
and listing budgets, and consumer matrix continue to live in import-formats.

The repaired lineage and IF-D19 lists render as distinct Markdown list items,
the fenced block and table are balanced, `git diff --check` reports no
whitespace errors for revision 3, and `pnpm exec prettier --check` accepts the
ADR. No malformed Markdown remains or was introduced.

## Residuals

None.

## Verification performed

Read and compared:

- `docs/CURRENT-DIRECTION.md`
- `docs/README.md`
- `docs/AGENT-FEEDBACK.md`
- commit `5e54e9f` and its parent diff
- `docs/adr/0030-photolab-product-import-package-and-provenance.md`
- both earlier ADR 0030 conformance reports
- `docs/builder-program/specs/import-formats/import-formats.md`, including the
  PhotoLab amendment and IF-D19–IF-D25
- `docs/builder-program/REGISTRY.md` item 8
- the actual current `docs/DATA-MODEL.md` “Immutable resources” paragraph
- the actual current `docs/PROJECT-FORMAT.md` “Product data” paragraph

No source, build, application, or network operation was needed. The only
repository write made by this re-check is this report.
