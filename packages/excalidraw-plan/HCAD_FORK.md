# HimmelCAD Excalidraw plan fork

Shallow clone of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) **v0.18.0**
for the Builder **Plan** subtool.

## Intent

- Fixed paper formats (not infinite canvas) — see `@himmelcad/plan` paper config + island chrome
- Group → library items
- Strong snap / align (extend natively in this tree)
- **No** PDFium continuous reload path
- Dimensions / point labels stay in the 3D **view**, not here

## Layout

- Upstream monorepo lives in this directory (`packages/excalidraw-plan`)
- Product package: `packages/@himmelcad/plan` (paper, library JSON)
- UI host: `apps/builder` Plan island

## Next fork edits (in this tree)

1. Constrain scene bounds to paper rectangle
2. Disable infinite scroll / unbounded zoom out past sheet
3. Library insert for grouped elements
4. Theme to HimmelCAD tokens

Until the monorepo build is wired into pnpm, the Plan island may use the published
`@excalidraw/excalidraw@0.18.0` binary with our paper frame overlay — behavior target is this fork.
