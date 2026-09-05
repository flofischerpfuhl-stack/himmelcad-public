# ADR 0030 revision 4 conformance re-check — 2026-09-02

Document class: report / verification evidence

Revision checked: commit `78db9ee860027389204f54e30938204202254288`
(`docs(adr): ADR 0030 revision 4 — adopt IF-D26–IF-D34`). This report checks
the committed ADR blob, not later working-tree text.

Authoritative comparison text:
`docs/builder-program/specs/import-formats/import-formats.md`, section
“PhotoLab product datasets — 2026-09-02,” from the WP-G1a contract-gap
material through decision records IF-D26–IF-D34, including the exact schema,
enumeration, disposition, DEM, identity, and decimal-encoding text incorporated
by those records.

## Standard applied

This is a zero-design-freedom check. An exact record-id adoption is effective
where the ADR contains no competing restatement. Where an ADR decision already
restates the same subject as an exact or mandatory shape, that local text must
be verbatim or a strict, complete restatement; a general scope citation does not
cure conflicting, stale, or materially incomplete local normative text.

## Overall verdict

**Non-conformant.** IF-D27, IF-D28, and IF-D30 are adopted without a competing
rule and IF-D30 also has a strict decision-level restatement. IF-D26, IF-D29,
IF-D31, IF-D32, IF-D33, and IF-D34 are not conformant because existing ADR
Decisions 2, 5, 6, 8, and 10 remain incomplete or contradictory after the
scope-only adoption.

Revision 4 leaves the previously conformant revision-3 edits unchanged in
substance. It introduces no malformed Markdown or whitespace defect.

## Per-record verdicts

### IF-D26 — exact `ProductLineageV1` serialized shape

**Non-conformant.** The specification requires one identity shape:

> “`ProductLineageIdentityV1 { id: string, sha256: Sha256 }`”

and makes `algorithms`, `configurations`, and `tools` always-present ordered
arrays whose repeated invocations remain repeated entries. Optional `?`
members are omitted and are never `null`.

ADR Decision 6 instead says:

> “ordered algorithm, configuration, and tool identities, each with stable id,
> version, and configuration/binary hash where applicable”

That is not the closed `{id, sha256}` wire shape and reintroduces the expressly
rejected alternate `version`, `configuration_sha256`, or `binary_sha256`
interpretation. Decision 6 also calls the normalized canonical format id part
of “The mandatory payload,” while the exact schema makes
`normalized_format_id?` conditional: it is omitted when no prepared format is
known without making lineage incomplete. It does not state the never-`null`
optional-member rule. The general IF-D26 citation cannot make this competing
mandatory-payload restatement exact.

### IF-D27 — closed missing-field member-id vocabulary

**Conformant by exact adoption.** Revision 4 says:

> “this ADR adopts ... IF-D26–IF-D34”

IF-D27 therefore supplies the exact top-level ids, dot paths for present
objects, zero-based bracket paths for present array items, whole-array rule,
conditional-member rule, invalid-versus-missing boundary, de-duplication, and
UTF-8-byte-order sorting. ADR Decision 8's older statement that legacy rows
list exact `missingFieldIds` does not redefine or weaken that vocabulary.

### IF-D28 — closed reason codes, precedence, meanings, and base copy

**Conformant by exact adoption.** IF-D28 is adopted by record id, including its
table above: `available`, `needs_republish_recompute`, `needs_preparation`,
`no_package`, `unsupported_format`, `invalid_package`, and
`unsupported_package_schema`, together with their dispositions, meanings,
precedence, and required base UI copy. The ADR's existing “Needs
republish/recompute” legacy copy is compatible and does not create another code
or precedence rule.

### IF-D29 — publication identity and generation authority

**Non-conformant.** IF-D29 requires:

> “`publication_generation` is the checked next PhotoLab journal command
> sequence and is identical in lineage, manifest, ready record, publication
> record, and committed journal entry.”

It also fixes the ready schema id as
`hcad.product-import-package-ready@1`, derives `publication_id` and non-null
`manifest_id` from the ordered four-element canonical JSON preimage, copies
dataset ids from admitted prepared datasets, makes every resource id equal its
SHA-256, and closes resource/artifact roles.

ADR Decision 5 still says only that the ready record contains generic
`schema_id`, “product id and version,” “publication generation,” and summary
hash/count fields. It omits `missing_field_ids`, does not name the ready-record
schema literal, does not identify the journal as generation authority, and
does not state the id derivation, dataset/resource-id rules, or closed roles.
Because Decision 5 is itself the normative publication/ready-record
restatement, the scope citation leaves two unequal descriptions of that
record.

### IF-D30 — exact DEM facts and resources

**Conformant.** The new IF-D30 bullet is a strict restatement of the decision:

> “`product_kind: "dem"` requires `PhotoLabDemFactsV1` with `elevationZ`, exact
> `RasterInterpolation`, exact `RasterConnectivity`, explicit source NoData
> semantics, the mandatory validity resource, and a connectivity resource for
> mask connectivity”

It also preserves the same-facts/resources binding to canonical Grid and the
prepared Raster root, and the requirement that an incomplete DEM publication
has `package: null` and is not Available. Combined with revision 4's adoption
of IF-D30 and its exact named `PhotoLabDemFactsV1` shape, this closes rather
than relaxes the earlier IF-D19 DEM constraints. Nothing in the older IF-D19
restatement supplies a default or permits inference.

### IF-D31 — Pointcloud ownership of prepared Gaussian splats

**Non-conformant.** IF-D31 says:

> “The Pointcloud specification's PhotoLab-arrival registry row is
> authoritative for `hcad.gaussian-splat-cloud@1`”

and explicitly requires revision 4 to remove revision 3's stale unresolved-
owner wording. Decision 10 still states:

> “proposed `hcad.gaussian-splat-cloud@1`; owner unresolved in Pointcloud”

and:

> “Deferred until Pointcloud explicitly accepts ownership”

Those statements directly contradict the adopted no-owner-choice rule.

### IF-D32 — ordinary manifest and ordered merged-alignment lineage

**Non-conformant.** IF-D32 requires an ordinary `potree@2` point-cloud product
row for overlap or shared-control merged alignment, with the merge entity id,
version hash, `lineage_sha256`, at least two ordered `{id, sha256}`
`source_alignment_inputs`, and no mixed-kind V1 value.

Decision 10 claims IF-D19 is restated “row by row” but has no merged-alignment
row. Decision 6 mentions only a source alignment id and version/content hash
and contains neither `source_alignment_kind` nor
`source_alignment_inputs`. The scope citation therefore coexists with an
incomplete local format/lineage restatement and does not meet the requested
Decision-10 zero-freedom boundary.

### IF-D33 — resident lineage with `package: null`

**Non-conformant.** IF-D33 requires every post-contract publication record to
retain the complete hash-bound lineage envelope even when its required package
member is exactly `package: null`; the five-field legacy relation is only a
read-only projection and can produce only `partial` or `unknown`.

ADR Decision 8 instead defines `complete` as requiring “every post-contract
mandatory field and package hash,” which excludes the complete-lineage/no-
package state. The Consequences section also says:

> “How the existing five-field product lineage record relates to
> `ProductLineageV1` is not decided here”

That directly conflicts with IF-D33's now-adopted read-only-projection
decision.

### IF-D34 — canonical `Decimal64` and model epoch authority

**Non-conformant.** IF-D34 requires every logical manifest/lineage `f64`,
including
`FrozenCrsEndpointV1.horizontal.coordinateEpoch.decimalYear`, to be a canonical
`Decimal64` JSON string. It also requires preserving original lineage bytes and
never rounding, normalizing, or writing the projected epoch back into the
authoritative transformation model.

ADR Decision 2 says only:

> “no floating-point manifest values”

It does not state the `Decimal64` encoding, the `coordinateEpoch.decimalYear`
case, or the prohibition on writing the projected epoch back to the source or
destination model. Decisions 3 and 7 protect package truth and provenance bytes
but do not close model-epoch write-back. The scope citation is therefore not a
strict Decision-2 restatement of IF-D34.

## Previously conformant revision-3 edits

The diff from revision 3 (`5e54e9f`) to revision 4 changes only the adoption
scope/history paragraph, adds the IF-D30 bullet, and expands the primary
reference. Therefore the revision-3 conformance results remain unchanged:

- Decision 10's original thirteen IF-D19 disposition rows and the
  no-independent-adoption boundary are unchanged.
- The former five-field projection question remains unchanged. It was
  conformant to IF-D19 at revision 3, but IF-D33 now resolves that question and
  makes the retained “not decided here” sentence a new conflict.
- The original IF-D19 DEM, orthomosaic, prepared-hierarchy, and decoder/label
  constraints are unchanged; IF-D30 adds a compatible DEM requirement.
- The full IF-D21 release gate is unchanged.
- The IF-D20/IF-D23/IF-D24/IF-D25 governing-reference-only wording is
  unchanged.
- The mirrored DATA-MODEL paragraph and PROJECT-FORMAT change record are
  unchanged.

No previously conformant text was silently weakened by the revision-4 diff;
the non-conformance comes from adopting new records without reconciling stale
or incomplete local restatements.

## Markdown and verification

The committed revision-4 blob is exactly unchanged by Prettier's Markdown
formatter. `git diff --check 5e54e9f 78db9ee --
docs/adr/0030-photolab-product-import-package-and-provenance.md` reports no
whitespace errors. Fences, lists, headings, block quotes, and the disposition
table remain structurally balanced. No new malformed Markdown appeared.

Verification was documentation-only. I read the repository direction,
documentation authority map, active agent feedback, the pinned ADR blob, the
revision-3 report and diff, and the authoritative PhotoLab package/provenance
schemas and IF-D26–IF-D34 records. No source, build, application, or network
operation was needed. The only repository write made by this check is this
report.

## Residuals

1. Reconcile Decision 6 with IF-D26's exact `{id, sha256}` ordered identity
   arrays, conditional `normalized_format_id?`, and omitted-never-`null`
   optional members.
2. Make Decision 5 state IF-D29's exact ready-record schema id and fields,
   journal-authoritative generation, deterministic id derivation, dataset and
   resource ids, and closed roles.
3. Replace Decision 10's unresolved Gaussian-splat owner text with IF-D31's
   authoritative Pointcloud ownership.
4. Add IF-D32's ordinary-manifest merged-alignment row and ordered merge-lineage
   fields to the corresponding Decision 10/lineage restatement.
5. Reconcile Decision 8 and Consequences with IF-D33's complete resident
   lineage plus `package: null` and its now-decided five-field legacy
   projection.
6. Make Decision 2 explicitly adopt IF-D34's canonical `Decimal64` strings,
   `coordinateEpoch.decimalYear`, original-byte preservation, and prohibition
   on model-epoch rewrite.
