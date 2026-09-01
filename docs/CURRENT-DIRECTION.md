# Current direction

Status: binding execution direction as of 2026-08-16.

This file defines current priority and sequencing. It does not override accepted
ADRs. Completed plans and reports do not regain authority when they contain
older priorities.

## Product priority

1. **Finish PhotoLab as the first released product.** PhotoLab is prioritized
   because its bounded workflow can reach a finished, testable product sooner.
   Release work includes real datasets, cancellation and recovery, offline
   runtimes, packaging, installation, visual quality, and honest reports.
2. **Keep Builder as the flagship product.** Builder is the long-term center of
   Himmel:CAD: a 3D-first Civil CAD with first-class 2D construction. Builder
   work proceeds where it completes shared platform integration, canonical IO,
   document commands, registration, properties, and essential CAD workflows.
   Broad feature expansion must not displace the PhotoLab release goal.
3. **Advance shared infrastructure when it directly serves the products.** Core,
   renderer, IO, UI, automation, project format, and Python SDK remain shared.
   No app receives a private canonical store, renderer, importer, or command
   model.
4. **Maintain Cap and WeltView without creating competing product programs.**
   Cap has an implemented Flutter MVP and `.hcap` pipeline; further hardening is
   driven by field validation. WeltView consumes the same read-only project and
   renderer contracts as Builder.

## Active boundaries

- Canonical entities and commands: ADR 0016 and ADR 0019.
- Unified Rust/wgpu renderer: ADR 0017. New work uses
  `@himmelcad/viewer/kernel`; the Three.js surface is migration-only legacy.
- Provider-neutral import/export: ADR 0018.
- Interactive import registration and unattended PhotoLab execution are
  separate lifecycles. A running PhotoLab batch never requests user input.
- Automation: ADR 0024. UI, Python, and AI use the same canonical queries and
  commands.
- Shared UI: `docs/DESIGN-SYSTEM.md` and `@himmelcad/ui`.

## Scope freezes

Himmel:CAD ChronoGit, Assembler, and TestFlight remain reserved names. Do not
implement their product surfaces without an explicit owner decision.

Allowed future-compatible foundations are limited to capabilities already
needed by active products: stable IDs, immutable objects, journaled commands,
rebuildable indexes, and clean shared boundaries. Do not add diff UI, merge
policy, simulation schema, manufacturing kernels, or other speculative product
complexity.

## Completion discipline

A feature is not complete because a code path or UI exists. Its relevant user
flow, conflicting-operation behavior, cancellation, failure recovery,
persistence, automation surface, sibling-app impact, and proportional tests must
be resolved or explicitly reported as remaining work.
