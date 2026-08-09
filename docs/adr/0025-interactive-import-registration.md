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

The shared registration UI uses PhotoLab's chat-led sequence for every
canonical provider: probe, explain the detected format, choose one applicable
placement method, stage, interact/review and commit. Product hosts provide the
live source and project views; they do not fork the conversation or the
registration state machine. Format profiles only constrain affordances:

| Format family              | Default                 | Additional reviewed affordances                                         |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| LAS, LAZ, E57 point clouds | fresh point pairs       | source coordinates, manual placement, bounded ICP                       |
| IFC BIM                    | origin + project north  | source coordinates, manual placement, geometry pairs, bounded ICP       |
| DXF, DWG CAD               | origin + project north  | source coordinates, manual placement, CAD geometry pairs                |
| LandXML Civil              | source coordinates      | origin + north, manual placement, surface/alignment pairs               |
| GeoTIFF/COG                | embedded source mapping | manual placement, raster sample pairs                                   |
| SLPK/I3S                   | source coordinates      | manual placement, prepared-mesh pairs, bounded ICP                      |
| Gaussian splats            | source coordinates      | manual placement and point pairs when the renderer supplies exact picks |

Point-cloud point picking is a first-class dual-view operation. A source pick
must be followed by exactly one project pick before another source pick is
accepted. Committed project point clouds are materialized in the target view
through the same streamed Potree residency path; they are not copied into UI
memory. Format profiles never authorize implicit reprojection, unit conversion
or scale correction.

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
