# S-06 command surfaces evidence — 2026-09-04

## Outcome

`G-UIP-CMD` passes for the Release 0.5 command-surface substrate. The authoritative
automation schema `methods` rows now carry command metadata (label, kind,
shortcut, enablement key, five surface flags, group, owner spec, and runtime
host). `scripts/generate-command-table.mjs` derives both the `@himmelcad/app`
runtime table and the CommonJS automation-host table from those same P11 rows;
there is no second hand-maintained command list. The existing Python generator
continues to derive SDK methods from the same schema rows.

The Builder now routes registry shortcuts through the S-03 callback and a
focus-safe window dispatcher, opens registry-fed entity and void surfaces from
the viewport, and uses the same entity surface in the tree. The UIP-D16 submenu
uses S-04's stable candidates and marks the current candidate. Cloud/splat left
click remains inert while RMB preserves the candidate for deliberate selection.
Console help, single-match Tab completion, command-id execution, and renderer
automation dispatch resolve registry entries.

## Files changed by S-06

- `schemas/automation/himmelcad-automation-v1.schema.json`
- `scripts/generate-command-table.mjs`
- `packages/@himmelcad/app/src/generated/commandTable.ts`
- `packages/@himmelcad/app/src/commands.ts`, `src/index.ts`, `package.json`
- `packages/@himmelcad/app/test/commands.test.ts`
- `packages/@himmelcad/console/src/commands.ts`, `src/Console.tsx`, `src/index.ts`
- `packages/@himmelcad/console/package.json`, `tsconfig.json`, `tsconfig.test.json`
- `pnpm-lock.yaml` (workspace-link importer entry only)
- `packages/@himmelcad/automation-host/generated-command-table.cjs`, `index.cjs`
- `packages/@himmelcad/automation-host/test/host.test.cjs`
- `packages/@himmelcad/ui/src/CommandSurfaces.tsx`, `CommandSurfaces.module.css`, `index.ts`
- `packages/@himmelcad/ui/src/EntityTree.tsx`, `package.json`, `tsconfig.test.json`
- `packages/@himmelcad/ui/test/commandSurfaces.test.tsx`
- `packages/@himmelcad/ui/gallery/Gallery.tsx`
- `apps/builder/renderer/src/App.tsx`, `BuilderKernelViewport.tsx`
- regenerated `sdk/python` client, model, manifest, and generator tests
- regenerated ignored gallery captures at
  `packages/@himmelcad/ui/gallery/shots/{dark,light}/command-surfaces.png`

Concurrent S-05b JobsSurfaces/ProgressBar work and V-01 render-crate/viewer-kernel
work were not edited.

## Gates and verbatim results

- `pnpm --filter @himmelcad/app test`
  - `tests 39`, `pass 39`, `fail 0`, `skipped 0`
  - includes generated-table staleness, reachability, runtime shortcut collision,
    point/polyline/mesh/cloud menu content, quick cap, exact console help, and
    three registry automation calls.
- `pnpm --filter @himmelcad/console test`
  - `tests 2`, `pass 2`, `fail 0`, `skipped 0`
- `pnpm --filter @himmelcad/ui test`
  - `tests 30`, `pass 30`, `fail 0`, `skipped 0`
- `pnpm --filter @himmelcad/builder typecheck`
  - exit 0; `tsc -b tsconfig.json tsconfig.typecheck-electron.json`
- `pnpm --filter @himmelcad/photolab typecheck`
  - exit 0; `PhotoLab English UI check passed.`
- `pnpm --filter @himmelcad/automation-host test`
  - `tests 46`, `pass 45`, `fail 0`, `skipped 1`
  - the skip is the pre-existing real-Codex version pin: installed 0.153.2 vs
    required 0.144.5; the generated-registry three-command round-trip passed.
- `pnpm --filter @himmelcad/data test`
  - `tests 3`, `pass 3`, `fail 0`, `skipped 0`
- `PYTHONPATH=sdk/python/src python3 -m unittest discover -s sdk/python/tests -v`
  - `Ran 12 tests in 0.463s` / `OK`; generated Python SDK is current.
- `pnpm --filter @himmelcad/ui gallery:shots`
  - `Captured 58 screenshots for 28 sections`; both command-surface theme images
    were inspected for grouping, header copy, current-candidate mark, and shortcut
    alignment.
- `git diff --check` on the S-06 change surface and
  `node scripts/generate-command-table.mjs --check`
  - exit 0.

## Not verified / follow-up

- No packaged Electron smoke test with a physical point-cloud fixture was run;
  pointer and selection behavior is covered at the store, arbiter integration,
  registry, renderer-host, and static-render levels.
- `pnpm install --lockfile-only --offline` could not run because the local pnpm
  mirror lacks `@types/react-dom@19.2.3`. S-06 adds only a workspace dependency
  and does not require a registry fetch; the lockfile's deterministic workspace
  link entry was updated directly and existing workspace links were used.
- Exact front/right/isometric camera transforms remain owned by the View-domain
  implementation. S-06 supplies the canonical ids and access paths; the current
  minimum Builder handler preserves 3D mode for those presets rather than
  inventing an axis convention.

## Architect review (G17, 2026-09-04 18:30)

Reviewed `gallery/shots/dark/command-surfaces.png`: entity menu grouping, right-aligned mono shortcuts, quick-surface header and cap, candidate submenu with current mark — accepted. One finding → S-06b: in the open-submenu fixture the candidate list renders *below* the parent menu instead of anchored to the right of the "Select under cursor ▸" item; the component must anchor submenus at the parent item's right edge (fallback: left edge when clipped), and the fixture must show that anchoring.

## S-06b — submenu anchoring closure (2026-09-04)

The shared menu submenu now opens from the parent item's right edge with a 2 px
overlap, top-aligned to that item, and flips to the parent's left edge when the
right placement would clip the viewport. ArrowRight opens and focuses the first
submenu item; ArrowLeft closes the submenu and restores focus to its parent.
Hover opening defaults to a tunable 150 ms delay, and the overlapped descendant
surface plus close grace keeps diagonal pointer travel toward the submenu open.

The open-submenu gallery row now renders the parent and candidate menus side by
side. Reviewed regenerated shot:
`packages/@himmelcad/ui/gallery/shots/dark/command-surfaces.png` (light companion:
`packages/@himmelcad/ui/gallery/shots/light/command-surfaces.png`). The serial
gallery run captured 60 screenshots for 29 sections.

S-06b gates:

- `pnpm --filter @himmelcad/ui test`: 32 passed, 0 failed.
- `pnpm --filter @himmelcad/ui typecheck`: exit 0.
- `pnpm --filter @himmelcad/builder typecheck`: exit 0.

## Architect acceptance (G17, 2026-09-05)

S-06b verified in `gallery/shots/dark/command-surfaces.png`: the candidate submenu is anchored at the parent item's right edge, top-aligned, with the current candidate marked. S-06 accepted.

## S-06c — PhotoLab product-row regression closure (2026-09-05)

The generated command table now carries optional product ownership, exact
entity-kind applicability, and multi-selection applicability. Context surfaces
filter those fields together with the existing enablement predicate. Shared
rows remain product-neutral; the two PhotoLab rows are admitted only when the
host identifies itself as `photolab`, so the Builder polyline menu is unchanged.
For a multi-selection, every selected entity must satisfy the row's exact kind
predicate.

`EntityCommandMenu` dispatches every row as
`onExecute(commandId, { entityIds, kind })`. `EntityTree` retains its local
rename/visibility handling and its existing export/properties/zoom-to host
mappings, then forwards every other unhandled id unchanged to
`onContextAction(commandId, entityIds)`. The optional product id defaults to
`builder`; the legacy callback compatibility branch exists only so the
read-only PhotoLab renderer continues to typecheck until its lane opts in with
`productId="photolab"` and the canonical callback mapping.

Exact PhotoLab host wiring:

| Command id | UI label | Existing PhotoLab action |
| --- | --- | --- |
| `photolab.images.remove` | `Remove from project…` | `remove` (continues into the existing `Remove image?` confirmation) |
| `photolab.gcp.images` | `Images containing this GCP` | `showGcpImages` |

S-06c files:

- `schemas/automation/himmelcad-automation-v1.schema.json`
- `scripts/generate-command-table.mjs`
- generated `packages/@himmelcad/app/src/generated/commandTable.ts` and
  `packages/@himmelcad/automation-host/generated-command-table.cjs`
- `packages/@himmelcad/app/src/commands.ts` and `test/commands.test.ts`
- `packages/@himmelcad/ui/src/CommandSurfaces.tsx`, `EntityTree.tsx`, and
  `index.ts`
- `packages/@himmelcad/ui/test/commandSurfaces.test.tsx` and
  `gallery/Gallery.tsx`
- the Builder entity-surface adapter in `apps/builder/renderer/src/App.tsx`
- regenerated ignored gallery captures at
  `packages/@himmelcad/ui/gallery/shots/{dark,light}/command-surfaces.png`

The PhotoLab renderer, render crate, viewer kernel, and Builder import paths
were read-only for S-06c.

S-06c gates:

- `node scripts/generate-command-table.mjs --check`: exit 0.
- `pnpm --filter @himmelcad/app test`: 44 passed, 0 failed.
- `pnpm --filter @himmelcad/ui test`: 35 passed, 0 failed.
- `pnpm --filter @himmelcad/ui typecheck`: exit 0.
- `pnpm --filter @himmelcad/photolab typecheck`: exit 0; `PhotoLab English UI
  check passed.`
- `pnpm --filter @himmelcad/automation-host test`: 45 passed, 0 failed, 1
  skipped (the existing real-Codex version pin expected 0.144.5 and found
  0.153.4).
- `pnpm --filter @himmelcad/ui gallery:shots`: `Captured 66 screenshots for 32
  sections`; both regenerated Command surfaces theme shots were inspected and
  contain the new PhotoLab image-node row.
- `pnpm --filter @himmelcad/builder typecheck`: S-06c-owned code typechecks, but
  the full gate remains red in concurrent V-02 work at
  `BuilderKernelViewport.tsx:1731` because the budget-reason label table does
  not yet cover `budget:points`, `budget:bytes`, `decode:backlog`, and
  `upload:backlog`. S-06c did not edit that viewer integration path.
- `git diff --check`: exit 0.

Not verified: no PhotoLab renderer integration click-through was performed,
because this slice was explicitly prohibited from editing `apps/photolab`.
The PhotoLab lane must add the product id and the exact two-id mapping above;
the existing confirmation and GCP filtering handlers remain authoritative.
