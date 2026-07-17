# Current Direction (execution lanes)

Status: binding for parallel agent work as of 2026-07-17.  
Does not replace ADRs. When this file and older roadmap prose disagree on
**what to implement now**, this file wins for sequencing and scope freezes.

## Active product focus

1. **Foundation stage A** — finish and gate the shared viewer core defined by
   ADR 0016/0017 before expanding product or entity-catalog breadth.
2. **HimmelCAD PhotoLab, Builder and WeltView integration** — consume the same
   stable package facade after stage A; no product-specific renderer fork.
3. **Further CAD and PhotoLab productization** — remains paused until the stage
   A report is complete.

## Foundation stage A

Stage A is the current kernel/viewer sequence and is complete only when
automated gates cover all of the following:

- one mixed view containing Potree point clouds, prepared mesh/TIN and authored
  CAD, with prepared raster/splat content on the same path where available;
- orbit, pan and zoom with separately calibrated idle and interaction ceilings;
- presentation-only exaggeration, source-coordinate pick/clip/measurement,
  provider-neutral entity placement without buffer rebuild, canonical CAD snaps
  and partition-independent exact sections on the implemented topology path;
- translation commit plus append-only undo/redo without reloading resident
  streaming content;
- a stable package facade for canonical, Potree, prepared mesh/TIN and generic
  prepared hierarchy load, entity visibility and complete unload;
- the ordinary WebGPU/WebGL2 correctness gates and the deliberately rare
  low/mixed scale gate. Mainstream latency is reported honestly and never
  weakened to manufacture a pass.

After all gates pass, report **A reached** and stop adding kernel breadth. App
wiring may then begin minimally; new conformance families remain parked.

**Status 2026-07-17: A reached.** The evidence and the deliberately unchanged
mainstream latency non-pass are recorded in `docs/VIEWER-VERIFICATION.md`.
The owner opened the next decision gate on 2026-07-17: resume the original
canonical-entity and unified-viewer program beyond A. A remains the permanent
regression floor; it is no longer a breadth freeze.

## Post-A viewer/entity program (active)

Work now proceeds in dependency order rather than catalog order:

1. canonical document authority, atomic command journal and project persistence;
2. provider-neutral canonical import/export transactions and immutable resources;
3. remaining canonical resource/definition semantics and CAD/Civil roundtrip;
4. scan, raster, splat, BIM and solid provider depth;
5. remaining viewer presentation, measurement and conformance paths;
6. deliberately scheduled real-data, visual, mixed-scale and native-host gates.

The resumed scope includes the items previously parked only because they did not
block A: additional 3D Tiles/glTF conformance, IFC/BIM and DXF depth, panorama
measurement, block/resource expansion, and native mobile sustained benchmarks.
It does not by itself authorize unrelated product UI or reserved products.

## Parallel work lanes

| Lane | Owns | Avoid |
| --- | --- | --- |
| Kernel / viewer | `crates/**`, `packages/@himmelcad/viewer/**`, entity/render contracts, ADR 0016/0017 implementation | Unrelated PhotoLab panel polish |
| PhotoLab UI | `apps/photolab/renderer/**`, PhotoLab-only UX, later extraction into `@himmelcad/ui` | `crates/**`, viewer/streaming/picking rewrites |
| Shared shell | `@himmelcad/ui`, `@himmelcad/console`, `@himmelcad/theme` | Only with coordination when both lanes need it |

`@himmelcad/data` contracts follow the kernel lane. UI work should adapt or
wait rather than invent parallel type shapes.

## Scope freezes (until an explicit decision gate)

### ChronoGit readiness tax

**Allowed now** (and already desired for undo/scripting):

- command journal,
- immutable content-addressed objects,
- stable entity IDs / revisions,
- rebuildable indexes.

**Frozen until ChronoGit feasibility (roadmap Phase 7 gate):**

- semantic diff product UI,
- merge policies for CAD collaboration,
- Git/LFS product packaging as a ChronoGit feature,
- extra schema complexity that only serves future diffs.

Do not grow the MVP or PhotoLab for ChronoGit productization. Keep the
storage shape compatible; do not implement ChronoGit.

### Reserved products

**HimmelCAD Composer**, **HimmelCAD TestFlight**, and **HimmelCAD ChronoGit**
remain reserved names only. No application directories, no feature work, and no
agent tasks unless the owner opens an explicit decision gate.

Design may keep a future time dimension and command-journal compatibility, but
agents must not generalize every PhotoLab or Builder change for those products.

### Render and entity sources of truth

- Entity semantics: **ADR 0016** (`docs/adr/0016-canonical-entity-model.md`)
  and `crates/himmelcad-core` canonical contracts. Older closed `EntityKind`
  lists are a migration boundary, not the long-term model.
- Renderer: **ADR 0017** is the permanent direction: one Rust/wgpu render core,
  canonical entities, one global streaming/residency policy, f64 source/project
  coordinates and WebGPU plus WebGL2 backends of the same engine. Do not add a
  Three.js, Potree or Cesium provisional engine and do not couple high-end
  quality ceilings to low-end hardware.
- Import/export publication: **ADR 0018**; providers stage one validated canonical
  package and never mutate a viewer or legacy project store directly.
- Mutable entity authority: **ADR 0019**; document commands, view attachment and
  tile residency are three distinct lifecycles.

### Resumed after stage A

- additional legacy 3D Tiles/glTF metadata corpora;
- IFC/BIM depth, DXF catalog breadth, panorama measurement and block expansion;
- hatch/linetype catalog expansion beyond the current contract;
- native mobile sustained benchmarks.

PhotoLab panel polish and Builder feature-CAD tools remain in their product/UI
lanes. An audit finding is implemented according to the dependency order above;
none may weaken an A invariant or turn a large-data provider into an in-memory
shortcut.

## Document authority

| Topic | Canonical file |
| --- | --- |
| Day-to-day agent rules | `AGENTS.md` |
| What to build *now* / freezes / lanes | `docs/CURRENT-DIRECTION.md` (this file) |
| Product family and long-term scope | `docs/PRODUCT-VISION.md` |
| Phase history and exit criteria | `docs/ROADMAP.md` (partially historical until rebaselined) |
| Accepted architecture decisions | `docs/adr/*` |
| Still-open product choices | `docs/OPEN-QUESTIONS.md` |

PhotoLab product detail remains in `photolab/PHOTOLAB-CONCEPT.md` and
`photolab/implementation-plan.html`.

## Design system

Visual rules for all products: `docs/DESIGN-SYSTEM.md`.
Shared modules: `packages/@himmelcad/ui` (IslandTabs, OverlayChip, Checkbox,
Select, EmptyState, ExpandChevron, CrsTransformPair, shell).
Tokens + light/dark: `packages/@himmelcad/theme/src/tokens.css`.
