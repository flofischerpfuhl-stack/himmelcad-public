# S-02 — shared theme and base controls evidence

Date: 2026-09-02

## Delivered substrate

| Capability | Implementation | Interaction / ARIA test | Axe fixture |
| --- | --- | --- | --- |
| Menu / ContextMenu | `packages/@himmelcad/ui/src/Menu.tsx` | 1 grouped test: menu/menuitem roles; ArrowUp/Down, Home/End roving logic; UIP-D14 menu rung | pass / pass |
| Button | `packages/@himmelcad/ui/src/Button.tsx` | 1 test: native button semantics, toggle ARIA; loading composes Spinner | pass |
| NumberInput | `packages/@himmelcad/ui/src/NumberInput.tsx` | 1 test: spinbutton ARIA, Enter commit contract, Escape field rung, parse/range behavior, blur suppression | pass |
| Toast / ToastRegion | `packages/@himmelcad/ui/src/Toast.tsx` | 1 test: polite region, assertive error, semantic dismiss action | pass |
| Spinner | `packages/@himmelcad/ui/src/Spinner.tsx` | 1 test: delayed default and status role | pass |
| Tooltip | `packages/@himmelcad/ui/src/Tooltip.tsx` | 1 test: described-by relationship, tooltip role, disabled-only omission | pass |
| Slider | `packages/@himmelcad/ui/src/Slider.tsx` | 1 test: slider role/value text; arrows and Home/End bounded values | pass |
| Dialog | `packages/@himmelcad/ui/src/Dialog.tsx` | 1 test: labelled modal role, Tab trap contract, UIP-D14 modal rung | pass |
| ProgressBar | `packages/@himmelcad/ui/src/ProgressBar.tsx` | 1 test: determinate/indeterminate progressbar ARIA | pass |
| Ribbon tabs | `packages/@himmelcad/ui/src/Ribbon.tsx` | 1 test: roving tabindex; ArrowLeft/Right, Home/End automatic activation | pass |

All controls share token-only styling in
`packages/@himmelcad/ui/src/BaseControls.module.css` and are exported from
`packages/@himmelcad/ui/src/index.ts`. Shared keyboard calculations live in
`packages/@himmelcad/ui/src/controlInteractions.ts` and are exercised directly
by the interaction tests.

`ProgressBar` remains re-exported by `ImportChat.tsx` for existing consumers,
while the package barrel now exports the top-level module. `Select.tsx` uses
`--hc-z-popover`; Builder's `FloatingTaskIsland.module.css` uses
`--hc-z-floating`.

Builder installs the shared Escape ladder once and enables
`closeFunctionTabs` / `onCloseFunction={closeFunction}` in
`apps/builder/renderer/src/App.tsx`. `FunctionPanel.tsx` was not changed.

## Accessibility audit

`packages/@himmelcad/ui/test/baseControlsA11y.test.ts` renders one semantic
fixture per component, launches the installed Google Chrome through
Playwright, injects the workspace's axe-core 4.13.0, and fails on any axe
violation. Results were zero violations for Menu, ContextMenu, Button,
NumberInput, Toast, Spinner, Tooltip, Slider, Dialog, ProgressBar, and Ribbon.

The new test count is 11: 10 unit/interaction tests plus one axe audit that
iterates 11 component fixtures. The complete `@himmelcad/ui` suite is 22 tests.

`NumberInput` consumes `registerEscapeRung('fieldRevert', ...)`,
`revertEscapeField`, and `consumeEscapeBlurCommitSuppression`. It deliberately
does not apply `escapeFreeTextProps`: that marker is the UIP-D14 exemption for
unbounded free text and would cause the dispatcher to bypass NumberInput's
commit/revert rung.

## Theme evidence

`packages/@himmelcad/theme/src/tokens.css` defines and
`packages/@himmelcad/theme/src/index.ts` exports the semantic z-layer scale and
SE-D18 axis tokens. Contrast was measured with WCAG sRGB relative luminance
against each theme's viewport background (`--hc-bg-void`).

| Token | Dark ratio against `#101114` | Light ratio against `#f1f2f5` |
| --- | ---: | ---: |
| `--hc-axis-x` | 6.64:1 | 6.42:1 |
| `--hc-axis-y` | 10.05:1 | 5.05:1 |
| `--hc-axis-z` | 7.51:1 | 5.16:1 |
| `--hc-axis-hover-outline` | 18.88:1 | 16.88:1 |
| `--hc-axis-active-outline` | 13.09:1 | 6.99:1 |

Every measured value exceeds the SE-D18 3:1 floor. A grep for hex literals in
the new shared CSS module returned no matches. A grep for the migrated
hard-coded `10050` / `z-index: 1000` pair in the two named files returned no
matches.

## Gates run

- `pnpm --filter @himmelcad/ui test` — pass, 22/22 tests; axe fixture audit pass.
- `pnpm --filter @himmelcad/ui typecheck` — pass.
- `pnpm --filter @himmelcad/theme typecheck` — pass. The theme package has no test script.
- `pnpm --filter @himmelcad/builder typecheck` — pass.
- `pnpm --filter @himmelcad/photolab typecheck` — pass; English UI check also passed.
- `git diff --check` on the S-02 implementation paths — pass.

## Decision / deviation record

No UIP-D12 component or build-order deviation was required. No new dependency
was added. The §3.6 gesture map is specification-only, not a code artifact, so
the Ribbon ArrowLeft/ArrowRight bindings were not registered in another file;
the architect should carry those bindings into any future executable gesture
registry.

Not verified in this package pass: product screenshot/visual-regression output
or a packaged Electron build. Those are outside G-UIP-1's component subset;
component semantics, keyboard logic, axe fixtures, package typechecks, and both
sibling-app typechecks were verified.
