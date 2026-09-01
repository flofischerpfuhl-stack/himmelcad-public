# Himmel:CAD design system

This document defines the shared visual, interaction, and product-copy language
for Builder, PhotoLab, Cap, and WeltView. Implementation lives in
`@himmelcad/theme` and `@himmelcad/ui`; product apps compose these modules rather
than inventing one-off chrome.

## Brand and language

- The product family is written **Himmel:CAD** in documentation, marketing, and
  product UI.
- Product names are **Himmel:CAD Builder**, **Himmel:CAD PhotoLab**,
  **Himmel:CAD Cap**, and **Himmel:CAD WeltView**.
- Lowercase or uppercase wordmarks such as `himmel:CAD` and `HIMMEL:CAD` are
  allowed when the supplied brand asset or display treatment requires them.
- Source identifiers, package names, formats, and compatibility paths may use
  `himmelcad` where punctuation is not valid.
- All product UI copy is English. Documentation is English even when owner and
  agent communicate in German.
- Use sentence case unless a supplied wordmark requires another casing.

## Visual language

Himmel:CAD uses a VS Code-inspired Dark Islands composition: a dark or light
void with separate floating work surfaces. Panels are not assembled from
unmodified browser borders or generic component-library defaults.

- Use theme tokens; do not add one-off colors, shadows, radii, fonts, or spacing
  when an existing token or pattern applies.
- Reuse the typography roles defined by `@himmelcad/theme`: UI, mono, display,
  and display-3D. Display faces are not body fonts.
- Use one accent blue sparingly for primary actions, focus, and important links.
  Status colors communicate success, warning, and error only.
- Active and selected states use shared neutral or accent-outline patterns. Do
  not invent translucent accent washes or gradients.
- Animations are subtle, non-blocking, and normally complete within 200 ms.

## Shared controls

Product-owned checkboxes, radios, selects, menus, dialogs, toasts, empty states,
tabs, and other recurring controls use shared themed modules.

Do not ship unstyled browser, Electron, Flutter, or operating-system defaults
for product-owned UI. Preserve semantic HTML, focus behavior, keyboard access,
screen-reader labels, and platform accessibility beneath the custom styling.
OS-owned permission, credential, and file-selection surfaces may remain native
when platform security or integration requires them.

Before creating a control:

1. Search `@himmelcad/ui` and existing product usage.
2. Reuse the closest established pattern, including typography and casing.
3. If the pattern is cross-product, extend the shared module first.
4. Keep a product-local control only when its domain interaction is genuinely
   product-specific.

## App composition

Desktop products use the shared shell language:

- top ribbon that can collapse while retaining discoverable actions;
- left entity/navigation area;
- central viewport or workspace;
- right properties and active-function surfaces;
- bottom console/results area;
- persistent viewport coordinate display where spatial interaction applies.

Panels remain collapsible. Tool parameters stay docked when the user must
interact with the viewport. Focused multi-step, destructive, or spatially dense
work may use a custom modal or full task surface.

## Discoverability and contextual access

Every user-facing capability needs a visible, discoverable UI entry. Keyboard
shortcuts and automation are additional access paths, not replacements for
visible UI.

Commands relevant to a selected entity should be evaluated for the entity
context menu. Commands relevant to empty viewport space may belong in the quick
function surface. Do not place unrelated global configuration into entity
context menus merely to satisfy parity.

Ribbon, context-menu, console, Python, and AI access must resolve to the same
underlying command or query when they represent the same capability.

## Complete user flows

Design beyond the happy-path button. For every operation, determine:

- how the user discovers and starts it;
- where it can be confirmed, cancelled, closed, or resumed;
- what happens on Escape, window close, project replacement, and app shutdown;
- how conflicting or simultaneous operations are coordinated;
- what remains visible after success, cancellation, and failure;
- whether the result belongs in properties, the entity tree, jobs, reports, or
  the console;
- which sibling apps and automation clients expose the same capability.

Incompatible operations must be serialized, disabled with an explanation, or
rejected explicitly. Separate panels do not imply safe concurrency.

## Progress, cancellation, and feedback

- Effectively instant actions do not flash indicators.
- If the user can perceive waiting, show an inline busy state or spinner without
  blocking unrelated interaction.
- Operations long enough to justify progress report real phases or units when
  available; do not fabricate a smooth percentage.
- Expensive work is cancellable. Cancellation must be checked between bounded
  units and must not publish partial canonical results.
- If a short atomic boundary cannot be interrupted safely, communicate that
  state and cancel at the next safe boundary.
- Errors explain what failed, what remains safe, and what the user can do next.

The in-app console records important operation start, completion, duration,
degraded fallbacks, and actionable failures. It complements task-local feedback
instead of replacing it.

## UI copy

- Prefer short labels and direct status text over explanatory paragraphs.
- Do not spend permanent screen space explaining familiar controls.
- Use tooltips or contextual help for unfamiliar icons and domain-specific
  terms, not as a substitute for clear labels.
- Empty states are concise and actionable.
- Confirmation copy names the actual consequence.
- Never claim accuracy, completion, recovery, or saved state that the product
  has not verified.

## Input consistency

Shared spatial controls remain consistent across Builder, PhotoLab, and
WeltView unless a product has a documented reason to differ. Selection,
navigation, snapping, command completion, cancellation, and context-menu
behavior must not change accidentally between workspaces.

Detailed camera, picking, and snapping behavior belongs to the viewer and input
contracts rather than being duplicated here.

## Verification

UI changes require proportional component or interaction tests and visual
inspection. React and CSS changes must reach the running dev server through HMR
or a verified reload. Mount-only behavior requires a remount. Electron main,
preload, and sidecar changes require a full dev restart.
