# Himmel:CAD documentation

This index defines document roles and authority. A document is not normative
merely because it is detailed or old.

## Authority order

1. Repository license and security policy.
2. Accepted architecture decision records in `docs/adr/`.
3. Current normative documents listed below.
4. Product and subsystem specifications.
5. Plans, reports, research notes, and archived evidence.

When two documents at the same level conflict, the more specific document wins.
If they remain equally specific, the newer explicit owner decision wins and the
conflict must be removed rather than documented twice.

## Normative documents

| Topic                                             | Authority                              |
| ------------------------------------------------- | -------------------------------------- |
| Agent implementation principles                   | `AGENTS.md`                            |
| Current priorities, sequencing, and freezes       | `docs/CURRENT-DIRECTION.md`            |
| Product family and product relationships          | `docs/PRODUCT-VISION.md`               |
| Future outcomes and decision gates                | `docs/ROADMAP.md`                      |
| System boundaries and runtime architecture        | `docs/ARCHITECTURE.md`                 |
| Canonical entity and command model                | `docs/DATA-MODEL.md` and ADR 0016/0019 |
| Project storage and migration                     | `docs/PROJECT-FORMAT.md`               |
| Coordinate transformation pipeline                | `docs/TRANSFORMATIONS.md`              |
| Visual language, UX, UI copy, and shared controls | `docs/DESIGN-SYSTEM.md`                |
| Verification tiers                                | `docs/TEST-TIERS.md`                   |
| Dependency and vendoring policy                   | `docs/DEPENDENCY-POLICY.md`            |
| Unresolved owner decisions                        | `docs/OPEN-QUESTIONS.md`               |
| Active corrections to agent behavior              | `docs/AGENT-FEEDBACK.md`               |

## Product and subsystem documents

- PhotoLab: `photolab/PHOTOLAB-CONCEPT.md` and the focused `docs/photolab-*`
  specifications.
- Cap: `docs/himmelcap/README.md`.
- Viewer integration: `packages/@himmelcad/viewer/README.md`.
- Shared UI integration: `packages/@himmelcad/ui/README.md`.
- Python automation: `sdk/python/README.md` and ADR 0024.
- Geometry representation providers:
  `docs/GEOMETRY-REPRESENTATION-PROVIDER.md`.
- Plan editor export: `docs/PLAN-EDITOR-EXPORT.md`.
- Desktop alpha update behavior: `docs/desktop-alpha-updates.md` and ADR 0029.

## Document classes

- **ADR:** an accepted or superseded decision. Do not silently rewrite history;
  add a superseding ADR when the decision changes.
- **Specification:** current exact behavior or format. It must identify its
  version or implementation status.
- **Plan:** proposed future work. It is never evidence that work exists.
- **Report / verification:** evidence from a particular revision and date. It
  must not define current product priority.
- **History:** retained context with no normative authority.

All first-party normative documentation is written in English. Product UI is
also English. Source identifiers, package names, paths, and compatibility names
may retain the unpunctuated `himmelcad` spelling where required.
