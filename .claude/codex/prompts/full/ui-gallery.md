Task: add a shared component gallery to `packages/@himmelcad/ui` so the architect can review every shared control by eye (light and dark), and produce screenshots now.

Read `packages/@himmelcad/ui/test/a11yFixtures.tsx` (11 fixtures from S-02), `packages/@himmelcad/ui/src/index.ts`, `packages/@himmelcad/theme/src/tokens.css`, and how Builder mounts the theme (`apps/builder/renderer/src/main.tsx` or equivalent — copy the exact theme/font setup so the gallery renders identically to the product).

Deliverable:
1. `packages/@himmelcad/ui/gallery/` — a tiny Vite app (`index.html`, `main.tsx`, `Gallery.tsx`) that renders every fixture from `a11yFixtures.tsx` plus the pre-existing shared controls (Select, Checkbox, Radio, IslandTabs, Ribbon, FunctionPanel, EntityTree, StatusBar, EmptyState, OverlayChip, ProgressBar, Splitter, TitleBar, EdgeStrip, PanelToggles) each in a labeled section: heading = component name, then one row per state (default, hover-simulated via a `data-force-hover` class if the CSS supports it, focus-visible, disabled, invalid/loading where applicable). Sections are laid out on the Dark Islands void with the same panel surface tokens the product uses. A `?theme=light|dark` query and `?section=<name>` filter.
2. Script `packages/@himmelcad/ui/gallery/shoot.mjs` (`pnpm --filter @himmelcad/ui gallery:shots`): builds the gallery with Vite (or serves it), then screenshots with `/usr/bin/google-chrome --headless=new --screenshot` (Playwright browsers are not installed) at 1280 px width, full page, for light and dark, into `packages/@himmelcad/ui/gallery/shots/{light,dark}.png` and additionally one PNG per section (`shots/{theme}/{section}.png`) — git-ignored.
3. Run it now and report the shot paths and any component that failed to render.

Constraints: no changes to component source files; gallery only. Do not add dependencies beyond what the workspace already has (Vite and React are present). `pnpm --filter @himmelcad/ui typecheck` must stay green (exclude the gallery from the composite project if needed, or add it as its own tsconfig). Budget: medium effort, one pass.


Resume notice: an earlier run of this exact brief was interrupted mid-work (process killed, no report). The tree may contain its partial files. Run `git status --short` first, inspect the partial work, keep what is sound, and finish the deliverable; do not start from scratch if the partial state is usable.
