# ADR 0030 revision 5 conformance re-check — 2026-09-02

Document class: report / verification evidence

Revision checked: commit `459dc4e221971698262b53da5104d9714f076c2c`
(`docs(adr): ADR 0030 revision 5 — restate IF-D26, IF-D33 and IF-D34
rules verbatim`). This report checks the committed ADR blob, not later
working-tree text.

Authoritative comparison text:
`docs/builder-program/specs/import-formats/import-formats.md`, section
“PhotoLab product datasets — 2026-09-02,” including the exact wire schemas,
canonical-decimal rules, publication and legacy-state rules, disposition
table, and decision records IF-D26–IF-D34.

## Standard applied

This re-check applies the same zero-design-freedom standard as
`docs/adr/0030-conformance-recheck3-2026-09-02.md`. Exact adoption by record id
is effective only where the ADR has no competing local restatement. A local
mandatory shape, definition, or row must be verbatim or a strict and complete
restatement; a scope citation does not cure contradictory or materially
incomplete local text.

## Overall verdict

**Non-conformant.** Revision 5 resolves IF-D34. It does not fully resolve
IF-D26, IF-D29, IF-D31, IF-D32, or IF-D33. IF-D27, IF-D28, and IF-D30 remain
conformant. No searched stale phrase remains verbatim, but equivalent stale
design freedom remains in Decision 10, and Decision 10 is no longer a Markdown
table when parsed.

## Per-residual verdicts

### IF-D26 — exact identity arrays and optional-member encoding

**Non-conformant.** Revision 5 now correctly says:

> “a `?` member is omitted, never `null`; every unmarked member is present”

and:

> “`algorithms`, `configurations`, and `tools` as always-present ordered
> identity arrays of `ProductLineageIdentityV1 { id: string, sha256: Sha256 }`
> (IF-D26), repeated invocations kept as repeated entries”

Those statements match IF-D26's ordered `{id, sha256}` identity arrays and
omitted-never-`null` optionals. The immediately following local description is
still introduced as “The mandatory payload” and still includes:

> “product entity id, exact entity version and content hash, publication
> generation, kind, label, dataset label, and normalized canonical format id”

The specification instead defines
`normalized_format_id?: NormalizedFormatId` and says it is omitted for an
unsupported or unprepared publication without making lineage incomplete. The
ADR therefore still has two incompatible local statements about whether that
member is mandatory. The exact identity-array and general optional-member
parts are repaired, but the prior IF-D26 residual is not closed as a whole.

### IF-D29 — ready schema and publication identity authority

**Non-conformant.** Revision 5 correctly adds the ready schema literal:

> “schema id `hcad.product-import-package-ready@1`”

It also correctly restates the journal authority and shared generation:

> “`publication_generation` is the checked next PhotoLab journal command
> sequence and is identical in lineage, manifest, ready record, publication
> record, and committed journal entry”

and the ordered deterministic identity derivation:

> “`publication_id` and a non-null package's `manifest_id` equal `"product-" +
sha256(canonical_json([source_project_id, product_entity_id,
product_entity_version_hash, publication_generation]))`”

The dataset-id, resource-id, and closed-role rules are also present. However,
Decision 5 still claims to enumerate what the ready record contains while
omitting the required `missing_field_ids` member and using non-wire names
“product id and version,” “normalized format,” “manifest hash,” and “lineage
hash and status” instead of the exact schema members. IF-D29 and the adopted
schema require the exact `ProductImportPackageReadyRecordV1` shape, including
`product_id`, `product_version_hash`, `normalized_format_id`,
`manifest_sha256`, `lineage_object_sha256`, `provenance_status`, and
`missing_field_ids`. The schema id and authority/derivation sub-residuals are
fixed, but the competing incomplete ready-record restatement remains.

### IF-D31 — Pointcloud-owned prepared Gaussian splat

**Non-conformant.** The dedicated splat line now says:

> “`hcad.gaussian-splat-cloud@1`; Pointcloud (authoritative owner per its
> PhotoLab-arrival registry row, IF-D31)”

and:

> “Eligible only after common data-model and package/provenance admission; no
> owner choice remains”

That matches IF-D31. A later Decision 10 line still describes
`himmelcad-prepared-hierarchy@1` as applying to:

> “eligible raster and mesh rows above, plus splat only after owner acceptance”

IF-D31 expressly leaves no owner choice after the authoritative Pointcloud
registry row. The retained “owner acceptance” condition therefore preserves
the same forbidden design freedom under different wording.

### IF-D32 — ordinary merged-alignment manifest and ordered inputs

**Non-conformant at the requested Decision 10 row.** The added text contains
the required substance:

> “Ordinary product-import manifest as any eligible `potree@2` point cloud
> (IF-D32); lineage identifies the merge entity (id, version hash,
> `lineage_sha256`) and `source_alignment_inputs` carries at least two `{id,
sha256}` identities in published input-alignment order; V1 does not represent
> a mixed overlap/shared-control merge”

This is a strict substantive restatement of IF-D32. It is not, however, a row
in the Decision 10 table. The preceding eight table-looking lines are indented
as a code block; the merged-alignment line is one of six pipe-delimited lines
without a table header or delimiter and parses as ordinary paragraph text.
Because the prior residual specifically required the corresponding Decision 10
row, and Decision 10 claims IF-D19 is restated “row by row,” revision 5 has not
closed the row-level residual.

### IF-D33 — resident lineage with `package: null` and legacy projection

**Non-conformant.** Revision 5 correctly states:

> “every post-contract publication writes the complete hash-bound lineage
> envelope in `PhotoLabProductPublicationRecordV1`; if no package exists the
> required member is exactly `package: null`, with no fabricated manifest id or
> zero hash”

and resolves the former open projection question:

> “the legacy five-field relation is only a read-only projection that can
> produce `partial` or `unknown`, never `complete` or reconstructed history”

The Consequences section repeats both rules compatibly. Decision 8 nevertheless
retains this definition:

> “`complete` means every post-contract mandatory field and package hash exists
> and validates”

That definition excludes IF-D33's complete-lineage publication with
`package: null`. Package readiness and lineage completeness are independent in
the specification. The new exact statement and the old contradictory
definition coexist, so the residual remains.

### IF-D34 — canonical `Decimal64` and model epoch authority

**Conformant.** Decision 2 now states:

> “every logical `f64` in a package manifest or lineage payload, including
> `FrozenCrsEndpointV1.horizontal.coordinateEpoch.decimalYear`, is a canonical
> JSON `Decimal64` string”

It further fixes the conversion as the finite binary64 value's shortest
round-tripping ties-to-even decimal, expanded without exponent notation and
normalized by the specification's exact rule, then states:

> “packages preserve the original lineage bytes and never round, normalize, or
> write the projected epoch back into the authoritative transformation model”

Decision 6 also says the coordinate epoch is never rewritten in the model.
Together with exact IF-D34 adoption, this closes the encoding, original-byte
preservation, and no-model-epoch-rewrite requirements without an alternate
rule.

## IF-D27, IF-D28, IF-D30, and revision-3 preservation

- **IF-D27 remains conformant.** Revision 5 adds a compatible local
  restatement of the exact member-id vocabulary, conditional/invalid boundary,
  de-duplication, and UTF-8-byte-order sorting. Its conformance result is
  unchanged, although the ADR blob is not textually unchanged.
- **IF-D28 remains conformant.** Revision 5 adds a compatible local
  restatement of the closed codes and adopts the specification's disposition,
  meaning, precedence, and base-copy table. Its conformance result is
  unchanged, although the ADR blob is not textually unchanged.
- **IF-D30 remains conformant and its Decision-level DEM bullet is byte-for-byte
  unchanged from revision 4.** No default or inference was introduced.
- The previously conformant revision-3 normative content is unchanged in
  substance outside the intended IF-D26–IF-D34 reconciliation. The original
  Decision 10 table structure is not preserved: revision 5 reindents its first
  eight rows into a code block and leaves the remaining lines outside a table.
  Therefore revision-3 Markdown structure cannot be confirmed unchanged.

## Stale phrases, design freedom, and Markdown

The committed ADR contains zero case-insensitive matches for each requested
stale phrase:

- `owner unresolved`
- `Deferred until Pointcloud`
- `not decided here`
- `each with stable id, version`

Their exact removal does not establish zero design freedom. The retained “plus
splat only after owner acceptance” condition conflicts with IF-D31; the
mandatory normalized-format bullet conflicts with IF-D26; the incomplete
ready-record enumeration conflicts with the exact ready schema; and Decision
8's package-hash definition conflicts with IF-D33.

`git diff --check 78db9ee 459dc4e --
docs/adr/0030-photolab-product-import-package-and-provenance.md` reports no
whitespace error, and Prettier 3.8.3 emits the committed blob unchanged.
Nevertheless, a CommonMark parse confirms that Decision 10 is structurally
broken: the first eight intended rows are a code block, the next six intended
rows are one paragraph, and the closing sentence is another code block. The
document is therefore mechanically formatter-clean but not clean Markdown for
its intended table structure.

Verification was documentation-only. I read the repository direction,
documentation authority map, active agent feedback, the revision-3 report, the
authoritative IF-D26–IF-D34 schemas and decisions, and the ADR blobs/diffs at
revisions 3, 4, and 5. I also checked stale-phrase counts, whitespace, Prettier
stability, and CommonMark rendering. No source, build, application, or network
operation was needed. The only repository write made by this check is this
report.

## Residuals

1. Remove `normalized_format_id` from Decision 6's mandatory list or state its
   exact conditional presence rule so it cannot compete with IF-D26.
2. Replace Decision 5's prose inventory with the exact ready-record member
   names and include `missing_field_ids`.
3. Remove the residual splat “owner acceptance” condition from Decision 10 so
   Pointcloud ownership has no second gate or owner choice.
4. Restore Decision 10 as one valid Markdown table and make the merged-alignment
   text an actual row.
5. Redefine `complete` independently of package presence so complete resident
   lineage with `package: null` satisfies IF-D33.
