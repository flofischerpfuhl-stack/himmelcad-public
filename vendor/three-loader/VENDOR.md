# `@pnext/three-loader` — Vendored

## Upstream

- **Repository:** https://github.com/pnext/three-loader
- **Branch / Commit:** `master` @ `a1b97ab4254562d89ff27860963945d92a17c904`
- **Commit message:** `fix: brace-expansion vulnerability (#281)`
- **Vendored at:** 2026-05-08
- **Upstream version at vendoring:** `1.0.0` (npm)

## License

MIT (PNext) + BSD 2-Clause (Potree-derived portions) + MIT (Plasio) — see
the bundled `LICENSE` file. Compatible with Himmelcad's BSL-1.1 product
per `AGENTS.md` §1.3.

## Why we vendored

Per `AGENTS.md` §1.6, this is treated as part of Himmelcad. We need the
ability to:

1. Patch upstream's `require('./shaders/foo.vert')` to Vite-compatible
   `?raw` imports.
2. Track newer `three.js` (we're on `0.169`; upstream peers `~0.160`).
3. Add Himmelcad-specific extensions: BROTLI Potree2 support (upstream
   PR #283 still open), MRT pick to lift the 256-layer cap, and a hook
   for our `f64`-precision Stage-2 cursor refinement.

ADR 0003 documents the architectural decision in detail.

## Layout

```
vendor/three-loader/
├── LICENSE             ← upstream license, mirrored verbatim
├── CHANGELOG.md        ← kept for upstream-sync reference
├── README.md           ← upstream readme, kept for context
├── VENDOR.md           ← this file
├── tsconfig.json       ← upstream tsconfig, kept as reference
├── package.json        ← Himmelcad-rewritten: name, peer, no devDeps
└── src/                ← upstream sources (untouched in initial vendor)
```

The upstream repo's webpack/babel build pipeline, husky hooks, eslint
config, and example app were removed at vendoring time — none of them
ship with the product, and they pull in dev dependencies (eslint 9,
webpack 5, babel) that conflict with our root tooling.

## Modifications (running log)

| Date       | Change                                                                                                                                                                   | Reason                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 2026-05-08 | Initial vendoring; upstream tooling stripped (webpack, babel, husky, eslint, example/, scripts/, package-lock.json).                                                     | Reduce surface area; we use Vite/tsc, not webpack.                                                                    |
| 2026-05-08 | `package.json`: name → `@himmelcad/three-loader`, set `private: true`, removed all `devDependencies`, peer `three` → `^0.169.0`, `main`/`types` point at `src/index.ts`. | Integrate into our pnpm workspace, match our `three` version.                                                         |
| 2026-05-14 | Exposed `Potree.maxLoadsToGPU` plus matching public types.                                                                                                               | Let Omnishape throttle GPU uploads during fast interaction/context recovery without lowering the user's point budget. |

**Pending modifications** (will be applied when integration starts):

- Convert `require('./shaders/*.vert')` → `import shader from './shaders/*.vert?raw'` (Vite-compatible). Files: `materials/blur-material.ts`, `materials/point-cloud-material.ts`, `splats-mesh.ts`.
- Audit any other `require()` calls and convert.
- Verify type compatibility with `@types/three@^0.169` (upstream peers `~0.160`).
- Patch `f64`-precision hook into `point-cloud-octree-picker.ts` so our `PointCloudSnapProvider` can refine through `himmelcad-spatial`.

## Re-syncing from upstream

When upstream lands a fix we want:

```bash
# 1. Save current local patches
cd vendor/three-loader
git diff > /tmp/himmelcad-three-loader-patches.diff   # if vendor is in git

# 2. Re-clone upstream at a newer commit
cd ..
rm -rf three-loader
git clone --depth=1 https://github.com/pnext/three-loader.git
cd three-loader
git rev-parse HEAD   # update VENDOR.md

# 3. Strip upstream tooling (see "Layout" above)
# 4. Re-apply Himmelcad-specific patches per the table above
# 5. Update `pnpm-workspace.yaml` if needed; run `pnpm install`
# 6. Smoke-test the viewer
```
