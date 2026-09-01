# acadrust fork provenance

Status: pinned provider input. The fork is mandatory; support claims remain gated
by Himmel:CAD's own corpus and fuzz results.

- Upstream: <https://github.com/hakanaktt/acadrust>
- Upstream version: `0.4.1`
- Exact release commit: `f249c2f816acf36ee51cd5533716bdd443c2517e`
- crates.io archive SHA-256:
  `d96c49ac7520273f8fb65865995efca78f5d75fdaf11d3ba3c87114f6496b941`
- License: Mozilla Public License 2.0
- Verification: the crates.io archive's `.cargo_vcs_info.json` names the same
  commit. The pin deliberately excludes later unversioned commits on upstream
  `main`, even though its `Cargo.toml` still says `0.4.1`.

The source will live below `vendor/acadrust/` with its upstream license and
notices intact. Modified upstream files remain MPL-2.0 at file level and are
marked in the fork inventory. Himmel:CAD-specific provider/admission code stays
outside the fork so the license and trust boundary remain obvious.

The fork was materialized on 2026-07-20. The archive's separately authored
Open Design specification PDF was intentionally excluded because the archive
does not establish its redistribution rights; it is not needed at runtime.
Exact fork and modification inventory lives in `vendor/acadrust/VENDOR.md` and
the binding decision is ADR 0026.

Before a DWG revision is advertised, its corpus must prove bounded parsing,
deterministic diagnostics and canonical fidelity for the entity families in
that revision. Unsupported or lossy entities must appear in the normal IO loss
plan; a successful parse alone is not a support claim.
