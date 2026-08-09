# Specs & Plan — implementation status (independent v0)

Started after review defaults (2026-07-18).

Rebased after owner review (2026-07-19): the plan prototype is
**Excalidraw-first**. Excalidraw remains the primary sheet interaction engine;
HimmelCAD supplies paper units, multi-sheet metadata, model-view descriptors,
templates and deterministic exports around it. See
`docs/PROGRAM-MILESTONES-2026-07-19.md`.

## Independence

Neither feature is wired to HimmelCAD core entities, layers, or the render viewer yet.
Both are Builder subtools (task islands), English UI, local persistence.

## Specifications (`@himmelcad/specs`)

- Hierarchical **integer codes** (1–10 digits): e.g. `1` → `11` / `12` / `13`
- Fields: **name**, **code**, **drawFolder** (path segments for future model/view placement)
- Per **entity kind** presentations (point / curve / area / …)
- Hierarchy: **linetypes → hatches → textures → materials → specs**
- Materials: color/hatch/texture/linetype + **extensible attribute table** (no physics)
- Sample hatches inspired by common CAD/Revit draft fills
- LocalStorage library + Export JSON
- Builder: **Output → Specifications**

## Plan (`@himmelcad/plan` + Excalidraw)

- **Not** infinite canvas: A0–A4, Letter, Tabloid, Custom mm; portrait/landscape
- Excalidraw for the complete PowerPoint-like sheet interaction: selection,
  draw/text/shapes/images, grouping, transforms, snapping and responsive canvas
- **Source fork** tree: `packages/excalidraw-plan` (v0.18.0) + `HCAD_FORK.md`
- Group → local **library** (insert later)
- No model/view import; no dimensions/point labels (view domain)
- No PDFium continuous-reload path
- Builder: **Output → Plan**

## Next (when you return)

1. Add a thin `PlanDocument` wrapper with physical paper and multi-sheet state
   while keeping Excalidraw scene coordinates and interactions intact
2. Add paper bounds, page navigation and export clipping around the canvas
3. Build frame/title-block/stamp libraries as ordinary selectable Excalidraw
   groups plus typed HimmelCAD metadata
4. Add model-view descriptors and deterministic PDF/SVG/image export
5. Add the Spec attribute editor and later bind `drawFolder` to the model tree
