# Himmel:CAD program milestones from 2026-07-19

Status: archived execution snapshot. Completion statements apply only to the
recorded revision and gates. This file has no authority over current product
priority or unfinished release validation.

Status: M0–M10 completed; M11 implementation completed; final integrated
release verification in progress. Architecture authority remains with the
accepted ADRs. This document resolves product sequencing and the reviewed
boundaries across Viewer, PhotoLab, Builder and shared infrastructure.

## Outcome

Himmel:CAD is completed through one shared canonical platform, not through
product-specific entity, IO, render or automation implementations. The active
program contains milestones M0 through M11 below. Work follows dependency
order; independent Viewer and PhotoLab slices may proceed in parallel after M1.

The owner authorized autonomous execution of the complete program. Existing
data, uncommitted work and irreversible external actions remain protected.
When an implementation detail is not product-defining, prefer the conservative,
reversible and versioned choice and record it instead of blocking for input.

Implementation status on 2026-07-20:

- M0 through M10 are completed.
- M11's product implementation and component-level acceptance gates are
  completed.
- The continuous finished-product gate remains open until the full release plan
  has passed on runners owning the required browser-GPU, real-data, Linux
  package and Windows package capabilities. A missing capability is not a pass.

## Binding boundaries

### One canonical IO module

- Import and export providers belong to `himmelcad-io` and publish or consume
  canonical entities through ADR 0018 transactions.
- Builder and PhotoLab only contribute product UI and domain-specific input
  selection. They must not implement private format parsers, entity stores or
  direct viewer publication paths.
- Provider capabilities, probe results, option schemas, loss plans, progress,
  cancellation and atomic publication use one shared facade.
- `acadrust` is forked at an exact upstream commit into `vendor/` and hardened
  as the DWG provider. Corpus, fuzz and license gates determine supported DWG
  revisions and entity fidelity, not whether the fork is adopted. Its files
  remain isolated and attributed according to MPL file-level requirements.
- SLPK/I3S is a provider for the shared prepared hierarchy and unified renderer,
  never a second viewer.

### Import registration is not PhotoLab batch execution

There are three separate lifecycles:

1. **Canonical IO** probes, decodes, validates and stages source data.
2. **Interactive import/registration** resolves CRS choices, point pairs,
   manual placement and optional ICP refinement before the canonical import
   transaction commits. A reusable recipe stores methods and parameters, never
   stale picks or silent approval.
3. **PhotoLab batch execution** consumes a completely configured immutable
   execution plan. After `Run`, it never requests user input.

The PhotoLab recipe editor may expose typed symbolic input slots and allow the
user to connect a particular imported DEM or another project artifact before
execution. A concrete run freezes exact entity revisions, object hashes and
configuration. Missing or ambiguous mandatory bindings make the recipe not
ready and disable execution; they do not become interactive runtime nodes.
Running batches support progress, cancellation, checkpoint/resume and clear
failure reporting only.

### 3D, 2D and 2.5D

- `3D` is the ordinary orbit/perspective scene.
- `2D` and `2.5D` share the same locked top-down camera, plan-only visibility,
  ranked snap providers and winning geometry target.
- `2D` deliberately removes height from the winning snap result and reports
  `z: null`. `2.5D` retains the same snap result's source height when available.
  It does not select or invent a separate reference surface.
- Switching between 2D and 2.5D changes acquisition semantics, not scene
  content. The load/reveal transition is between 3D and either plan mode.
- Leaving plan mode unlocks the current view at the same target, scale and
  north orientation. It does not restore an older orbit orientation.
- Raster placement distinguishes unknown plan height, explicit constant
  elevation and a real elevation/depth authority.

### PhotoLab reference and adjustment behavior

- Non-georeferenced reconstructions may be first-class local metric projects.
  A scale constraint establishes metres without inventing a CRS, origin, north
  direction or gravity constraint.
- Every accepted GCP observation immediately refreshes that point's local
  triangulation, residual estimate, covariance and predicted image projections
  using the currently fixed camera state. Global bundle adjustment remains a
  separate explicit operation.
- Intrinsics defaults are decided from primary photogrammetric literature,
  observability diagnostics and real Golden datasets during M4. The current
  documentation conflict between fixed and refined shared intrinsics must not
  be resolved by UI convention or blind trust in manufacturer metadata.

### Excalidraw-first plan composer

- Excalidraw is the primary interaction and canvas engine for the independent
  plan-composer prototype: selection, transforms, grouping, snapping, drawing,
  text and responsive canvas behavior are not rebuilt from scratch.
- Himmel:CAD wraps it with paper/sheet semantics, physical units, templates,
  title blocks, stamps, model-view descriptors, scale rules, persistence and
  deterministic export.
- Canonical model geometry and georeferencing remain outside Excalidraw. Model
  views enter a sheet through versioned descriptors or generated vector/raster
  elements; Excalidraw does not become the canonical CAD entity store.

### Automation and agents

- Automation uses a versioned language-neutral protocol and the same canonical
  queries, commands and journal as the product UI.
- Python runs out of process in a managed local environment. Large arrays use
  bounded bulk-data leases rather than JSON copies.
- Network access is off by default. File and project capabilities are explicit;
  destructive commands require approval.
- Agent chat discovers installed CLI harnesses. A pinned, attributed T3 Code
  vendor slice may supply provider adapters, event normalization, virtualized
  message rendering and scroll anchoring; it is not a second project authority.

## Milestones

### M0 — Rebaseline and verification policy

Status: completed.

- Record the reviewed boundaries in binding docs/ADRs.
- Split verification into changed, commit, push and release tiers.
- Remove the English UI audit from ordinary PhotoLab typecheck.
- Add automatic path/risk escalation and test-duration reporting.
- Preserve existing Foundation-A/V1–V6 Viewer gates as the regression floor.

### M1 — Shared app control plane

Status: completed.

- Wire canonical document snapshots, commands, CAS revisions and durable
  journal into Builder and the shared app facade.
- Add schema-aware property queries and atomic multi-entity edits.
- Expose generic IO registry/probe/options/loss-plan/import/export operations.
- Define versioned view state/control and automation protocol boundaries.
- Keep attachment, residency and document lifetime separate per ADR 0019.

### M2 — Streaming performance

Status: completed.

- Add real cold/warm/back-pan telemetry and reproducible point/mesh gates.
- Pool bounded file handles and coalesce/deduplicate compatible ranges.
- Add a globally budgeted RAM-warm tier.
- Introduce provider-neutral physical pages and immutable GPU-ready artifacts.
- Add compact point layouts, reusable GPU buffer arenas and bounded prefetch.
- Preserve additive point coverage and atomic replacement coverage for meshes.

### M3 — View modes and plan presentation

Status: completed.

- Implement the reviewed 3D/2D/2.5D semantics in shared viewer contracts.
- Admit and prewarm plan-only representations without inventing height.
- Coordinate camera and representation transitions without blank frames.
- Correct Builder adapters that currently collapse `z: null` or use
  presentation coordinates as source truth.

### M4 — PhotoLab GCP and calibration correctness

Status: completed.

- Show all relevant GCPs in an image while retaining one focused marker.
- Preserve magnification and center the focused marker during image changes.
- Add context creation/assignment of manual observations.
- Implement immediate local triangulation and covariance propagation.
- Replace heuristic error ellipses with projection-Jacobian covariance.
- Research, document and expose per-calibration-group intrinsics policies.

### M5 — General capture and local scale

Status: completed.

- Gate real smartphone, system-camera, RAW and HEIC/HEIF datasets end to end.
- Add explicit camera-profile and decode/transcode capability handling.
- Add local metric scale constraints over triangulated endpoints.
- Treat video as an immutable source with versioned, quality-selected frames
  feeding the ordinary image pipeline.

### M6 — PhotoLab recipe graph and product IO

Status: completed.

- Extend the typed DAG with versioned external artifact ports.
- Make DEM and other product inputs explicit and provenance-bound.
- Implement an Excalidraw-style or dedicated node editor only as a recipe
  configuration UI; execution remains fully unattended.
- Ship reusable standard recipes and exact import/export product mappings.

### M7 — Builder IO, registration and IFC

Status: completed.

- Consume the shared IO facade instead of Builder-specific import paths.
- Productize the common transform wizard without disturbing the reviewed
  separate horizontal/vertical versus joint ordering.
- Add point-pair and manual placement workflows, then bounded ICP refinement.
- Reach reliable IFC display, selection and measurement on the Alte Akademie
  real-data gate before semantic IFC editing/writing breadth.

### M8 — Builder view tools and properties

Status: completed.

- Add scoped Viewing Box manipulation that composes with other clip tools.
- Replace the fixed Function panel with persistent Properties plus named tool
  tabs.
- Add schema-aware shared/mixed/unavailable multiselect properties and atomic
  match/batch edits with one undo step.

### M9 — Format expansion

Status: completed.

- Fork, inventory and corpus-test `acadrust`, then publish DWG through the
  canonical provider contract.
- Add SLPK/I3S import through the shared hierarchy and renderer.
- Prioritize additional providers by fidelity and user value rather than by
  filename count; no format may bypass loss reporting or canonical admission.

### M10 — Plan composer prototype

Status: completed.

- Build the PowerPoint-like, Excalidraw-first sheet experience.
- Add multi-sheet paper, templates, title blocks, stamps and reusable groups.
- Add model-view placeholders/descriptors, physical scale and deterministic
  PDF/SVG/image export while remaining independently usable.

### M11 — Python SDK and agent chat

Status: implementation completed; final integrated release verification in
progress.

- Generate sync and async Python clients from the automation contract.
- Provide paginated entities/properties, command transactions, bulk geometry,
  camera/view control and screenshots.
- Gate stale generated SDK output before relevant pushes.
- Add the virtualized agent-chat panel and installed-harness adapters last.
- Keep provider credentials in the Electron main process. A harness receives
  neither the secret nor general network access: optional Codex provider egress
  is mediated by a host broker restricted to the exact audited HTTPS origin and
  Responses API route.
- Stage the managed CPython runtime from hash-pinned archives and wheels for
  Linux and Windows, remove installers, probe the installed packages and emit a
  reproducible runtime inventory before package certification.

## Continuous finished-product gate

Every milestone owns its user-facing completion details rather than postponing
all polish to the end: project recovery and migrations, deterministic undo,
cancel/resume, errors and empty states, keyboard/accessibility, persistent
layout/view state, logs and support bundles, offline/runtime inventory,
packaging, install tests, documentation and measured performance.
