# Himmel:CAD roadmap

This roadmap describes future product outcomes and decision gates. Current
execution order lives in `docs/CURRENT-DIRECTION.md`; completed execution logs
belong in history or verification reports.

## R1 — PhotoLab first release

Outcome: a finished offline photogrammetry product for Linux and Windows.

Required gates:

- complete workflows from import through published products;
- real-dataset accuracy and quality evidence;
- deterministic lineage, reports, project recovery, and resume;
- bounded cancellation across every expensive stage;
- audited offline runtimes and license inventories;
- installable packages and update behavior on supported platforms;
- English UI, shared design-system conformance, accessibility, and visual tests;
- PhotoLab outputs open through canonical contracts in Builder and WeltView.

## R2 — Builder product completion

Outcome: the flagship 3D-first Civil CAD with complete 2D, 2.5D, and 3D
construction workflows.

Program areas:

- canonical project, entity, property, command, and undo/redo workflows;
- provider-neutral import, export, registration, and transformation;
- point-cloud, terrain, mesh, raster, splat, BIM, and CAD interoperability;
- construction, snapping, measurement, sections, alignments, and derived Civil
  geometry;
- plan composition, sheets, annotation, and deterministic export;
- discoverable commands through ribbon, contextual surfaces, console,
  automation, and Python;
- large-project performance and crash-safe persistence.

Builder milestones must be defined as user outcomes with integration and
performance gates, not as entity-count or toolbar-count targets.

## R3 — WeltView publication

Outcome: Builder and PhotoLab projects can be published for browser viewing
without a second renderer or data model.

Decision gate: select the supported delivery modes for large projects among
complete download, static range streaming, and a future service. The shared
viewer must remain compatible with all modes until the product decision is made.

## R4 — Cap field hardening

Outcome: the existing Cap MVP becomes a field-validated capture product.

Required evidence includes supported devices, capture reliability, honest GNSS
quality, `.hcap` interoperability, English UI, privacy, package recovery, and
measured PhotoLab results. Marketing accuracy claims require field evidence.

## Reserved decision gates

- **ChronoGit:** proceed only if semantic CAD diffs solve demonstrated user
  problems. Until then, no diff or merge product.
- **TestFlight:** proceed only after a simulation-product feasibility decision.
- **Assembler:** proceed only after proving that the shared foundation fits
  manufacturing better than a separate kernel and product.

No reserved gate may delay active product work.
