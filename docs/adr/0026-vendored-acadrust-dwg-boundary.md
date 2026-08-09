# ADR 0026: Vendored acadrust DWG boundary

Status: Accepted (owner decision, 2026-07-19)

## Context

DWG is proprietary and versioned, while HimmelCAD needs an offline,
cross-platform reader that can feed the same canonical IO and renderer paths as
every other format. The young pure-Rust `acadrust` project already implements a
substantial DWG/DXF object model under MPL-2.0. Consuming an unconstrained
moving crate would make parser hardening, malformed-file fixes and exact release
reproduction difficult.

## Decision

HimmelCAD maintains a source fork at `vendor/acadrust/`, pinned to upstream
version 0.4.1 and commit
`f249c2f816acf36ee51cd5533716bdd443c2517e`. The crates.io archive hash and
file inventory are recorded in `vendor/acadrust/VENDOR.md`.

The fork remains an isolated MPL-2.0 file-level component. HimmelCAD-specific
provider, canonical conversion, process limits and UI files remain outside the
fork. Modified fork files are inventoried and distributed with source. A
separately authored DWG specification PDF present in the crate archive is not
vendored because its redistribution rights are not established.

The provider probes and parses through `himmelcad-io`; it never creates a
second entity store or renderer. Version and entity support are advertised only
after corpus and fuzz gates prove bounded parsing, deterministic diagnostics
and canonical fidelity. Parse success alone is insufficient, and every known
loss enters the ordinary export/import loss report.

## Consequences

- Releases are reproducible and fixes can be carried without waiting for an
  upstream release.
- MPL source-distribution and modification tracking become release gates.
- Parser breadth remains conservative until real-data and malformed-input
  corpora justify each support claim.
- Future upstream updates are explicit reviewed diffs against the pinned
  commit, never silent dependency upgrades.
