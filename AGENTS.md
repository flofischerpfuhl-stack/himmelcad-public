# Himmel:CAD agent principles

Himmel:CAD is a family of applications primarily for construction and civil
engineering. Himmel:CAD Builder is the flagship: a 3D-first Civil CAD with
first-class 2D construction support. Himmel:CAD PhotoLab is the tactical first
release because it can become a finished product sooner. The products share the
canonical core, renderer, automation contracts, and visual language wherever
their domains allow it.

Before a non-trivial implementation, read `docs/CURRENT-DIRECTION.md` and use
`docs/README.md` to locate the authoritative document for the affected area.
Accepted ADRs override older plans and reports.

## Principles

- Correctness, data integrity, and security are non-negotiable. Within those
  boundaries: performance > intuitive UX > aesthetics.
- Import and preprocessing may be expensive; interaction after loading must be
  fast. Large data stays streamed, bounded, and incremental.
- Treat every change as a system change. Trace interactions, shared state,
  lifecycle, persistence, undo/redo, cancellation, and failure recovery. Decide
  explicitly which operations may run concurrently and which must be
  coordinated, serialized, or rejected.
- Trace the complete change surface before finishing: callers, consumers,
  sibling apps, shared packages, commands, context menus, automation protocol,
  Python SDK, formats, migrations, documentation, and tests. Report relevant
  follow-up work that is intentionally out of scope.
- Prefer shared core, renderer, command, and UI modules over app-specific
  implementations. Check whether sibling apps should reflect the same change.
- Product UI is English. Use the shared design system, tokens, typography,
  casing, and controls. Never ship unstyled browser, Electron, or platform
  defaults; preserve native semantics and accessibility beneath custom styling.
- Design the complete user flow: discovery, confirmation, cancellation,
  closing, recovery, and contextual access. Every user-facing capability needs
  a visible UI entry; entity-relevant commands should also be considered for
  context menus. Keep UI copy concise.
- Product capabilities and state-changing operations use canonical query and
  command contracts so UI, Python, and AI agents do not diverge.
- Work that is not effectively instant needs visible activity. Longer work
  reports meaningful progress and must be cancellable with bounded response
  time.
- Never invent coordinates, heights, CRS transformations, scale, or other
  domain truth. Source data remains authoritative until an explicit command
  changes it.
- Follow `docs/DEPENDENCY-POLICY.md` before adding dependencies or vendored
  code.
- Validate every implementation proportionally to its risk and report what was
  and was not verified.
- Apply active owner corrections from `docs/AGENT-FEEDBACK.md`. Keep this file
  short; detailed rules belong in their authoritative documents.
