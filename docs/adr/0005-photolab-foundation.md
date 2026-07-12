# ADR 0005: PhotoLab App Foundation and Frozen Processing Profiles

- Status: accepted
- Date: 2026-07-11

## Context

PhotoLab is the current product focus and must become a separate desktop
product while reusing the Builder UI, viewer, data contracts and Rust
sidecar. Its first implementation slice needs to establish the permanent
command boundary before image import and compute workers land.

Alignment exposes quality profiles, but a queued run must never depend on a
profile name whose meaning can change after an update. Windows/Linux and
AMD/NVIDIA/CPU also require one fachlich identical configuration contract.

## Decision

1. PhotoLab lives in `apps/photolab` as its own secure Electron app.
2. It imports `@himmelcad/ui`, `@himmelcad/viewer`, `@himmelcad/data`,
   `@himmelcad/theme` and `@himmelcad/console`; these packages remain
   Electron-free.
3. Electron-specific code may live below each desktop product's `electron/`
   directory. It does not enter shared renderer packages.
4. The Rust core owns alignment-profile resolution. The UI sends a profile
   request and receives a complete immutable `ResolvedAlignmentConfig` with a
   deterministic SHA-256 configuration hash.
5. `QualityHybrid` is the release default: ALIKED/LightGlue and SIFT/LightGlue
   match every candidate pair independently. Large learned and dense rescue
   backends remain explicit resolved policies.
6. Hardware changes work-unit sizes and concurrency only. It does not silently
   rewrite the resolved fachliche quality configuration.
7. Every future queued run persists the resolved configuration, not only the
   profile name.

## Consequences

- PhotoLab can evolve independently without forking the viewer controls or
  Dark-Islands components.
- Old runs remain reproducible when profile defaults change.
- CLI, UI and later Python SDK can resolve the same profile through the core.
- Actual image matching, model packaging and worker execution remain later
  slices, but cannot invent a second configuration model.
