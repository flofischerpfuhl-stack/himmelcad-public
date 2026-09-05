# Plan editor export fidelity

Status: current implemented export contract. Limitations listed here are part
of the contract until code and verification update them together.

The Plan editor exports a deterministic multi-sheet SVG/PDF bundle and a machine-readable
`*-fidelity.json` report. PNG is rendered from the SVG in the active browser.

The report is part of the export contract. It contains a schema version, the frozen PlanDocument hash,
counts, target capabilities and per-sheet/per-element warnings. Export does not silently claim complete
Excalidraw fidelity.

Current boundaries:

- SVG keeps rectangle, ellipse, diamond, polyline/arrow/free-draw paths and text as vectors. Roughness,
  rotation, arrowheads, bindings and advanced fill styles are simplified. Image elements are bounds-only
  placeholders until file embedding is implemented. Text uses browser sans-serif fallback metrics.
- PDF keeps rectangles, polylines/free-draw paths and text as vectors with exact physical page boxes.
  Ellipses and diamonds are currently omitted and reported per element. Colors, fills, rotations,
  arrowheads and advanced styles are simplified; images are bounds-only and text uses built-in Helvetica.
- PNG inherits SVG fidelity. Browser canvas, OS font rendering and device scale can change pixels, so PNG
  is explicitly reported as non-deterministic even though its SVG source is deterministic.

The `.hcplan` file remains the editable authority. SVG, PDF and PNG are delivery artifacts and must not be
used as round-trip document formats.

## Planned change: Plan authority and exchange (not implemented)

Status: planned by the Builder completion program (plan-editor PE-D7 and
PE-D13, registry 2026-09-02). Until code and verification change together,
the current contract above remains in force: `.hcplan` is the editable
authority today.

Planned contract: the canonical Plan root, sheets, elements, viewports,
templates, bindings, and schedules live in the project journal; `.hcplan`
becomes a versioned exchange package only and is never project authority.
Import validates and previews identifier/version collisions, then commits one
transaction or none. Export reads a captured exact Plan revision. PDF/SVG/PNG
and print outputs consume frozen capture artifacts, including exact
entity/resource revisions, fonts, view state, and raster/mesh preparation;
preflight and publication use platform jobs, bounded restart, cancellation,
atomic target publication, and retained heavy-undo inputs. Preview labels are
not publication guarantees, and stale captures require an explicit refresh
before export.
