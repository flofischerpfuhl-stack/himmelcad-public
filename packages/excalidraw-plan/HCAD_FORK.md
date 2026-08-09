# HimmelCAD Excalidraw plan fork

Shallow clone of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) **v0.18.0**
for the Builder **Plan** subtool.

## Intent

- Primary PowerPoint-like interaction and sheet-composition engine for Plan
- Physical paper formats and multi-sheet chrome supplied by `@himmelcad/plan`
- Group → library items with typed frame/title-block/stamp metadata
- Preserve and extend Excalidraw's selection, transform, snap and align behavior
- **No** PDFium continuous reload path
- Dimensions / point labels stay in the 3D **view**, not here

The Excalidraw scene is authoritative for interactive sheet composition. It is
never authoritative for canonical CAD entities, model coordinates,
georeferencing or physical scale. The Plan wrapper owns those semantics and
stores versioned model-view descriptors with generated vector/raster artifacts.

## Layout

- Upstream monorepo lives in this directory (`packages/excalidraw-plan`)
- Product package: `packages/@himmelcad/plan` (paper, library JSON)
- UI host: `apps/builder` Plan island

## Product status

The maintained TypeScript source is the Builder runtime. The published
`@excalidraw/excalidraw@0.18.0` package supplies the pinned third-party dependency
graph only; it is not the editor runtime or stylesheet authority. Finite paper,
host toolbar actions, grouped library insertion and HimmelCAD theme variables are
connected through the host contract below.

Further fork work is deliberately compatibility-focused: upstream security fixes,
bundle splitting and progressively replacing export simplifications documented in
`docs/implementation-plans/plan-editor-export-fidelity.md`.

## Maintained changes

### 2026-07-20 — Plan host contract

- Builder Vite aliases the Excalidraw, math and utils runtime modules directly
  to this source tree. The registry package remains only the pinned
  lockfile/dependency source while TypeScript and SCSS come from this fork.
- `ExcalidrawImperativeAPI.executeAction(name)` exposes already registered
  Excalidraw actions to HimmelCAD's PowerPoint-like toolbar. Alignment,
  distribution, z-order, grouping and undo/redo therefore continue to use
  Excalidraw's implementation instead of a parallel host implementation.
- `himmelcad.ts` defines the finite-paper viewport clamp and theme-variable
  bridge. Physical dimensions still come from `@himmelcad/plan`; the fork only
  receives derived scene bounds.

Files changed from upstream v0.18.0:

- `packages/excalidraw/types.ts`
- `packages/excalidraw/components/App.tsx`
- `packages/excalidraw/index.tsx`
- `packages/excalidraw/himmelcad.ts` (HimmelCAD addition)

Upstream attribution and the MIT license remain unchanged.
