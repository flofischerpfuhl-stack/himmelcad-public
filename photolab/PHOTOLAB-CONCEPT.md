# Himmel:CAD PhotoLab

Status: normative product overview. Detailed algorithm decisions live in ADRs
and focused specifications; implementation status is proven by tests and release
reports rather than this document.

## Product goal

PhotoLab is an offline photogrammetric processing application for aerial,
terrestrial, close-range, mobile, and multi-camera datasets. It is prioritized
as the first finished Himmel:CAD product because its workflow is narrower than
the full Builder product.

PhotoLab produces measurable, reproducible spatial products with explicit
inputs, coordinate decisions, accuracy evidence, processing lineage, and
recovery behavior.

Primary products are:

1. measurable depth images;
2. dense point clouds;
3. DSM and DTM elevation products;
4. orthomosaics;
5. textured terrain and spatial meshes;
6. Gaussian splat datasets.

Calibrated cameras, sparse geometry, control observations, alignments,
optimization runs, reports, and intermediate artifacts remain first-class
project records. Published spatial outputs are normal canonical Himmel:CAD
entities that Builder and WeltView can consume.

## Product principles

- Source images and metadata remain immutable.
- No CRS, vertical reference, grid, scale, camera model, or accuracy is silently
  assumed.
- Local metric projects are valid without inventing a CRS, origin, north, or
  gravity constraint.
- Displayed resolution is not presented as achieved accuracy.
- Processing is hardware-adaptive without silently reducing requested quality.
- All expensive stages are bounded, cancellable, checkpointed where useful, and
  recoverable after process or application failure.
- A result is published only after its complete artifact set and lineage have
  been validated.

## Project model

PhotoLab does not copy the mutable “chunk” model of other applications.

- Capture groups organize one mission or continuous camera setup.
- Calibration groups define which cameras may share intrinsics.
- Processing sets select immutable input scopes.
- Alignment and optimization runs preserve exact configuration and inputs.
- Merge runs connect independent alignments explicitly.
- Product runs reference exact upstream revisions and hashes.
- Jobs represent execution lifecycle and checkpoints, not render entities.

Organization, canonical entities, processing history, and transient worker
state remain separate authorities.

## Workflow

### Import and reference

PhotoLab imports image files, directories, video-derived frames, Cap `.hcap`
sessions, camera metadata, and control data through shared IO contracts.

Horizontal and vertical reference decisions are explicit. Missing grids,
ambiguous axes, unsupported metadata, and transformation loss are surfaced
before execution. Interactive registration completes before a canonical import
transaction commits.

### Alignment

Alignment prepares immutable feature and match artifacts, estimates camera
poses, forms tracks, triangulates sparse geometry, and records calibration and
quality diagnostics.

Classical and learned feature paths may coexist as separate provenanced graphs.
They do not mix incompatible descriptor spaces or hide fallback behavior.

### Control and optimization

GCPs and checkpoints retain source coordinates, roles, uncertainty, and image
observations. Adding or changing an observation refreshes the relevant local
diagnostics. Global bundle adjustment is a separate explicit operation.

Control and checkpoint residuals remain distinct in UI and reports. Covariance,
accuracy, and warning statements identify their assumptions and source.

### Product generation

Depth, dense, raster, mesh, and splat products consume a frozen execution plan.
Every mandatory symbolic input is resolved to an exact artifact before `Run`.
A running batch never opens an editor or requests a new human decision.

## Execution and concurrency

PhotoLab has one authoritative job owner in the Rust sidecar. Electron,
renderers, and workers do not create parallel job identities.

Before two operations overlap, their project scope, immutable inputs, output
targets, compute budgets, disk budgets, and publication boundaries must be
checked.

- Read-only inspection may continue against committed snapshots.
- Independent jobs may run concurrently only within shared CPU, GPU, RAM, VRAM,
  disk, and worker budgets.
- Jobs that publish to the same record, entity, archive, or external target are
  serialized or rejected.
- Project replacement, close, and shutdown coordinate with active jobs and
  recoverable checkpoints.
- Cancellation stops new work, terminates non-cooperative workers within a
  bounded deadline, and leaves committed state unchanged.
- Resume requires exact compatible configuration and input identities.

No UI component infers concurrency safety from separate controls.

## UI and access

PhotoLab uses the shared English Himmel:CAD design system.

- The ribbon exposes major workflows.
- The entity/project tree exposes contextual commands through right-click.
- Active functions use shared task and function surfaces.
- Jobs show state, real progress, pause/resume capability where supported,
  cancellation, and actionable failure information.
- Properties and reports inspect committed records rather than reconstructing
  truth from transient UI state.
- Console, Python, and AI access resolve to the same underlying operations as
  visible UI.

UI copy stays concise. Detailed method explanations belong in contextual help
or documentation rather than permanently consuming workspace area.

## Shared viewer

PhotoLab uses `@himmelcad/viewer/kernel` and the Rust/wgpu render core. It does
not own a PhotoLab-specific renderer, camera, picking system, or residency
policy.

Image workspaces may add product-specific overlays and tools, but canonical
coordinates, selections, measurements, and published spatial products retain
shared contracts.

## Runtime and release boundary

The product ships audited offline worker runtimes for the supported platforms.
Workers may wrap mature permissively licensed tools and models, but they do not
own project state or publication.

Release readiness requires:

- complete license and runtime inventories;
- real-data results and accuracy comparison;
- cancellation and recovery at expensive stage boundaries;
- Linux and Windows package and installation tests;
- English UI and visual-regression coverage;
- deterministic reports and export behavior;
- shared viewer, Builder, WeltView, Python, and agent contract checks where the
  changed capability crosses those boundaries.

## Focused authorities

- PhotoLab foundation and compute: ADR 0005 onward.
- Product viewers and portable MVS: their accepted ADRs.
- GCP and coordinate behavior: ADR 0009, ADR 0023, and focused PhotoLab docs.
- Product lineage and masks: ADR 0012, ADR 0014, and ADR 0015.
- Offline runtimes: ADR 0010 and ADR 0013.
- Canonical entities, renderer, IO, and commands: ADR 0016–0019.
- Automation: ADR 0024.
- Import registration: ADR 0025.
