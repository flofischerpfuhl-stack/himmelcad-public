# S-02 base controls — architect visual review (G17)

Reviewed: `packages/@himmelcad/ui/gallery/shots/{dark,light}.png` and the
dark section shots for Button, NumberInput, Dialog, Menu, Toast (1280 px,
2026-09-04). Verdict: the token discipline, Dark Islands surfaces, focus rings
and typography are consistent across all 24 sections and both themes; five
corrections before S-02 counts as landed.

| #   | Component | Finding                                                                                                                                                                                                                                                                                    | Required change                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Button    | The `default` row shows a secondary-looking "Save" while hover/focus/disabled/loading show the primary blue — the state rows mix two variants, so the primary default state is never shown.                                                                                                | Gallery: one row block per variant (primary, secondary, quiet, danger), each with default/hover/focus-visible/disabled; loading only on primary. Component: verify all four variants exist and use only tokens; danger uses the error token family.                                                                                                                                                            |
| 2   | Dialog    | The `default` fixture is a stub: a tiny dialog whose only action is unstyled text "OK" (reads as a label). The confirm fixtures show only Cancel; a confirmation dialog needs its primary/destructive action.                                                                              | Gallery: one realistic fixture — title "Delete 3 entities?", body sentence, footer right-aligned with secondary Cancel and danger "Delete" (primary position, rightmost), width 420 px, 16 px padding, footer separated by the divider token. States: default, focus-visible on Delete, close-button hover. Component: footer slot must accept the action pair; initial focus on the least destructive action. |
| 3   | Menu      | In the `hover` row both items are highlighted, in `focus-visible` both items carry focus rings. Exactly one item may be hovered/focused at a time (roving focus). Whether this is the fixture's simulation class applied to every item or the component's state handling must be verified. | Fix the fixture to mark one item; add a test that at most one `[data-focused]`/focused item exists after ArrowDown; if the component itself renders multiple focus rings, fix the roving-tabindex implementation. Also: the `default` row's single tall box ("Open") is not a realistic menu — show the same three-item menu in every row.                                                                     |
| 4   | Toast     | Rows labelled default/hover/focus-visible actually differ by accent colour (blue, orange, green) — those are kinds (info, warning, success), not states, so the labels lie and the error kind is never shown.                                                                              | Gallery: rows by kind — info, success, warning, error (error with `aria-live=assertive` and an action slot "Retry"), plus one row for close-button hover/focus. Component: kind → accent token mapping documented.                                                                                                                                                                                             |
| 5   | All       | Hover is simulated via a forced class; for Button the hover surface is barely distinguishable from default in dark theme (Save vs Save project rows differ only by width).                                                                                                                 | Ensure the hover state raises the surface by exactly one token step (`--hc-surface-raised` or the existing hover token) so hover is visible in both themes; verify in the gallery shot by pixel difference between default and hover rows (script check: the two rows must differ).                                                                                                                            |

Not findings (accepted as is): NumberInput (right-aligned value, unit suffix,
invalid state with message), Spinner, Tooltip, Slider, ProgressBar, Select,
Checkbox, Radio, IslandTabs, FunctionPanel, EntityTree, StatusBar, EmptyState,
OverlayChip, Splitter, TitleBar, EdgeStrip, PanelToggles.

## Corrections applied

The five numbered findings were corrected on 2026-09-04. The gallery now
shows every Button variant and required state, the complete destructive Dialog,
single-item Menu hover/focus with realistic groups, all four Toast kinds and
close-control states, and a pixel assertion that rejects identical primary
Button default/hover rows in either theme.

Regenerated evidence:

- `packages/@himmelcad/ui/gallery/shots/light/button.png`
- `packages/@himmelcad/ui/gallery/shots/light/dialog.png`
- `packages/@himmelcad/ui/gallery/shots/light/menu.png`
- `packages/@himmelcad/ui/gallery/shots/light/toast.png`
- `packages/@himmelcad/ui/gallery/shots/dark/button.png`
- `packages/@himmelcad/ui/gallery/shots/dark/dialog.png`
- `packages/@himmelcad/ui/gallery/shots/dark/menu.png`
- `packages/@himmelcad/ui/gallery/shots/dark/toast.png`

## Architect acceptance (2026-09-04, after S-02b)

Reviewed the regenerated dark section shots for Button, Dialog, Menu, Toast (and the light sheet): all five findings are resolved as briefed — four Button variants with distinct hover/focus/disabled rows and loading on primary; a realistic destructive Dialog (Cancel left, danger Delete right, focus on Delete shown); Menu with exactly one hovered/focused item and separators; Toast rows by kind with the error kind carrying a Retry action. S-02 counts as **landed under G17**.

S-02c — The light Dialog defect was stale/mixed generated evidence: concurrent
`gallery:shots` runs shared the same preview port, build directory, and output
paths, allowing one run to capture or remove another run's artifacts. The
rendered Cancel buttons were enabled and resolved the correct secondary tokens.
Gallery capture is now mutually exclusive (a concurrent run is rejected) and
rejects text-to-fill contrast below 4.5:1 for Cancel in every Dialog row in
both themes.

S-02d — The shared closeable FunctionPanel tablist now keeps Properties and the
active function visible, shrinks tabs to the 96 px floor with ellipsized labels,
and moves rightmost excess tabs into the ARIA-separated “⋯” Menu. The gallery
adds the 320 px three-tab, five-tab overflow, and open-menu rows; its serial
capture rejects tab-label geometry or header pixels outside the panel bounds
and verifies ArrowRight/Enter access to the overflow button.

Regenerated evidence:

- `packages/@himmelcad/ui/gallery/shots/light/function-panel.png`
- `packages/@himmelcad/ui/gallery/shots/dark/function-panel.png`

## Architect acceptance of S-02d (G17, 2026-09-08)

`gallery/shots/dark/function-panel.png`: three tabs shrink with ellipsis at 320 px, five tabs collapse into the ⋯ overflow menu with per-tab close actions, Properties stays first and the active tab stays visible, roving focus reaches the overflow button. S-02d accepted; F16 closed on the shared side.

## S-02e — F17 light-theme status text contrast (2026-09-08)

Added the missing foreground role `--hc-info-fg`: dark remains `#1597f2`;
light is `#0b5fa8`. The light value measures 5.72:1 on the panel surface
`#eef0f3`, 6.14:1 on island-hi `#f7f8fa`, and 6.53:1 on island
`#ffffff`. Dark measures 5.48:1 on island `#1a1c20`, 5.13:1 on
island-hi `#1f2226`, and 5.76:1 on the panel surface `#15171a`.
`tokens.css` now documents that status text uses the matching `*-fg` role;
plain status tokens remain for fills, borders, and bars.

The complete scoped plain-token text scan changed these declarations (27
declarations; `packages/@himmelcad/app` had none):

- `packages/@himmelcad/console/src/Console.module.css`: `.info .level` info →
  info-fg; `.warn .level` warning → warning-fg; `.error .level` error →
  error-fg; `.warn .msg` warning → warning-fg; `.error .msg` error → error-fg.
- `packages/@himmelcad/ui/src/FunctionPanel.module.css`: `.tabClose:hover` and
  `.overflowMenuClose:hover, .overflowMenuClose:focus-visible` error → error-fg.
- `packages/@himmelcad/ui/src/JobsSurfaces.module.css`:
  `.row[data-state='needs-input'] .glyph` warning → warning-fg and
  `.row[data-state='completed'] .glyph` success → success-fg.
- `packages/@himmelcad/ui/src/ViewportHud.module.css`:
  `.number[data-tone='warning']` warning → warning-fg and
  `.number[data-tone='error']` error → error-fg.
- `packages/@himmelcad/ui/src/ImportRegistrationWizard.module.css`: `.warning`
  warning → warning-fg and `.error` error → error-fg.
- `packages/@himmelcad/ui/src/ImportChat.module.css`: `.bubbleOk strong` success
  → success-fg; `.bubbleWarn strong` warning → warning-fg; `.bubbleError strong`
  error → error-fg; `.metricWarn strong` warning → warning-fg; `.listRow em`
  success → success-fg; `.warningText` warning → warning-fg;
  `.errorInline > svg` error → error-fg; `.warnInline > svg` warning →
  warning-fg; `.successInline > svg` success → success-fg.
- `apps/builder/renderer/src/PlanIsland.module.css`: `.refresh_clean` success →
  success-fg; `.refresh_stale` warning → warning-fg; `.refresh_error` error →
  error-fg.
- `apps/builder/renderer/src/GroundExtractionPanel.module.css`: `.error` error →
  error-fg.
- `apps/builder/renderer/src/SpecsIsland.module.css`: `.error` error → error-fg.

The theme package now exposes `lint:tokens`, also wired as its `test` script.
It recursively rejects a `color:` declaration containing a plain info,
success, warning, or error token in the shared UI, Console, app, or Builder CSS
modules while permitting non-text roles such as `background` and
`border-color`.

The gallery adds “Status text”, rendering all four foreground roles on panel,
island, and island-hi surfaces. Its serial capture checks the rendered text and
surface pixels for at least 4.5:1 in both themes (24 combinations). Regenerated
ignored visual evidence:

- `packages/@himmelcad/ui/gallery/shots/light/status-text.png`
- `packages/@himmelcad/ui/gallery/shots/dark/status-text.png`
- `packages/@himmelcad/ui/gallery/shots/light.png`
- `packages/@himmelcad/ui/gallery/shots/dark.png`

Verification:

- PASS — `pnpm --filter @himmelcad/theme test`.
- PASS — `pnpm --filter @himmelcad/builder typecheck`.
- PASS — `pnpm --filter @himmelcad/photolab typecheck`.
- PASS — serial `pnpm --filter @himmelcad/ui gallery:shots` (86 screenshots,
  42 sections, including the 24 status-text pixel checks).
- PARTIAL — `pnpm --filter @himmelcad/ui test`: 45/46 tests passed and the
  shared axe fixture passed with zero findings; the unrelated in-flight
  point-size multiplier implementation does not yet match its old pixel-size
  assertion.
- BLOCKED BY PARALLEL LANE — `pnpm --filter @himmelcad/console test`: compile
  passed and 1/2 tests passed; the generated vocabulary currently includes
  `photolab.images.remove` and `photolab.gcp.images`, which the in-flight active
  command registry does not yet expose.

## Architect acceptance of S-02e (G17, 2026-09-08)

`gallery/shots/light/status-text.png`: Information/Success/Warning/Error legible on panel, island and island-hi surfaces in the light theme (≥ 4.5:1 asserted by 24 pixel checks); `--hc-info-fg` exists in both themes; the theme's `lint:tokens` now fails any plain status token used as text colour — it already flags the in-flight sampling/segment panels, which their lanes must fix before landing. S-02e accepted.
