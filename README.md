# Himmelcad

Himmelcad is a 3D point-cloud-first CAD platform. The first product is
**Himmelcad Polyshape**, followed later by **Photolab**, **Weltview**,
**Chronogit**, and **Testflight**.

The project is designed around three constraints from day one:

- very large 3D datasets must stay interactive,
- Polyshape projects must later be viewable in a browser,
- the data model must preserve enough semantic history for undo/redo and a
  future CAD-diff system.

## Products

| Product | Purpose | Status |
| --- | --- | --- |
| Polyshape | Desktop CAD for point clouds, 3D entities, segmentation, measurement, drawing | MVP first |
| Photolab | Photogrammetry, scan import, georeferencing, Gaussian splat generation | Later |
| Weltview | Browser viewer for Polyshape projects, read-only measurements, IoT overlays | Later |
| Chronogit | Semantic versioning and diffing for CAD projects | Feasibility study first |
| Testflight | Scripted simulations such as runoff, wind, vehicle sweep paths | Feasibility study first |

## Current Direction

- Shell: Electron for Polyshape, static web bundle for Weltview.
- UI: TypeScript, React, Vite, Zustand, Tailwind-style design tokens.
- 3D: three.js plus modular point-cloud loading based on `pnext/three-loader`
  concepts, not a monolithic Potree v1 application fork.
- Core: Rust workspace compiled to NAPI-RS for Electron and WASM for Weltview.
- Storage: hybrid `.hcad/` folder project with `.hcadx` export bundle.
- Data model: immutable, content-addressable entities with command journal.

## Important Files

- `AGENTS.md` — binding project rules and AI-agent instructions.
- `docs/ROADMAP.md` — product roadmap.
- `docs/MVP-PLAN.md` — implementation plan for the first MVP.
- `docs/ARCHITECTURE.md` — system architecture and core trade-offs.
- `docs/DATA-MODEL.md` — entity, attribute, command, and undo model.
- `docs/PROJECT-FORMAT.md` — `.hcad/` and `.hcadx` storage format.
- `docs/adr/0001-stack.md` — first architecture decision record.

## License

Himmelcad is source-available under BSL 1.1. Private, non-commercial forking and
self-building are allowed. Commercial use requires a separate license.

Dependencies must be compatible with this model. GPL/LGPL/AGPL/SSPL code must
not be incorporated into the product. See `AGENTS.md`.
