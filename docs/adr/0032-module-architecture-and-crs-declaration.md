# ADR 0032 — Module architecture and the CRS as a declaration

## Status

Accepted by the owner on 2026-09-23. Implementation proceeds in steps on
`main`; PhotoLab R1 release work continues on `release/photolab-r1`.

## Context

The platform decisions of ADR 0016–0019, 0022 and 0024 hold: Rust owns the
canonical project, one wgpu renderer serves every product, providers adapt
formats, and UI, Python and AI share one command contract. The code has not
followed those decisions into module boundaries:

- `himmelcad-sidecar` is one crate and one binary with ~117,000 lines. Its
  `main.rs` (~13,600 lines) dispatches all 152 protocol methods, ~100 of them
  PhotoLab-only. `himmelcad-core` mixes the canonical model with 16
  `photolab_*` modules.
- Hardware knowledge is spread over five places in three languages
  (`himmelcad-render::hardware_policy`, `sidecar::hardware_runtime`, the job
  memory plan in `core::photolab_jobs`, and Electron GPU switches in both app
  hosts).
- Builder and PhotoLab compose their UI in single files (`App.tsx`, ~7,100 and
  ~5,600 lines) and wire ribbon commands by hand beside the generated command
  table.
- The legacy Three.js path still lives in 19 viewer files.

The owner's goals add two requirements: products and future standalone apps
(split out of the owner's fernwork.net project) are composed from a selection
of modules, and a fix for one class of hardware must not touch the renderer
used by all others.

## Decision

### 1. Modules and allowed dependencies

Himmel:CAD is built from the modules in `docs/ARCHITECTURE.md` § Module map.
Dependencies point only downward through the layers
Products → Interface → Command gate → Domain modules → Foundation → Display
support (the renderer depends on the foundation's model and on the hardware
profile, never on domain modules or products). An automated check enforces the
direction for Rust crates and TypeScript packages.

- **Foundation and display modules are shared** by every product: model,
  document, transform, IO, spatial, command gate and jobs, hardware profile,
  renderer, UI library, tools, client, scripting.
- **Domain modules are selectable.** A product or standalone app is a
  composition: a list of domain modules plus a layout. A domain module
  registers its commands, jobs, panels and tools; it never edits another
  domain module or the composition of a product.
- **The sidecar becomes a thin host.** A small kernel (protocol, command
  registry, jobs, project store) links the domain crates a product selects.
  Protocol method dispatch comes from registrations, not from one central
  `match`.
- **AI builds on scripting.** The agent can do exactly what the automation
  protocol allows a Python client to do, under the trust rules of ADR 0024; it
  has no private access path.
- **Plugins run out of process.** Third-party code (for example a Python
  library that blurs people in scan panoramas) runs in its own process with
  granted rights and reaches the project only through the automation protocol.
  Bulk data moves by bounded leases, not by copying projects.

### 2. The CRS is a declaration; HimmelCAD computes at scale 1

- Every project computes in one Cartesian system with metric (or declared
  imperial) linear units at scale 1. Latitude/longitude never appear inside a
  project; there is no grid scale factor and no angular distortion in any
  measurement, construction, volume or display.
- The project CRS (horizontal and vertical) is metadata that says what the
  numbers mean. It does not change any computation.
- Real CRS transformations (datum, projection, geoid, grid) are explicit,
  journaled operations at the boundary: import, registration, export. PhotoLab
  georeferencing is such a boundary operation. Rotations and translations of
  local frames (cross-sections, station views) are ordinary geometry.
- Consequence, accepted by the owner: data kept in projected grid numbers
  (for example ETRS89/UTM) measures grid distances; 1.000 m in HimmelCAD is one
  grid metre. Users who need ground distances transform into a local site
  system on import.

### 3. Hardware profile

One hardware module detects the machine (GPU, driver, memory, cores, display
session), keeps per-device quirk rules, and hands budgets to the renderer and
to jobs. Device-specific fixes are rules in this module; the renderer consumes
capabilities and never tests for a vendor or model itself.

## Consequences

- Restructuring runs in bounded steps on `main`, each green before the next:
  dependency check, sidecar split, hardware profile, removal of the legacy
  Three.js path. The Builder UI redesign follows and moves interaction logic
  out of `App.tsx` into the tools module.
- PhotoLab release evidence stays valid on `release/photolab-r1`; fixes there
  are ported to `main` after the split.
- `docs/TRANSFORMATIONS.md` states the CRS rule; ADR 0025 registration flows
  remain the place where transformations are chosen.
- Supersedes nothing; it makes ADR 0016–0019 and 0024 enforceable as module
  boundaries.
