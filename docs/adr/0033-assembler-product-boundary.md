# ADR 0033 — Assembler product boundary

## Status

Accepted by the owner on 2026-09-29. Implementation starts with Phase 0
(documentation, license policy, fork-base pin) plus a Shapr3D-like UI shell
without a CAD kernel.

## Context

Himmel:CAD Assembler is a new product: a local desktop CAD focused on
3D-printable parts, aiming to get as close as possible to Shapr3D in
function, UI and interaction (`assembler/OWNER-INTENT.md` U1, U2). The
existing platform decisions (ADR 0016, 0017, 0032) require every product to
share the canonical entity model, the one wgpu render core, and module
composition through the layered dependency direction. Assembler's owner
explicitly accepted the risk that renderer sharing could cause
Assembler-specific pressure to degrade Builder (U7) and proposed forking the
renderer as the current mitigation, while remaining open to a demonstrably
better shared or separate solution later.

Assembler also needs a CAD document/feature history, a geometry kernel
(OCCT, with selected FreeCAD logic under evaluation per `assembler/PLAN.md`
§3), and an agent/Python surface. None of these exist as shared HimmelCAD
modules today, and building them is out of scope for this ADR; this ADR only
draws the product boundary and states which existing mandates it narrows.

Own product code follows the repository's BUSL-1.1 licensing like every
other Himmel:CAD product (U3); this ADR does not change `LICENSE` or
`LICENSING.md`.

## Decision

### 1. Assembler is an active product

Assembler is no longer a reserved name (see `docs/CURRENT-DIRECTION.md`). It
is a local desktop CAD application for 3D-printable parts, with the ambition
to match Shapr3D in functionality, workflow, UI and mouse/touch interaction,
not merely its appearance. Assembler's own source lives under this
repository's BUSL-1.1, on the same terms as Builder, PhotoLab and WeltView
(U3). Builder remains the flagship priority per `docs/CURRENT-DIRECTION.md`;
this ADR does not reorder existing product priorities.

### 2. A product-specific fork of the render core, narrowly

ADR 0016, 0017 and 0032 require Builder, PhotoLab and WeltView to share one
canonical entity model and one wgpu render core, composed from selectable
domain modules. For Assembler only, this mandate is narrowed:

- Assembler may start its renderer from a **fork** of the current HimmelCAD
  render core (`himmelcad-render`, `himmelcad-model`,
  `himmelcad-hardware-profile`, `himmelcad-prepared`) under its own
  crate/package names (for example `assembler-render`) and its own dependency
  graph, pinned per `assembler/FORK-BASE.md`.
- Builder, PhotoLab and WeltView keep the shared renderer unchanged. No
  shared crate, package, build target or CI pipeline is ever pointed at the
  Assembler fork.
- The goal being protected is **U7 (Assembler work must not degrade
  Builder)**. The fork is the current means of protecting that goal, not the
  goal itself. If a shared or differently isolated approach is later shown to
  protect Builder equally well while meeting U2 and U6, it may replace the
  fork through an amendment to this ADR that records the evidence, including
  Builder regression evidence for every shared path it reintroduces.
- Shared theme and UI packages (`@himmelcad/theme`, `@himmelcad/ui`) remain
  shared, not forked. Any change made to them for Assembler must not change
  Builder's behavior; such a change requires Builder regression evidence
  (screenshot/behavior comparison or automated test) before it lands.

### 3. Assembler's CAD history is its own authority

Assembler's CAD document and feature history is its own authoritative store,
independent of the Himmel:CAD canonical civil document core (ADR 0019). The
civil document core is not a prerequisite for Assembler. CAD geometry is
planned via OCCT, with selected FreeCAD logic reused where it reduces effort
(`assembler/PLAN.md` §3). Which of the two variants there — a retained
FreeCAD document/recompute backend, or a selective Rust feature-graph port —
becomes the actual foundation is decided by evidence from the Phase 1
vertical slice, not by this ADR. Exactly one authoritative CAD history exists
per chosen variant; no independently editable FreeCAD document runs beside a
second Assembler history.

### 4. Command/query contract

Assembler follows the canonical command/query contract principle of ADR 0024:
UI, Python and agents act through the same commands and queries rather than
diverging automation paths. The concrete Assembler command/query contract
(scene, features, sketches, body operations, preview/commit/cancel
transactions) is future work, designed alongside the Phase 1 vertical slice.

### 5. Backports are deliberate, never automatic

Fixes found useful in both the Assembler fork and the shared renderer are
backported individually: picked per fix, applied to the target product, and
tested there before landing. There is no automatic synchronization, shared
branch, or scripted merge between the fork and the shared renderer. A
backport into the shared renderer requires Builder regression evidence for
the affected paths (see `assembler/PLAN.md` §4 "Regeln").

## Consequences

- This narrows ADR 0016, 0017 and 0032 for Assembler only: Assembler may
  operate its own renderer fork, its own CAD document authority, and its own
  crate/dependency graph. It supersedes nothing else in those ADRs; Builder,
  PhotoLab and WeltView keep the existing shared-module mandate unchanged.
- `assembler/FORK-BASE.md` records the fork provenance (pinned commit,
  crate list, dependency graph) so the fork's starting point stays
  reproducible and auditable.
- `docs/DEPENDENCY-POLICY.md` needs the conditional-LGPL update tracked
  separately (see the same-day update to that file) before any LGPL
  component (for example ported FreeCAD logic) is actually admitted into the
  Assembler fork or its OCCT/FreeCAD adapter.
- Future backports between the fork and the shared renderer, and any change
  to `@himmelcad/theme`/`@himmelcad/ui` made for Assembler, require Builder
  regression evidence as a landing condition; this is a follow-up process,
  not yet a written test suite.
- The concrete Assembler command/query contract, the OCCT-vs-FreeCAD
  decision, and the actual act of forking (copying/renaming crates under new
  names) remain future work, gated on the Phase 1 vertical slice per
  `assembler/PLAN.md` §6.
