# ADR 0001 — Initial Application Stack

## Status

Accepted. Runtime bridge revised during implementation: Builder uses a
separate sidecar process over JSON-RPC rather than an in-process NAPI module.
The browser/WASM direction remains unchanged.

## Date

2026-05-02

## Context

Himmel:CAD Builder must be a 3D point-cloud-first CAD application with very
large datasets, a precise cursor coordinate system, segmentation, and future
support for meshes, Gaussian splats, BIM/IFC entities, browser viewing,
semantic diffs, scripting, and simulations.

The first idea was an Electron app based on a forked Potree foundation. The
existing `libs/` folder contains:

- `polyshapev01` as visual/prototype reference,
- `CloudCompare-master` as algorithmic inspiration only,
- `vscode-dark-islands-main` as aesthetic reference.

The chosen stack must keep the MVP from becoming a dead-end prototype.

## Decision

Use:

- Electron for Builder desktop shell,
- Vite browser app for WeltView,
- TypeScript + React for UI,
- Zustand for UI mirror state,
- CSS variables/Tailwind-style design tokens for theming,
- three.js for rendering,
- modular Potree/pnext-inspired point-cloud loading instead of monolithic
  Potree v1 application state,
- Rust for authoritative core,
- separate `himmelcad-sidecar` process spoken to via JSON-RPC 2.0 over stdio
  from Electron (crash isolation, same pattern as the later PhotoLab Python
  sidecar),
- wasm-bindgen bridge for WeltView, hosted in a Web Worker,
- `.hcad/` folder storage plus `.hcadx` bundle export,
- BSL 1.1 for own code,
- no GPL-family code in the product.

## Rationale

Electron is heavier than Tauri, but it provides a stable Chromium runtime. For a
WebGL/WebGPU-heavy CAD where the viewer must later run in a browser, predictable
Chromium behavior is more important than smaller binaries.

React and TypeScript are chosen because the UI will be complex: ribbon,
collapsible panels, tree views, command panels, consoles, multi-view tabs, and
future scripting/inspection tools. Strong typing and mature tooling matter more
than minimal framework size.

Rust is chosen for import, indexing, spatial queries, commands, storage, and
future geometry algorithms. The shared model must be usable from the Builder
sidecar and from a browser-compatible WASM surface for WeltView.

The renderer is deliberately independent from Electron. This avoids a future
rewrite for WeltView and prevents desktop-specific APIs from leaking into core
viewer behavior.

The data model is content-addressed and command-journaled from day one because
undo/redo, segmentation, and ChronoGit all need immutable references and
semantic history.

## Alternatives Considered

### Tauri

Pros:

- smaller app,
- Rust-native shell,
- good security defaults.

Cons:

- relies on system webviews,
- WebGL/WebGPU compatibility less predictable,
- Linux WebKitGTK is risky for a 3D-heavy CAD.

Rejected for now.

### Native UI / Slint

Pros:

- small and native-feeling,
- Rust-friendly.

Cons:

- worse reuse for WeltView,
- less direct access to three.js/splat/WebGL ecosystem,
- more custom renderer integration work.

Rejected.

### Vanilla JS Continuation of v01

Pros:

- fastest first visible progress,
- existing prototype assets.

Cons:

- high long-term maintenance cost,
- poor architectural discipline for command/state/history,
- harder testing/refactoring.

Rejected.

### Full Potree v1 Fork

Pros:

- proven point-cloud viewer,
- many features already exist.

Cons:

- app-level assumptions not shaped like CAD,
- harder to integrate cleanly with React, command journal, and entity model,
- future splat/mesh/BIM architecture would be constrained by inherited state.

Rejected as application foundation. Potree concepts and permissively licensed
modules remain useful.

## Consequences

Positive:

- MVP architecture can grow into WeltView, PhotoLab outputs, ChronoGit, and
  TestFlight.
- Heavy compute lives outside the renderer and outside the Electron main
  process.
- The same data contracts support desktop and browser.
- Undo/redo and semantic diffs are designed in early.
- A sidecar crash does not take down the editor.

Negative:

- MVP takes longer than continuing v01.
- Build tooling is more complex.
- Sidecar + WASM dual-target Rust requires discipline.
- More up-front architecture must be maintained.
- Sidecar IPC adds a small per-call latency vs. in-process NAPI; acceptable
  because hot-path rendering does not call the sidecar per frame.

## Guardrails

- Renderer packages may not import Electron.
- Rust core may not assume desktop filesystem access in browser-targeted code.
- UI may not mutate project state directly.
- GPL-family code may not be ported or built into the product.
- CRS/import metadata may not become implicit engine reprojection behavior.
