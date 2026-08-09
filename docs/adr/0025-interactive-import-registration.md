# ADR 0025: Interactive import registration is a reviewed pre-commit lifecycle

- Status: Accepted
- Date: 2026-07-20
- Depends on: ADR 0018, ADR 0021

## Context

Canonical format providers must remain app-neutral, while survey, scan and BIM
imports may need CRS selection, an origin and project-north bearing, manual
placement, fresh point pairs or optional ICP. Publishing provider output before
that decision makes the temporary placement project truth and complicates undo,
audit and restart behavior.

## Decision

Builder and PhotoLab use the common `@himmelcad/app` I/O and registration
facades. A provider-selected import is first staged below a host-owned temporary
root. Registration owns it until one of two terminal outcomes:

1. cancellation deletes the temporary provider artifacts without a canonical
   mutation; or
2. a reviewed, accepted preview composes one entity-level `Transform3d`, adds a
   hash-bound aggregate registration audit and publishes the complete package
   through one canonical command.

Persisted `RegistrationRecipe@1` values contain the method and reusable
parameters. `PointPairs` and `ICP` recipes require fresh interaction on every
run. Viewport picks and sampled ICP points live only in the transient session;
they are not serialized into the recipe. ICP is bounded to prepared samples,
reports progress, supports cancellation and never runs implicitly.

`OriginAndProjectNorth` defines project north as the clockwise bearing of model
`+Y` from project `+Y`. It is converted to a right-handed Z rotation and composed
outside any existing IFC/product placement.

Site-calibration import fails closed. HimmelCAD accepts its own
`hcad.site-calibration@1` JSON and explicit named text parameters with declared
rotation units. It does not infer semantics from opaque proprietary `.dc`
binary data.

## Consequences

- Provider probing/version freezing and format options have one implementation.
- The existing separate horizontal/vertical and joint transform specs remain
  unchanged; registration composes after those resolved stages.
- BIM geometry bytes and streamed point-cloud tiles can stay immutable while
  project placement changes.
- Registration audit retains the transform and aggregate residual/overlap
  diagnostics, but reusable recipes cannot replay stale picks.
- Streamed staged datasets and resource sets are exposed only through the
  ephemeral `hcad-staged://` host protocol. The sidecar verifies immutable
  hash, length, media type and safe canonical containment before Electron
  receives opaque resource IDs. Reads are range- and request-bounded and the
  capability is revoked on cancel, commit, sidecar restart and product-host
  teardown.
- Potree imports produced from LAS/E57 expose deterministic bounded root-node
  samples with dataset, resource-hash and existing-placement provenance. The
  dual-view host may use point-to-point ICP, or point-to-plane ICP when the
  target mesh supplies transformed face normals.
