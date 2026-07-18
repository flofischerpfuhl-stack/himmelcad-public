# Specs & Plan — implementation status (independent v0)

Started after review defaults (2026-07-18).

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
- Excalidraw for draw/text/shapes/images (npm 0.18 for runtime)
- **Source fork** tree: `packages/excalidraw-plan` (v0.18.0) + `HCAD_FORK.md`
- Group → local **library** (insert later)
- No model/view import; no dimensions/point labels (view domain)
- No PDFium continuous-reload path
- Builder: **Output → Plan**

## Next (when you return)

1. Native paper bounds inside the Excalidraw fork (disable infinite scroll)
2. Better multi-select group + snap guides
3. Spec attribute editor UI for free-form key/value
4. Optional later: bind drawFolder to model tree
