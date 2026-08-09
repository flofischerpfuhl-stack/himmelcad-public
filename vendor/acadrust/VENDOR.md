# HimmelCAD acadrust fork inventory

- Upstream: <https://github.com/hakanaktt/acadrust>
- Upstream version: `0.4.1`
- Exact upstream commit: `f249c2f816acf36ee51cd5533716bdd443c2517e`
- Source archive: crates.io `acadrust-0.4.1.crate`
- Archive SHA-256:
  `d96c49ac7520273f8fb65865995efca78f5d75fdaf11d3ba3c87114f6496b941`
- License: Mozilla Public License 2.0; see `LICENSE` in this directory.
- Imported: 2026-07-20.

The archive's `.cargo_vcs_info.json` independently records the same commit.
Later unversioned changes from upstream `main` are intentionally excluded.

## File-level boundary

Every upstream source file in this directory remains MPL-2.0. Changes to those
files are recorded below and distributed in source form with the corresponding
release. HimmelCAD provider, canonical admission, sandboxing and product UI
code stay outside this directory under the repository's normal license.

The archive contained
`src/docs/OpenDesign_Specification_for_.dwg_files.pdf`. It is deliberately not
vendored or distributed: the archive does not establish a redistribution grant
for that separately authored specification, and the parser does not require it
at runtime.

## HimmelCAD modifications

None at initial import. Hardening changes must add the file path and rationale
to this section before they are merged.

## Support claims

The upstream README's DWG revision list is not a HimmelCAD support promise.
Each advertised revision and entity family must pass the bounded corpus,
fuzzing, deterministic-diagnostics and canonical-fidelity gates in the shared
IO provider. Unsupported or lossy entities are reported through the normal
loss plan.
