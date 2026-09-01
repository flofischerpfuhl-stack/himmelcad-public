# Himmel:CAD Cap documentation

Cap is an implemented Flutter mobile MVP for Android and iOS. It captures field
sessions into `.hcap` packages for PhotoLab. Field validation and release
hardening remain open.

| Document                                               | Purpose                                          |
| ------------------------------------------------------ | ------------------------------------------------ |
| [`PRODUCT.md`](PRODUCT.md)                             | Product boundary, audience, and success criteria |
| [`ROADMAP.md`](ROADMAP.md)                             | Remaining field-validation and release work      |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                   | Implemented runtime and platform boundaries      |
| [`FORMAT.md`](FORMAT.md)                               | `.hcap` v1 package format                        |
| [`PHOTOLAB-IMPORTER.md`](PHOTOLAB-IMPORTER.md)         | Canonical PhotoLab import behavior               |
| [`UI-BRIEF.md`](UI-BRIEF.md)                           | English mobile UX and state model                |
| [`GNSS-RTK-ALGORITHMS.md`](GNSS-RTK-ALGORITHMS.md)     | Positioning research and algorithm constraints   |
| [`ADR 0027`](../adr/0027-himmelcap-capture-product.md) | Accepted product decision                        |

Implementation: `apps/cap/`. Interactive historical prototype:
`apps/cap-prototype/`. Schemas: `schemas/himmelcap/`.
