SPLIT STEP 8 — remove the legacy Three.js viewer path. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0017-unified-render-core.md` (Decision + Consequences), `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` § "Legacy Three.js path" and step 8; `packages/@himmelcad/viewer/README.md`; then the files you change.

FACTS (verify): the legacy path is 19 files (~6.3k lines) in `packages/@himmelcad/viewer/src`: `Viewport.tsx`, `camera/CameraController.ts`, `picking/{PickMaterial,PickingPass}.ts`, `products/{GaussianSplatDataset,ProductTileDataset,RasterPyramidDataset,TiledMeshDataset}.ts`, `scene/{Layer,PointCloudLayer,SceneGraph}.ts`, `snapping/{CameraSnapProvider,FallbackSnapProvider,PointCloudSnapProvider,PotreeSnapProvider,SnapProvider}.ts`, `spatial/{PointOctree,planeFit}.ts`, `streaming/TiledDataset.ts`, plus the root barrel `index.ts` → `legacy.ts`. Only `apps/weltview/src/App.tsx` imports the legacy root (`import { Viewport } from '@himmelcad/viewer'`). Builder and PhotoLab use `@himmelcad/viewer/kernel` and `/kernel/react`.

GOAL
1. WeltView: replace the legacy `Viewport` with the kernel viewport the other apps use (`@himmelcad/viewer/kernel/react` — look at how PhotoLab or Builder mounts it) keeping WeltView exactly as small as it is: an empty read-only viewer shell with its current ribbon/panels. No new WeltView features, no data loading that does not exist today. `pnpm --filter @himmelcad/weltview build` and `typecheck` must pass.
2. Delete the 19 legacy files, `legacy.ts`, the root barrel's legacy re-exports, legacy-only tests/fixtures, and any viewer-internal code that only they used. Keep everything the kernel path uses (check imports before deleting; if a kernel file imports a "legacy" file, it is not legacy — keep it and list it).
3. Dependencies: remove `three`, `@types/three` and `@himmelcad/three-loader` from every `package.json` that no longer imports them (viewer, builder, photolab, weltview — verify with an import scan first; builder/photolab declare `three` but should not import it). Remove the `@himmelcad/three-loader` workspace package and its vendored source/fetch/license wiring only if nothing else uses it (search `pnpm-workspace.yaml`, `LICENSES/`, `scripts/`, `vendor/`, `libs/`); list what you removed. Update `pnpm-lock.yaml` with `pnpm install` (offline if possible; never upgrade other packages).
4. Remove the `viewer:. → viewer:legacy` allowlist entry (it becomes stale) and any viewer-subpath mapping for `legacy` in `scripts/module-layers.json`.
5. Update `packages/@himmelcad/viewer/README.md` and `docs/ARCHITECTURE.md` § Renderer: the legacy path no longer exists (short edits only).

HARD RULES
- No behaviour change in Builder or PhotoLab. No renderer/kernel code changes except removing dead imports.
- NEVER `git stash`, `git reset`, `git checkout -- <path>`. Never copy the repo; scratch only under `.build/split-s8/`, delete at the end. Do not commit or push. No UI runs on `DISPLAY=:0`; if you run a browser/Electron test use the repo's headless/`scripts/ui-test-display.sh` path.

GATES (verbatim)
- `pnpm --filter @himmelcad/viewer typecheck`; `pnpm --filter @himmelcad/viewer test`; `pnpm --filter @himmelcad/viewer test:browser-kernel-webgl2` and `test:browser-kernel-webgpu` if they run headless (else say why)
- `pnpm --filter @himmelcad/builder typecheck`; `pnpm --filter @himmelcad/builder test`; `pnpm --filter @himmelcad/photolab typecheck`; `pnpm --filter @himmelcad/photolab test`; `pnpm --filter @himmelcad/weltview typecheck`; `pnpm --filter @himmelcad/weltview build`
- `pnpm check:modules`; `pnpm -r --if-present lint` restricted to changed packages if available
- quote: `rg -n "from 'three'|from \"three\"|three-loader" --glob '!node_modules' --glob '!dist' --glob '!target' --glob '!docs/**'`

EVIDENCE `docs/builder-program/evidence/SPLIT-S8-2026-09-24.md`: files deleted (lines), kept-because-used list, WeltView change, dependencies removed, lockfile diff summary, gates verbatim, what was NOT verified, measured wall-clock time.
