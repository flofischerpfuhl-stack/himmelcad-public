# @himmelcad/assembler

Himmel:CAD Assembler, a Shapr3D-like desktop CAD for 3D-printed parts.
Electron + TypeScript + React on `@himmelcad/theme` and `@himmelcad/ui`,
with a WebGL2 viewport and — since the Phase 1 kernel spike — a real B-rep
CAD kernel: OCCT 8.0.1 compiled to WebAssembly (`replicad-opencascadejs`),
driven through `replicad`, running in a Web Worker behind the app-owned
`KernelAdapter` (`renderer/src/kernel/`). Decision, measurements, the
stable-reference scheme and open risks: `assembler/KERNEL-SPIKE.md`.

## Layout

- `renderer/src/model/` — feature document (`document.ts`), store with
  async evaluation, undo/redo, tools and selection (`store.ts`), command
  registry.
- `renderer/src/kernel/` — kernel adapter contract, OCCT evaluator,
  naming/reference resolution, worker.
- `renderer/src/viewport/` — WebGL2 scene, picking by face/edge naming key.
- `renderer/public/licenses/` — third-party notices and license texts
  shipped with the app (OCCT is LGPL-2.1 with the Open CASCADE exception; see
  `LICENSES/THIRD_PARTY.md`).

## Scripts

- `pnpm dev` — Vite dev server + Electron together.
- `pnpm dev:web` — Vite only, for iterating on the renderer in a browser.
- `pnpm build` — renderer (Vite) + Electron main/preload (`tsc`).
- `pnpm typecheck` — renderer and main-process TypeScript projects.
- `pnpm test` — Node test runner; kernel tests load the real OCCT wasm in
  Node (once per test file).

## Boundary

Assembler must not depend on Builder: no `apps/builder`, `@himmelcad/agent`,
`@himmelcad/automation-host`, `@himmelcad/viewer`, `@himmelcad/app`, or the
Builder sidecar. See `assembler/README.md` (product/plan overview) and
`docs/adr/0033-assembler-product-boundary.md` (the boundary decision) for the
authoritative rules.
