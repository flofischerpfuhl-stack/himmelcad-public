# @himmelcad/assembler

Phase 0 skeleton for Himmel:CAD Assembler, a Shapr3D-like desktop CAD for
3D-printed parts. Electron + TypeScript + React on `@himmelcad/theme` and
`@himmelcad/ui`; no Rust application layer or renderer fork yet. This app
renders only a placeholder shell — the real ribbon/entity-tree/viewport UI is
designed in a follow-up pass.

## Scripts

- `pnpm dev` — Vite dev server + Electron together.
- `pnpm dev:web` — Vite only, for iterating on the renderer in a browser.
- `pnpm build` — renderer (Vite) + Electron main/preload (`tsc`).
- `pnpm typecheck` — renderer and main-process TypeScript projects.
- `pnpm test` — Node test runner against the main-window options builder.

## Boundary

Assembler must not depend on Builder: no `apps/builder`, `@himmelcad/agent`,
`@himmelcad/automation-host`, `@himmelcad/viewer`, `@himmelcad/app`, or the
Builder sidecar. See `assembler/README.md` (product/plan overview) and
`docs/adr/0033-assembler-product-boundary.md` (the boundary decision) for the
authoritative rules.
