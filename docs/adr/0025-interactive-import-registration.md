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

Site-calibration import fails closed. Himmel:CAD accepts its own
`hcad.site-calibration@1` JSON and explicit named text parameters with declared
rotation units. It does not infer semantics from opaque proprietary `.dc`
binary data.

The shared registration UI uses PhotoLab's chat-led sequence for every
canonical provider: probe, choose one of `none`, `transform file`, `horizontal
and height separately` or `horizontal and height together`, stage,
interact/review and commit. Product hosts provide the live source and project
views; they do not fork the conversation or the registration state machine.

Himmel:CAD is CRS-neutral. LAS/LAZ/E57 metadata may be retained for audit, but
the UI never infers a usable source CRS from it. Every CRS operation requires
an explicit source and target decision. The joint path selects horizontal and
vertical endpoints in one decision; the separate path collects the same two
decisions in explicit order. A geoid or horizontal/vertical grid is an
operation input, not a file-format guess.

Common-point registration is available for every renderable format with exact
picking. Format profiles only add provider-specific preparation controls:

| Format family       | Provider-specific preparation                                                         |
| ------------------- | ------------------------------------------------------------------------------------- |
| LAS, LAZ            | no inferred CRS; streamed point picking and bounded root-node samples                 |
| E57                 | scan/pose handling before the same point-cloud registration path                      |
| IFC BIM             | preserve product placements; explicit fallback/loss approval                          |
| DXF, DWG CAD        | no layer-selection step; explicit unsupported-content/loss approval                   |
| LandXML Civil       | declared units and civil-coordinate metadata review                                   |
| GeoTIFF/COG         | raster/elevation interpretation and elevation discontinuity threshold                 |
| SLPK/I3S            | layer choice only when the package actually contains multiple admissible scene layers |
| Meshes and other 3D | exact geometry picks; bounded point-to-cloud ICP after a coarse placement             |
| Gaussian splats     | point pairs when the renderer can return an exact source pick                         |

Point picking is a first-class dual-view operation. A source pick
must be followed by exactly one project pick before another source pick is
accepted. Committed project point clouds are materialized in the target view
through the same streamed Potree residency path; they are not copied into UI
memory. Format profiles never authorize implicit reprojection, unit conversion
or scale correction. ICP is a refinement, never the initial placement.

Transform files persist replayable parameters and immutable provenance. Files
that only describe an interactive method cannot replay old viewport picks.
After a point-pair fit the accepted similarity/translation parameters may be
saved as `hcad.site-calibration@1`; the point observations themselves remain
transient.

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
- Potree imports produced from LAS/E57 and live committed project point clouds
  expose deterministic bounded root-node samples with dataset, resource-hash
  and existing-placement provenance. The dual-view host may use point-to-point
  ICP against a point cloud, or point-to-plane ICP when the target mesh supplies
  transformed face normals.
