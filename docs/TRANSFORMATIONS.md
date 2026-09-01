# Coordinate transformations

Status: current subsystem contract. The Rust types and tests remain the exact
implementation authority.

## Purpose

Himmel:CAD transforms world-space points through one reusable pipeline. File
providers are adapters: they stream positions into the pipeline and rebuild or
invalidate dependent bounds, indexes, tiles, normals, georeferencing, and
derived products. A display-only matrix must never silently replace a data
transformation.

## Canonical boundary

- `himmelcad-core::transform` owns serializable specifications, validation,
  frozen audit records, empirical models, and residual reports.
- `himmelcad-sidecar::transform_runtime` resolves offline PROJ operations,
  inspects grids, freezes specifications, and applies point batches.
- World coordinates remain `f64`; render-relative `f32` is never authoritative.
- A frozen transform records ordered stages, grid identity, policy, domain, and
  user-confirmed choices. Stage order is semantic data.
- Missing grids, invalid domains, non-finite output, or disallowed ballpark
  operations fail explicitly according to the selected policy.

Supported compositions are separate horizontal/vertical stages, a joint 3D
operation, and an explicit hybrid cascade. Current empirical operations include
2D similarity, 2D affine, 3D similarity, and 3D translation. Do not advertise
planned ICP, site-calibration parsers, or local free-form deformation as
implemented until their contracts and tests exist.

## Lifecycle and coordination

Interactive registration follows ADR 0025: draft, preview, validate, freeze,
then commit through canonical IO. Unattended execution accepts only a complete,
immutable specification and never opens interactive input.

Independent read-only previews may run concurrently. Operations that publish
to the same project or replace the same entity revision must be coordinated by
the command/transaction boundary. A newer preview cancels or supersedes its
older preview; stale results must not publish. Long applications stream bounded
batches, report real progress, check cancellation between batches, and leave no
partially published entity.

## Product integration

Builder, PhotoLab, and automation use the same specification and execution
contract. UI labels, context actions, console commands, Python bindings, and AI
tools are views over that contract, not separate implementations. Each adapter
must test coordinate accuracy, cancellation, atomic publication, invalidation,
and format-specific rebuilding.

Related authority: ADR 0012, ADR 0018, ADR 0021, ADR 0025, and
`docs/PROJECT-FORMAT.md`.
