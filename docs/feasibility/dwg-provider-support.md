# Canonical DWG provider support

## Implemented boundary

`hcad.io.acadrust-dwg@1` is the sole DWG import provider. It binds the pinned
MPL-2.0 fork at `vendor/acadrust/`, performs bounded magic/size/hash checks,
parses inside a panic boundary, and writes a private ASCII DXF intermediate.
That intermediate enters the existing canonical DXF mapper. It does not create
a DWG entity model, Builder importer or renderer.

The revision corpus generates one exact LINE entity for each acadrust revision
signature AC1012, AC1014, AC1015, AC1018, AC1021, AC1024, AC1027 and AC1032
(DWG R13 through R2018), imports all eight, validates the canonical package and
passes the shared viewer contract. Truncated input and pre-cancellation are
negative gates. The parser is limited to 512 MiB source bytes, two million
entities, ten thousand diagnostics and a 2 GiB private DXF intermediate.

Unknown entities and acadrust `NotImplemented`/`NotSupported` diagnostics are
never silently discarded. They require explicit acceptance of the stable loss
codes `hcad.loss.dwg.unknown-entity@1` and
`hcad.loss.dwg.parser-diagnostic@1`. Source SHA-256, signature, parser version,
entity/diagnostic counts, accepted losses and intermediate length are retained
as immutable provenance.

## Deliberate limits

The revision signature is not a claim that every application/entity family in
that revision is supported. Broader support requires independent real-world
corpora and malformed/fuzz-like cases per entity family. DWG export remains
unregistered even though acadrust contains writer code: no product export is
advertised until independent-application round trips prove geometry,
properties, layers, blocks, units and coordinate fidelity. When that gate is
absent, the precise product behavior is import-only—not a lossy fake export.

Fork provenance, update policy and source-distribution obligations are in
[`acadrust-fork-provenance.md`](acadrust-fork-provenance.md),
[`../adr/0026-vendored-acadrust-dwg-boundary.md`](../adr/0026-vendored-acadrust-dwg-boundary.md)
and `vendor/acadrust/VENDOR.md`.
